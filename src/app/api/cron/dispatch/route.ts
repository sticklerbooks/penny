// Cron endpoint — called every 5 minutes by an external scheduler (e.g. cron-job.org)
// Finds scheduled messages due to be sent and fires them via Pushover.
// Protected by CRON_SECRET query param or header.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendNotification } from '@/lib/pushover'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Verify secret (accepts either query param or header)
  const secret = req.nextUrl.searchParams.get('secret') ?? req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  console.log(`[dispatch] Running at ${now.toISOString()}`)

  // Find all unsent messages that are due
  const due = await prisma.scheduledMessage.findMany({
    where: { sent: false, sendAt: { lte: now } },
    orderBy: { sendAt: 'asc' },
  })

  console.log(`[dispatch] Found ${due.length} message(s) due`)

  if (due.length === 0) {
    return NextResponse.json({ sent: 0, checked: now.toISOString() })
  }

  // Send one at a time (avoids any Pushover rate limiting)
  let succeeded = 0
  const errors: string[] = []

  for (const msg of due) {
    try {
      console.log(`[dispatch] Sending id=${msg.id} label="${msg.label ?? ''}" scheduledFor=${msg.sendAt.toISOString()}`)
      await sendNotification(msg.message)
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: { sent: true, sentAt: new Date() },
      })
      console.log(`[dispatch] ✓ Sent id=${msg.id}`)
      succeeded++
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      console.error(`[dispatch] ✗ Failed id=${msg.id}: ${err}`)
      errors.push(`id=${msg.id}: ${err}`)
    }
  }

  return NextResponse.json({
    sent: succeeded,
    failed: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    checked: now.toISOString(),
  })
}

// Also support GET for easy manual testing
export async function GET(req: NextRequest) {
  return POST(req)
}
