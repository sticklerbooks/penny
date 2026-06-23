// GET /api/dashboard?modality=<id>
//
// The principal's read view of one modality's world: active tasks, projects, and
// pending events, each carrying Adam's ItemNotes inline. No LLM — pure Prisma, so
// it costs nothing to open and refresh. Mirrors the chat lens (assignedModality
// === id; PA sees everything) so the dashboard shows exactly what she's holding.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getModality } from '@/lib/modalities'
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
  dateRaw: string | null     // the original free-text date (events) for display
  dueTime: string | null
  bucket: Bucket
  overdue: boolean
  status: string | null
  priority: number | null
  projectId: string | null
  notes: NoteLite[]
  unacked: number            // open Class-B flags still awaiting the modality
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

  const mineTask = isPA ? {} : { assignedModality: modalityId }

  const [tasks, projects, events, allNotes] = await Promise.all([
    prisma.task.findMany({
      where: { profileId: profile.id, archivedAt: null, status: { not: 'Complete' }, ...mineTask },
    }),
    prisma.project.findMany({
      where: { profileId: profile.id, progress: { lt: 10 }, ...mineTask },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.pendingCalendarEvent.findMany({
      where: { profileId: profile.id, archivedAt: null, completedAt: null, ...mineTask },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma as any).itemNote.findMany({
      where: { profileId: profile.id },
      orderBy: { createdAt: 'desc' },
    }).catch(() => []),
  ])

  // Index notes by (itemType:itemId).
  const notesByItem = new Map<string, NoteLite[]>()
  for (const n of allNotes as Array<{ id: string; itemType: string; itemId: string; kind: string; body: string | null; createdAt: Date; acknowledged: boolean }>) {
    const key = `${n.itemType}:${n.itemId}`
    const list = notesByItem.get(key) ?? []
    list.push({ id: n.id, kind: n.kind, body: n.body, createdAt: n.createdAt.toISOString(), acknowledged: n.acknowledged })
    notesByItem.set(key, list)
  }

  const today = todayInTz()
  const weekEnd = addDays(today, 6)

  const attach = (type: ItemType, id: string) => {
    const list = notesByItem.get(`${type}:${id}`) ?? []
    return { notes: list, unacked: list.filter((n) => !n.acknowledged && n.kind !== 'done' && n.kind !== 'moved').length }
  }

  const taskItems: DashItem[] = tasks.map((t) => {
    const date = dateOnly(t.dueDate)
    const bucket = bucketFor(date, today, weekEnd)
    return {
      id: t.id, type: 'task', title: t.name, description: t.description,
      date, dateRaw: t.dueDate ? new Date(t.dueDate).toISOString() : null, dueTime: t.dueTime,
      bucket, overdue: bucket === 'overdue',
      status: t.status, priority: t.priority, projectId: t.projectId,
      ...attach('task', t.id),
    }
  })

  const eventItems: DashItem[] = events.map((e) => {
    const date = dateOnly(e.date)
    const bucket = bucketFor(date, today, weekEnd)
    return {
      id: e.id, type: 'event', title: e.name, description: e.description ?? '',
      date, dateRaw: e.date, dueTime: e.startTime,
      bucket, overdue: bucket === 'overdue',
      status: e.scheduled ? 'Scheduled' : 'Pending', priority: e.priority, projectId: e.projectId,
      ...attach('event', e.id),
    }
  })

  // Projects are containers, not time-bucketed — returned as their own band.
  const projectItems = projects.map((p) => ({
    id: p.id, type: 'project' as const, title: p.name, description: p.description,
    progress: p.progress, expectedDuration: p.expectedDuration, contingencies: p.contingencies,
    priority: null as number | null,
    ...attach('project', p.id),
  }))

  // Agenda = tasks + events, grouped by bucket, each group date-ascending then by
  // priority. Undated sinks to the bottom (handled by BUCKET_ORDER in the UI).
  const agenda = [...taskItems, ...eventItems].sort((a, b) => {
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
