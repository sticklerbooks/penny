// The Item data layer — every write goes through here, and every stage change
// goes through the FSM (decideStatusChange). Nothing else may mutate `stage`,
// so the lifecycle can't drift. decideStatusChange is pure and unit-tested;
// the DB ops are thin wrappers around it.

import { prisma } from '@/lib/db'
import { canTransitionStage, type Stage } from './fsm'
import { decideStatusChange, type StatusDecision } from './status'

export { decideStatusChange }
export type { StatusPatch, StatusDecision } from './status'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

// ─── DB ops ─────────────────────────────────────────────────────────────────────

export interface ItemRow {
  id: string
  profileId: string
  name: string
  description: string
  notes: string
  type: string
  createdBy: string
  target: string
  projectId: string | null
  priority: number
  duration: string | null
  dayTime: string | null
  dueDate: Date | null
  contingency: string
  contingencyUntil: Date | null
  stage: string | null
  stageEnteredAt: Date | null
  visibility: boolean
  completedAt: Date | null
  scheduledAt: Date | null
  createdAt: Date
}

export interface CreateItemInput {
  name: string
  description: string
  notes?: string
  type: string
  target: string
  createdBy: string
  projectId?: string | null
  priority?: number
  duration?: string | null
  dayTime?: string | null
  dueDate?: Date | null
  contingency?: string
  contingencyUntil?: Date | null
  /** Initial stage. Defaults to 'backlog'. Validated as a legal entry stage. */
  stage?: Stage
  /** Provenance tag for migrated rows (e.g. "task:abc"). */
  sourceRef?: string | null
}

export async function createItem(profileId: string, input: CreateItemInput): Promise<ItemRow> {
  let stage: Stage = input.stage ?? 'backlog'
  if (!canTransitionStage(null, stage)) stage = 'backlog'
  const now = new Date()

  return db().item.create({
    data: {
      profileId,
      name: input.name,
      description: input.description,
      notes: input.notes ?? '',
      type: input.type,
      createdBy: input.createdBy,
      target: input.target,
      projectId: input.projectId ?? null,
      priority: input.priority ?? 2,
      duration: input.duration ?? null,
      dayTime: input.dayTime ?? null,
      dueDate: input.dueDate ?? null,
      contingency: input.contingency ?? '',
      contingencyUntil: input.contingencyUntil ?? null,
      stage,
      stageEnteredAt: now,
      sourceRef: input.sourceRef ?? null,
    },
  })
}

/** Has a row with this provenance tag already been migrated? (cutover idempotency) */
export async function itemExistsBySourceRef(profileId: string, sourceRef: string): Promise<boolean> {
  const row = await db().item.findFirst({ where: { profileId, sourceRef }, select: { id: true } })
  return !!row
}

/** Apply a stage change through the FSM. Returns the decision (ok/reason) so the
 *  caller can report the rejection to the model rather than silently failing. */
export async function setItemStatus(
  id: string,
  to: string
): Promise<StatusDecision & { item?: ItemRow }> {
  const item: ItemRow | null = await db().item.findUnique({ where: { id } })
  if (!item) return { ok: false, reason: `item ${id} not found` }
  const decision = decideStatusChange({ stage: item.stage as Stage | null }, to)
  if (!decision.ok) return decision
  const updated = await db().item.update({ where: { id }, data: decision.patch })
  return { ...decision, item: updated }
}

export async function updateItemFields(
  id: string,
  fields: Partial<Pick<ItemRow, 'name' | 'description' | 'notes' | 'type' | 'priority' | 'duration' | 'dayTime' | 'projectId' | 'dueDate' | 'target' | 'contingency' | 'contingencyUntil'>>
): Promise<ItemRow> {
  return db().item.update({ where: { id }, data: fields })
}

/** Add a dated line to an item's notes without erasing what's already there — the
 *  alternative to minting a duplicate Item every time more is learned about one. */
export async function appendItemNote(id: string, text: string): Promise<ItemRow> {
  const item: ItemRow | null = await db().item.findUnique({ where: { id } })
  if (!item) throw new Error(`item ${id} not found`)
  const stamp = new Date().toISOString().slice(0, 10)
  const line = `[${stamp}] ${text}`
  const notes = item.notes ? `${item.notes}\n${line}` : line
  return db().item.update({ where: { id }, data: { notes } })
}

/** Hard delete — only the wrap-up phase calls this, for rows already at to-delete. */
export async function hardDeleteItem(id: string): Promise<void> {
  await db().item.delete({ where: { id } })
}

export interface ItemQuery {
  id?: string
  target?: string
  createdBy?: string
  projectId?: string
  type?: string
  visibleOnly?: boolean
}

export async function searchItems(profileId: string, q: ItemQuery = {}): Promise<ItemRow[]> {
  return db().item.findMany({
    where: {
      profileId,
      ...(q.id ? { id: q.id } : {}),
      ...(q.target ? { target: q.target } : {}),
      ...(q.createdBy ? { createdBy: q.createdBy } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.visibleOnly === false ? {} : { visibility: true }),
    },
    orderBy: { createdAt: 'desc' },
  })
}
