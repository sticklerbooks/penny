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
import { sendNotification } from '@/lib/pushover'

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

Don't over-reach. You can only touch what's in your domain.

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
  if (dirty.length === 0) {
    return NextResponse.json({ ok: true, ran: [], message: 'Nothing dirty tonight.' })
  }

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

  // ── Hygiene pass per dirty modality ───────────────────────────────────────
  for (const modalityId of dirty) {
    // PA runs the weekly synthesis — skip nightly hygiene for PA and Lila
    if (modalityId === 'pa' || modalityId === 'lila') {
      await touchCompleted(profile.id, modalityId)
      continue
    }

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

  // ── Fire any self-scheduled check-ins that are due ────────────────────────
  // These are tasks Penny scheduled for herself during conversations.
  // She gets full current context and writes the notification fresh at fire time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const dueTasks = await db.scheduledTask.findMany({
    where: { profileId: profile.id, ran: false, runAt: { lte: new Date() } },
    orderBy: { runAt: 'asc' },
  }).catch(() => [])

  const firedTasks: { id: string; sent: boolean }[] = []

  for (const task of dueTasks) {
    try {
      const pennyPrompt = buildSystemPrompt(
        profile, memories, tasks, nextSessionNotes, clients,
        scheduledMessages, emailCalendarSummary, false, 'pa', null
      )

      const response = await getAnthropic().messages.create({
        model: PENNY_MODEL,
        max_tokens: 400,
        system: pennyPrompt,
        messages: [{
          role: 'user',
          content: `You scheduled a check-in for right now. Here's what you wrote to your future self when you set it up:\n\n"${task.topic}"\n\nGiven your full current context, compose a brief honest Pushover notification to ${userName} about this. Don't be cheerful unless there's real reason to be. If nothing of note has happened, say so plainly. Write only the message text — no quotes, no preamble, just the message.`,
        }],
      })

      const message = (response.content[0] as { type: string; text: string }).text.trim()
      await sendNotification(message)
      await db.scheduledTask.update({
        where: { id: task.id },
        data: { ran: true, ranAt: new Date() },
      })
      firedTasks.push({ id: task.id, sent: true })
      console.log(`[nightly-hygiene] Fired scheduled task ${task.id}`)
    } catch (err) {
      console.error(`[nightly-hygiene] Scheduled task ${task.id} failed:`, err)
      firedTasks.push({ id: task.id, sent: false })
    }
  }

  return NextResponse.json({ ok: true, ran: results, firedTasks })
}
