// Stage-3 cutover: migrate ACTIVE Task / Note / Routine rows into the Item world,
// normalizing modality labels on the way (see items/cutover.ts). NON-DESTRUCTIVE —
// the old tables are left intact as a backup. Idempotent — a row already migrated
// (matched by sourceRef) is skipped, so re-running is safe.
//
//   GET  /api/admin/cutover?secret=$CRON_SECRET   → dry-run preview (writes nothing)
//   POST /api/admin/cutover?secret=$CRON_SECRET   → apply
//
// Protected by CRON_SECRET (Authorization: Bearer, or ?secret=).

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { createItem, itemExistsBySourceRef } from '@/lib/items/item-store'
import { taskToItem, noteToItem, routineToItem, canonLabel, type Mapped } from '@/lib/items/cutover'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.headers.get('authorization')?.replace('Bearer ', '')
  const query = new URL(req.url).searchParams.get('secret')
  return header === secret || query === secret
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

async function runCutover(dry: boolean) {
  const profile = await prisma.profile.findFirst()
  if (!profile) return { error: 'no profile' }
  const pid = profile.id

  // ACTIVE only: incomplete + un-archived tasks; open notes; all routines.
  const tasks = await db.task.findMany({ where: { profileId: pid, archivedAt: null, NOT: { status: 'Complete' } } })
  const notes = await db.note.findMany({ where: { profileId: pid, resolution: 'Open' } })
  const routines = await db.routine.findMany({ where: { profileId: pid } })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: { kind: 'task' | 'note' | 'routine'; raw: any; m: Mapped }[] = [
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...tasks.map((t: any) => ({ kind: 'task' as const, raw: t, m: taskToItem(t) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...notes.map((n: any) => ({ kind: 'note' as const, raw: n, m: noteToItem(n) })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...routines.map((r: any) => ({ kind: 'routine' as const, raw: r, m: routineToItem(r) })),
  ]

  const summary = {
    task: { migrated: 0, skipped: 0 },
    note: { migrated: 0, skipped: 0 },
    routine: { migrated: 0, skipped: 0 },
  }
  const samples: unknown[] = []
  const relabeled: { from: string; to: string; name: string }[] = []

  for (const { kind, raw, m } of rows) {
    if (await itemExistsBySourceRef(pid, m.sourceRef)) {
      summary[kind].skipped++
      continue
    }
    // Surface any label that got normalized (the drift fix).
    const origLabel = kind === 'note' ? raw.modalityTarget : raw.assignedModality
    if (origLabel && canonLabel(origLabel) !== origLabel) {
      relabeled.push({ from: origLabel, to: canonLabel(origLabel), name: m.input.name })
    }
    if (samples.length < 15) {
      samples.push({ kind, name: m.input.name, target: m.input.target, status: m.input.paStatus ?? m.input.modalityStatus, type: m.input.type })
    }
    if (!dry) await createItem(pid, m.input)
    summary[kind].migrated++
  }

  return {
    dry,
    totals: { tasks: tasks.length, notes: notes.length, routines: routines.length },
    summary,
    relabeled,
    samples,
  }
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(await runCutover(true))
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(await runCutover(false))
}
