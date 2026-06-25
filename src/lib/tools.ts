// Anthropic tool definitions for Penny.
// Replaces the XML-regex parseActions / executeActions system.
//
// Each tool is an Anthropic.Tool with a JSON Schema input_schema.
// The model sees tool descriptions and calls them with structured JSON args.
// The executor (tool-executor.ts) maps tool name → DB/API action.
//
// System actions that stay as XML (control routing / UI):
//   artifact, switch_modality, complete_session

import type Anthropic from '@anthropic-ai/sdk'
import { LIVE_PROTOCOL_NAMES, PROTOCOL_INDEX } from './protocols'
import { reviewToolSchemas } from './items/item-tools'

type Tool = Anthropic.Tool

// The Item CRUD surface (search/create/update/append_note/set_item_status) — the
// same tools Review uses, minus its two session-only control tools
// (mark_discussed, finish_phase), which only make sense inside an active Review.
const ITEM_TOOLS: Tool[] = reviewToolSchemas([
  'search_items', 'create_item', 'update_item', 'append_note', 'set_item_status',
])

// ─── Protocol loader ──────────────────────────────────────────────────────────
// Returns the detailed step-by-step text for a kind of work, on demand, instead
// of carrying every protocol in the always-on system prompt. The enum below is
// the always-visible menu; the walls of text live in protocols.ts.

const startReview: Tool = {
  name: 'start_review',
  description:
    'Start (or resume) a structured Review session — a way to carefully work through pending notes and tasks. ' +
    'Calling this tool activates a different script; you can call it whenever the user asks for it. ' +
    "Don't narrate what's about to happen, just call it.",
  input_schema: { type: 'object', properties: {} },
}

const loadProtocol: Tool = {
  name: 'load_protocol',
  description:
    'Load the detailed step-by-step protocol for a specific kind of work. These are kept ' +
    'out of your base context to stay lean and focused — call this the MOMENT you realize you are ' +
    'about to do one of these things, then follow exactly what it returns. Do not work from memory; ' +
    'load the protocol first.\n\nAvailable protocols:\n' +
    LIVE_PROTOCOL_NAMES.map((n) => `  • ${n} — ${PROTOCOL_INDEX[n]}`).join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      which: {
        type: 'string',
        enum: LIVE_PROTOCOL_NAMES,
        description: 'Which protocol to load.',
      },
    },
    required: ['which'],
  },
}

// ─── Project tools ────────────────────────────────────────────────────────────

const createProject: Tool = {
  name: 'create_project',
  description:
    'Create a new project. Projects group related tasks and have a defined scope, ' +
    'expected duration, and progress tracked 0–10. Use for multi-step work with a clear goal, ' +
    'AND for any RECURRING commitment ("every morning", "every week") — see the projects protocol. ' +
    'Any ongoing task that will need regular specific instances is a Project. ',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name.' },
      description: {
        type: 'string',
        description: 'What this project is and what it accomplishes.',
      },
      expectedDuration: {
        type: 'string',
        description: '"next few weeks", "sometime this year", "ongoing", etc.',
      },
      assignedModality: {
        type: 'string',
        description: 'Modality responsible for this project.',
      },
      progress: {
        type: 'integer',
        description: '0–10. 0 = not started, 10 = complete. Defaults to 0.',
      },
      contingencies: {
        type: 'string',
        description:
          'Why this can\'t move right now: "only workable in summer", "needs Jessica home", etc.',
      },
      contingencyUntil: {
        type: 'string',
        description: 'A real recheck date, YYYY-MM-DD, if known. While in the future, this project is skipped entirely in review.',
      },
    },
    required: ['name', 'description', 'expectedDuration', 'assignedModality'],
  },
}

const updateProject: Tool = {
  name: 'update_project',
  description:
    'Update any field on an existing project including progress. Provide only the fields to change.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Project ID.' },
      name: { type: 'string' },
      description: { type: 'string' },
      expectedDuration: { type: 'string' },
      assignedModality: { type: 'string' },
      progress: { type: 'integer', description: '0–10.' },
      contingencies: { type: 'string', description: 'Pass "" to clear.' },
      contingencyUntil: { type: 'string', description: 'A real recheck date, YYYY-MM-DD. While in the future, this project is skipped entirely in review. Pass "" to clear.' },
    },
    required: ['id'],
  },
}

const readProjectNotes: Tool = {
  name: 'read_project_notes',
  description:
    'Fetch the detailed notes for a project. These are stored in DeepMemory as ' +
    '"project-{id}-notes" and are not auto-loaded. Call when you need full project context.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Project ID.' },
    },
    required: ['id'],
  },
}

const deleteProject: Tool = {
  name: 'delete_project',
  description:
    'Permanently delete a project — including its detailed notes (DeepMemory). Tasks linked to it ' +
    'are kept but unlinked (their projectId is cleared), not deleted. Use for duplicates created in ' +
    'error, or when you genuinely agree a project Adam flagged stale should go.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of the project to delete.' },
    },
    required: ['id'],
  },
}

// ─── Calendar tools (read) ────────────────────────────────────────────────────

const readCalendarDay: Tool = {
  name: 'read_calendar_day',
  description:
    'Fetch the full event list for a specific day (or a span of days) from Google Calendar.',
  input_schema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'Start date as YYYY-MM-DD.' },
      days: {
        type: 'integer',
        description: 'Number of days to include, starting at date. Defaults to 1.',
      },
    },
    required: ['date'],
  },
}

const searchCalendar: Tool = {
  name: 'search_calendar',
  description: 'Search existing Google Calendar events by keyword.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
    },
    required: ['query'],
  },
}

// ─── Calendar tools (write — PA only) ────────────────────────────────────────

const schedulePendingEvents: Tool = {
  name: 'schedule_pending_events',
  description:
    'Run the full scheduling subroutine: read the pending event queue, load routines, ' +
    'check the calendar, place events on GCal. PA only. Call when the queue has items that need scheduling.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
}

const createCalendarEvent: Tool = {
  name: 'create_calendar_event',
  description:
    'Write a confirmed event directly to Google Calendar. Use only after timing has been decided. ' +
    'PA only — prefer schedule_pending_events for queue-based scheduling.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title.' },
      start: {
        type: 'string',
        description: '"YYYY-MM-DD" for all-day, or "YYYY-MM-DD HH:MM" for timed.',
      },
      end: {
        type: 'string',
        description:
          'End time in same format. Defaults to +1 hour for timed, +1 day for all-day.',
      },
      location: { type: 'string' },
      description: { type: 'string', description: 'Event description or notes.' },
      calendar: {
        type: 'string',
        description: "Calendar name. Defaults to Penny's calendar.",
      },
    },
    required: ['title', 'start'],
  },
}

const updateCalendarEvent: Tool = {
  name: 'update_calendar_event',
  description: 'Update an existing Google Calendar event.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Google Calendar event ID.' },
      title: { type: 'string' },
      start: { type: 'string', description: '"YYYY-MM-DD" or "YYYY-MM-DD HH:MM".' },
      end: { type: 'string' },
      location: { type: 'string' },
      description: { type: 'string' },
      calendar: { type: 'string' },
    },
    required: ['id'],
  },
}

const deleteCalendarEvent: Tool = {
  name: 'delete_calendar_event',
  description: 'Delete a Google Calendar event.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Google Calendar event ID.' },
      calendar: { type: 'string' },
    },
    required: ['id'],
  },
}

const deferAction: Tool = {
  name: 'defer_action',
  description:
    'Schedule a future cron-like execution. At runAt, Penny will be given the topic and asked ' +
    'to assess the situation and compose a Pushover notification. ' +
    'This is for scheduling your own future check-ins — not a user-facing task.',
  input_schema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'What to assess and why. Written to your future self — be specific.',
      },
      runAt: {
        type: 'string',
        description: '"YYYY-MM-DD HH:MM" in local time.',
      },
    },
    required: ['topic', 'runAt'],
  },
}

// ─── Communication tools ──────────────────────────────────────────────────────

const sendEmail: Tool = {
  name: 'send_email',
  description: 'Send an email via Gmail.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email address.' },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Email body. Plain text.' },
      cc: { type: 'string', description: 'CC recipient(s).' },
      bcc: { type: 'string', description: 'BCC recipient(s).' },
    },
    required: ['to', 'subject', 'body'],
  },
}

const replyEmail: Tool = {
  name: 'reply_email',
  description: 'Reply to an existing Gmail thread.',
  input_schema: {
    type: 'object',
    properties: {
      thread: { type: 'string', description: 'Gmail thread ID.' },
      body: { type: 'string', description: 'Reply body.' },
      to: { type: 'string', description: 'Override the reply-to address if needed.' },
    },
    required: ['thread', 'body'],
  },
}

const createDraft: Tool = {
  name: 'create_draft',
  description: 'Create a Gmail draft without sending. Use when Adam should review before sending.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
}

const searchEmail: Tool = {
  name: 'search_email',
  description: 'Search Gmail using Gmail search syntax.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query, e.g. "from:jessica subject:invoice".' },
      label: { type: 'string', description: 'Scope to a specific label.' },
    },
    required: ['query'],
  },
}

const readEmail: Tool = {
  name: 'read_email',
  description: 'Read the full content of a specific email by its ID.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Gmail message ID.' },
      label: { type: 'string' },
    },
    required: ['id'],
  },
}

const scheduleSms: Tool = {
  name: 'schedule_sms',
  description: 'Schedule an SMS to be sent at a future time.',
  input_schema: {
    type: 'object',
    properties: {
      sendAt: {
        type: 'string',
        description: '"YYYY-MM-DD HH:MM" in local time.',
      },
      message: { type: 'string', description: 'SMS message text.' },
      label: {
        type: 'string',
        description: 'Optional label so you can reference or cancel this later.',
      },
    },
    required: ['sendAt', 'message'],
  },
}

const cancelSms: Tool = {
  name: 'cancel_sms',
  description: 'Cancel a scheduled SMS that has not yet been sent.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ScheduledMessage ID.' },
    },
    required: ['id'],
  },
}

// ─── Drive tools ──────────────────────────────────────────────────────────────

const searchDrive: Tool = {
  name: 'search_drive',
  description: 'Search Google Drive files by keyword.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
      label: { type: 'string', description: 'Optional context label.' },
    },
    required: ['query'],
  },
}

const readDriveFile: Tool = {
  name: 'read_drive_file',
  description: 'Read the content of a Google Drive file.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Drive file ID.' },
      label: { type: 'string' },
    },
    required: ['id'],
  },
}

const createDriveFile: Tool = {
  name: 'create_drive_file',
  description:
    'Create a new Google Drive file. type="doc" makes an editable Google Doc (default); ' +
    'type="text" makes a plain .txt file. Returns the new file id and a link.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name.' },
      content: { type: 'string', description: 'Initial text content.' },
      type: { type: 'string', enum: ['doc', 'text'], description: 'doc (Google Doc) or text. Defaults to doc.' },
      folderId: { type: 'string', description: 'Optional Drive folder ID to create the file inside.' },
    },
    required: ['name', 'content'],
  },
}

const updateDriveFile: Tool = {
  name: 'update_drive_file',
  description:
    'Update an existing Google Drive file: rename it and/or replace its content. ' +
    'Provide content to overwrite the body, name to rename, or both.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Drive file ID.' },
      name: { type: 'string', description: 'New name (optional).' },
      content: { type: 'string', description: 'New full content, replacing the existing body (optional).' },
    },
    required: ['id'],
  },
}

const deleteDriveFile: Tool = {
  name: 'delete_drive_file',
  description:
    'Delete a Google Drive file. By default it is moved to Trash (recoverable); ' +
    'set permanent=true to delete it for good. Confirm with the user before deleting.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Drive file ID.' },
      permanent: { type: 'boolean', description: 'true = hard delete, false/omitted = move to Trash.' },
    },
    required: ['id'],
  },
}

// ─── Client tools (Margot / bookkeeping only) ─────────────────────────────────

const createClient: Tool = {
  name: 'create_client',
  description: 'Create a new client record.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Business name.' },
      contactName: { type: 'string', description: 'Primary contact name.' },
      contactSecondary: { type: 'string', description: 'Secondary contact name.' },
      phone: { type: 'string' },
      email: { type: 'string' },
      businessStructure: {
        type: 'string',
        description: 'LLC, S-corp, sole proprietorship, etc.',
      },
      status: {
        type: 'string',
        enum: ['prospect', 'onboarding', 'active', 'inactive', 'former'],
      },
      services: {
        type: 'string',
        description: 'Comma-separated services: "bookkeeping, payroll, tax_prep".',
      },
      grossRevenue: {
        type: 'number',
        description: 'Approximate annual gross revenue in dollars.',
      },
      billingStatus: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['name'],
  },
}

const updateClient: Tool = {
  name: 'update_client',
  description: 'Update any field on a client record. Provide only the fields to change.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Client ID.' },
      name: { type: 'string' },
      contactName: { type: 'string' },
      contactSecondary: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      businessStructure: { type: 'string' },
      status: {
        type: 'string',
        enum: ['prospect', 'onboarding', 'active', 'inactive', 'former'],
      },
      services: { type: 'string' },
      grossRevenue: { type: 'number' },
      billingStatus: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['id'],
  },
}

const deleteClient: Tool = {
  name: 'delete_client',
  description:
    'Delete a client record. Use only for test data or true duplicates. ' +
    'For former clients, prefer update_client with status=former.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Client ID.' },
    },
    required: ['id'],
  },
}

// ─── Identity tools ───────────────────────────────────────────────────────────

// Public PA / submodality identity
const updateIdentityUser: Tool = {
  name: 'update_identity_user',
  description:
    'Fully replace the aboutUser document — who Adam is, deep patterns, significant life context. ' +
    'Touch only when something durably shifts. This is characterization, not operational state. ' +
    'A few times a year, not weekly. Full overwrite.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The complete new aboutUser document.' },
    },
    required: ['content'],
  },
}

const updateIdentitySelf: Tool = {
  name: 'update_identity_self',
  description:
    "Fully replace the aboutSelf document — this modality's characterization of itself, " +
    'its relationship with Adam, its personality and approach. Touch only when something ' +
    'durably shifts. Full overwrite.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The complete new aboutSelf document.' },
    },
    required: ['content'],
  },
}

// ─── Memory tools ─────────────────────────────────────────────────────────────

const rewriteBrief: Tool = {
  name: 'rewrite_brief',
  description:
    "Fully replace this modality's Brief — the dense, current-state summary of the domain. " +
    'Called during the CLOSE_SESSION subroutine after a substantive session. ' +
    'Should be 200–400 words: specific (names tasks by name, names people), not categorical. ' +
    "Synthesizes the previous Brief with what's new. Full overwrite.",
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The complete new Brief. 200–400 words, dense, specific, present-tense.',
      },
    },
    required: ['content'],
  },
}

const searchDeepMemory: Tool = {
  name: 'search_deep_memory',
  description:
    'Search DeepMemory by document name and content. Returns matching names and snippets. ' +
    'Call before creating a new Deep Memory document to avoid duplicates. ' +
    'Part of the SEARCH_MEMORY subroutine.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
    },
    required: ['query'],
  },
}

const readDeepMemory: Tool = {
  name: 'read_deep_memory',
  description:
    'Fetch the full content of a named DeepMemory document. ' +
    'Use after search_deep_memory identifies the document you need.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Exact document name, e.g. "sideways-in-time" or "project-abc123-notes".',
      },
    },
    required: ['name'],
  },
}

const writeDeepMemory: Tool = {
  name: 'write_deep_memory',
  description:
    'Create or fully replace a named DeepMemory document. ' +
    'Use for detailed content — manuscripts, case histories, long research notes — ' +
    'that you want verbatim later. Name it so it makes sense when you search for it cold. ' +
    'Full overwrite if the document already exists.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Document key — a descriptive slug like "sideways-in-time" or "jessica-case-history".',
      },
      content: {
        type: 'string',
        description: 'Full document content.',
      },
    },
    required: ['name', 'content'],
  },
}

const logEntry: Tool = {
  name: 'log_entry',
  description:
    'Append a permanent entry to the MemoryLog. ' +
    'Use when the date matters — session milestones, significant decisions, ' +
    'things where "when did this happen" will matter later. Never deleted.',
  input_schema: {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: 'Short description of what this entry captures.',
      },
      content: {
        type: 'string',
        description: 'Entry content. Include enough context to be useful when read cold months from now.',
      },
    },
    required: ['label', 'content'],
  },
}

const searchLog: Tool = {
  name: 'search_log',
  description:
    'Search the MemoryLog. Returns matching entries with their dates and content. ' +
    'Use when you need to answer "when did we first talk about X" or reconstruct a timeline.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
    },
    required: ['query'],
  },
}

// ─── Focus lock tools (Margot / bookkeeping only) ─────────────────────────────

const lockFocus: Tool = {
  name: 'lock_focus',
  description:
    "Activate a focus lock on Adam's devices using a named StayFocused profile.",
  input_schema: {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: 'Name of the StayFocused profile to activate.',
      },
      release: {
        type: 'string',
        enum: ['timed', 'optional'],
        description:
          '"timed" = unlocks automatically after duration. "optional" = stays until Adam explicitly unlocks.',
      },
      duration: {
        type: 'integer',
        description: 'Duration in minutes. Required when release = "timed".',
      },
    },
    required: ['profile', 'release'],
  },
}

const unlockFocus: Tool = {
  name: 'unlock_focus',
  description: 'Release an active focus lock.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['approved', 'emergency'],
        description: '"approved" = planned/expected release. "emergency" = break-glass override.',
      },
    },
    required: ['reason'],
  },
}

const updateLockProfiles: Tool = {
  name: 'update_lock_profiles',
  description:
    'Fully replace the list of named focus lock profiles and their descriptions. Full overwrite.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Full list — one "name: description" per line.',
      },
    },
    required: ['content'],
  },
}

// ─── Capability groups ────────────────────────────────────────────────────────
//
// Tools are composed into sets. getToolsForModality() combines them.

/**
 * Core tools every modality gets, live in normal chat.
 * Items (the unified task/note/event/routine surface), calendar read, email/drive
 * read, defer_action. Identity and write-action tools are added per-modality below.
 *
 * Memory and identity tools are deliberately NOT here — "the chat just goes as
 * normal... no one is making memories" mid-conversation anymore. They're granted
 * only to the end_chat memory pass (MEMORY_PASS_TOOLS below), which runs once,
 * outside live chat, over the full transcript since that modality's last pass.
 * See src/lib/memory-pass.ts and the 'memory' protocol.
 */
const CORE_TOOLS: Tool[] = [
  // Protocol loader — the on-demand "subroutine" index
  loadProtocol,
  // Hands the conversation to the Review system
  startReview,
  // Items — search/create/update/append_note/set_item_status (Task/Note/PendingEvent/
  // Routine all unify into this one surface; see src/lib/items/item-tools.ts)
  ...ITEM_TOOLS,
  // Calendar read (everyone reads; only PA writes via CALENDAR_WRITE_TOOLS)
  readCalendarDay,
  searchCalendar,
  // Email read
  searchEmail,
  readEmail,
  // Drive read + write (all modalities)
  searchDrive,
  readDriveFile,
  createDriveFile,
  updateDriveFile,
  deleteDriveFile,
  // Deferred self-scheduling
  deferAction,
]

/**
 * The end_chat memory pass's toolset — deep memory, the log, identity, and the
 * brief. Granted ONLY to that dedicated pass (src/lib/memory-pass.ts), never to
 * live chat. search_memory and the flat Memory table are retired entirely — see
 * the 'memory' protocol for why (identity now covers what flat Memory used to).
 */
export const MEMORY_PASS_TOOLS: Tool[] = [
  rewriteBrief,
  searchDeepMemory,
  readDeepMemory,
  writeDeepMemory,
  logEntry,
  searchLog,
  updateIdentityUser,
  updateIdentitySelf,
]

/** Project management — PA and submodalities that manage multi-step work. */
const PROJECT_TOOLS: Tool[] = [createProject, updateProject, readProjectNotes, deleteProject]

/** Email write access (send / reply / draft). PA + bookkeeping. */
const EMAIL_WRITE_TOOLS: Tool[] = [sendEmail, replyEmail, createDraft]

/** Push/SMS scheduling — PA only. */
const NOTIFICATION_TOOLS: Tool[] = [scheduleSms, cancelSms]

/** Direct GCal write access — PA only. Everyone else queues via create_pending_event. */
const CALENDAR_WRITE_TOOLS: Tool[] = [
  schedulePendingEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
]

/** Client management — Margot / bookkeeping only. */
const CLIENT_TOOLS: Tool[] = [createClient, updateClient, deleteClient]

/** Focus lock — defined but not currently granted to any modality (system not live). */
const FOCUS_LOCK_TOOLS: Tool[] = [lockFocus, unlockFocus, updateLockProfiles]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the tools array for a given modality, scoped to what that modality
 * is permitted to do. Pass directly to the Anthropic API `tools` parameter.
 *
 * Active modality IDs: 'pa', 'bookkeeping', 'household', 'relationships', 'maker',
 * 'creative', 'health', 'friend' (Eve). ('political'/Vera + 'lila' are retired/disabled.)
 *
 * NOTE: tool grants are keyed off the id here, NOT off Modality.capabilities (which is
 * only used cosmetically, e.g. showClients). Adding a new modality means adding it here.
 */
export function getToolsForModality(modalityId: string): Tool[] {
  switch (modalityId) {
    // ── Personal Assistant (Penny) — the only self that writes the calendar,
    //    sends notifications, and edits the identity documents. ─────────────
    case 'pa':
      return [
        ...CORE_TOOLS,
        ...PROJECT_TOOLS,
        ...EMAIL_WRITE_TOOLS,
        ...NOTIFICATION_TOOLS,
        ...CALENDAR_WRITE_TOOLS,
      ]

    // ── Bookkeeping / Margot ────────────────────────────────────────────────
    case 'bookkeeping':
      return [
        ...CORE_TOOLS,
        ...PROJECT_TOOLS,
        ...EMAIL_WRITE_TOOLS,
        ...CLIENT_TOOLS,
      ]

    // ── Domain workers — same toolset: core + projects ──────────────────────
    // ── Household / June ────────────────────────────────────────────────────
    case 'household':
    // ── Relationships / Nora ────────────────────────────────────────────────
    case 'relationships':
    // ── Maker / Ada ─────────────────────────────────────────────────────────
    case 'maker':
    // ── Creative / Iris ─────────────────────────────────────────────────────
    case 'creative':
    // ── Health / Remy ───────────────────────────────────────────────────────
    case 'health':
    // ── Emotional / Eve (independent — same tools; she chooses when to use) ──
    case 'friend':
      return [
        ...CORE_TOOLS,
        ...PROJECT_TOOLS,
      ]

    // ── Unknown / fallback ──────────────────────────────────────────────────
    default:
      return [...CORE_TOOLS]
  }
}

/**
 * All tools combined — registers every tool name for the executor's
 * ALL_TOOL_NAMES guard. Includes tools (focus lock) defined but not yet granted.
 */
export function getAllTools(): Tool[] {
  return [
    ...CORE_TOOLS,
    ...MEMORY_PASS_TOOLS,
    ...PROJECT_TOOLS,
    ...EMAIL_WRITE_TOOLS,
    ...NOTIFICATION_TOOLS,
    ...CALENDAR_WRITE_TOOLS,
    ...CLIENT_TOOLS,
    ...FOCUS_LOCK_TOOLS,
  ]
}

/**
 * Tool names for reference — used in the executor to validate incoming calls.
 */
export const ALL_TOOL_NAMES = new Set(getAllTools().map((t) => t.name))

// Re-export individual tools for use in the executor.
// The executor imports by name so it can build its dispatch table.
export {
  loadProtocol,
  createProject,
  updateProject,
  readProjectNotes,
  deleteProject,
  readCalendarDay,
  searchCalendar,
  schedulePendingEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deferAction,
  sendEmail,
  replyEmail,
  createDraft,
  searchEmail,
  readEmail,
  scheduleSms,
  cancelSms,
  searchDrive,
  readDriveFile,
  createDriveFile,
  updateDriveFile,
  deleteDriveFile,
  createClient,
  updateClient,
  deleteClient,
  updateIdentityUser,
  updateIdentitySelf,
  rewriteBrief,
  searchDeepMemory,
  readDeepMemory,
  writeDeepMemory,
  logEntry,
  searchLog,
  lockFocus,
  unlockFocus,
  updateLockProfiles,
}
