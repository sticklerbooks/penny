// Pure decision logic for the review phases — the parts that are deterministic and
// therefore belong in code, not in an LLM prompt. Each function takes plain data
// and returns a decision; the engine does the DB I/O around them. No DB, no LLM
// here, so every rule below is unit-testable in isolation.

import type { PaStatus, ModalityStatus } from '../items/fsm'

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

// ─── notes-pass phase (submodality review) ──────────────────────────────────────
// Note 2 from design review: notes-read runs EARLY, but a self may mint a task
// later (projects/user phase) that never got triaged or marked sent-to-PA. So
// notes-pass must sweep BOTH (a) everything already flagged sent-to-PA AND (b)
// anything created THIS SESSION that's still undecided about escalation — and ask,
// for each, whether it should go up to Penny.

// Modality statuses that have NOT yet resolved the "does this go to Penny?"
// question. (completed / to-delete / sent-to-PA are already decided.)
const UNDECIDED_FOR_ESCALATION: ReadonlySet<ModalityStatus> = new Set([
  'new',
  'pending',
  'continuing',
  'blocked',
])

export interface NotesPassItem {
  id: string
  modalityStatus: ModalityStatus | null
  createdAt: Date
}

/**
 * The set of items notes-pass should walk: anything sent-to-PA (whenever made),
 * plus anything minted this session that's still undecided about escalation.
 */
export function notesPassQueue<T extends NotesPassItem>(items: T[], sessionStartedAt: Date): T[] {
  return items.filter((it) => {
    if (it.modalityStatus === 'sent-to-PA') return true
    const madeThisSession = it.createdAt.getTime() >= sessionStartedAt.getTime()
    return madeThisSession && !!it.modalityStatus && UNDECIDED_FOR_ESCALATION.has(it.modalityStatus)
  })
}

// ─── Triage ordering ────────────────────────────────────────────────────────────
// The order each notes phase walks statuses, straight from the spec.

// Penny's notes phase: pending first, then continuing, then new.
export const PA_NOTES_ORDER: readonly PaStatus[] = ['pending', 'continuing', 'new']

// Submodality notes-read: pending, then new, then acknowledge completed, then blocked.
export const SUB_NOTESREAD_ORDER: readonly ModalityStatus[] = ['pending', 'new', 'completed', 'blocked']

interface PaQueueItem {
  paStatus: PaStatus | null
}
interface ModQueueItem {
  modalityStatus: ModalityStatus | null
}

/** Items the PA notes phase triages, grouped and ordered per PA_NOTES_ORDER. */
export function paNotesQueue<T extends PaQueueItem>(items: T[]): T[] {
  return orderByStatus(items, PA_NOTES_ORDER, (it) => it.paStatus)
}

/** Items the submodality notes-read phase walks, ordered per SUB_NOTESREAD_ORDER. */
export function subNotesReadQueue<T extends ModQueueItem>(items: T[]): T[] {
  return orderByStatus(items, SUB_NOTESREAD_ORDER, (it) => it.modalityStatus)
}

function orderByStatus<T, S extends string>(items: T[], order: readonly S[], pick: (it: T) => S | null): T[] {
  const rank = new Map<S, number>(order.map((s, i) => [s, i]))
  return items
    .filter((it) => {
      const s = pick(it)
      return s !== null && rank.has(s)
    })
    .sort((a, b) => rank.get(pick(a)!)! - rank.get(pick(b)!)!)
}
