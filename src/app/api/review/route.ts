// Review Session endpoint (behind the same password gate as /api/chat).
//
//   POST { action: 'start', kind?, modalityId? }  → create/resume a review
//   POST { action: 'step',  messages: [...] }      → run one phase turn; returns
//                                                     { text, chips, phase, advanced, done }
//   POST { action: 'abandon' }                      → drop the active review
//   GET                                             → the active review, if any
//
// Non-streaming for now; the streaming + chip UI wiring is the next slice.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startOrResumeReview, abandonReview, activeReview } from '@/lib/review/session'
import { runReviewStep, type ChatMsg } from '@/lib/review/runner'
import type { ReviewKind } from '@/lib/review/phases'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET() {
  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ active: null })
  const s = await activeReview(profile.id)
  return NextResponse.json({
    active: s ? { id: s.id, kind: s.kind, modalityId: s.modalityId, phase: s.phase } : null,
  })
}

export async function POST(req: NextRequest) {
  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ error: 'no profile' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const action = body.action as string

  if (action === 'start') {
    const kind: ReviewKind = body.kind === 'submodality' ? 'submodality' : 'pa'
    const modalityId = typeof body.modalityId === 'string' && body.modalityId ? body.modalityId : 'pa'
    const { session, resumed } = await startOrResumeReview(profile.id, kind, modalityId)
    return NextResponse.json({
      session: { id: session.id, kind: session.kind, modalityId: session.modalityId, phase: session.phase, status: session.status },
      resumed,
    })
  }

  if (action === 'step') {
    const active = await activeReview(profile.id)
    if (!active) return NextResponse.json({ error: 'no active review' }, { status: 400 })
    const messages: ChatMsg[] = Array.isArray(body.messages)
      ? body.messages.filter((m: ChatMsg) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : []
    const result = await runReviewStep(profile.id, messages)
    return NextResponse.json(result)
  }

  if (action === 'abandon') {
    const s = await activeReview(profile.id)
    if (s) await abandonReview(s.id)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
