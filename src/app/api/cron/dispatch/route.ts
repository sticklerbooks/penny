// Dispatch cron — called every 5 minutes by an external scheduler.
//
// Does two things:
//   1. Fires any ScheduledMessage rows that are due (pre-written Pushover notifications).
//   2. Fires any ScheduledTask rows that are due — builds Penny's full current context,
//      asks her to compose a fresh message based on what's actually happened, and sends it.
//      This is the "Penny woke up and thought about it" path.
//
// Protected by CRON_SECRET (Authorization header or ?secret= query param).

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendNotification } from '@/lib/pushover'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL } from '@/lib/claude'
import { getEmailCalendarSummary } from '@/lib/email-calendar'
import { searchItems } from '@/lib/items/item-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const headerSecret = req.headers.get('authorization')?.replace('Bearer ', '')
  const querySecret  = req.nextUrl.searchParams.get('secret')
  return headerSecret === secret || querySecret === secret
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  // ── 1. Pre-written scheduled messages (schedule_sms) ──────────────────────
  const dueMessages = await prisma.scheduledMessage.findMany({
    where: { sent: false, sendAt: { lte: now } },
    orderBy: { sendAt: 'asc' },
  })

  let messagesSent = 0
  const messageErrors: string[] = []

  for (const msg of dueMessages) {
    try {
      await sendNotification(msg.message)
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: { sent: true, sentAt: new Date() },
      })
      messagesSent++
    } catch (e) {
      messageErrors.push(`id=${msg.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ── 2. Self-scheduled check-ins (schedule_task) ────────────────────────────
  // These require a fresh LLM call — load context only if there's something due.
  const dueTasks = await db.scheduledTask.findMany({
    where: { ran: false, runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
  }).catch(() => [])

  let tasksFired = 0
  const taskErrors: string[] = []

  if (dueTasks.length > 0) {
    // Load profile + full context (same as chat route)
    const profile = await prisma.profile.findFirst()
    if (profile) {
      const [items, clients, scheduledMessages, emailCalendarSummary] =
        await Promise.all([
          searchItems(profile.id, { visibleOnly: true }),
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

      const pennyPrompt = buildSystemPrompt(
        profile, items, clients,
        scheduledMessages, emailCalendarSummary, false, 'pa', null
      )

      const userName = profile.userName || 'Adam'

      for (const task of dueTasks) {
        try {
          const response = await getAnthropic().messages.create({
            model: PENNY_MODEL,
            max_tokens: 400,
            system: pennyPrompt,
            messages: [{
              role: 'user',
              content: `You scheduled a check-in for right now. Here's what you wrote to your future self:\n\n"${task.topic}"\n\nGiven your full current context, compose a brief honest Pushover notification to ${userName} about this. Don't be cheerful unless there's real reason to be. If nothing notable has happened, say so plainly.\n\nWrite only the message text — no quotes, no preamble.`,
            }],
          })

          const body = (response.content[0] as { type: string; text: string }).text.trim()
          // Prefix marks this as a live Penny check-in (vs. a pre-written reminder)
          const message = `[Penny checked in] ${body}`

          await sendNotification(message)
          await db.scheduledTask.update({
            where: { id: task.id },
            data: { ran: true, ranAt: new Date() },
          })
          tasksFired++
          console.log(`[dispatch] Fired scheduled task ${task.id}`)
        } catch (e) {
          taskErrors.push(`id=${task.id}: ${e instanceof Error ? e.message : String(e)}`)
          console.error(`[dispatch] Scheduled task ${task.id} failed:`, e)
        }
      }
    }
  }

  return NextResponse.json({
    checked: now.toISOString(),
    messagesSent,
    messageErrors: messageErrors.length ? messageErrors : undefined,
    tasksFired,
    taskErrors: taskErrors.length ? taskErrors : undefined,
  })
}

// GET for easy manual testing / healthcheck
export async function GET(req: NextRequest) {
  return POST(req)
}
