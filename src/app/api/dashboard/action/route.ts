// POST /api/dashboard/action
//
// The principal speaks to a single item. No LLM in the loop — this is the whole
// point: marking a task done must be a deterministic DB write, not a thing Adam
// has to convince a modality of in chat (and pay Sonnet for) four times over.
//
// Body: { itemType, itemId, kind, body?, newDueDate? }
//   Class A (self-executing): done, moved, scheduled — mutate the item via the
//     same FSM-gated item-store Review uses, so the change is automatically
//     visible the next time this item comes up in a Review.
//   Class B (flag for her):   stale, contingent, note — appended to the item's
//     notes log (append_note); contingent also flips modalityStatus → 'contingent' so
//     it surfaces in her next notes-read queue with no extra wiring.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { invalidateContext } from '@/lib/context-cache'
import { setItemStatus, updateItemFields, appendItemNote } from '@/lib/items/item-store'
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
  if ((kind === 'contingent' || kind === 'note') && !body?.trim()) {
    return NextResponse.json({ error: `${kind} requires an explanation` }, { status: 400 })
  }
  if (kind === 'moved' && !newDueDate) {
    return NextResponse.json({ error: 'moved requires a new date' }, { status: 400 })
  }

  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ error: 'no profile' }, { status: 404 })

  const now = new Date()
  const due = newDueDate ? new Date(newDueDate + 'T12:00:00') : null

  if (itemType === 'project') {
    // Project stays its own model (untouched by the Item migration).
    if (kind === 'done') {
      await prisma.project.update({ where: { id: itemId }, data: { progress: 10 } })
    } else if (kind === 'stale' || kind === 'contingent' || kind === 'note') {
      const stamp = now.toISOString().slice(0, 10)
      const p = await prisma.project.findUnique({ where: { id: itemId } })
      const line = `[${stamp}] Adam: ${kind}${body?.trim() ? ` — ${body.trim()}` : ''}`
      await prisma.project.update({
        where: { id: itemId },
        data: { description: p?.description ? `${p.description}\n${line}` : line },
      })
    }
  } else {
    // Task/event are both just Items now.
    const item = await prisma.item.findUnique({ where: { id: itemId } })
    if (!item) return NextResponse.json({ error: `item ${itemId} not found` }, { status: 404 })
    const side: 'pa' | 'modality' = item.target === 'pa' ? 'pa' : 'modality'

    if (kind === 'done') {
      const res = await setItemStatus(itemId, side, 'completed')
      if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 400 })
    } else if (kind === 'moved' && due) {
      await updateItemFields(itemId, { dueDate: due })
    } else if (kind === 'scheduled') {
      const res = await setItemStatus(itemId, 'pa', 'scheduled')
      if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 400 })
    } else if (kind === 'stale' || kind === 'contingent' || kind === 'note') {
      await appendItemNote(itemId, `Adam: ${kind}${body?.trim() ? ` — ${body.trim()}` : ''}`)
      if (kind === 'contingent') await setItemStatus(itemId, side, 'contingent')
    }
  }

  invalidateContext(profile.id)
  return NextResponse.json({ ok: true })
}
