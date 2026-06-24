// Per-phase plan: which tools a phase grants, and the instruction block injected
// into the active self's prompt for that phase. The tool grant is pure and tested
// — the engine refuses to hand the model a tool the phase didn't authorize, so a
// phase can't reach outside its job.

import type { ReviewKind, Phase } from './phases'

// The review tool surface (Item-world + review control). Defined in items/item-tools.ts.
export const REVIEW_TOOLS = {
  search: 'search_items',
  create: 'create_item',
  update: 'update_item',
  updateProject: 'update_project',
  setStatus: 'set_item_status',
  markDiscussed: 'mark_discussed',
  finishPhase: 'finish_phase',
} as const

const COMMON_TRIAGE = [
  REVIEW_TOOLS.search,
  REVIEW_TOOLS.create,
  REVIEW_TOOLS.update,
  REVIEW_TOOLS.setStatus,
  REVIEW_TOOLS.markDiscussed,
  REVIEW_TOOLS.finishPhase,
]

const PA_PHASE_TOOLS: Record<string, string[]> = {
  greeting: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.finishPhase],
  notes: COMMON_TRIAGE,
  projects: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.update, REVIEW_TOOLS.updateProject, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.markDiscussed, REVIEW_TOOLS.finishPhase],
  // The engine books the "talk to X" items and bumps attention BEFORE this turn;
  // the self just reviews what was booked.
  submodalities: [REVIEW_TOOLS.search, REVIEW_TOOLS.finishPhase],
  user: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.finishPhase],
  // Scheduling is scripted; the self confirms and the engine flips schedule→scheduled.
  calendar: [REVIEW_TOOLS.search, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.finishPhase],
  'wrap-up': [REVIEW_TOOLS.finishPhase],
}

const SUB_PHASE_TOOLS: Record<string, string[]> = {
  greeting: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.finishPhase],
  'notes-read': COMMON_TRIAGE,
  projects: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.update, REVIEW_TOOLS.updateProject, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.markDiscussed, REVIEW_TOOLS.finishPhase],
  user: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.finishPhase],
  // The engine pre-loads the notes-pass queue (sent-to-PA + this-session items);
  // the self decides each, the engine copies the chosen ones up to Penny.
  'notes-pass': [REVIEW_TOOLS.search, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.create, REVIEW_TOOLS.finishPhase],
  'wrap-up': [REVIEW_TOOLS.finishPhase],
}

export function toolsForPhase(kind: ReviewKind, phase: Phase): string[] {
  const table = kind === 'pa' ? PA_PHASE_TOOLS : SUB_PHASE_TOOLS
  return table[phase] ?? [REVIEW_TOOLS.finishPhase]
}

// ─── Instruction blocks ─────────────────────────────────────────────────────────
// Short, phase-scoped. The runner appends the loaded items beneath these.

export function phaseInstructions(kind: ReviewKind, phase: Phase, name: string): string {
  const finish = `When this phase's work is genuinely done, call ${REVIEW_TOOLS.finishPhase}. Don't call it early; don't linger once it's done.`

  const blocks: Record<string, string> = {
    greeting: `REVIEW · GREETING. Say hello to ${name} and ask if anything is urgent. If something is, handle it now (capture it with ${REVIEW_TOOLS.create}) before moving on. ${finish}`,
    notes: `REVIEW · NOTES. Walk the items below in order (pending, then continuing, then new). For each: decide with ${name} what it should be, fix its type/status with ${REVIEW_TOOLS.setStatus}/${REVIEW_TOOLS.update}, and call ${REVIEW_TOOLS.markDiscussed} once handled. Nothing may stay 'new'. ${finish}`,
    'notes-read': `REVIEW · NOTES-READ. Walk your domain's items below (pending, new, then acknowledge completed, then blocked). Resolve each with ${name}; mark it discussed. Nothing stays 'new'; try to move anything off 'blocked'. ${finish}`,
    projects: `REVIEW · PROJECTS. The list below is your PROJECTS — each is a folder holding related items. Go through them one at a time with ${name}. For each project you can: look at what's inside it (${REVIEW_TOOLS.search} with that project's projectId), nudge its progress (${REVIEW_TOOLS.updateProject}), and — if ${name} wants to act on it — capture a concrete item inside it (${REVIEW_TOOLS.create} with projectId set to that project). Leaving a project untouched is fine. The moment you've talked a project through, call ${REVIEW_TOOLS.markDiscussed} with THAT PROJECT'S id — every project must be marked before the phase will close. ${finish}`,
    submodalities: `REVIEW · SUBMODALITIES. The engine has already booked any "talk to <self>" items that were due and flagged the selves needing attention (shown below). Walk them with ${name} so he knows what's coming. ${finish}`,
    user: `REVIEW · USER. Check in on ${name} himself — how he's doing, anything else on his mind. Capture anything that surfaces (${REVIEW_TOOLS.create}). ${finish}`,
    calendar: `REVIEW · CALENDAR. The items below are queued for scheduling. Confirm timing with ${name}; the engine writes the calendar and flips each schedule→scheduled. ${finish}`,
    'notes-pass': `REVIEW · NOTES-PASS. The items below are everything that may need to go up to Penny — already-escalated ones plus anything you created this session. For each, decide with ${name} whether it goes up; mark it sent-to-PA (${REVIEW_TOOLS.setStatus}) if so. ${finish}`,
    'wrap-up': `REVIEW · WRAP-UP. The engine handles the cleanup (deleting flagged items, saving memories, resetting state). Give ${name} a brief, honest sign-off on what got done. ${finish}`,
  }
  void kind
  return blocks[phase] ?? `REVIEW · ${phase}. ${finish}`
}
