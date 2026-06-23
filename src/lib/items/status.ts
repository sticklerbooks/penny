// Pure status-change decision logic — split out from item-store.ts so it carries
// NO DB dependency and can be unit-tested in isolation. Every Item status write
// goes through decideStatusChange; it is the gate that keeps the lifecycle honest.

import { transitionPa, transitionModality, type PaStatus, type ModalityStatus } from './fsm'

export type StatusSide = 'pa' | 'modality'

export interface StatusPatch {
  paStatus?: PaStatus
  modalityStatus?: ModalityStatus
  completedAt?: Date
  scheduledAt?: Date
}

export interface StatusDecision {
  ok: boolean
  reason?: string
  patch?: StatusPatch
}

/**
 * Validate a status move and return the row patch it implies. Rejects an illegal
 * transition with a reason (never throws). `completed`/`scheduled` also stamp their
 * timestamps. THE gate — DB ops refuse to write when this returns ok:false.
 */
export function decideStatusChange(
  side: StatusSide,
  current: { paStatus: PaStatus | null; modalityStatus: ModalityStatus | null },
  to: string,
  now: Date = new Date()
): StatusDecision {
  if (side === 'pa') {
    const res = transitionPa(current.paStatus, to as PaStatus)
    if (!res.ok) return { ok: false, reason: res.reason }
    const patch: StatusPatch = { paStatus: to as PaStatus }
    if (to === 'completed') patch.completedAt = now
    if (to === 'scheduled') patch.scheduledAt = now
    return { ok: true, patch }
  }
  const res = transitionModality(current.modalityStatus, to as ModalityStatus)
  if (!res.ok) return { ok: false, reason: res.reason }
  const patch: StatusPatch = { modalityStatus: to as ModalityStatus }
  if (to === 'completed') patch.completedAt = now
  return { ok: true, patch }
}
