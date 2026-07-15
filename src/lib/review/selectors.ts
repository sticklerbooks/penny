// Pure decision logic for the review phases — the parts that are deterministic and
// therefore belong in code, not in an LLM prompt. Each function takes plain data
// and returns a decision; the engine does the DB I/O around them. No DB, no LLM
// here, so every rule below is unit-testable in isolation.

import type { Stage } from '../items/fsm'

const DAY_MS = 24 * 60 * 60 * 1000

// ─── Submodalities phase (Penny's review) ──────────────────────────────────────
// Spec: for each submodality, if last contact > 5 days ago OR needs-attention > 3,
// book a "talk to <self>" (30 or 60 min). Separately, if the self's item count is
// way too high or too low, bump its needs-attention by 1 (for next time).
//
// Thresholds are named + tunable on purpose — they're the knobs you'll want to
// turn once you watch a few real reviews.
export const OVERDUE_DAYS = 5
export const ATTENTION_THRESHOLD = 3
export const ITEM_COUNT_TOO_FEW = 1 // fewer than this (i.e. 0) reads as neglected
export const ITEM_COUNT_TOO_MANY = 15 // more than this reads as overloaded

export interface SubmodalityCheck {
  modalityId: string
  lastContactAt: Date | null // null = never contacted → treated as overdue
  needsAttention: number // 0–5
  itemCount: number // total live items owned by this self
}

export interface SubmodalityVerdict {
  modalityId: string
  /** Book a "talk to <self>" item this review? */
  shouldTalk: boolean
  reason: 'overdue' | 'needs-attention' | 'overdue+attention' | null
  /** Penny's judgment, scripted: longer when she's been neglected or is flagged. */
  durationMinutes: 30 | 60
  /** Add this to the stored needsAttention (0 or 1) — applies for NEXT time. */
  needsAttentionDelta: 0 | 1
}

export function checkSubmodality(c: SubmodalityCheck, now: Date): SubmodalityVerdict {
  const daysSince = c.lastContactAt === null
    ? Infinity
    : (now.getTime() - c.lastContactAt.getTime()) / DAY_MS

  const overdue = daysSince > OVERDUE_DAYS
  const flagged = c.needsAttention > ATTENTION_THRESHOLD
  const shouldTalk = overdue || flagged

  const reason: SubmodalityVerdict['reason'] =
    overdue && flagged ? 'overdue+attention' : overdue ? 'overdue' : flagged ? 'needs-attention' : null

  // 60 min when she's flagged or badly stale (2× overdue); 30 otherwise.
  const durationMinutes: 30 | 60 = flagged || daysSince > 2 * OVERDUE_DAYS ? 60 : 30

  const outOfBand = c.itemCount < ITEM_COUNT_TOO_FEW || c.itemCount > ITEM_COUNT_TOO_MANY
  const needsAttentionDelta: 0 | 1 = outOfBand ? 1 : 0

  return { modalityId: c.modalityId, shouldTalk, reason, durationMinutes, needsAttentionDelta }
}

// ─── Triage ordering ────────────────────────────────────────────────────────────
// The order the notes phase walks stages, straight from the spec. One order now,
// shared by PA and every submodality — status belongs to the task, not to who's
// looking at it. (Until 2026-06-25 PA and submodality each had a separate
// vocabulary and a distinct notes-pass phase whose only job was deciding
// escalation between them; retired — committing an item to 'planned' IS handing
// it to Penny now, since she queries 'planned' across every target directly.)
// 'planned'/'scheduled' items don't appear here at all — they're already
// decided; PA's calendar phase is where a 'planned' item gets a slot.
export const NOTES_ORDER: readonly Stage[] = ['backlog', 'blocked', 'done']

// A one-off with a specific due date further out than this is NOT surfaced for
// triage yet — no point reviewing it now. (Projects have no single due date, so
// they're never skipped by this.)
export const SKIP_DUE_BEYOND_DAYS = 10

export function isFarFutureDue(dueDate: Date | null | undefined, now: Date): boolean {
  if (!dueDate) return false
  return dueDate.getTime() > now.getTime() + SKIP_DUE_BEYOND_DAYS * DAY_MS
}

// A contingent item with a REAL recheck date still in the future is skipped
// ENTIRELY — not just deprioritized. There's nothing to ask about "did the IRS
// get back to them" before the date she herself said to check back. A contingent
// item with no contingencyUntil (or a past one) gets triaged as normal.
export function isFutureContingency(contingencyUntil: Date | null | undefined, now: Date): boolean {
  return !!contingencyUntil && contingencyUntil.getTime() > now.getTime()
}

interface NotesQueueItem {
  stage: Stage | null
  dueDate?: Date | null
  contingencyUntil?: Date | null
}

/** Items the notes phase triages, ordered per NOTES_ORDER, skipping dated
 *  one-offs due more than SKIP_DUE_BEYOND_DAYS out, and anything contingent on a
 *  recheck date that hasn't arrived yet. Same function for PA and every
 *  submodality — the caller scopes `items` to the right `target` beforehand. */
export function notesQueue<T extends NotesQueueItem>(items: T[], now: Date = new Date()): T[] {
  const due = items.filter((it) => !isFarFutureDue(it.dueDate, now) && !isFutureContingency(it.contingencyUntil, now))
  return orderByStage(due, NOTES_ORDER, (it) => it.stage)
}

function orderByStage<T>(items: T[], order: readonly Stage[], pick: (it: T) => Stage | null): T[] {
  const rank = new Map<Stage, number>(order.map((s, i) => [s, i]))
  return items
    .filter((it) => {
      const s = pick(it)
      return s !== null && rank.has(s)
    })
    .sort((a, b) => rank.get(pick(a)!)! - rank.get(pick(b)!)!)
}
