// Phase exit guards — the deterministic predicate the engine checks before it will
// advance. This is the "loop until everything's resolved" condition, evaluated
// against the DATABASE, not against anything the LLM claims. finish_phase runs
// these inline and refuses (returns the offenders) until they come back empty, so
// it is impossible to leave a phase with work unfinished.
//
// One kind of exit condition now that stage is unified, per item-in-queue:
//   • consideration — every item in the queue must be marked discussed, even one
//                      deliberately left unchanged (e.g. still 'backlog' is a
//                      legitimate, considered resting place — same as old
//                      'pending' was). The forced "must not still be 'new'" rule
//                      from the old dual-vocabulary model is gone along with
//                      'new' itself: 'backlog' covers both "never looked at" and
//                      "looked at, staying put," and discussion is what proves
//                      you looked.
// PA's calendar phase keeps its own pure status invariant — nothing may remain
// queued for scheduling, independent of discussion.

export interface GuardViolation {
  id: string
  name: string
  reason: string
}

export interface GuardItem {
  id: string
  name: string
  stage: string | null
}

// PA calendar phase: nothing may remain queued for scheduling — every 'planned'
// item must become 'scheduled' (or be pulled back). Pure status invariant.
export function calendarExitViolations(items: GuardItem[]): GuardViolation[] {
  return items
    .filter((it) => it.stage === 'planned')
    .map((it) => ({ id: it.id, name: it.name, reason: "still 'planned' — must be scheduled or moved off the calendar queue" }))
}

// Notes / projects / any other consideration-gated phase: every item in the
// queue must be considered (discussed), even if left unchanged. No forbidden
// status.
export function considerationViolations(
  queue: { id: string; name: string }[],
  discussed: Set<string>
): GuardViolation[] {
  return queue
    .filter((it) => !discussed.has(it.id))
    .map((it) => ({ id: it.id, name: it.name, reason: 'not yet discussed this review' }))
}
