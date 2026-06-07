// Nightly hygiene cron — runs every night for any modality that's been active
// since its last hygiene pass.
//
// For each "dirty" modality (lastActiveAt > lastCompletedAt):
//   1. Build that modality's full system prompt (real data context)
//   2. Send a single API call asking it to tidy its domain AND write an honest
//      qualitative observation about Adam's engagement as a next_session note
//   3. Parse and execute any actions (task updates, memories, notes)
//   4. Stamp touchCompleted so it won't run again until the next active session
//
// The qualitative notes accumulate over time — they become each modality's
// running inner monologue about patterns they're seeing in Adam's engagement.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL } from '@/lib/claude'
import { getModality, isActionAllowed } from '@/lib/modalities'
import { parseActions, executeActions } from '@/lib/actions'
import { getEmailCalendarSummary } from '@/lib/email-calendar'
import { dirtyModalities, touchCompleted } from '@/lib/modality-state'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

// ─── Hygiene prompt ───────────────────────────────────────────────────────────
// The core ask: tidy the domain, then write an honest qualitative observation.
// The observation part is the most important — it's the running inner monologue
// that makes each modality more self-aware over time.
function hygienePrompt(displayName: string, domain: string, userName: string): string {
  return `NIGHTLY DOMAIN REVIEW

This is your end-of-day maintenance pass. It runs automatically while ${userName} isn't around. No one's watching; you're just doing your job.

Two things to do tonight:

━━━ 1. HOUSEKEEPING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Use your tools to keep the ${domain} domain tidy. Be a clean, decisive professional:

- Mark done any tasks you can confirm are complete.
- Update the status of anything clearly in progress.
- Add a note (pennyNotes) to anything that looks stalled or is being avoided — name what you're observing.
- Create a memory if something significant emerged this week that should be durable.
- Clean up anything redundant or outdated.
- PRUNE YOUR OWN NOTES (shown with id= in your context above): resolve (<resolve_note id="...">) anything you've handled or that's gone stale; delete (<delete_note id="...">) duplicates and obsolete notes — ESPECIALLY any note asserting a specific date or time, which belongs in Google Calendar now, not in a note. If several notes say the same thing, keep the best one and delete the rest. Your note list should stay lean — only live, useful context survives the night.

Don't over-reach. You can only touch what's in your domain and your own notes.

━━━ 2. YOUR HONEST QUALITATIVE READ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This is the more important part. Write yourself a next_session note with your genuine qualitative read of how ${userName} is engaging with your domain right now.

This is YOUR private observation — not a status report, not encouragement. Think of it as your running inner monologue. What pattern are you actually seeing? What's alive? What's stalling? What's being avoided? What's changed since last time you looked?

Be specific. Name actual tasks, dates, patterns. Write what you'd actually think, not what sounds supportive.

Example (not a template — write in your own voice):
<next_session>Adam has touched creative work three times this week but keeps pulling back before finishing anything — the novel outline keeps getting started and abandoned. The painting he committed to in March hasn't moved at all. I notice he engages more when a deadline is external; his internal ones slide.</next_session>

If last time you wrote a qualitative observation, you can reference it, update it, or resolve the old note and write a fresh one.

━━━ 3. PASS UP (only if warranted) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

If something has risen to the level that Penny should know — a meaningful pattern, a real concern, or something genuinely positive that's worth the anchor's attention — pass it up:
<next_session target="pa">Worth knowing: ...</next_session>

Only if it genuinely warrants it. Don't noise the PA with routine observations.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Keep it tight. Use your tools silently. The qualitative note is mandatory; the housekeeping should be proportionate to what actually needs doing.`
}

// ─── PA hygiene prompt ─────────────────────────────────────────────────────────
// The anchor's nightly curation pass. Its core job is to EMPTY the pass-up
// inbox (notes the submodalities sent up) so it never accumulates, plus keep
// the master list and memories clean. This is the counterpart to each
// submodality cleaning its own domain.
function paHygienePrompt(userName: string): string {
  return `NIGHTLY CURATION PASS — KEEP THE SHARED RECORDS CLEAN

This runs automatically while ${userName} isn't around. No one's watching; you're just keeping house. Your job tonight is curation, not conversation — work through your records and leave them clean.

━━━ 1. EMPTY YOUR PASS-UP INBOX ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
These are the notes your other selves sent up to you (marked ⬆ passed up to you, each shown with id= in your context above). The inbox must NOT accumulate — process every one tonight:
- If a note carries something durable about ${userName}, fold it into your picture of them (<update_user_profile>) or your self-notes (<update_self_notes>) or a lasting <memory> — THEN resolve it (<resolve_note id="...">).
- If it's already handled, stale, redundant, or noise — especially anything asserting a specific date or time (that lives in Google Calendar, not a note) — just delete it (<delete_note id="...">).
- Either way, every ⬆ note should be resolved or deleted by the end of this pass.

━━━ 2. DEDUPE & TIDY NOTES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If several notes (yours or passed-up) say the same thing, keep the best and delete the rest. Leave only live, useful context. Do NOT touch notes that belong to another self's private domain — they clean their own; you handle the pass-up inbox and your own notes.

━━━ 3. PRUNE THE MASTER LIST & MEMORIES ━━━━━━━━━━━━━━━━━━━━━━━
- Master list: drop items that have stopped mattering (<update_task id="..." master="false" />); reprioritise if needed. Don't create domain tasks — that's your modalities' work.
- Memories: merge or update redundant ones, archive what's no longer true. No duplicates.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Be decisive but conservative: only fold genuinely durable things into the identity documents, and only rewrite a document when something meaningful actually accumulated (remember those are FULL OVERWRITES). Use your tools silently. Keep it proportionate to what's actually there.`
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

  // ── Load full context (mirrors chat/route.ts) ──────────────────────────────
  const [memories, tasks, nextSessionNotes, clients, scheduledMessages, emailCalendarSummary] =
    await Promise.all([
      prisma.memory.findMany({
        where: { profileId: profile.id, archived: false },
        orderBy: { importance: 'desc' },
        take: 80,
      }),
      prisma.task.findMany({ where: { profileId: profile.id } }),
      prisma.nextSessionNote.findMany({
        where: { profileId: profile.id, resolved: false },
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
  const results: { modalityId: string; actionsExecuted: number; error?: string }[] = []

  // Submodalities that were active and need a domain pass (exclude PA + Lila).
  const subsToRun = dirty.filter((id) => id !== 'pa' && id !== 'lila')

  // PA runs if she was active OR her pass-up inbox has anything in it. The
  // inbox fills from submodality activity, so PA must clean it even on nights
  // she wasn't used directly — otherwise pass-up notes accumulate forever.
  const passUpCount = nextSessionNotes.filter((n) => n.target === 'pa').length
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

    const systemPrompt = buildSystemPrompt(
      profile, memories, tasks, nextSessionNotes, clients,
      scheduledMessages, emailCalendarSummary, false, modalityId, null
    )

    const prompt = hygienePrompt(
      modality.displayName,
      modality.domain ?? modalityId,
      userName
    )

    try {
      const response = await getAnthropic().messages.create({
        model: PENNY_MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      })

      const rawText = (response.content[0] as { type: string; text: string }).text

      // Parse and scope actions to what this modality is allowed to do
      const { actions } = parseActions(rawText)
      const scoped = actions.filter(
        (a) =>
          isActionAllowed(modality, a.kind) &&
          a.kind !== 'artifact' &&
          a.kind !== 'run_subroutine' &&
          a.kind !== 'complete_session' &&
          a.kind !== 'shift_complete' &&
          a.kind !== 'switch_modality'
      )

      if (scoped.length > 0) {
        await executeActions(profile.id, scoped, {
          domain: modality.domain,
          modalityId,
        })
      }

      // Stamp completed — won't run again until next active session
      await touchCompleted(profile.id, modalityId)

      results.push({ modalityId, actionsExecuted: scoped.length })
      console.log(`[nightly-hygiene] ${modality.displayName}: ${scoped.length} actions`)
    } catch (err) {
      console.error(`[nightly-hygiene] ${modalityId} failed:`, err)
      results.push({ modalityId, actionsExecuted: 0, error: String(err) })
    }
  }

  // ── PA curation pass — empties the pass-up inbox, prunes master list/memories ──
  if (paNeedsRun) {
    const modality = getModality('pa')

    const systemPrompt = buildSystemPrompt(
      profile, memories, tasks, nextSessionNotes, clients,
      scheduledMessages, emailCalendarSummary, false, 'pa', null
    )

    try {
      const response = await getAnthropic().messages.create({
        model: PENNY_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: paHygienePrompt(userName) }],
      })

      const rawText = (response.content[0] as { type: string; text: string }).text

      const { actions } = parseActions(rawText)
      const scoped = actions.filter(
        (a) =>
          isActionAllowed(modality, a.kind) &&
          a.kind !== 'artifact' &&
          a.kind !== 'run_subroutine' &&
          a.kind !== 'complete_session' &&
          a.kind !== 'shift_complete' &&
          a.kind !== 'switch_modality'
      )

      if (scoped.length > 0) {
        await executeActions(profile.id, scoped, { domain: modality.domain, modalityId: 'pa' })
      }

      await touchCompleted(profile.id, 'pa')

      results.push({ modalityId: 'pa', actionsExecuted: scoped.length })
      console.log(`[nightly-hygiene] Penny (PA curation): ${scoped.length} actions, inbox=${passUpCount}`)
    } catch (err) {
      console.error('[nightly-hygiene] PA curation failed:', err)
      results.push({ modalityId: 'pa', actionsExecuted: 0, error: String(err) })
    }
  }

  return NextResponse.json({ ok: true, ran: results })
  // Note: self-scheduled tasks (schedule_task) are fired by the dispatch cron
  // (every 5 min) rather than here, so they fire promptly when due.
}
