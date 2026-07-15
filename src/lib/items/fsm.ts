// The Item lifecycle state machine — the single source of truth for how an Item
// moves through review (PA and submodality alike).
//
// Status belongs to the TASK, not to whoever's looking at it. One `stage`,
// shared by every viewer: PA's queries span every `target`, a submodality's
// queries filter to her own — same field, different filter, not a second
// status vocabulary. (Until 2026-06-25 this was two parallel fields,
// `paStatus`/`modalityStatus`, with an escalation-copy dance between them —
// retired in favor of this.)
//
// THIS FILE IS DELIBERATELY PURE — no DB, no I/O, no LLM. It is the one place the
// transition rules live, so they can be read at a glance and unit-tested. The
// phase engine calls transitionStage and never mutates `stage` directly — that
// invariant is what keeps the lifecycle honest instead of drifting in prose.

// ─── Vocabularies ──────────────────────────────────────────────────────────────

// 'ongoing' is retired — a recurring commitment is a Project now (it has the
// progress/contingency/notes machinery a recurring thing actually needs).
// 'task' fills a gap 'ongoing' used to paper over: a plain one-off with no real
// calendar slot ('event') and no special handling ('memory'/'suggestion').
export const ITEM_TYPES = ['task', 'event', 'memory', 'suggestion'] as const
export type ItemType = (typeof ITEM_TYPES)[number]

// `completed`/`done` carries a completedAt date on the row; the stage itself is
// just `done`. `cancelled` is the only true sink — wrap-up removes those rows
// for real.
export const STAGES = [
  'backlog',   // exists, not yet committed to right now
  'planned',   // committed — ready to be worked, or queued for a calendar slot
  'scheduled', // has a real calendar slot
  'blocked',   // stuck on something outside anyone's control (see Item.contingency)
  'done',      // finished
  'cancelled', // true sink
] as const
export type Stage = (typeof STAGES)[number]

// ─── Transition table ──────────────────────────────────────────────────────────
// from-stage → the stages it may legally move to (self-inclusion = "may stay").
// Read this as the literal rules of the review phases; nothing else encodes them.

export const STAGE_TRANSITIONS: Record<Stage, readonly Stage[]> = {
  // A `backlog` item must be triaged out during the notes phase: committed
  // (planned), stuck (blocked), finished, or dropped. May also just stay.
  backlog: ['backlog', 'planned', 'blocked', 'done', 'cancelled'],
  // Committed. Gets a calendar slot (scheduled), goes blocked, finishes, is
  // dropped, or simply stays planned (still waiting on a slot).
  planned: ['planned', 'scheduled', 'blocked', 'done', 'cancelled'],
  // On the calendar. Can be pulled back to planned (plans changed before it
  // happened), go blocked, finish, or be dropped.
  scheduled: ['scheduled', 'planned', 'blocked', 'done', 'cancelled'],
  // Stuck on something outside anyone's control (see Item.contingency /
  // contingencyUntil). Skipped entirely in triage while contingencyUntil is
  // still future. Can resolve back into any live stage once unstuck.
  blocked: ['backlog', 'planned', 'scheduled', 'blocked', 'done', 'cancelled'],
  // Done. Near-terminal: the weekly brief hides it via visibility, not a stage
  // change. The only move left is an explicit deletion request.
  done: ['cancelled'],
  // True sink — removed for real in wrap-up.
  cancelled: [],
}

// Stages an item may take when it FIRST enters the world (from a null stage).
// `scheduled`/`done`/`cancelled` are never valid first stages — they imply a
// prior lifecycle. An item CAN be born `blocked` (e.g. created already known
// to be stuck on something).
export const ENTRY_STAGES: readonly Stage[] = ['backlog', 'planned', 'blocked']

// ─── Type guards ───────────────────────────────────────────────────────────────

export function isItemType(t: string | null | undefined): t is ItemType {
  return !!t && (ITEM_TYPES as readonly string[]).includes(t)
}
export function isStage(s: string | null | undefined): s is Stage {
  return !!s && (STAGES as readonly string[]).includes(s)
}

// ─── Transition checks ─────────────────────────────────────────────────────────

export interface TransitionResult {
  ok: boolean
  from: Stage | null
  to: Stage
  /** Present only when ok === false — a human-readable reason the move is illegal. */
  reason?: string
}

/** Legal next stages from `from` (entry stages when `from` is null). */
export function nextStages(from: Stage | null): readonly Stage[] {
  return from === null ? ENTRY_STAGES : STAGE_TRANSITIONS[from]
}

export function canTransitionStage(from: Stage | null, to: Stage): boolean {
  return nextStages(from).includes(to)
}

/**
 * Validate a stage move. Returns a result instead of throwing so the engine can
 * surface the reason rather than crash a review mid-phase. The engine treats a
 * non-ok result as "do not write" — it never forces an illegal stage onto a row.
 */
export function transitionStage(from: Stage | null, to: Stage): TransitionResult {
  if (!isStage(to)) return { ok: false, from, to, reason: `"${to}" is not a stage` }
  if (canTransitionStage(from, to)) return { ok: true, from, to }
  return {
    ok: false,
    from,
    to,
    reason: `Stage cannot move ${from ?? '(new item)'} → ${to}; allowed: ${nextStages(from).join(', ') || '(none — terminal)'}`,
  }
}

// ─── Terminal helper ───────────────────────────────────────────────────────────
// Only `cancelled` is a hard sink (no outgoing edges). `done` is "soft" —
// finished, but a deletion can still follow.

export function isStageTerminal(s: Stage): boolean {
  return STAGE_TRANSITIONS[s].length === 0
}
