// Phase exit guards — the deterministic predicate the engine checks before it will
// advance. This is the "loop until everything's resolved" condition, evaluated
// against the DATABASE, not against anything the LLM claims. finish_phase runs
// these inline and refuses (returns the offenders) until they come back empty, so
// it is impossible to leave a phase with work unfinished.
//
// Two kinds of exit condition, per the spec:
//   • status invariant   — a forbidden status may not remain (e.g. nothing 'new').
//   • consideration       — every item in the queue must be marked discussed, even
//                           one deliberately left unchanged.
// A phase may require either, both, or neither. All pure + unit-tested.

export interface GuardViolation {
  id: string
  name: string
  reason: string
}

export interface GuardItem {
  id: string
  name: string
  paStatus: string | null
  modalityStatus: string | null
}

// PA notes phase: nothing may stay 'new', and every triaged item must be discussed
// (so a pending note you chose to leave as-is still proves you looked at it).
export function notesExitViolations(queue: GuardItem[], discussed: Set<string>): GuardViolation[] {
  const out: GuardViolation[] = []
  for (const it of queue) {
    if (it.paStatus === 'new') {
      out.push({ id: it.id, name: it.name, reason: "still 'new' — triage it to a real status" })
    } else if (!discussed.has(it.id)) {
      out.push({ id: it.id, name: it.name, reason: 'not yet discussed this review' })
    }
  }
  return out
}

// Submodality notes-read: nothing may stay 'new' (modality side); each discussed.
export function notesReadExitViolations(queue: GuardItem[], discussed: Set<string>): GuardViolation[] {
  const out: GuardViolation[] = []
  for (const it of queue) {
    if (it.modalityStatus === 'new') {
      out.push({ id: it.id, name: it.name, reason: "still 'new' — resolve it to a real status" })
    } else if (!discussed.has(it.id)) {
      out.push({ id: it.id, name: it.name, reason: 'not yet discussed this review' })
    }
  }
  return out
}

// PA calendar phase: nothing may remain queued for scheduling — every 'schedule'
// must become 'scheduled' (or be pulled back). Pure status invariant, no discussion.
export function calendarExitViolations(items: GuardItem[]): GuardViolation[] {
  return items
    .filter((it) => it.paStatus === 'schedule')
    .map((it) => ({ id: it.id, name: it.name, reason: "still 'schedule' — must be scheduled or removed" }))
}

// Projects / notes-pass: every item in the queue must be considered (discussed),
// even if left unchanged. No forbidden status.
export function considerationViolations(
  queue: { id: string; name: string }[],
  discussed: Set<string>
): GuardViolation[] {
  return queue
    .filter((it) => !discussed.has(it.id))
    .map((it) => ({ id: it.id, name: it.name, reason: 'not yet discussed this review' }))
}
