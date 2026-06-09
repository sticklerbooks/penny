# Penny Memory System — Design Plan

## Background

The current system loads up to 80 flat memories into every system prompt, costing significant tokens and producing diminishing returns. This plan replaces it with a three-tier architecture inspired by how human memory actually works: a small, always-present working state; organized knowledge fetched on demand; and a searchable chronological record that is never fully loaded.

---

## The Three Tiers

### Tier 1 — Brief (always in context)

A short, dense, current-state document for each modality's domain. Always loaded into the system prompt. Rewritten in full when the modality closes a substantive session — never appended to.

- Replaces the flat memory list as the "hot" layer
- Should be ~200–400 words maximum; enforced by instruction, not truncation
- Specific, not categorical: names tasks by name, states status, names people
- Distinct from **Identity** (see below) — Brief is operational and fast-changing; Identity is characterization and slow-changing

**Storage:** a `brief` field per modality, probably on `ModalityState` or a new `ModalityBrief` table (one row per modality per profile).

**Update action:** `<rewrite_brief>[full content]</rewrite_brief>` — replaces entirely, never appends.

### Tier 2 — Deep Memory (searched, not loaded)

Named documents for things that are too detailed or long to live in the Brief but deserve organized preservation: a full creative manuscript, a detailed client case history, a long research note.

- Stored in a `DeepMemory` table: `name`, `content`, `domain`, `profileId`
- Nothing is pre-loaded into context — not even an index
- Access pattern is identical to regular Memory: search, get snippets, read what's relevant
- Distinct from regular Memory by *form*: Memory is a fact or short note; DeepMemory is a named document with length
- Should be rare — if someone is creating many Deep Memories, those things probably belong in structured tables (Client, Task, etc.)

**Actions:**
- `<search_deep_memory query="...">` — returns matching names + snippets
- `<read_deep_memory name="...">` — returns full content of one document
- `<write_deep_memory name="...">content</write_deep_memory>` — creates or fully replaces a named document

### Tier 3 — Log (append-only, searchable, never loaded)

A chronological record of sessions and significant events. Never compressed or deleted. Never loaded in full.

- Only a count and last-entry date appear in the system prompt: `Log: 47 entries. Last: Jun 8.`
- Searchable by query — returns matching entries with dates and snippets
- Used when the date matters, when you want a trail, or when you need to answer "when did we first talk about X?"

**Storage:** a `MemoryLog` table: `id`, `profileId`, `domain`, `label`, `content`, `createdAt` — append-only, no updates, no deletes.

**Actions:**
- `<log_entry label="...">content</log_entry>` — appends one entry
- `<search_log query="...">` — returns matching entries with dates and snippets

---

## Identity (unchanged)

`aboutUser` / `aboutSelf` on Profile remain as-is. Updated by `update_user_profile` and `update_self_notes`. These are the slow-changing characterization layer: who Adam is, deep patterns, significant life context. Brief is operational; Identity is characterization. Both are always in context; both are full-overwrites when updated. Touch Identity only when something genuinely and durably shifts — a few times a year, not weekly.

---

## What Appears in the System Prompt

The memory section of the system prompt becomes:

```
📋 YOUR BRIEF:
[brief content — 200–400 words, dense, current]

🗂 IDENTITY — Adam:
[aboutUser content]

🗂 IDENTITY — [Modality Name]:
[aboutSelf content]

📓 LOG: [n] entries. Last: [date].
```

No flat memory list. No deep memory index. No instructions about how memory works — those live in subroutines.

Regular memories (the existing `Memory` table) become the search layer alongside Deep Memory — searched on demand, not pre-loaded. The `take: 80` auto-load is eliminated.

---

## Subroutines

### CLOSE_SESSION

Run at the end of any substantive session, before switching modalities or completing the session. Skip if nothing happened worth preserving.

1. Read your Brief in full (it is in your system prompt).
2. Review your current context — what happened in this session.
3. For each thing worth preserving, ask:
   - Is it already captured in a structured table (task, calendar event, client record, memory)? → skip
   - Is it going to Deep Memory as a named document? → skip (write the Deep Memory separately, then skip)
   - Is it too small or insignificant to change your operational picture? → skip
4. If anything remains after that filter — something that changes your picture of this domain and lives nowhere else — rewrite the Brief entirely, synthesizing the previous version with what you're adding. Use `<rewrite_brief>`.
5. If nothing remains, leave the Brief alone.

### SEARCH_MEMORY

Before claiming you don't know something, before asking Adam to re-explain something, before creating a new Deep Memory document:

1. Search regular memories: `<search_memory query="...">` — facts and short notes
2. Search Deep Memory: `<search_deep_memory query="...">` — named documents
3. Search the Log if you suspect there's relevant history: `<search_log query="...">`
4. Read what looks relevant. Trust what you find.
5. Only after checking: if nothing surfaces, you genuinely don't have it.

The rule: "I don't remember" is only accurate after you've checked.

### WRITE_MEMORY

When something from a session is worth preserving, decide where it goes. Run through this in order:

**Step 0:** Is this already being captured elsewhere — a task, a calendar event, a client record, a pass-up note to PA? If yes, stop. You don't need to do anything else with it.

**Step 1:** Does this change your operational picture of the domain in a way that isn't captured in any structured record?
→ Note it. The Brief rewrite at close will absorb it. Don't create a separate record now.

**Step 2:** Is this detailed content — a full document, a long case history — that you'll want verbatim later?
→ Write a Deep Memory document: `<write_deep_memory name="descriptive-name.md">full content</write_deep_memory>`
→ Name it so it makes sense when you search for it later.

**Step 3:** Does the date matter? Is this a session milestone, a significant decision, a thing where "when did this happen" will matter later?
→ Log it: `<log_entry label="[what happened]">content with enough context to be useful cold</log_entry>`

**Step 4:** None of the above?
→ Let it go. Not everything needs to be preserved.

---

## Implementation Requirements

### New DB tables

| Table | Key columns | Notes |
|---|---|---|
| `ModalityBrief` | `profileId`, `modalityId`, `content`, `updatedAt` | One row per modality. Replaces flat memory load. |
| `DeepMemory` | `profileId`, `domain`, `name`, `content`, `updatedAt` | Named documents. Searched, not indexed. |
| `MemoryLog` | `profileId`, `domain`, `label`, `content`, `createdAt` | Append-only. Never updated. |
| `Routine` | `profileId`, `domain`, `subject`, `constraint`, `timeContext`, `source` | Scheduling constraints for people and patterns in Adam's life. |

Alternatively `ModalityBrief` could be a column on the existing `ModalityState` table if schema changes are easier there.

**Routines:** loaded only during the scheduling subroutine — not in the base system prompt, not in general memory. The same fact (e.g. Jessica's work schedule) may be known to multiple modalities but each would frame it differently; routines are not person-profile data. `domain` scopes which modality owns a given routine. `timeContext` is a plain-text hint ("weekday evenings", "weekly") for future smarter filtering; not required at first.

### New action types (parseActions / executeActions)

- `rewrite_brief` — replaces ModalityBrief content for the current modalityId
- `search_memory` — queries Memory table, returns snippets (may already exist as a subroutine)
- `search_deep_memory` — queries DeepMemory table by text similarity or keyword
- `read_deep_memory` — returns full content of one named DeepMemory row
- `write_deep_memory` — upserts a DeepMemory row by name
- `log_entry` — appends a row to MemoryLog
- `search_log` — queries MemoryLog by keyword, returns matching entries with dates

### Changes to buildSystemPrompt

- Remove the `take: 80` memory auto-load
- Add Brief content for the current modality (from `ModalityBrief`)
- Add Log count + last date (from `MemoryLog` aggregate)
- Keep Identity (`aboutUser`, `aboutSelf`) as-is
- Remove the memory section that lists flat memories — memories are now search-only

### Changes to nightly hygiene

- The Brief rewrite is now an in-session action (close_session tool), not a hygiene job
- Hygiene still handles: task pruning, note resolution, identity updates
- Pass-up inbox is eliminated — submodalities write to shared tables; Penny reads them directly
- Hygiene may also trigger brief rewrite if the modality was active but close_session was never called (fallback, uses Opus)

### Subroutines → Tools

All subroutines become proper Anthropic tools (JSON schema, required fields, return values). The `src/lib/subroutines/index.ts` file is retired. See Tool Registry below.

---

## Tool Use Migration

### Why now

All new subroutines are being written at once. Converting to proper tool use at the same time means the schemas and instructions only get written once. The XML-regex system (`parseActions` / `executeActions`) is retired entirely.

### What changes

**Server side:**
- `parseActions()` and `executeActions()` are replaced by a tool execution loop
- Each tool has a JSON schema with required fields and types — malformed calls are rejected before reaching the DB
- The model sees success/failure for each tool call and can retry or adjust
- The chat route runs a loop: call API → execute tool calls → feed results back → repeat until done
- A "working…" state is shown in the UI during tool execution gaps (the stream pauses while tools run; this is expected and fine)

**Client side:**
- Stream handler needs to tolerate pauses between tool calls
- Show a subtle working indicator during gaps — not an error state

**Nightly hygiene:**
- No streaming involved — tool use loop is pure server-side, straightforward to implement first
- Implement and test the tool execution loop in hygiene before touching the chat route

### Recommended migration order

1. Write all tool schemas (alongside table design)
2. Implement tool loop in nightly hygiene (no streaming complexity)
3. Migrate chat route (streaming + tool loop)
4. Retire `parseActions` / `executeActions` / `subroutines/index.ts`

---

## Tool Registry

All tools available to modalities. Each is a JSON schema with required fields. Capabilities system controls which modalities get which tools (same as current).

### Task & project tools

| Tool | Required fields | Schema notes |
|---|---|---|
| `create_task` | `name`, `description`, `priority`, `assignedModality` | New formal schema: `projectId?`, `dueDate?`, `dueTime?`, `contingentOn?`, `linkedCalendarEventId?`, `status` enum: Unstarted\|Started\|Waiting on Contingency\|Mostly Complete\|Complete |
| `update_task` | `id` | Same fields as create; all optional except id |
| `delete_task` | `id` | Soft-delete or hard-delete TBD |
| `search_tasks` | `query` | Searches ALL tasks including Complete — override for hidden completed tasks |
| `create_project` | `name`, `description`, `expectedDuration`, `assignedModality` | Fields per TRIAGE doc; `progress` 0–10; `contingencies?`; linked task/event IDs |
| `update_project` | `id` | Updates any field including progress, linked IDs, notes |
| `read_project_notes` | `id` | Fetches detailed notes from DeepMemory for this project |
| `create_routine` | `description`, `frequency`, `priority`, `flexibility` | `priority` and `flexibility` both 1–4; `dayTime?`; `assignedModality` |

### Calendar & scheduling tools

| Tool | Required fields | Schema notes |
|---|---|---|
| `create_pending_event` | `name`, `duration`, `priority` | Staging queue — not written to GCal until confirmed. Fields per TRIAGE doc: `projectId?`, `description?`, `date?`, `startTime?`, `location?` |
| `schedule_pending_events` | _(none)_ | PA only — triggers the full scheduling subroutine against the pending queue |
| `read_calendar_day` | `date` | Fetches GCal agenda for one day |
| `read_calendar_week` | `weekOf` | Fetches GCal agenda for a week |
| `create_calendar_event` | `title`, `start`, `end` | Writes confirmed event directly to Penny's GCal (PA only post-confirmation) |
| `update_calendar_event` | `id` | Updates GCal event |
| `delete_calendar_event` | `id` | Deletes GCal event |
| `search_calendar` | `query` | Searches existing GCal events |
| `calendar_agenda` | `date` | Fetches agenda for date + optional day range |
| `defer_action` | `topic`, `runAt` | Was `schedule_task` — schedules a future cron-like API execution (not a Task in the formal sense). Renamed to avoid confusion. |

### Notes tool

| Tool | Required fields | Schema notes |
|---|---|---|
| `create_note` | `title`, `content`, `expiresAt`, `modalityTarget` | Max 2 weeks expiry enforced by schema; replaces `next_session_note` |
| `resolve_note` | `id` | Marks Open → Resolved |
| `ignore_note` | `id` | Marks Open → Ignored |

### Communication tools

| Tool | Required fields | Schema notes |
|---|---|---|
| `send_email` | `to`, `subject`, `body` | `cc?`, `bcc?` |
| `reply_email` | `thread`, `body` | `to?` |
| `create_draft` | `to`, `subject`, `body` | `cc?`, `bcc?` |
| `search_email` | `query` | `label?` |
| `read_email` | `id` | `label?` |
| `schedule_sms` | `sendAt`, `message` | `label?` |
| `cancel_sms` | `id` | |

### Client tools (Margot only)

| Tool | Required fields | Schema notes |
|---|---|---|
| `create_client` | `name` | All other fields optional: `contactName`, `phone`, `email`, `businessStructure`, `status`, `services`, `grossRevenue`, `billingStatus`, `notes` |
| `update_client` | `id` | Same optional fields |
| `delete_client` | `id` | |

### Drive tools

| Tool | Required fields | Schema notes |
|---|---|---|
| `search_drive` | `query` | `label?` |
| `read_drive_file` | `id` | `label?` |

### Identity & memory tools

| Tool | Required fields | Schema notes |
|---|---|---|
| `update_identity_user` | `content` | Full replacement of aboutUser — was `update_user_profile` |
| `update_identity_self` | `content` | Full replacement of aboutSelf — was `update_self_notes` |
| `update_private_user_profile` | `content` | Lila's version; unchanged |
| `update_private_self_notes` | `content` | Lila's version; unchanged |
| `update_alt_about_user` | `content` | Alt-mode version; unchanged |
| `update_alt_about_self` | `content` | Alt-mode version; unchanged |
| `rewrite_brief` | `content` | Full replacement — triggers Opus model call; called at close_session |
| `search_memory` | `query` | Searches Memory table (facts/short notes); returns snippets |
| `search_deep_memory` | `query` | Searches DeepMemory by name+content; returns names+snippets |
| `read_deep_memory` | `name` | Returns full content of one named DeepMemory document |
| `write_deep_memory` | `name`, `content` | Upserts a DeepMemory document — full replacement |
| `log_entry` | `label`, `content` | Appends to MemoryLog — permanent, never deleted |
| `search_log` | `query` | Searches MemoryLog; returns matching entries with dates |

### Focus lock tools

| Tool | Required fields | Schema notes |
|---|---|---|
| `lock_focus` | `profile`, `release` | `release` enum: timed\|optional; `duration?` |
| `unlock_focus` | `reason` | `reason` enum: approved\|emergency |
| `update_lock_profiles` | `content` | Full replacement |

### System actions (not converted to tools — control routing/UI)

| Action | Notes |
|---|---|
| `artifact` | Renders content in the UI; stays as XML |
| `switch_modality` | Routing — triggers close_session then hands off |
| `complete_session` | Consolidated from `complete_session` + `shift_complete` |

### Retired (do not migrate)

| Action | Replaced by |
|---|---|
| `create_memory` / `update_memory` / `delete_memory` | New memory architecture (`write_deep_memory`, `log_entry`, `rewrite_brief`) |
| `next_session_note` | `create_note` |
| `delete_note` | `ignore_note` |
| `run_subroutine` | Subroutines are now tools |
| `shift_complete` | Merged into `complete_session` |

---

## Visibility Rules

**Default context load (every session):**
- Brief (current modality)
- Identity: aboutUser, aboutSelf (current modality)
- Tasks: active only (status ≠ Complete), scoped to modality. Penny sees all modalities.
- Notes: Open only, targeted to current modality
- PendingCalendarEvents: all pending, scoped to modality. Penny sees all.
- Projects: all active (progress 0–9), summary row only (no detailed notes), scoped to modality. Penny sees progress 3–9 only.
- Routines: NOT loaded by default — loaded only when scheduling subroutine runs
- Log: count + last date only (one line)
- Email/calendar summary: when available

**Never auto-loaded:**
- Completed tasks (searchable via `search_tasks`)
- Archived/ignored notes
- Projects at progress 10 (complete)
- Project detailed notes (fetched via `read_project_notes`)
- DeepMemory content (fetched via `read_deep_memory`)
- Memory facts (searched via `search_memory`)
- Log entries (searched via `search_log`)
- Routines (loaded only during scheduling subroutine)

**Records are never deleted** — tasks and projects stay in the DB forever. Completion/archival removes them from default context. A modality can always search for them explicitly.

---

## Model Tiering

**Opus** — used only for `rewrite_brief`. This is the synthesis moment: reading the full session context and rewriting the domain Brief from scratch. High-quality compression matters here. Everything else is Sonnet or Haiku.

**Sonnet** — default model for all conversation turns and most tool decisions. Scheduling subroutine (complex calendar reasoning), triage decisions, qualitative hygiene observations, identity updates.

**Haiku** — mechanical passes where judgment is minimal:
- Note resolution loop during hygiene (expired? → ignore; addressed? → resolve)
- Search-and-return operations (execute query, format results)
- Simple task status updates with no ambiguity
- Possibly: hygiene pass for lower-complexity modalities (Margot's task triage, June's routine check)

Haiku is never used for conversation turns or anything requiring qualitative judgment.

---

## Instruction Rewrite Scope

### Remove entirely
- "Pass it up to Penny" / `<next_session target="pa">` language from all modality bios
- XML action tag instructions from system prompts
- The flat memory list section

### Replace with
- TRIAGE decision tree (always in context — explains when to call which tool)
- Brief section (always in context — the current domain state)
- Identity sections (always in context — who Adam is, who this modality is)
- Visibility summary (always in context — what's loaded, what must be searched)
- Tool descriptions (in context via tools array — Anthropic handles this)

### Penny's cross-modality visibility (rewrite her bio)
Replace pass-up language with: *"You see all active Tasks, all Pending Calendar Events, and all Projects with progress 3–9 across every modality. Submodalities don't send things to you — they write to the shared tables and you read them. If something warrants your attention, it will be visible."*

### Submodality bios (rewrite the pass-up section)
Replace with: *"If something needs Penny's attention, write it to the appropriate table — a Task, a Pending Calendar Event, a Project update. She sees them. There is no separate pass-up mechanism."*

---

## Transition: The Working Note

After migration, Penny's Brief will be empty or sparse and her memories will be minimal. Add a system note acknowledging this — written into the initial Brief for each modality — so they don't interpret sparse context as amnesia or a bug:

> *"The memory system was recently rebuilt. Your Brief is being written from scratch as we work together. Context will fill in over the coming sessions. Don't apologize for not knowing things — just ask."*

---

## Open Questions

- Should the existing Memory table rows (the 150 domain memories we kept) be migrated into the new search-only Memory tier as-is, or reviewed first? Probably: load them as-is into searchable Memory, let each modality encounter them organically.
- Per-modality Identity (`aboutSelf`): submodalities (Margot, June, Iris, Sage, Vera) don't currently have their own. Add a `ModalityIdentity` table (profileId, modalityId, aboutUser, aboutSelf) or columns on ModalityState.
- Full-text search in Turso: basic FTS should be sufficient for Memory, DeepMemory, and MemoryLog search. Confirm Turso FTS extension is enabled.
- Project detailed notes as DeepMemory: the Projects table has a `detailedNotes` column in the current design. This should be removed from the table and stored as a DeepMemory document keyed to the project ID instead. The `read_project_notes` tool fetches it.
