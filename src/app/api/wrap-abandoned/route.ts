// POST /api/wrap-abandoned
//
// Fired (fire-and-forget) when Adam opens the dashboard. If he left a session
// mid-stream — an unclosed conversation whose last message is stale — the owning
// self runs its close-out sweep in the background, then the conversation is
// closed. A quick reload of an *active* session (recent last message) is left
// untouched, and this NEVER blocks the dashboard from loading.

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { runCloseSweep } from '@/lib/close-sweep'

export const dynamic = 'force-dynamic'

// How long since the last message before a still-open session counts as abandoned.
const ABANDON_MS = 30 * 60 * 1000

export async function POST() {
  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ wrapped: false })

  const convo = await prisma.conversation.findFirst({
    where: { profileId: profile.id, closed: false },
    orderBy: { createdAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  })

  if (!convo || convo.messages.length === 0) {
    return NextResponse.json({ wrapped: false })
  }

  const last = convo.messages[convo.messages.length - 1]
  const ageMs = Date.now() - new Date(last.createdAt).getTime()
  if (ageMs < ABANDON_MS) {
    // Still warm — Adam may just be reloading. Leave it open.
    return NextResponse.json({ wrapped: false, reason: 'active' })
  }

  const modalityId = convo.activeModality || 'pa'

  try {
    await runCloseSweep({
      profileId: profile.id,
      modalityId,
      messages: convo.messages.map((m) => ({ role: m.role, content: m.content })),
    })
  } catch (err) {
    console.error('[wrap-abandoned] sweep failed:', err)
    // Still close it — a failed hygiene pass shouldn't leave the session dangling.
  }

  await prisma.conversation.update({ where: { id: convo.id }, data: { closed: true } })
  return NextResponse.json({ wrapped: true, modality: modalityId })
}
