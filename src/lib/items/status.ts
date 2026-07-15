// Pure status-change decision logic — split out from item-store.ts so it carries
// NO DB dependency and can be unit-tested in isolation. Every Item stage write
// goes through decideStatusChange; it is the gate that keeps the lifecycle honest.

import { transitionStage, type Stage } from './fsm'

export interface StatusPatch {
  stage: Stage
  stageEnteredAt: Date
  completedAt?: Date
  scheduledAt?: Date
}

export interface StatusDecision {
  ok: boolean
  reason?: string
  patch?: StatusPatch
}

/**
 * Validate a stage move and return the row patch it implies. Rejects an illegal
 * transition with a reason (never throws). `done`/`scheduled` also stamp their
 * timestamps; every successful move stamps `stageEnteredAt` (distinct from
 * `updatedAt`, which Prisma bumps on ANY field edit) so "how long has this sat
 * here" is a real, queryable fact. THE gate — DB ops refuse to write when this
 * returns ok:false.
 */
export function decideStatusChange(
  current: { stage: Stage | null },
  to: string,
  now: Date = new Date()
): StatusDecision {
  const res = transitionStage(current.stage, to as Stage)
  if (!res.ok) return { ok: false, reason: res.reason }
  const patch: StatusPatch = { stage: to as Stage, stageEnteredAt: now }
  if (to === 'done') patch.completedAt = now
  if (to === 'scheduled') patch.scheduledAt = now
  return { ok: true, patch }
}
