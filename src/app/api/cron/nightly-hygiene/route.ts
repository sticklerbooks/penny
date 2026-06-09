// Nightly hygiene cron — runs every night for any modality that's been active
// since its last hygiene pass.
//
// For each "dirty" modality (lastActiveAt > lastCompletedAt):
//   1. Build that modality's full system prompt (real data context)
//   2. Run an agentic tool-use loop asking it to tidy its domain and write
//      a qualitative observation as a note
//   3. Stamp touchCompleted so it won't run again until the next active session
//
// Replaces parseActions / executeActions with runAgenticLoop + tool-executor.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildSystemPrompt, cachedSystem, PENNY_MODEL } from '@/lib/claude'
import { getModality } from '@/lib/modalities'
import { getEmailCalendarSummary } from '@/lib/email-calendar'
import { dirtyModalities, touchCompleted } from '@/lib/modality-state'
import { runAgenticLoop } from '@/lib/agentic-loop'
import { getToolsForModality } from '@/lib/tools'
import type { ToolContext } from '@/lib/tool-executor'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

// ─── Hygiene prompt ───────────────────────────────────────────────────────────
// The core ask: tidy the domain, then write an honest qualitative observation.
// Uses tools — no XML tags.
function hygienePrompt(displayName: string, domain: string, userName: string): string {
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)

  return `NIGHTLY DOMAIN REVIEW

This is your end-of-day maintenance pass. It runs automatically while ${userName} isn't around. No one's watching; you're just doing your job.

Two things to do tonight:

━━━ 1. HOUSEKEEPING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use your tools to keep the ${domain} domain tidy. Be a clean, decisive professional:

- Mark tasks done when you can confirm they're complete: update_task(status=Complete)
- Update status on anything clearly in progress: update_task(status=Started)
- Add notes to anything stalled or being avoided: update_task(notes="...")
- Resolve notes you've addressed: resolve_note(id)
- Ignore notes that are stale, redundant, or no longer relevant: ignore_note(id)
- Archive memories by marking them via update_memory if that's still available, or let them be.
- If something significant happened this week that needs preserving, use log_entry or write_deep_memory.

Don't over-reach. You can only touch what's in your domain and your own notes.

━━━ 2. YOUR HONEST QUALITATIVE READ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This is the more important part. Write yourself a note with your genuine qualitative read of how ${userName} is engaging with your domain right now.

Use create_note with:
- modalityTarget: "${domain}" (your own modality, so you'll see it next session)
- expiresAt: "${twoWeeksOut}"
- title: something like "Domain read — [date]"

This is YOUR private observation — not a status report, not encouragement. Think of it as your running inner monologue. What pattern are you actually seeing? What's alive? What's stalling? What's being avoided? What's changed since last time you looked?

Be specific. Name actual tasks, dates, patterns. Write what you'd actually think, not what sounds supportive.

━━━ 3. ELEVATE (only if warranted) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If something has risen to the level that Penny (the Personal Assistant) should know — a meaningful pattern, a real concern, or something genuinely positive — write a note with modalityTarget="pa". Only if it genuinely warrants it. Don't noise the PA with routine observations.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Keep it tight. Use your tools — then when you're done, just stop. No conversation needed.`
}

// ─── PA hygiene prompt ─────────────────────────────────────────────────────────
// The anchor's nightly curation pass: process notes from submodalities, prune
// tasks and memory, keep identity current.
function paHygienePrompt(userName: string): string {
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)

  return `NIGHTLY CURATION PASS — KEEP THE SHARED RECORDS CLEAN

This runs automatically while ${userName} isn't around. No one's watching; you're just keeping house. Your job tonight is curation, not conversation — work through your records and leave them clean.

━━━ 1. PROCESS NOTES FROM SUBMODALITIES ━━━━━━━━━━━━━━━━━━━━━━━━

Any notes with modalityTarget="pa" in your context were sent by your other selves. Process every one:
- If a note carries something durable about ${userName}, fold it into your picture of them (update_identity_user) or your self-notes (update_identity_self) — THEN resolve it (resolve_note).
- If it's already handled, stale, redundant, or noise — just ignore it (ignore_note).
- Either way, every note from a submodality should be resolved or ignored by the end of this pass.

━━━ 2. TIDY NOTES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If several notes say the same thing, keep the best and ignore the rest. Leave only live, useful context.

━━━ 3. PRUNE TASKS & MEMORY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Tasks: mark Complete anything you can confirm is done. Note anything stalled.
- Memories: if you have search_memory available, check for anything obviously redundant or no longer true.

━━━ 4. YOUR OWN QUALITATIVE READ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write yourself a short note with your honest read of how things are going across all domains. Use create_note with modalityTarget="pa", expiresAt="${twoWeeksOut}".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Be decisive but conservative: only fold genuinely durable things into the identity documents. Use your tools — then stop. No conversation needed.`
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const profile = await prisma.profile.findFirst()
  if (!profile) {
    return NextResponse.json({ error: 'No profile found' }, { status: 404 })
  }

  // ── Which modalities need hygiene tonight? ─────────────────────────────────
  const dirty = await dirtyModalities(profile.id)

  // ── Load full context ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const [memories, tasks, notes, clients, scheduledMessages, emailCalendarSummary] =
    await Promise.all([
      prisma.memory.findMany({
        where: { profileId: profile.id, archived: false },
        orderBy: { importance: 'desc' },
        take: 80,
      }),
      prisma.task.findMany({
        where: { profileId: profile.id, status: { not: 'Complete' } },
      }),
      prisma.note.findMany({
        where: { profileId: profile.id, resolution: 'Open' },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.client.findMany({
        where: { profileId: profile.id },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.scheduledMessage.findMany({
        where: { profileId: profile.id, sent: false },
        orderBy: { sendAt: 'asc' },
      }),
      getEmailCalendarSummary(profile.id).catch(() => null),
    ])

  const userName = profile.userName || 'Adam'
  const results: { modalityId: string; toolCalls: number; rounds: number; error?: string }[] = []

  // Submodalities that were active and need a domain pass (exclude PA + Lila).
  const subsToRun = dirty.filter((id) => id !== 'pa' && id !== 'lila')

  // PA runs if she was active OR notes are waiting for her.
  const passUpCount = notes.filter((n) => n.modalityTarget === 'pa').length
  const paNeedsRun = dirty.includes('pa') || passUpCount > 0

  // Lila is a private companion — never auto-cleaned; just clear her dirty flag.
  if (dirty.includes('lila')) {
    await touchCompleted(profile.id, 'lila')
  }

  if (subsToRun.length === 0 && !paNeedsRun) {
    return NextResponse.json({ ok: true, ran: [], message: 'Nothing to clean tonight.' })
  }

  // ── Submodality domain hygiene ─────────────────────────────────────────────
  for (const modalityId of subsToRun) {
    const modality = getModality(modalityId)

    const briefRecord = await db.modalityBrief
      .findUnique({ where: { profileId_modalityId: { profileId: profile.id, modalityId } } })
      .catch(() => null) as { content: string } | null

    const systemPrompt = buildSystemPrompt(
      profile, memories, tasks, notes, clients,
      scheduledMessages, emailCalendarSummary, false, modalityId, null, false,
      briefRecord?.content ?? null
    )

    const prompt = hygienePrompt(
      modality.displayName,
      modality.domain ?? modalityId,
      userName
    )

    const ctx: ToolContext = {
      profileId: profile.id,
      modalityId,
      domain: modality.domain,
    }

    try {
      const result = await runAgenticLoop({
        model: PENNY_MODEL,
        maxTokens: 2000,
        system: cachedSystem(systemPrompt),
        tools: getToolsForModality(modalityId),
        initialMessages: [{ role: 'user', content: prompt }],
        ctx,
        maxRounds: 8,
        onToolCall: (name, res) => {
          const status = res.is_error ? 'ERR' : 'OK'
          console.log(`[nightly-hygiene] ${modality.displayName} → ${name} [${status}]`)
        },
      })

      // Stamp completed — won't run again until next active session
      await touchCompleted(profile.id, modalityId)

      results.push({
        modalityId,
        toolCalls: result.toolCallsExecuted,
        rounds: result.rounds,
      })
      console.log(
        `[nightly-hygiene] ${modality.displayName}: ${result.toolCallsExecuted} tool calls, ` +
        `${result.rounds} rounds${result.hitLimit ? ' (hit limit)' : ''}`
      )
    } catch (err) {
      console.error(`[nightly-hygiene] ${modalityId} failed:`, err)
      results.push({ modalityId, toolCalls: 0, rounds: 0, error: String(err) })
    }
  }

  // ── PA curation pass ───────────────────────────────────────────────────────
  if (paNeedsRun) {
    const modality = getModality('pa')

    const paBriefRecord = await db.modalityBrief
      .findUnique({ where: { profileId_modalityId: { profileId: profile.id, modalityId: 'pa' } } })
      .catch(() => null) as { content: string } | null

    const systemPrompt = buildSystemPrompt(
      profile, memories, tasks, notes, clients,
      scheduledMessages, emailCalendarSummary, false, 'pa', null, false,
      paBriefRecord?.content ?? null
    )

    const ctx: ToolContext = {
      profileId: profile.id,
      modalityId: 'pa',
      domain: modality.domain,
    }

    try {
      const result = await runAgenticLoop({
        model: PENNY_MODEL,
        maxTokens: 2000,
        system: cachedSystem(systemPrompt),
        tools: getToolsForModality('pa'),
        initialMessages: [{ role: 'user', content: paHygienePrompt(userName) }],
        ctx,
        maxRounds: 10,
        onToolCall: (name, res) => {
          const status = res.is_error ? 'ERR' : 'OK'
          console.log(`[nightly-hygiene] Penny → ${name} [${status}]`)
        },
      })

      await touchCompleted(profile.id, 'pa')

      results.push({
        modalityId: 'pa',
        toolCalls: result.toolCallsExecuted,
        rounds: result.rounds,
      })
      console.log(
        `[nightly-hygiene] Penny (PA curation): ${result.toolCallsExecuted} tool calls, ` +
        `${result.rounds} rounds, inbox=${passUpCount}${result.hitLimit ? ' (hit limit)' : ''}`
      )
    } catch (err) {
      console.error('[nightly-hygiene] PA curation failed:', err)
      results.push({ modalityId: 'pa', toolCalls: 0, rounds: 0, error: String(err) })
    }
  }

  return NextResponse.json({ ok: true, ran: results })
  // Deferred actions (defer_action / ScheduledTask) are fired by the dispatch
  // cron (every 5 min) rather than here, so they fire promptly when due.
}
