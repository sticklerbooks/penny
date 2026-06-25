// POST /api/chat/end
//
// Script-driven session close, triggered by the "End Chat" button. Closing a
// conversation happens continuously throughout the day already (every modality
// switch closes the previous one) — this route is the ONE deliberate trigger
// for something heavier: every modality that talked since her last memory pass
// gets one batched pass over her transcript (deep memory / log / identity /
// brief — see src/lib/memory-pass.ts and the 'memory' protocol). Switching
// modalities mid-day does NOT run this; only this button does.
//
// The Item tools are correct by construction (search-first creation, append_note
// instead of a new item), so there's no duplicate/stale Item cleanup left to do —
// just the memory pass.
//
// The memory-pass fan-out runs in `after()`, NOT before the response: it can be
// several full-transcript Anthropic calls (one per modality that talked), and
// the button shouldn't sit there for however long that takes. The user lands on
// the dashboard immediately; the passes finish in the background. A backlog too
// big for one pass is chunked across runs (see memory-pass.ts) rather than
// dropped, so there's no "did it actually finish" UI to build here — the next
// time this runs, it just continues.

import { NextRequest, NextResponse, after } from 'next/server'
import { prisma } from '@/lib/db'
import { runMemoryPass, modalitiesPendingMemoryPass } from '@/lib/memory-pass'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const { conversationId } = await req.json().catch(() => ({})) as { conversationId?: string }
  if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } })
  if (!convo) return NextResponse.json({ error: 'conversation not found' }, { status: 404 })

  // Lightweight session summary: items touched since this conversation opened.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const touched = await (prisma as any).item.count({
    where: { profileId: convo.profileId, updatedAt: { gte: convo.createdAt } },
  })

  if (!convo.closed) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { closed: true } })
  }

  const profileId = convo.profileId
  after(async () => {
    // Every modality that talked since her last pass — not just this
    // conversation's — gets processed now. One at a time: each is a real
    // Anthropic call over a transcript, and isolating failures per modality
    // matters more than speed.
    const pending = await modalitiesPendingMemoryPass(profileId)
    for (const modalityId of pending) {
      try {
        await runMemoryPass(profileId, modalityId)
      } catch (e) {
        console.error(`[chat/end] memory pass failed for ${modalityId}:`, e)
      }
    }
  })

  return NextResponse.json({ ok: true, touched })
}
