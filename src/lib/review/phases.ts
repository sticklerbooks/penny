// The Review Session phase sequences — the ordered walk Penny (and each
// submodality) takes through a deliberate review. This is a ritual the user (or a
// cron) starts; it is NOT the shape of every chat. The phase pointer is persisted
// on ReviewSession so an interrupted review resumes exactly where it left off.
//
// Pure module — no DB, no LLM. The engine (session.ts) reads these to know what
// comes next; the per-phase work lives elsewhere.

export type ReviewKind = 'pa' | 'submodality'

// Penny's review — the anchor's full sweep across the whole picture. Opens
// straight on notes: there is no separate greeting phase. Greeting had no item
// gate, so the self could linger in it forever without ever calling finish_phase
// to advance; the first real phase carries the hello now (see the output rules
// in runner.ts, which already let a phase open with a greeting).
export const PA_PHASES = [
  'notes',
  'projects',
  'submodalities',
  'calendar',
  'wrap-up',
] as const
export type PaPhase = (typeof PA_PHASES)[number]

// A submodality's review — narrower: her own domain. There is no separate
// "notes-pass / escalate to Penny" phase: status belongs to the task, not the
// viewer, so committing an item (set_item_status → 'planned') during notes-read
// IS handing it to Penny — she picks up every 'planned' item across every
// target directly, with no separate hand-off copy to make. (Until 2026-06-25
// this was a distinct phase that spawned a duplicate PA-targeted Item.)
export const SUB_PHASES = [
  'notes-read',
  'projects',
  'wrap-up',
] as const
export type SubPhase = (typeof SUB_PHASES)[number]

export type Phase = PaPhase | SubPhase

export function phasesFor(kind: ReviewKind): readonly Phase[] {
  return kind === 'pa' ? PA_PHASES : SUB_PHASES
}

export function firstPhase(kind: ReviewKind): Phase {
  return phasesFor(kind)[0]
}

/** The phase after `current`, or null when `current` is the last (review is done). */
export function nextPhase(kind: ReviewKind, current: Phase): Phase | null {
  const seq = phasesFor(kind)
  const i = seq.indexOf(current)
  if (i === -1) return null // unknown phase — caller should treat as a reset
  return i + 1 < seq.length ? seq[i + 1] : null
}

export function isLastPhase(kind: ReviewKind, current: Phase): boolean {
  const seq = phasesFor(kind)
  return seq.indexOf(current) === seq.length - 1
}

export function isValidPhase(kind: ReviewKind, phase: string): phase is Phase {
  return (phasesFor(kind) as readonly string[]).includes(phase)
}
