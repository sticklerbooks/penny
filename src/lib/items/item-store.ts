// The Item data layer — every write goes through here, and every status change
// goes through the FSM (decideStatusChange). Nothing else may mutate paStatus /
// modalityStatus, so the lifecycle can't drift. decideStatusChange is pure and
// unit-tested; the DB ops are thin wrappers around it.

import { prisma } from '@/lib/db'
import { transitionPa, transitionModality, type PaStatus, type ModalityStatus } from './fsm'
import { decideStatusChange, type StatusSide, type StatusDecision } from './status'

export { decideStatusChange }
export type { StatusSide, StatusPatch, StatusDecision } from './status'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

// ─── DB ops ─────────────────────────────────────────────────────────────────────

export interface ItemRow {
  id: string
  profileId: string
  name: string
  description: string
  type: string
  createdBy: string
  target: string
  projectId: string | null
  priority: number
  duration: string | null
  dayTime: string | null
  paStatus: string | null
  modalityStatus: string | null
  visibility: boolean
  completedAt: Date | null
  scheduledAt: Date | null
  createdAt: Date
}

export interface CreateItemInput {
  name: string
  description: string
  type: string
  target: string
  createdBy: string
  projectId?: string | null
  priority?: number
  duration?: string | null
  dayTime?: string | null
  /** Initial status on the relevant side. Defaults to 'new' on the side implied by
   *  `target` ('pa' → paStatus, otherwise modalityStatus). Validated as an entry. */
  paStatus?: PaStatus
  modalityStatus?: ModalityStatus
}

export async function createItem(profileId: string, input: CreateItemInput): Promise<ItemRow> {
  const toPa = input.target === 'pa'
  // Default entry status on the side the item lives in, validated through the FSM.
  let paStatus = input.paStatus ?? (toPa ? ('new' as PaStatus) : undefined)
  let modalityStatus = input.modalityStatus ?? (toPa ? undefined : ('new' as ModalityStatus))
  if (paStatus && !transitionPa(null, paStatus).ok) paStatus = 'new'
  if (modalityStatus && !transitionModality(null, modalityStatus).ok) modalityStatus = 'new'

  return db().item.create({
    data: {
      profileId,
      name: input.name,
      description: input.description,
      type: input.type,
      createdBy: input.createdBy,
      target: input.target,
      projectId: input.projectId ?? null,
      priority: input.priority ?? 2,
      duration: input.duration ?? null,
      dayTime: input.dayTime ?? null,
      paStatus: paStatus ?? null,
      modalityStatus: modalityStatus ?? null,
    },
  })
}

/** Apply a status change through the FSM. Returns the decision (ok/reason) so the
 *  caller can report the rejection to the model rather than silently failing. */
export async function setItemStatus(
  id: string,
  side: StatusSide,
  to: string
): Promise<StatusDecision & { item?: ItemRow }> {
  const item: ItemRow | null = await db().item.findUnique({ where: { id } })
  if (!item) return { ok: false, reason: `item ${id} not found` }
  const decision = decideStatusChange(
    side,
    { paStatus: item.paStatus as PaStatus | null, modalityStatus: item.modalityStatus as ModalityStatus | null },
    to
  )
  if (!decision.ok) return decision
  const updated = await db().item.update({ where: { id }, data: decision.patch })
  return { ...decision, item: updated }
}

export async function updateItemFields(
  id: string,
  fields: Partial<Pick<ItemRow, 'name' | 'description' | 'type' | 'priority' | 'duration' | 'dayTime' | 'projectId'>>
): Promise<ItemRow> {
  return db().item.update({ where: { id }, data: fields })
}

/** Hard delete — only the wrap-up phase calls this, for rows already at to-delete. */
export async function hardDeleteItem(id: string): Promise<void> {
  await db().item.delete({ where: { id } })
}

export interface ItemQuery {
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
      ...(q.target ? { target: q.target } : {}),
      ...(q.createdBy ? { createdBy: q.createdBy } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.visibleOnly === false ? {} : { visibility: true }),
    },
    orderBy: { createdAt: 'desc' },
  })
}
