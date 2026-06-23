// POST /api/dashboard/action
//
// The principal speaks to a single item. No LLM in the loop — this is the whole
// point: marking a task done must be a deterministic DB write, not a thing Adam
// has to convince a modality of in chat (and pay Sonnet for) four times over.
//
// Body: { itemType, itemId, kind, body?, newDueDate? }
//   Class A (self-executing): done, moved, scheduled — mutate the item + log why.
//   Class B (flag for her):   stale, blocked, note    — log only; she reconciles.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { invalidateContext } from '@/lib/context-cache'
import { CLASS_A, CLASS_B, type ItemType, type ItemKind } from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

const VALID_TYPES: ItemType[] = ['task', 'event', 'project']

export async function POST(req: NextRequest) {
  const { itemType, itemId, kind, body, newDueDate } = await req.json() as {
    itemType: ItemType; itemId: string; kind: ItemKind; body?: string; newDueDate?: string
  }

  if (!VALID_TYPES.includes(itemType) || !itemId || !kind) {
    return NextResponse.json({ error: 'itemType, itemId, and kind are required' }, { status: 400 })
  }
  if (![...CLASS_A, ...CLASS_B].includes(kind)) {
    return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 })
  }
  if ((kind === 'blocked' || kind === 'note') && !body?.trim()) {
    return NextResponse.json({ error: `${kind} requires an explanation` }, { status: 400 })
  }
  if (kind === 'moved' && !newDueDate) {
    return NextResponse.json({ error: 'moved requires a new date' }, { status: 400 })
  }

  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ error: 'no profile' }, { status: 404 })

  const now = new Date()
  const due = newDueDate ? new Date(newDueDate + 'T12:00:00') : null

  // ── Class A: mutate the item directly. ──────────────────────────────────────
  if (kind === 'done') {
    if (itemType === 'task') {
      await prisma.task.update({ where: { id: itemId }, data: { status: 'Complete', completedAt: now } })
    } else if (itemType === 'event') {
      await prisma.pendingCalendarEvent.update({ where: { id: itemId }, data: { completedAt: now } })
    } else {
      await prisma.project.update({ where: { id: itemId }, data: { progress: 10 } })
    }
  } else if (kind === 'moved' && due) {
    if (itemType === 'task') {
      await prisma.task.update({ where: { id: itemId }, data: { dueDate: due } })
    } else if (itemType === 'event') {
      await prisma.pendingCalendarEvent.update({ where: { id: itemId }, data: { date: newDueDate! } })
    }
    // projects have no due date — the note carries the intent.
  } else if (kind === 'scheduled' && itemType === 'event') {
    await prisma.pendingCalendarEvent.update({ where: { id: itemId }, data: { scheduled: true, scheduledAt: now } })
  }

  // ── Record the ItemNote (audit trail for Class A, the request for Class B). ──
  const noteBody = kind === 'moved' && newDueDate
    ? `Moved to ${newDueDate}${body?.trim() ? ` — ${body.trim()}` : ''}`
    : body?.trim() || null

  // Class A is a done deal — born acknowledged (pure audit, never nags her).
  // Class B is a live request — unacknowledged until she reads and acts on it.
  const isClassA = CLASS_A.includes(kind)
  await prisma.itemNote.create({
    data: {
      profileId: profile.id, itemType, itemId, kind, body: noteBody,
      acknowledged: isClassA, acknowledgedAt: isClassA ? now : null,
    },
  })

  invalidateContext(profile.id)
  return NextResponse.json({ ok: true })
}
