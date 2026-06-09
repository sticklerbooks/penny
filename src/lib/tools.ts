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

type Tool = Anthropic.Tool

// ─── Task tools ───────────────────────────────────────────────────────────────

const createTask: Tool = {
  name: 'create_task',
  description:
    'Create a new task. Use for discrete action items that need to be tracked and completed. ' +
    'Prefer over notes for anything with a clear owner, status, and completion criteria.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short label — a few words at most.',
      },
      description: {
        type: 'string',
        description: 'Full description of what needs to be done.',
      },
      priority: {
        type: 'integer',
        description: '1–4. 1 = low, 2 = normal, 3 = high, 4 = urgent.',
      },
      assignedModality: {
        type: 'string',
        description: 'Modality ID that owns and is responsible for this task.',
      },
      projectId: {
        type: 'string',
        description: 'ID of the project this task belongs to, if any.',
      },
      clientId: {
        type: 'string',
        description: 'ID of the client this task is for (Margot / bookkeeping context).',
      },
      dueDate: {
        type: 'string',
        description: 'Due date as YYYY-MM-DD.',
      },
      dueTime: {
        type: 'string',
        description: 'Time constraint in natural language — "before noon", "end of week".',
      },
      contingentOn: {
        type: 'string',
        description:
          'What this task is waiting for. Free text: another task ID, an external event, a decision pending.',
      },
      linkedCalendarEventId: {
        type: 'string',
        description: 'ID of a PendingCalendarEvent this task is tied to.',
      },
      status: {
        type: 'string',
        enum: ['Unstarted', 'Started', 'Waiting on Contingency', 'Mostly Complete', 'Complete'],
        description: 'Defaults to Unstarted.',
      },
      notes: {
        type: 'string',
        description: 'Your observations about this task — blockers, context, caveats.',
      },
    },
    required: ['name', 'description', 'priority', 'assignedModality'],
  },
}

const updateTask: Tool = {
  name: 'update_task',
  description:
    'Update any field on an existing task. Provide only the fields you want to change. ' +
    'Set status=Complete when a task is done rather than deleting it.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of the task to update.' },
      name: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'integer', description: '1–4.' },
      assignedModality: { type: 'string' },
      projectId: { type: 'string' },
      clientId: { type: 'string' },
      dueDate: { type: 'string', description: 'YYYY-MM-DD.' },
      dueTime: { type: 'string' },
      contingentOn: { type: 'string' },
      linkedCalendarEventId: { type: 'string' },
      status: {
        type: 'string',
        enum: ['Unstarted', 'Started', 'Waiting on Contingency', 'Mostly Complete', 'Complete'],
      },
      notes: { type: 'string' },
    },
    required: ['id'],
  },
}

const deleteTask: Tool = {
  name: 'delete_task',
  description:
    'Permanently delete a task. Prefer update_task with status=Complete for finished work. ' +
    'Use delete only for tasks created in error or true duplicates.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'ID of the task to delete.' },
    },
    required: ['id'],
  },
}

const searchTasks: Tool = {
  name: 'search_tasks',
  description:
    'Search all tasks including completed ones. Use to check history, find archived work, ' +
    'or look up a task by name or description. Completed tasks are hidden from your default context ' +
    'but fully searchable here.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
    },
    required: ['query'],
  },
}

// ─── Project tools ────────────────────────────────────────────────────────────

const createProject: Tool = {
  name: 'create_project',
  description:
    'Create a new project. Projects group related tasks and have a defined scope, ' +
    'expected duration, and progress tracked 0–10. Use for multi-step work with a clear goal. ' +
    'Detailed notes are stored separately via write_deep_memory with key "project-{id}-notes".',
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
          'Conditions or dependencies: "only workable in summer", "needs Jessica home", etc.',
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
      contingencies: { type: 'string' },
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

// ─── Routine tools ────────────────────────────────────────────────────────────

const createRoutine: Tool = {
  name: 'create_routine',
  description:
    'Record a scheduling constraint or recurring pattern. Routines are not auto-loaded — ' +
    'they are only consulted during the scheduling subroutine. Use for standing commitments, ' +
    'recurring obligations, and time-of-week patterns that affect scheduling.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What this routine or constraint describes.',
      },
      frequency: {
        type: 'string',
        description: '"Weekly", "Tuesdays", "Most weekday evenings", "Occasionally", etc.',
      },
      priority: {
        type: 'integer',
        description: '1–4. 4 = absolutely obligatory.',
      },
      flexibility: {
        type: 'integer',
        description:
          '1–4. 4 = must happen at this exact time, cannot be moved. 1 = anytime, very flexible.',
      },
      dayTime: {
        type: 'string',
        description: '"Thursday mornings", "Saturdays at 9am", "Weekday afternoons". Optional.',
      },
      assignedModality: {
        type: 'string',
        description: 'Modality that owns this routine.',
      },
    },
    required: ['description', 'frequency', 'priority', 'flexibility', 'assignedModality'],
  },
}

// ─── Pending calendar event tools ─────────────────────────────────────────────

const createPendingEvent: Tool = {
  name: 'create_pending_event',
  description:
    'Add an event to the scheduling queue. Pending events are not written to GCal until ' +
    'PA runs the scheduling subroutine. Use when something needs to happen but timing is not yet confirmed. ' +
    'Any modality can create pending events; PA schedules them.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Event name.' },
      duration: {
        type: 'string',
        description: 'Required: "1 hour", "30–45 min", "half day", etc.',
      },
      priority: {
        type: 'integer',
        description: '1–4. 4 = must happen on time, cannot slip.',
      },
      projectId: {
        type: 'string',
        description: 'ID of a related project, if any.',
      },
      description: {
        type: 'string',
        description: 'What this event is for.',
      },
      date: {
        type: 'string',
        description:
          '"2026-06-15" for a specific date, "By 2026-06-20" for a deadline, omit if fully flexible.',
      },
      startTime: {
        type: 'string',
        description: 'Time preferences in natural language: "morning", "after 3pm", "not before noon".',
      },
      location: { type: 'string' },
      assignedModality: {
        type: 'string',
        description: 'Modality this event belongs to. Defaults to pa.',
      },
    },
    required: ['name', 'duration', 'priority'],
  },
}

const updatePendingEvent: Tool = {
  name: 'update_pending_event',
  description: 'Update a pending calendar event before it has been scheduled.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Pending event ID.' },
      name: { type: 'string' },
      duration: { type: 'string' },
      priority: { type: 'integer' },
      projectId: { type: 'string' },
      description: { type: 'string' },
      date: { type: 'string' },
      startTime: { type: 'string' },
      location: { type: 'string' },
      assignedModality: { type: 'string' },
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

// ─── Note tools ───────────────────────────────────────────────────────────────

const createNote: Tool = {
  name: 'create_note',
  description:
    'Create a note targeted at a specific modality, to be seen at the start of their next session. ' +
    'Use for cross-modality communication or reminders that have a defined expiry. ' +
    'Maximum expiry is 2 weeks from today.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title for the note.' },
      content: { type: 'string', description: 'Full note content.' },
      expiresAt: {
        type: 'string',
        description: 'Expiry date as YYYY-MM-DD. Maximum 2 weeks from today.',
      },
      modalityTarget: {
        type: 'string',
        description: 'Which modality should see this note.',
      },
    },
    required: ['title', 'content', 'expiresAt', 'modalityTarget'],
  },
}

const resolveNote: Tool = {
  name: 'resolve_note',
  description: 'Mark a note as Resolved — the issue has been addressed.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID.' },
    },
    required: ['id'],
  },
}

const ignoreNote: Tool = {
  name: 'ignore_note',
  description: 'Mark a note as Ignored — it is no longer relevant and can be dismissed.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Note ID.' },
    },
    required: ['id'],
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

const searchMemory: Tool = {
  name: 'search_memory',
  description:
    'Search the Memory table — facts and short notes accumulated across sessions. ' +
    'Call before claiming you do not know something. Part of the SEARCH_MEMORY subroutine.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms.' },
    },
    required: ['query'],
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
 * Core tools every modality gets.
 * Tasks, notes, calendar read, pending events, email/drive read, memory, defer_action.
 * Identity and write-action tools are added per-modality below.
 */
const CORE_TOOLS: Tool[] = [
  // Tasks
  createTask,
  updateTask,
  deleteTask,
  searchTasks,
  // Notes
  createNote,
  resolveNote,
  ignoreNote,
  // Pending calendar events (any modality creates; PA schedules)
  createPendingEvent,
  updatePendingEvent,
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
  // Memory
  rewriteBrief,
  searchMemory,
  searchDeepMemory,
  readDeepMemory,
  writeDeepMemory,
  logEntry,
  searchLog,
  // Deferred self-scheduling
  deferAction,
  // Routines (all modalities can document their own)
  createRoutine,
]

/** Public identity tools — all non-private, non-alt modalities. */
const PUBLIC_IDENTITY_TOOLS: Tool[] = [updateIdentityUser, updateIdentitySelf]

/** Project management — PA and submodalities that manage multi-step work. */
const PROJECT_TOOLS: Tool[] = [createProject, updateProject, readProjectNotes]

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
 * Active modality IDs: 'pa', 'bookkeeping', 'household', 'creative', 'friend', 'political'.
 * (Lila / private + alt-mode are retired.)
 */
export function getToolsForModality(modalityId: string): Tool[] {
  switch (modalityId) {
    // ── Personal Assistant (Penny) — the only self that writes the calendar,
    //    sends notifications, and edits the identity documents. ─────────────
    case 'pa':
      return [
        ...CORE_TOOLS,
        ...PUBLIC_IDENTITY_TOOLS,
        ...PROJECT_TOOLS,
        ...EMAIL_WRITE_TOOLS,
        ...NOTIFICATION_TOOLS,
        ...CALENDAR_WRITE_TOOLS,
      ]

    // ── Bookkeeping / Margot ────────────────────────────────────────────────
    case 'bookkeeping':
      return [
        ...CORE_TOOLS,
        ...PUBLIC_IDENTITY_TOOLS,
        ...PROJECT_TOOLS,
        ...EMAIL_WRITE_TOOLS,
        ...CLIENT_TOOLS,
      ]

    // ── Household / June ────────────────────────────────────────────────────
    case 'household':
    // ── Creative / Iris ─────────────────────────────────────────────────────
    case 'creative':
    // ── Friend / Sage ───────────────────────────────────────────────────────
    case 'friend':
    // ── Political / Vera ────────────────────────────────────────────────────
    case 'political':
      return [
        ...CORE_TOOLS,
        ...PUBLIC_IDENTITY_TOOLS,
        ...PROJECT_TOOLS,
      ]

    // ── Unknown / fallback ──────────────────────────────────────────────────
    default:
      return [...CORE_TOOLS, ...PUBLIC_IDENTITY_TOOLS]
  }
}

/**
 * All tools combined — registers every tool name for the executor's
 * ALL_TOOL_NAMES guard. Includes tools (focus lock) defined but not yet granted.
 */
export function getAllTools(): Tool[] {
  return [
    ...CORE_TOOLS,
    ...PUBLIC_IDENTITY_TOOLS,
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
  createTask,
  updateTask,
  deleteTask,
  searchTasks,
  createProject,
  updateProject,
  readProjectNotes,
  createRoutine,
  createPendingEvent,
  updatePendingEvent,
  readCalendarDay,
  searchCalendar,
  schedulePendingEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deferAction,
  createNote,
  resolveNote,
  ignoreNote,
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
  searchMemory,
  searchDeepMemory,
  readDeepMemory,
  writeDeepMemory,
  logEntry,
  searchLog,
  lockFocus,
  unlockFocus,
  updateLockProfiles,
}
