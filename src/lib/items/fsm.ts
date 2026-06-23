// The Item lifecycle state machines — the single source of truth for how an Item
// moves through Penny's review and the submodality reviews.
//
// An Item carries TWO independent status fields:
//   • paStatus       — its lifecycle in Penny's (PA) world. Drives her notes and
//                      calendar phases. Set when target = 'pa', or once a
//                      submodality escalates the item up to her.
//   • modalityStatus — its lifecycle inside the owning submodality's world.
//                      Drives that self's notes-read / notes-pass phases.
// Which one is "live" depends on the item's target; either may be null when the
// item has never entered that world.
//
// THIS FILE IS DELIBERATELY PURE — no DB, no I/O, no LLM. It is the one place the
// transition rules live, so they can be read at a glance and unit-tested. The
// phase engine (Stage 2) calls transitionPa / transitionModality and never
// mutates a status field directly — that invariant is what keeps the lifecycle
// honest instead of drifting in prose. See the redesign plan.

// ─── Vocabularies ──────────────────────────────────────────────────────────────

export const ITEM_TYPES = ['event', 'ongoing', 'memory', 'suggestion'] as const
export type ItemType = (typeof ITEM_TYPES)[number]

// PA-side lifecycle. `completed` carries a completedAt date on the row; the status
// itself is just `completed`. `to-delete` is the only true sink — the wrap-up
// phase removes those rows for real.
export const PA_STATUSES = [
  'new',
  'pending',
  'schedule',
  'scheduled',
  'continuing',
  'completed',
  'to-delete',
] as const
export type PaStatus = (typeof PA_STATUSES)[number]

// Submodality-side lifecycle. `sent-to-PA` means "escalate me": the notes-pass
// phase spawns a fresh PA-targeted item from this one, then drops this one back to
// `pending` (so the original keeps living in the modality's world).
export const MODALITY_STATUSES = [
  'new',
  'pending',
  'sent-to-PA',
  'completed',
  'blocked',
  'to-delete',
] as const
export type ModalityStatus = (typeof MODALITY_STATUSES)[number]

// ─── Transition tables ─────────────────────────────────────────────────────────
// from-state → the states it may legally move to (self-inclusion = "may stay").
// Read these as the literal rules of the review phases; nothing else encodes them.

export const PA_TRANSITIONS: Record<PaStatus, readonly PaStatus[]> = {
  // A `new` note must be triaged out of `new` during the notes phase.
  new: ['pending', 'schedule', 'continuing', 'completed', 'to-delete'],
  // A pending event may stay pending, or be reclassified as an ongoing task
  // (→ continuing), queued for the calendar (→ schedule), finished, or dropped.
  pending: ['pending', 'continuing', 'schedule', 'completed', 'to-delete'],
  // An ongoing task stays continuing while it recurs. Scheduling a concrete
  // instance spawns a SEPARATE schedule item (engine), so that is not a move of
  // this row; but the row itself may be collapsed to a single event (→ pending),
  // queued directly, finished, or dropped.
  continuing: ['continuing', 'pending', 'schedule', 'completed', 'to-delete'],
  // Queued for the calendar. The calendar phase places it and marks it scheduled,
  // or it can be pulled back to pending / dropped.
  schedule: ['scheduled', 'pending', 'to-delete'],
  // On the calendar. It later completes, gets re-queued, or is dropped.
  scheduled: ['completed', 'schedule', 'to-delete'],
  // Done. Near-terminal: the weekly brief hides it via visibility, not a status
  // change. The only move left is an explicit deletion request.
  completed: ['to-delete'],
  // True sink — removed for real in wrap-up.
  'to-delete': [],
}

export const MODALITY_TRANSITIONS: Record<ModalityStatus, readonly ModalityStatus[]> = {
  // A `new` note must be triaged out of `new` during notes-read.
  new: ['pending', 'sent-to-PA', 'completed', 'blocked', 'to-delete'],
  // May stay pending, be escalated to Penny, finished, blocked, or dropped.
  pending: ['pending', 'sent-to-PA', 'completed', 'blocked', 'to-delete'],
  // Escalation in flight. notes-pass copies it to a PA item, then returns this
  // one to pending. Can also simply be dropped.
  'sent-to-PA': ['pending', 'to-delete'],
  // Stuck. The notes-read phase tries to move it off blocked.
  blocked: ['pending', 'sent-to-PA', 'completed', 'to-delete'],
  // Done (acknowledged in notes-read). Only an explicit deletion remains.
  completed: ['to-delete'],
  // True sink.
  'to-delete': [],
}

// States an item may take when it FIRST enters a world (from a null status).
// Penny may mint an item straight as `schedule`; a submodality may mint one
// `blocked`. Terminal/derived states (scheduled, completed, to-delete, sent-to-PA)
// are never valid first states — they imply a prior lifecycle.
export const PA_ENTRY_STATES: readonly PaStatus[] = ['new', 'pending', 'schedule', 'continuing']
export const MODALITY_ENTRY_STATES: readonly ModalityStatus[] = ['new', 'pending', 'blocked']

// ─── Type guards ───────────────────────────────────────────────────────────────

export function isItemType(t: string | null | undefined): t is ItemType {
  return !!t && (ITEM_TYPES as readonly string[]).includes(t)
}
export function isPaStatus(s: string | null | undefined): s is PaStatus {
  return !!s && (PA_STATUSES as readonly string[]).includes(s)
}
export function isModalityStatus(s: string | null | undefined): s is ModalityStatus {
  return !!s && (MODALITY_STATUSES as readonly string[]).includes(s)
}

// ─── Transition checks ─────────────────────────────────────────────────────────

export interface TransitionResult<S extends string> {
  ok: boolean
  from: S | null
  to: S
  /** Present only when ok === false — a human-readable reason the move is illegal. */
  reason?: string
}

/** Legal next PA states from `from` (entry states when `from` is null). */
export function nextPaStatuses(from: PaStatus | null): readonly PaStatus[] {
  return from === null ? PA_ENTRY_STATES : PA_TRANSITIONS[from]
}

/** Legal next modality states from `from` (entry states when `from` is null). */
export function nextModalityStatuses(from: ModalityStatus | null): readonly ModalityStatus[] {
  return from === null ? MODALITY_ENTRY_STATES : MODALITY_TRANSITIONS[from]
}

export function canTransitionPa(from: PaStatus | null, to: PaStatus): boolean {
  return nextPaStatuses(from).includes(to)
}
export function canTransitionModality(from: ModalityStatus | null, to: ModalityStatus): boolean {
  return nextModalityStatuses(from).includes(to)
}

/**
 * Validate a PA-side move. Returns a result instead of throwing so the engine can
 * surface the reason rather than crash a review mid-phase. The engine treats a
 * non-ok result as "do not write" — it never forces an illegal status onto a row.
 */
export function transitionPa(from: PaStatus | null, to: PaStatus): TransitionResult<PaStatus> {
  if (!isPaStatus(to)) return { ok: false, from, to, reason: `"${to}" is not a PA status` }
  if (canTransitionPa(from, to)) return { ok: true, from, to }
  return {
    ok: false,
    from,
    to,
    reason: `PA status cannot move ${from ?? '(new item)'} → ${to}; allowed: ${nextPaStatuses(from).join(', ') || '(none — terminal)'}`,
  }
}

export function transitionModality(
  from: ModalityStatus | null,
  to: ModalityStatus
): TransitionResult<ModalityStatus> {
  if (!isModalityStatus(to)) return { ok: false, from, to, reason: `"${to}" is not a modality status` }
  if (canTransitionModality(from, to)) return { ok: true, from, to }
  return {
    ok: false,
    from,
    to,
    reason: `Modality status cannot move ${from ?? '(new item)'} → ${to}; allowed: ${nextModalityStatuses(from).join(', ') || '(none — terminal)'}`,
  }
}

// ─── Terminal helpers ──────────────────────────────────────────────────────────
// Only `to-delete` is a hard sink (no outgoing edges). `completed` is "soft" —
// finished, but a deletion can still follow.

export function isPaTerminal(s: PaStatus): boolean {
  return PA_TRANSITIONS[s].length === 0
}
export function isModalityTerminal(s: ModalityStatus): boolean {
  return MODALITY_TRANSITIONS[s].length === 0
}
