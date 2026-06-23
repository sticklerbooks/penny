// Review Session lifecycle — the thin DB layer around the phase walk. The phase
// ORDER and all phase DECISIONS live in phases.ts / selectors.ts (pure, tested);
// this file only persists position and the discussed-set. Per-phase work (loading
// items, running the LLM, applying FSM transitions, computing the DB-delta report)
// will call into here to read/advance state.

import { prisma } from '@/lib/db'
import { firstPhase, nextPhase, isValidPhase, type ReviewKind, type Phase } from './phases'

// Lightweight shape so callers don't need the generated Prisma type.
export interface ReviewSessionRow {
  id: string
  profileId: string
  kind: string
  modalityId: string
  phase: string
  status: string
  startedAt: Date
  completedAt: Date | null
  discussedItemIds: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

/** The profile's currently-active review, or null. At most one should exist. */
export async function activeReview(profileId: string): Promise<ReviewSessionRow | null> {
  return db().reviewSession.findFirst({
    where: { profileId, status: 'active' },
    orderBy: { startedAt: 'desc' },
  })
}

/**
 * Resume the active review if there is one, otherwise start a fresh one at the
 * first phase. Reviews are exclusive: if an active review already exists (even for
 * a different target), it is returned as-is — the caller must abandon it before
 * starting a different one, so two reviews can't run at once.
 */
export async function startOrResumeReview(
  profileId: string,
  kind: ReviewKind,
  modalityId: string
): Promise<{ session: ReviewSessionRow; resumed: boolean }> {
  const existing = await activeReview(profileId)
  if (existing) return { session: existing, resumed: true }
  const session = await db().reviewSession.create({
    data: { profileId, kind, modalityId, phase: firstPhase(kind), startedAt: new Date() },
  })
  return { session, resumed: false }
}

/**
 * Advance to the next phase, persisting the new pointer. When already on the last
 * phase, marks the review completed. Returns the updated row plus whether the
 * review is now done.
 */
export async function advanceReview(
  sessionId: string
): Promise<{ session: ReviewSessionRow; done: boolean }> {
  const s: ReviewSessionRow = await db().reviewSession.findUniqueOrThrow({ where: { id: sessionId } })
  const kind = s.kind as ReviewKind
  // Unknown/corrupt phase → restart at the first phase rather than silently ending.
  const current = isValidPhase(kind, s.phase) ? (s.phase as Phase) : null
  const next = current ? nextPhase(kind, current) : firstPhase(kind)

  if (next === null) {
    const session = await db().reviewSession.update({
      where: { id: sessionId },
      data: { status: 'completed', completedAt: new Date() },
    })
    return { session, done: true }
  }
  const session = await db().reviewSession.update({ where: { id: sessionId }, data: { phase: next } })
  return { session, done: false }
}

/** Jump the pointer to a specific phase (e.g. greeting handled an urgent item and
 *  wants to stay put, or a manual back-step). Validated against the kind. */
export async function setPhase(sessionId: string, phase: Phase): Promise<ReviewSessionRow> {
  const s: ReviewSessionRow = await db().reviewSession.findUniqueOrThrow({ where: { id: sessionId } })
  if (!isValidPhase(s.kind as ReviewKind, phase)) {
    throw new Error(`"${phase}" is not a phase of a ${s.kind} review`)
  }
  return db().reviewSession.update({ where: { id: sessionId }, data: { phase } })
}

export async function abandonReview(sessionId: string): Promise<ReviewSessionRow> {
  return db().reviewSession.update({ where: { id: sessionId }, data: { status: 'abandoned' } })
}

// ─── Discussed-this-session set ─────────────────────────────────────────────────

export function discussedIds(session: ReviewSessionRow): string[] {
  if (!session.discussedItemIds) return []
  try {
    const parsed = JSON.parse(session.discussedItemIds)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Mark an item discussed in this review (idempotent). */
export async function markDiscussed(sessionId: string, itemId: string): Promise<ReviewSessionRow> {
  const s: ReviewSessionRow = await db().reviewSession.findUniqueOrThrow({ where: { id: sessionId } })
  const ids = discussedIds(s)
  if (!ids.includes(itemId)) ids.push(itemId)
  return db().reviewSession.update({
    where: { id: sessionId },
    data: { discussedItemIds: JSON.stringify(ids) },
  })
}
