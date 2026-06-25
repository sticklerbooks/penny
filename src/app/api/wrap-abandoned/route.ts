// POST /api/wrap-abandoned
//
// Fired (fire-and-forget) when Adam opens the dashboard. If he left a session
// mid-stream — an unclosed conversation whose last message is stale — it's closed
// deterministically. A quick reload of an *active* session (recent last message)
// is left untouched, and this NEVER blocks the dashboard from loading.
//
// Used to run a prose LLM hygiene pass first (capture/remember/cleanup/brief) —
// retired along with the rest of the close-sweep system. The Item tools are
// correct by construction (search-first creation, append_note instead of a new
// item), so there's nothing left to comb the transcript for.

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

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

  await prisma.conversation.update({ where: { id: convo.id }, data: { closed: true } })
  return NextResponse.json({ wrapped: true, modality: convo.activeModality || 'pa' })
}
