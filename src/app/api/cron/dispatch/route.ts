// Cron endpoint — called every 5 minutes by an external scheduler (e.g. cron-job.org)
// Finds scheduled messages due to be sent and fires them via Twilio SMS.
// Protected by CRON_SECRET header to prevent unauthorized triggering.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendSMS } from '@/lib/twilio'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // Verify secret (accepts either query param or header)
  const secret = req.nextUrl.searchParams.get('secret') ?? req.headers.get('x-cron-secret')
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()

  // Find all unsent messages that are due
  const due = await prisma.scheduledMessage.findMany({
    where: {
      sent: false,
      sendAt: { lte: now },
    },
    include: { profile: true },
  })

  if (due.length === 0) {
    return NextResponse.json({ sent: 0 })
  }

  const results = await Promise.allSettled(
    due.map(async (msg) => {
      await sendSMS(msg.message)
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: { sent: true, sentAt: new Date() },
      })
      return msg.id
    })
  )

  const succeeded = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.filter((r) => r.status === 'rejected').length

  if (failed > 0) {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason?.message || String(r.reason))
    console.error('Failed to send scheduled messages:', errors)
  }

  return NextResponse.json({ sent: succeeded, failed })
}

// Also support GET for easy testing from a browser
export async function GET(req: NextRequest) {
  return POST(req)
}
