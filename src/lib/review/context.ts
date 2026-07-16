// Per-phase plan: which tools a phase grants, and the instruction block injected
// into the active self's prompt for that phase. The tool grant is pure and tested
// — the engine refuses to hand the model a tool the phase didn't authorize, so a
// phase can't reach outside its job.

import type { ReviewKind, Phase } from './phases'

// The review tool surface: the two generic table tools (item + project rows)
// plus review-session control. Defined in items/item-tools.ts.
export const REVIEW_TOOLS = {
  queryTable: 'query_table',
  writeTable: 'write_table',
  markDiscussed: 'mark_discussed',
  finishPhase: 'finish_phase',
} as const

const COMMON_TRIAGE = [
  REVIEW_TOOLS.queryTable,
  REVIEW_TOOLS.writeTable,
  REVIEW_TOOLS.markDiscussed,
  REVIEW_TOOLS.finishPhase,
]

const PA_PHASE_TOOLS: Record<string, string[]> = {
  notes: COMMON_TRIAGE,
  projects: COMMON_TRIAGE,
  // The engine books the "talk to X" items and bumps attention BEFORE this turn;
  // the self just reviews what was booked.
  submodalities: [REVIEW_TOOLS.queryTable, REVIEW_TOOLS.finishPhase],
  // Same calendar tools as live chat (see the calendar protocol) — Penny reads
  // the queue + the real calendar, places the actual events, then flips stage.
  calendar: [
    REVIEW_TOOLS.queryTable,
    REVIEW_TOOLS.writeTable,
    'read_calendar_day',
    'search_calendar',
    'schedule_planned_items',
    'create_calendar_event',
    'update_calendar_event',
    REVIEW_TOOLS.finishPhase,
  ],
  'wrap-up': [REVIEW_TOOLS.finishPhase],
}

const SUB_PHASE_TOOLS: Record<string, string[]> = {
  'notes-read': COMMON_TRIAGE,
  projects: COMMON_TRIAGE,
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

  const noDupes = `If what ${name} just said is more about something ALREADY listed below — not a new thing — use ${REVIEW_TOOLS.writeTable} with \`append: { notes: "..." }\` to add it to that item's notes. Do NOT write_table a new row for an update to something that already exists; a duplicate row for the same thing is the #1 mistake to avoid.`

  // This is the FIRST phase of each review (greeting was retired), so its block
  // opens with a quick hello before getting to the items.
  const blocks: Record<string, string> = {
    notes: `REVIEW · NOTES — the start of the review. Open with a warm one-line hello to ${name}, then get to work. Walk the items below in order (backlog, then blocked, then done — to acknowledge). For each: decide with ${name} what it should be, fix its type/stage with ${REVIEW_TOOLS.writeTable}(table='item', id=..., fields={...}), and call ${REVIEW_TOOLS.markDiscussed} once handled. A backlog item you and ${name} deliberately leave as backlog is fine — that's a real decision, not a skipped one, as long as you discussed it. The moment something is genuinely committed to, move it to 'planned' (fields={stage:'planned'}) — that's how it reaches Penny; there's no separate hand-off step. A blocked item whose recheck date hasn't arrived yet won't even be listed — only act on the ones shown. If one of these looks like a recurring commitment rather than a one-off (you've seen it, or something like it, before), say so to ${name} — but don't convert it here; bring it up in the projects phase below, which has the right tools for that. ${noDupes} ${finish}`,
    'notes-read': `REVIEW · NOTES-READ — the start of the review. Open with a warm one-line hello to ${name}, then get to work. Walk your domain's items below (backlog, blocked, then done — to acknowledge). Resolve each with ${name}; mark it discussed. A backlog item left as backlog is a fine outcome once you've actually talked about it; try to move anything off 'blocked' once you have an answer. The moment something is genuinely committed to, move it to 'planned' (fields={stage:'planned'}) — Penny picks up every planned item across every domain on her own, so there's nothing further for you to do to hand it to her. A blocked item whose recheck date hasn't arrived yet won't even be listed. If one of these looks like a recurring commitment rather than a one-off, say so — but save the actual conversion for the projects phase. ${noDupes} ${finish}`,
    projects: `REVIEW · PROJECTS. The list below is your PROJECTS — each is a folder holding related items. Go through them one at a time with ${name}. For each project you can: look at what's inside it (${REVIEW_TOOLS.queryTable}(table='item', projectId=...)), nudge it forward (${REVIEW_TOOLS.writeTable}(table='project', id=..., fields={...})), and — if ${name} wants to act on it — capture a concrete item inside it (${REVIEW_TOOLS.writeTable}(table='item', fields={..., projectId: that project's id})). This is also where you and ${name} decide WHICH tasks make up the project right now — that decision is a conversation, never something you generate on your own. Leaving a project untouched is fine. The moment you've talked a project through, call ${REVIEW_TOOLS.markDiscussed} with THAT PROJECT'S id — every project must be marked before the phase will close.

ALSO: this is where a recurring item gets upgraded. If you flagged one earlier (or notice now, via ${REVIEW_TOOLS.queryTable}) that's really a recurring commitment being recreated instance after instance rather than a true one-off — confirm with ${name}, then ${REVIEW_TOOLS.writeTable}(table='project', fields={...}) to create it, and mark the old duplicate item(s) done or cancelled so they stop reappearing. From then on each occurrence is its own fresh item carrying that project's id, made when it's actually due — not all at once. ${noDupes} ${finish}`,
    submodalities: `REVIEW · SUBMODALITIES. The engine has already booked any "talk to <self>" items that were due and flagged the selves needing attention (shown below). Walk them with ${name} so he knows what's coming. ${finish}`,
    calendar: `REVIEW · CALENDAR. The items below are committed and waiting on a slot (stage='planned'). Nothing here is on the calendar yet — you have to put it there:
1. Call schedule_planned_items — it returns the full queue plus a real two-week calendar read, so you're never placing anything blind.
2. For each one, pick an actual slot (respecting what's already on the calendar — never double-book) and call create_calendar_event(title, start, end, ...). If ${name} wants to adjust timing, talk it through first; otherwise use your own judgment.
3. The moment an event is really on the calendar, call ${REVIEW_TOOLS.writeTable}(table='item', id=..., fields={stage:'scheduled'}) — not before. A 'scheduled' item with nothing on the calendar is worse than one still queued, so don't flip stage as a shortcut to finishing this phase.
Work highest priority first. ${finish}`,
    'wrap-up': `REVIEW · WRAP-UP. The engine handles the cleanup (deleting flagged items, saving memories, resetting state). Give ${name} a brief, honest sign-off on what got done. ${finish}`,
  }
  void kind
  return blocks[phase] ?? `REVIEW · ${phase}. ${finish}`
}
