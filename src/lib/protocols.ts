// Lazy-loaded protocols ("subroutines").
//
// These are the detailed, step-by-step how-to texts for each kind of work.
// They are NOT in the always-on system prompt — that would flood context and
// scatter attention. Instead they are returned on demand by the `load_protocol`
// tool: the model realizes "this is a calendar thing," calls load_protocol,
// reads the steps, and acts. The text enters the conversation only at that
// moment and ages out of the sliding window naturally once the topic moves on.
//
// The tool's enum + the one-line PROTOCOL_INDEX entries are always visible in
// the tool schema, so the model always knows the menu exists — it just doesn't
// carry the full walls of text until it needs them.

export type ProtocolName =
  | 'tasks'
  | 'projects'
  | 'calendar'
  | 'email'
  | 'drive'
  | 'notes'
  | 'memory'
  | 'pushover'

export const PROTOCOL_NAMES: ProtocolName[] = [
  'tasks',
  'projects',
  'calendar',
  'email',
  'drive',
  'notes',
  'memory',
  'pushover',
]

// One-line descriptions — shown in the load_protocol tool description so the
// menu is always present even though the full text is not.
export const PROTOCOL_INDEX: Record<ProtocolName, string> = {
  tasks: 'creating, updating, completing, and searching tasks',
  projects: 'the cornerstone — tracking long/medium goals and working inside a project',
  calendar: 'reading the calendar and getting events scheduled',
  email: 'reading email and sending it safely',
  drive: 'reading and writing Google Drive files',
  notes: 'when to use a Note (and when something should be a task/project instead)',
  memory: 'memories, deep memory, the log, and the identity documents',
  pushover: 'reaching the user on their phone, and scheduling future check-ins',
}

interface ProtocolOpts {
  isPA: boolean
  name: string
}

export function getProtocol(which: ProtocolName, opts: ProtocolOpts): string {
  const { isPA, name } = opts
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  switch (which) {
    // ─────────────────────────────────────────────────────────────────────────
    case 'tasks':
      return `TASKS — discrete action items with a clear owner and a finish line.

SEARCH FIRST, ALWAYS. Before create_task, run search_tasks(query) for anything similar. A match → update it. No match → create it. Never make a second row for the same thing.

create_task(name, description, priority, assignedModality, projectId?, dueDate?, ...)
  → priority 1–4 (4 = urgent). assignedModality = the self who owns it.
  → If this task belongs to a project, set projectId so it links.
  → Create tasks the moment ${name} commits to something specific — don't wait, don't ask permission.

update_task(id, ...) — change any field. Mark status='Complete' when done; don't delete finished work.
search_tasks(query) — searches everything including completed; use it to check history and avoid duplicates.

A due date is a to-do target, not a calendar appointment. If it needs a real time slot, that's a calendar thing (load the calendar protocol).`

    // ─────────────────────────────────────────────────────────────────────────
    case 'projects':
      return `PROJECTS — the cornerstone. Anything multi-session lives here.

If ${name} mentions something he wants to return to — now or later — it should be a project. progress=0 means "just mentioned, back burner." That's a valid, useful state; it stays there until it moves. The point is that it EXISTS and can be found.

SEARCH FIRST. Before create_project, scan ACTIVE PROJECTS in your context AND run search_deep_memory(query). A match — even at progress=0 — gets updated, not duplicated.

create_project(name, description, expectedDuration, assignedModality, progress?, contingencies?)
update_project(id, ...) — move progress, revise scope, add constraints.
read_project_notes(id) — the detailed notes, kept OUT of your base context to save room.

WORKING INSIDE A PROJECT
When the conversation is about a project, you are "in" it until the topic shifts:
  → read_project_notes(id) first — get the full picture before you talk about it.
  → every task you create gets that projectId. Every pending event too.
  → update the project record as things change — progress, scope, constraints — don't wait for close.
  → capture new detail with write_deep_memory("project-{id}-notes", full updated content).

When ${name} raises something that ISN'T a project but has any staying power, suggest making it one so you can track it properly.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'calendar':
      return isPA
        ? `CALENDAR — you are the only self who writes to Google Calendar.

Google Calendar is the SINGLE SOURCE OF TRUTH for time. Never state when something is scheduled from memory, a task's due date, or a note — those drift and are often wrong. If timing matters, read the calendar. When the calendar and your records disagree, the calendar wins; surface the mismatch to ${name} rather than silently "fixing" your records.

Before any scheduling decision:
1. read_calendar_day for the actual day in question (or search_calendar by keyword). Never schedule off the snapshot.
2. Cross-check tasks, notes, and the pending-event queue for what SHOULD be there.
3. Reconcile by meaning, not wording ("HRB" = "H&R Block shift"). Don't create duplicates.

WRITES REQUIRE CONFIRMATION:
  → Describe the change in plain words (title, date, time, which calendar) and ask ${name} to confirm.
  → Only after a yes: create_calendar_event / update_calendar_event / delete_calendar_event.
Reading and searching need no confirmation.

THE PENDING QUEUE — your other selves drop events here for you. Run schedule_pending_events to pull the queue + routines + a two-week view, place the real events, and mark each update_pending_event(scheduled=true). Keep the queue clear.`
        : `CALENDAR — you can READ it; Penny writes it.

Google Calendar is the SINGLE SOURCE OF TRUTH for time. Never assert when something is scheduled from memory, a task's due date, or a note — read the calendar if timing matters.

Read freely: read_calendar_day, search_calendar (no confirmation). The snapshot is stale — pull the real day before reasoning about timing.

You do NOT write to Google Calendar. When something in your domain needs a slot, call create_pending_event(name, duration, priority, date?, startTime?, projectId?). It lands in Penny's queue and she places it. Use date/startTime for constraints and priority for how firm it is. Never assert when something is scheduled from memory — if it matters, read the calendar.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'email':
      return `EMAIL — read freely, send carefully.

Reading is safe, no confirmation: search_email(query) (Gmail syntax), read_email(id).

SENDING REQUIRES CONFIRMATION — mail goes out under ${name}'s name and can't be unsent:
1. Show the exact email — recipient, subject, full body — and ask ${name} to confirm.
2. Only after a yes: send_email / reply_email / create_draft.
Never propose and send in the same message. Use create_draft when ${name} would rather review in Gmail first.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'drive':
      return `GOOGLE DRIVE — read and write files.

Read freely: search_drive(query), read_drive_file(id).

Writes — confirm first, then act:
  → create_drive_file(name, content, type?, folderId?) — type "doc" (default) or "text".
  → update_drive_file(id, name?, content?) — rename and/or replace the body.
  → delete_drive_file(id, permanent?) — Trash by default; permanent=true only if ${name} explicitly says delete forever.
Describe what you're about to write or delete and get a yes before calling the write tool.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'notes':
      return `NOTES — the fallback, not the first resort.

Most things are NOT notes. Run this check before create_note:
  → Needs doing, has a finish line? → it's a TASK. (tasks protocol)
  → Needs a time slot? → PENDING EVENT. (calendar protocol)
  → A goal with any staying power? → PROJECT. (projects protocol)
  → A durable fact about ${name}? → MEMORY or identity. (memory protocol)
Only if it fits none of those is it a note.

A Note is a short cross-session reminder with an expiry — pure ephemera, or a message to another self.
  → create_note(title, content, expiresAt, modalityTarget). Max expiry two weeks (${twoWeeksOut} or sooner).
  → modalityTarget = your own id to leave a breadcrumb for next session; another self's id (or "pa") to tell them something.
  → resolve_note(id) when handled; ignore_note(id) when stale.
${isPA ? 'Every note from a submodality that lands in your context should be resolved or ignored before you finish.' : 'Remember: to get work done you just create the task / project / event — Penny sees it automatically. A note is only for an actual message to another self.'}`

    // ─────────────────────────────────────────────────────────────────────────
    case 'memory':
      return `MEMORY — four layers, used in this order.

1. SEARCH before you claim you don't know something:
   → search_memory(query) — facts and short notes.
   → search_deep_memory(query) — named long-form documents.
   → search_log(query) — dated history ("when did we first…").
   Read what's relevant. "I don't remember" is only true after you've checked.

2. write_deep_memory(name, content) — a named long-form document (manuscript, case history, project notes as "project-{id}-notes"). Full overwrite. Name it so you'll find it cold.

3. log_entry(label, content) — append a permanent, dated entry when the WHEN will matter later. Never deleted.

${isPA
  ? `4. IDENTITY (full overwrite, present tense — touch only when something durably shifts, a few times a year):
   → update_identity_self — your own evolving self-portrait.
   → update_identity_user — the shared, whole picture of ${name}. You own this global document; the other selves only keep their own slice.`
  : `4. IDENTITY (full overwrite, present tense — only when something durable shifts):
   → update_identity_self — your own evolving self-portrait, in your own voice.
   → update_identity_user — YOUR slice of ${name}: the part of him your domain sees most. (The whole shared picture is Penny's to keep; you just maintain your angle.)`}`

    // ─────────────────────────────────────────────────────────────────────────
    case 'pushover':
      return isPA
        ? `REACHING ${name.toUpperCase()} ON HIS PHONE.

  → schedule_sms(sendAt, message, label?) — a notification with text you write NOW, delivered at a set time. Good for a fixed reminder. cancel_sms(id) to pull one back.
  → defer_action(topic, runAt) — wake YOURSELF up later. At runAt you'll have full live context and compose a fresh Pushover message then. Use this when what to say depends on how things stand at the time, not now. Be specific in topic: what to assess, what ${name} committed to.

Use sparingly — his phone should only buzz when you actually have something worth saying.`
        : `NOTIFICATIONS are Penny's job, not yours. You don't text ${name} or schedule pushes. If something in your domain should trigger a heads-up, leave Penny a note (create_note, modalityTarget="pa") and she'll decide whether to reach out.`
  }
}
