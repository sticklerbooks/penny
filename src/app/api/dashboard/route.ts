// GET /api/dashboard?modality=<id>
//
// The principal's read view of one modality's world: active items and projects.
// No LLM — pure Prisma/Item reads, so it costs nothing to open and refresh.
// Mirrors the chat lens (target === id; PA sees everything) so the dashboard
// shows exactly what she's holding. Items unify what used to be split across
// Task/PendingCalendarEvent; the wire shape below (`type: 'task' | 'event'`) is
// kept as-is so the existing UI needs no changes — an Item of type 'event' maps
// to 'event', everything else maps to 'task'.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getModality } from '@/lib/modalities'
import { searchItems } from '@/lib/items/item-store'
import {
  todayInTz, addDays, dateOnly, bucketFor, type Bucket, type ItemType,
} from '@/lib/dashboard'

export const dynamic = 'force-dynamic'

interface DashItem {
  id: string
  type: ItemType
  title: string
  description: string
  date: string | null        // YYYY-MM-DD, or null
  dateRaw: string | null     // ISO datetime for display, when there's a due date
  dueTime: string | null
  bucket: Bucket
  overdue: boolean
  status: string | null
  priority: number | null
  projectId: string | null
  notes: NoteLite[]
  unacked: number
}

interface NoteLite {
  id: string
  kind: string
  body: string | null
  createdAt: string
  acknowledged: boolean
}

export async function GET(req: NextRequest) {
  const modalityId = req.nextUrl.searchParams.get('modality') || 'pa'
  const modality = getModality(modalityId)
  const isPA = modality.domain === null

  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ error: 'no profile' }, { status: 404 })

  const mineProject = isPA ? {} : { assignedModality: modalityId }

  const [allItems, allProjects] = await Promise.all([
    // Unfiltered by stage — we need DONE/cancelled children too, to compute a
    // goal-kind project's progress live (see projectProgress below).
    searchItems(profile.id, { visibleOnly: true, target: isPA ? undefined : modalityId }),
    prisma.project.findMany({
      where: { profileId: profile.id, visibility: true, ...mineProject },
      orderBy: { updatedAt: 'desc' },
    }),
  ])

  const isActive = (i: { stage: string | null }) => i.stage !== 'done' && i.stage !== 'cancelled'
  const items = allItems.filter(isActive)

  // A goal-kind project's progress is computed live from its children — never
  // hand-set, so it can't drift the way the old manual 0–10 number did. An
  // ongoing-kind project has no end-state, so it keeps whatever manual value
  // (if any) a modality chose to track activity with, and is never hidden by it.
  const projectProgress = (projectId: string): number => {
    const children = allItems.filter((i) => i.projectId === projectId && i.stage !== 'cancelled')
    if (children.length === 0) return 0
    const done = children.filter((i) => i.stage === 'done').length
    return Math.round((done / children.length) * 10)
  }
  const projects = allProjects.filter((p) => p.kind === 'ongoing' || projectProgress(p.id) < 10)

  const today = todayInTz()
  const weekEnd = addDays(today, 6)

  // An item's accumulated free-write log, shown as a single block — Item.notes
  // replaced the separate ItemNote flag system (see CLAUDE.md / Stage B notes).
  const notesFor = (notes: string): { notes: NoteLite[]; unacked: number } =>
    notes
      ? { notes: [{ id: 'log', kind: 'notes', body: notes, createdAt: new Date().toISOString(), acknowledged: true }], unacked: 0 }
      : { notes: [], unacked: 0 }

  const dashItems: DashItem[] = items.map((i) => {
    const date = dateOnly(i.dueDate)
    const bucket = bucketFor(date, today, weekEnd)
    return {
      id: i.id, type: i.type === 'event' ? 'event' : 'task',
      title: i.name, description: i.description,
      date, dateRaw: i.dueDate ? new Date(i.dueDate).toISOString() : null, dueTime: i.dayTime,
      bucket, overdue: bucket === 'overdue',
      status: i.stage, priority: i.priority, projectId: i.projectId,
      ...notesFor(i.notes),
    }
  })

  // Projects are containers, not time-bucketed — returned as their own band.
  const projectItems = projects.map((p) => ({
    id: p.id, type: 'project' as const, title: p.name, description: p.description,
    kind: p.kind, progress: p.kind === 'ongoing' ? p.progress : projectProgress(p.id),
    expectedDuration: p.expectedDuration, contingencies: p.contingencies,
    priority: null as number | null,
    ...notesFor(''),
  }))

  // Agenda = all items, grouped by bucket, each group date-ascending then by
  // priority. Undated sinks to the bottom (handled by BUCKET_ORDER in the UI).
  const agenda = dashItems.sort((a, b) => {
    const ad = a.date ?? '9999-12-31'
    const bd = b.date ?? '9999-12-31'
    if (ad !== bd) return ad < bd ? -1 : 1
    return (b.priority ?? 0) - (a.priority ?? 0)
  })

  return NextResponse.json({
    modality: { id: modality.id, name: modality.displayName, role: modality.role, color: modality.color, bgPath: modality.bgPath },
    today,
    agenda,
    projects: projectItems,
  })
}
