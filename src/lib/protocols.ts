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
  | 'items'
  | 'projects'
  | 'calendar'
  | 'email'
  | 'drive'
  | 'memory'
  | 'pushover'
  | 'review'

// The full set, for getProtocol's type. 'memory' is deliberately NOT live-chat
// callable (see LIVE_PROTOCOL_NAMES below) — it's only ever invoked directly,
// server-side, by the end_chat memory pass (src/lib/memory-pass.ts), which has
// its own dedicated tool grant. There is nothing for a self to act on it with
// mid-conversation now that the memory/identity tools live there exclusively.
export const PROTOCOL_NAMES: ProtocolName[] = [
  'items',
  'projects',
  'calendar',
  'email',
  'drive',
  'memory',
  'pushover',
  'review',
]

// What load_protocol's tool schema actually exposes during live chat.
export const LIVE_PROTOCOL_NAMES: ProtocolName[] = PROTOCOL_NAMES.filter((n) => n !== 'memory')

// One-line descriptions — shown in the load_protocol tool description so the
// menu is always present even though the full text is not.
export const PROTOCOL_INDEX: Record<ProtocolName, string> = {
  items: 'creating, updating, completing, and searching items — tasks, events, notes',
  projects: 'the cornerstone — tracking long/medium goals and working inside a project',
  calendar: 'reading the calendar and getting events scheduled',
  email: 'reading email and sending it safely',
  drive: 'reading and writing Google Drive files',
  memory: 'deep memory, the log, and the identity documents — end_chat only, not live',
  pushover: 'reaching the user on their phone, and scheduling future check-ins',
  review: 'starting or resuming a structured Review session',
}

interface ProtocolOpts {
  isPA: boolean
  name: string
}

export function getProtocol(which: ProtocolName, opts: ProtocolOpts): string {
  const { isPA, name } = opts

  switch (which) {
    // ─────────────────────────────────────────────────────────────────────────
    case 'items':
      return `ITEMS — the one surface for everything you track: one-off tasks, events, notes-to-self.

SEARCH FIRST, ALWAYS. Before create_item, run search_items(query) for anything similar (and scan what's already in your context). A match → append_note to add what you learned, or update_item if a field genuinely changed. No match → create_item. Never make a second item for the same thing — that's the #1 mistake to avoid.

create_item(name, description, type, target, priority?, duration?, dayTime?, dueDate?, projectId?, contingency?, contingencyUntil?)
  → type: task | event | memory | suggestion.
  → target: a modality id, or "pa" to send it to Penny.
  → priority 0–5 (5 = urgent). Set 5 only for things that must be addressed as soon as possible..
  → If this item belongs to a project, set projectId so it links.
  → Create the moment ${name} commits to something specific — don't wait, don't ask permission.
  → A dueDate is a to-do target, not a calendar appointment. If it needs a real time slot, that's a calendar thing (load the calendar protocol).

RECURRING THINGS ARE PROJECTS, NOT REPEATED ITEMS. If you catch yourself about to create basically the same item again — "yoga every morning," a weekly report, anything that comes back on its own schedule — stop. That's a recurring commitment; it belongs in a Project (see the projects protocol), not as a fresh item each time it recurs. Flag it to ${name} instead of quietly re-minting the item.

STUCK ON SOMETHING OUTSIDE YOUR CONTROL? Use contingency (a short phrase — "waiting on IRS callback") and, if you genuinely know a real recheck date, contingencyUntil (YYYY-MM-DD). Set status to 'contingent' (set_item_status) rather than re-asking ${name} about it every pass. While contingencyUntil is still in the future, the item is hidden entirely from review and notes — it resurfaces on its own once that date arrives, or any time sooner if you clear the contingency.

update_item(id, ...) — change any field, including reassigning target if it was filed under the wrong domain.
append_note(id, text) — add a dated line to the item's free-write notes field. Use this constantly as you learn more — it's the alternative to minting a duplicate item.
set_item_status(id, side, to) — move its lifecycle (pa or modality side). Mark completed when done; don't delete finished work.
search_items(query?, target?, type?, projectId?) — searches everything including completed; use it to check history and avoid duplicates.

A short cross-session reminder with no real owner or finish line — pure ephemera, or a message to another self — is still just an item; give it a low priority and a plain description rather than overloading some other field.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'projects':
      return `PROJECTS — the cornerstone. Anything multi-session lives here.

If ${name} mentions something he wants to return to — now or later — it should be a project. progress=0 means "just mentioned, back burner." That's a valid, useful state; it stays there until it moves. The point is that it EXISTS and can be found.

SEARCH FIRST. Before create_project, scan ACTIVE PROJECTS in your context AND run search_deep_memory(query). A match — even at progress=0 — gets updated, not duplicated.

create_project(name, description, expectedDuration, assignedModality, progress?, contingencies?, contingencyUntil?)
update_project(id, ...) — move progress, revise scope, add constraints.
read_project_notes(id) — the detailed notes, kept OUT of your base context to save room.
  → contingencyUntil: a real recheck date (YYYY-MM-DD), if known. While it's still in the future, the project is skipped entirely in review — don't set it unless you actually have a date to wait for.

WORKING INSIDE A PROJECT
When the conversation is about a project, you are "in" it until the topic shifts:
  → read_project_notes(id) first — get the full picture before you talk about it.
  → every task you create gets that projectId. Every pending event too.
  → update the project record as things change — progress, scope, constraints — don't wait for close.
  → capture new detail with write_deep_memory("project-{id}-notes", full updated content).

When ${name} raises something that ISN'T a project but has any staying power, suggest making it one so you can track it properly.

UPGRADING A RECURRING ITEM. There is no automatic spawning — a recurring commitment ("yoga every morning," a weekly report) will keep showing up as the SAME item being recreated, because nothing else makes a Project on its own. When you notice that pattern (duplicate or near-duplicate items, same name, recurring cadence), say so to ${name} and, if he agrees it's an ongoing thing: create_project for it, then mark the old duplicate item(s) completed (or to-delete if they were just placeholders) so they don't linger. From then on, each future occurrence is its own fresh item with that projectId — created when it's actually time to do it, not all at once.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'calendar':
      return isPA
        ? `CALENDAR — you are the only self who writes to Google Calendar.

Google Calendar is the SINGLE SOURCE OF TRUTH for time. Never state when something is scheduled from memory, a task's due date, or a note — those drift and are often wrong. If timing matters, read the calendar. When the calendar and your records disagree, the calendar wins; surface the mismatch to ${name} rather than silently "fixing" your records.

Before any scheduling decision:
1. read_calendar_day for the actual day in question (or search_calendar by keyword). Never schedule off the snapshot.
2. Cross-check search_items for what SHOULD be there.
3. Reconcile by meaning, not wording ("HRB" = "H&R Block shift"). Don't create duplicates.

WRITES REQUIRE CONFIRMATION:
  → Describe the change in plain words (title, date, time, which calendar) and ask ${name} to confirm.
  → Only after a yes: create_calendar_event / update_calendar_event / delete_calendar_event.
Reading and searching need no confirmation.

THE PENDING QUEUE — items with paStatus='schedule' are waiting on you. A fresh item a submodality sends you lands as 'new' first and surfaces in your notes phase; she only jumps the queue if she (or you) explicitly call set_item_status(id, side='pa', to='schedule') once it's clearly calendar-ready. Run schedule_pending_events to pull the queue + ongoing items + a two-week view, place the real events, and mark each set_item_status(id, side='pa', to='scheduled'). Keep the queue clear.`
        : `CALENDAR — you can READ it; Penny writes it.

Google Calendar is the SINGLE SOURCE OF TRUTH for time. Never assert when something is scheduled from memory or an item's due date — read the calendar if timing matters.

Read freely: read_calendar_day, search_calendar (no confirmation). The snapshot is stale — pull the real day before reasoning about timing.

You do NOT write to Google Calendar. When something in your domain needs a slot, create_item(..., target='pa') with the timing as dueDate/dayTime. It lands as a fresh item in Penny's world (paStatus='new') and she triages it in her notes phase; if it's urgent and unambiguously calendar-ready right now, also call set_item_status(id, side='pa', to='schedule') so it jumps straight to her pending queue instead of waiting on triage. Never assert when something is scheduled from memory — if it matters, read the calendar.`

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
    case 'memory':
      return `MEMORY — run ONCE, at end_chat, over the full transcript since your last pass.

You're handed everything ${name} said to you since you last ran this. Read it as a whole before acting — don't react message by message. Most of it probably isn't worth keeping. Decide, fact by fact, what is worth commiting to memory, and which of the three layers below it belongs to.

1. SEARCH FIRST, always — search_deep_memory(query), search_log(query) — before writing anything. A fact already on record gets updated, never duplicated. search_deep_memory is a literal keyword match on the name and content, not a guess at meaning — if you're not sure a doc exists, check your brief first (every doc worth having is pointed to from there; see #2).

2. write_deep_memory(name, content) — named, substantial documents: a project history, an ongoing situation, real elaboration that doesn't fit a sentence. Full overwrite — read_deep_memory(name) first if you're updating one, so you don't drop what's already there. Whenever you write a NEW doc, or touch one not already pointed to from your brief, add a one-line pointer to it there in this same pass ("doc: project-x-notes — ongoing renovation, contractor disputes") — an untracked doc is one future-you will forget exists.

3. log_entry(label, content) — append a permanent, dated entry when the WHEN will matter later ("first mentioned wanting to do X on..."). Never edited, never deleted.

${isPA
  ? `4. IDENTITY (full overwrite, present tense — only when something in this transcript durably shifted who you are or who ${name} is, not every pass):
   → update_identity_self — your own evolving self-portrait.
   → update_identity_user — the shared, whole picture of ${name}. You own this global document; the other selves only keep their own slice. Small durable facts (a preference, a detail about his life) belong HERE, in a sentence — not as a separate memory entry. This document is rendered into every conversation, so it's the most discoverable layer you have.`
  : `4. IDENTITY (full overwrite, present tense — only when something in this transcript durably shifted who you are or who ${name} is, not every pass):
   → update_identity_self — your own evolving self-portrait, in your own voice.
   → update_identity_user — YOUR slice of ${name}: the part of him your domain sees most. Small durable facts belong HERE, in a sentence — not as a separate memory entry. (The whole shared picture is Penny's to keep; you just maintain your angle.)`}

Finish every pass with rewrite_brief — synthesize what happened, in your own voice, and confirm every deep-memory doc that still matters is pointed to from it.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'pushover':
      return isPA
        ? `REACHING ${name.toUpperCase()} ON HIS PHONE.

  → schedule_sms(sendAt, message, label?) — a notification with text you write NOW, delivered at a set time. Good for a fixed reminder. cancel_sms(id) to pull one back.
  → defer_action(topic, runAt) — wake YOURSELF up later. At runAt you'll have full live context and compose a fresh Pushover message then. Use this when what to say depends on how things stand at the time, not now. Be specific in topic: what to assess, what ${name} committed to.

Use sparingly — his phone should only buzz when you actually have something worth saying.`
        : `NOTIFICATIONS are Penny's job, not yours. You don't text ${name} or schedule pushes. If something in your domain should trigger a heads-up, create_item(..., target='pa') describing it and she'll decide whether to reach out.`

    // ─────────────────────────────────────────────────────────────────────────
    case 'review':
      return `REVIEW — a structured, phase-by-phase walk through everything pending, separate from how you normally talk to ${name}.

Call start_review() the moment ${name} says yes to going into Review. It takes no arguments — it always starts (or resumes) YOUR review, in your own world. There is nothing else to do on your end: the call hands the rest of this conversation to the Review system, which runs its own phases, its own prompts, and its own exit rules. Don't describe what's about to happen or narrate the phases — just call it and let it take over.

If ${name} says no, or it's not the moment, simply continue the conversation as normal — there's no harm in asking again next time.`
  }
}
