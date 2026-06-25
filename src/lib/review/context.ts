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
  appendNote: 'append_note',
  updateProject: 'update_project',
  createProject: 'create_project',
  setStatus: 'set_item_status',
  markDiscussed: 'mark_discussed',
  finishPhase: 'finish_phase',
} as const

const COMMON_TRIAGE = [
  REVIEW_TOOLS.search,
  REVIEW_TOOLS.create,
  REVIEW_TOOLS.update,
  REVIEW_TOOLS.appendNote,
  REVIEW_TOOLS.setStatus,
  REVIEW_TOOLS.markDiscussed,
  REVIEW_TOOLS.finishPhase,
]

const PA_PHASE_TOOLS: Record<string, string[]> = {
  greeting: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.appendNote, REVIEW_TOOLS.finishPhase],
  notes: COMMON_TRIAGE,
  projects: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.update, REVIEW_TOOLS.appendNote, REVIEW_TOOLS.updateProject, REVIEW_TOOLS.createProject, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.markDiscussed, REVIEW_TOOLS.finishPhase],
  // The engine books the "talk to X" items and bumps attention BEFORE this turn;
  // the self just reviews what was booked.
  submodalities: [REVIEW_TOOLS.search, REVIEW_TOOLS.finishPhase],
  // Same calendar tools as live chat (see the calendar protocol) — Penny reads
  // the queue + the real calendar, places the actual events, then flips status.
  calendar: [
    REVIEW_TOOLS.search,
    REVIEW_TOOLS.setStatus,
    'read_calendar_day',
    'search_calendar',
    'schedule_pending_events',
    'create_calendar_event',
    'update_calendar_event',
    REVIEW_TOOLS.finishPhase,
  ],
  'wrap-up': [REVIEW_TOOLS.finishPhase],
}

const SUB_PHASE_TOOLS: Record<string, string[]> = {
  greeting: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.appendNote, REVIEW_TOOLS.finishPhase],
  'notes-read': COMMON_TRIAGE,
  projects: [REVIEW_TOOLS.search, REVIEW_TOOLS.create, REVIEW_TOOLS.update, REVIEW_TOOLS.appendNote, REVIEW_TOOLS.updateProject, REVIEW_TOOLS.createProject, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.markDiscussed, REVIEW_TOOLS.finishPhase],
  // The engine pre-loads the notes-pass queue (sent-to-PA + this-session items);
  // the self decides each, the engine copies the chosen ones up to Penny.
  'notes-pass': [REVIEW_TOOLS.search, REVIEW_TOOLS.setStatus, REVIEW_TOOLS.create, REVIEW_TOOLS.appendNote, REVIEW_TOOLS.markDiscussed, REVIEW_TOOLS.finishPhase],
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

  const noDupes = `If what ${name} just said is more about something ALREADY listed below — not a new thing — use ${REVIEW_TOOLS.appendNote} to add it to that item's notes. Do NOT call ${REVIEW_TOOLS.create} for an update to something that already exists; a new Item for the same thing is the #1 mistake to avoid.`

  const blocks: Record<string, string> = {
    greeting: `REVIEW · GREETING. Say hello to ${name} and ask if anything is urgent. If something is, handle it now (capture it with ${REVIEW_TOOLS.create}) before moving on. ${finish}`,
    notes: `REVIEW · NOTES. Walk the items below in order (pending, then contingent, then new). For each: decide with ${name} what it should be, fix its type/status with ${REVIEW_TOOLS.setStatus}/${REVIEW_TOOLS.update}, and call ${REVIEW_TOOLS.markDiscussed} once handled. Nothing may stay 'new'. A contingent item whose recheck date hasn't arrived yet won't even be listed — only act on the ones shown. If one of these looks like a recurring commitment rather than a one-off (you've seen it, or something like it, before), say so to ${name} — but don't convert it here; bring it up in the projects phase below, which has the right tools for that. ${noDupes} ${finish}`,
    'notes-read': `REVIEW · NOTES-READ. Walk your domain's items below (pending, contingent, new, then completed). Resolve each with ${name}; mark it discussed. Nothing stays 'new'; try to move anything off 'contingent' once you have an answer. A contingent item whose recheck date hasn't arrived yet won't even be listed. If one of these looks like a recurring commitment rather than a one-off, say so — but save the actual conversion for the projects phase. ${noDupes} ${finish}`,
    projects: `REVIEW · PROJECTS. The list below is your PROJECTS — each is a folder holding related items. Go through them one at a time with ${name}. For each project you can: look at what's inside it (${REVIEW_TOOLS.search} with that project's projectId), nudge its progress (${REVIEW_TOOLS.updateProject}), and — if ${name} wants to act on it — capture a concrete item inside it (${REVIEW_TOOLS.create} with projectId set to that project). Leaving a project untouched is fine. The moment you've talked a project through, call ${REVIEW_TOOLS.markDiscussed} with THAT PROJECT'S id — every project must be marked before the phase will close.

ALSO: this is where a recurring item gets upgraded. If you flagged one earlier (or notice now, via ${REVIEW_TOOLS.search}) that's really a recurring commitment being recreated instance after instance rather than a true one-off — confirm with ${name}, then ${REVIEW_TOOLS.createProject} for it and mark the old duplicate item(s) completed or to-delete so they stop reappearing. From then on each occurrence is its own fresh item (${REVIEW_TOOLS.create}) carrying that project's id, made when it's actually due — not all at once. ${noDupes} ${finish}`,
    submodalities: `REVIEW · SUBMODALITIES. The engine has already booked any "talk to <self>" items that were due and flagged the selves needing attention (shown below). Walk them with ${name} so he knows what's coming. ${finish}`,
    calendar: `REVIEW · CALENDAR. The items below are queued for scheduling (paStatus='schedule'). Nothing here is on the calendar yet — you have to put it there:
1. Call schedule_pending_events — it returns the full queue plus a real two-week calendar read, so you're never placing anything blind.
2. For each one, pick an actual slot (respecting what's already on the calendar — never double-book) and call create_calendar_event(title, start, end, ...). If ${name} wants to adjust timing, talk it through first; otherwise use your own judgment.
3. The moment an event is really on the calendar, call set_item_status(id, side='pa', to='scheduled') — not before. A 'scheduled' item with nothing on the calendar is worse than one still queued, so don't flip status as a shortcut to finishing this phase.
Work highest priority first. ${finish}`,
    'notes-pass': `REVIEW · NOTES-PASS. The items below are everything that may need to go up to Penny — already-escalated ones plus anything you created this session. For each, decide with ${name}: if it goes up, mark it sent-to-PA (${REVIEW_TOOLS.setStatus}); if it stays in your world, call ${REVIEW_TOOLS.markDiscussed} on it. Every item must be settled one way or the other before the phase closes. ${finish}`,
    'wrap-up': `REVIEW · WRAP-UP. The engine handles the cleanup (deleting flagged items, saving memories, resetting state). Give ${name} a brief, honest sign-off on what got done. ${finish}`,
  }
  void kind
  return blocks[phase] ?? `REVIEW · ${phase}. ${finish}`
}
