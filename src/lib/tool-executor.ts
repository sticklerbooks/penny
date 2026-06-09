// Tool executor — maps Anthropic tool_use calls to DB / API actions.
// Returns a result string that goes back to the model as tool_result content.
//
// Usage:
//   const { content, is_error } = await executeTool(name, args, ctx)
//
// This replaces executeActions() from actions.ts.
// System signals (artifact, switch_modality, complete_session) stay as XML
// and are not routed here.

import { prisma } from './db'
import { sendNotification } from './pushover'
import {
  searchGmail,
  readGmailMessage,
  sendGmail,
  replyGmail,
  createGmailDraft,
  searchGoogleCalendar,
  getGoogleCalendarAgenda,
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  searchDrive,
  readDriveFileContent,
  createDriveFile,
  updateDriveFile,
  deleteDriveFile,
  type EventTime,
} from './google'
import { ALL_TOOL_NAMES } from './tools'
import { getModality } from './modalities'
import { getProtocol, PROTOCOL_NAMES, type ProtocolName } from './protocols'

// ─── Context ─────────────────────────────────────────────────────────────────

export interface ToolContext {
  profileId: string
  modalityId: string      // 'pa' | 'bookkeeping' | 'household' | 'creative' | 'friend' | 'political' | ...
  domain?: string | null  // modality domain string for DB records
}

// ─── Return type ─────────────────────────────────────────────────────────────

export interface ToolResult {
  content: string   // sent back to the model as tool_result content
  is_error?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Parse "YYYY-MM-DD HH:MM" as local time in the configured timezone.
function parseSendAt(at: string): Date {
  const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
  const m = at.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/)
  if (m) {
    const naive = new Date(`${m[1]}T${m[2]}:00Z`)
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = Object.fromEntries(formatter.formatToParts(naive).map((p) => [p.type, p.value]))
    const tzDate = new Date(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`
    )
    const offsetMs = tzDate.getTime() - naive.getTime()
    return new Date(naive.getTime() - offsetMs)
  }
  return new Date(at)
}

// Build a Google Calendar start/end EventTime from the model's string.
function buildEventTime(value: string): EventTime {
  const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
  const v = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v }
  return { dateTime: parseSendAt(v).toISOString(), timeZone: tz }
}

function defaultEnd(start: EventTime): EventTime {
  if (start.date) {
    const d = new Date(start.date + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    return { date: d.toISOString().slice(0, 10) }
  }
  const d = new Date(start.dateTime!)
  return { dateTime: new Date(d.getTime() + 60 * 60 * 1000).toISOString(), timeZone: start.timeZone }
}

// Coerce unknown to string safely.
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback
}

// Simple keyword search helper — splits on whitespace, does case-insensitive LIKE queries.
// SQLite doesn't have FTS enabled by default; upgrade to fts5 when Turso confirms it.
function keywordFilter(query: string): string {
  return `%${query.trim()}%`
}

// Format a list of task records for the model.
function formatTasks(tasks: Array<{
  id: string; name: string; description: string; status: string;
  priority: number; dueDate?: Date | null; assignedModality: string;
  notes?: string | null
}>): string {
  if (!tasks.length) return '(no tasks found)'
  return tasks.map((t) => {
    const due = t.dueDate ? ` due=${t.dueDate.toISOString().slice(0, 10)}` : ''
    const notes = t.notes ? ` notes="${t.notes}"` : ''
    return `[${t.id}] ${t.name} | status=${t.status} priority=${t.priority}${due} modality=${t.assignedModality}${notes}\n  ${t.description}`
  }).join('\n\n')
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const { profileId, modalityId, domain } = ctx

  if (!ALL_TOOL_NAMES.has(name)) {
    return { content: `Unknown tool: ${name}`, is_error: true }
  }

  try {
    switch (name) {

      // ── Protocol loader ───────────────────────────────────────────────────

      case 'load_protocol': {
        const which = str(args.which) as ProtocolName
        if (!PROTOCOL_NAMES.includes(which)) {
          return {
            content: `Unknown protocol "${which}". Available: ${PROTOCOL_NAMES.join(', ')}`,
            is_error: true,
          }
        }
        const modality = getModality(modalityId)
        const profile = await prisma.profile.findUnique({ where: { id: profileId } })
        const text = getProtocol(which, {
          isPA: modality.domain === null,
          name: profile?.userName || 'them',
        })
        return { content: text }
      }

      // ── Tasks ─────────────────────────────────────────────────────────────

      case 'create_task': {
        const task = await prisma.task.create({
          data: {
            profileId,
            name: str(args.name),
            description: str(args.description),
            priority: num(args.priority, 2),
            assignedModality: str(args.assignedModality, modalityId),
            projectId: str(args.projectId) || null,
            clientId: str(args.clientId) || null,
            dueDate: args.dueDate ? new Date(str(args.dueDate)) : null,
            dueTime: str(args.dueTime) || null,
            contingentOn: str(args.contingentOn) || null,
            linkedCalendarEventId: str(args.linkedCalendarEventId) || null,
            status: str(args.status, 'Unstarted'),
            notes: str(args.notes) || null,
          },
        })
        return { content: `Task created: "${task.name}" (id=${task.id})` }
      }

      case 'update_task': {
        const id = str(args.id)
        const data: Record<string, unknown> = {}
        if (args.name !== undefined) data.name = str(args.name)
        if (args.description !== undefined) data.description = str(args.description)
        if (args.priority !== undefined) data.priority = num(args.priority, 2)
        if (args.assignedModality !== undefined) data.assignedModality = str(args.assignedModality)
        if (args.projectId !== undefined) data.projectId = str(args.projectId) || null
        if (args.clientId !== undefined) data.clientId = str(args.clientId) || null
        if (args.dueDate !== undefined) data.dueDate = args.dueDate ? new Date(str(args.dueDate)) : null
        if (args.dueTime !== undefined) data.dueTime = str(args.dueTime) || null
        if (args.contingentOn !== undefined) data.contingentOn = str(args.contingentOn) || null
        if (args.linkedCalendarEventId !== undefined) data.linkedCalendarEventId = str(args.linkedCalendarEventId) || null
        if (args.status !== undefined) data.status = str(args.status)
        if (args.notes !== undefined) data.notes = str(args.notes) || null
        if (Object.keys(data).length === 0) return { content: 'update_task: no fields to update' }
        await prisma.task.update({ where: { id }, data })
        return { content: `Task ${id} updated.` }
      }

      case 'delete_task': {
        const id = str(args.id)
        await prisma.task.delete({ where: { id } })
        return { content: `Task ${id} deleted.` }
      }

      case 'search_tasks': {
        const q = keywordFilter(str(args.query))
        const tasks = await prisma.task.findMany({
          where: {
            profileId,
            OR: [
              { name: { contains: q } },
              { description: { contains: q } },
              { notes: { contains: q } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        })
        return { content: formatTasks(tasks) }
      }

      // ── Projects ──────────────────────────────────────────────────────────

      case 'create_project': {
        const project = await prisma.project.create({
          data: {
            profileId,
            name: str(args.name),
            description: str(args.description),
            expectedDuration: str(args.expectedDuration),
            assignedModality: str(args.assignedModality, modalityId),
            progress: num(args.progress, 0),
            contingencies: str(args.contingencies) || null,
          },
        })
        return { content: `Project created: "${project.name}" (id=${project.id})` }
      }

      case 'update_project': {
        const id = str(args.id)
        const data: Record<string, unknown> = {}
        if (args.name !== undefined) data.name = str(args.name)
        if (args.description !== undefined) data.description = str(args.description)
        if (args.expectedDuration !== undefined) data.expectedDuration = str(args.expectedDuration)
        if (args.assignedModality !== undefined) data.assignedModality = str(args.assignedModality)
        if (args.progress !== undefined) data.progress = num(args.progress, 0)
        if (args.contingencies !== undefined) data.contingencies = str(args.contingencies) || null
        if (Object.keys(data).length === 0) return { content: 'update_project: no fields to update' }
        await prisma.project.update({ where: { id }, data })
        return { content: `Project ${id} updated.` }
      }

      case 'read_project_notes': {
        const id = str(args.id)
        const docName = `project-${id}-notes`
        const doc = await prisma.deepMemory.findUnique({
          where: { profileId_name: { profileId, name: docName } },
        })
        if (!doc) return { content: `(no notes found for project ${id})` }
        return { content: doc.content }
      }

      // ── Routines ──────────────────────────────────────────────────────────

      case 'create_routine': {
        const routine = await prisma.routine.create({
          data: {
            profileId,
            description: str(args.description),
            frequency: str(args.frequency),
            priority: num(args.priority, 2),
            flexibility: num(args.flexibility, 2),
            dayTime: str(args.dayTime) || null,
            assignedModality: str(args.assignedModality, modalityId),
          },
        })
        return { content: `Routine created (id=${routine.id}): "${routine.description}"` }
      }

      // ── Pending calendar events ───────────────────────────────────────────

      case 'create_pending_event': {
        const event = await prisma.pendingCalendarEvent.create({
          data: {
            profileId,
            name: str(args.name),
            duration: str(args.duration),
            priority: num(args.priority, 2),
            projectId: str(args.projectId) || null,
            description: str(args.description) || null,
            date: str(args.date) || null,
            startTime: str(args.startTime) || null,
            location: str(args.location) || null,
            assignedModality: str(args.assignedModality, modalityId),
          },
        })
        return { content: `Pending event created: "${event.name}" (id=${event.id})` }
      }

      case 'update_pending_event': {
        const id = str(args.id)
        const data: Record<string, unknown> = {}
        if (args.name !== undefined) data.name = str(args.name)
        if (args.duration !== undefined) data.duration = str(args.duration)
        if (args.priority !== undefined) data.priority = num(args.priority, 2)
        if (args.projectId !== undefined) data.projectId = str(args.projectId) || null
        if (args.description !== undefined) data.description = str(args.description) || null
        if (args.date !== undefined) data.date = str(args.date) || null
        if (args.startTime !== undefined) data.startTime = str(args.startTime) || null
        if (args.location !== undefined) data.location = str(args.location) || null
        if (args.assignedModality !== undefined) data.assignedModality = str(args.assignedModality)
        // Mark as scheduled — call this after creating the calendar event
        if (args.scheduled === true || args.scheduled === 'true') {
          data.scheduled = true
          data.scheduledAt = new Date()
        }
        if (Object.keys(data).length === 0) return { content: 'update_pending_event: no fields to update' }
        await prisma.pendingCalendarEvent.update({ where: { id }, data })
        return { content: `Pending event ${id} updated.` }
      }

      // ── Calendar (read) ───────────────────────────────────────────────────

      case 'read_calendar_day': {
        const date = str(args.date)
        const days = num(args.days, 1)
        const result = await getGoogleCalendarAgenda(date, days)
        return { content: result }
      }

      case 'search_calendar': {
        const result = await searchGoogleCalendar(str(args.query))
        return { content: result }
      }

      // ── Calendar (write — PA only) ────────────────────────────────────────

      case 'schedule_pending_events': {
        // Load the pending event queue and routines, read two weeks of calendar,
        // then return a full briefing so the model can place events with
        // create_calendar_event + update_pending_event(scheduled=true).

        const [pending, routines] = await Promise.all([
          prisma.pendingCalendarEvent.findMany({
            where: { profileId, scheduled: false },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
          }).catch(() => []),
          prisma.routine.findMany({
            where: { profileId },
            orderBy: { priority: 'desc' },
          }).catch(() => []),
        ])

        if (pending.length === 0) {
          return { content: 'Pending event queue is empty — nothing to schedule.' }
        }

        // Read the next 14 days of calendar for slot-finding context
        const today = new Date().toISOString().slice(0, 10)
        const calendarText = await getGoogleCalendarAgenda(today, 14).catch(
          () => '(calendar unavailable)'
        )

        const lines: string[] = [
          `SCHEDULING QUEUE — ${pending.length} event(s) to place:\n`,
        ]

        for (const evt of pending) {
          const dateHint = evt.date ? ` | target date: ${evt.date}` : ' | date flexible'
          const timeHint = evt.startTime ? ` @ ${evt.startTime}` : ' | time flexible'
          const loc = evt.location ? ` | location: ${evt.location}` : ''
          lines.push(
            `• [id=${evt.id} p${evt.priority}] "${evt.name}" — duration: ${evt.duration}${dateHint}${timeHint}${loc}` +
            (evt.description ? `\n  Notes: ${evt.description}` : '')
          )
        }

        if (routines.length) {
          lines.push(`\nROUTINES (protected time — work around these):\n`)
          for (const r of routines) {
            const flex = r.flexibility <= 2 ? '⚠️ LOW flex' : r.flexibility >= 4 ? 'high flex' : 'medium flex'
            lines.push(
              `• [p${r.priority}] ${r.description} — ${r.frequency}` +
              (r.dayTime ? ` | usual time: ${r.dayTime}` : '') +
              ` | ${flex}`
            )
          }
        }

        lines.push(`\nCALENDAR — next 14 days:\n${calendarText}`)

        lines.push(
          `\nINSTRUCTIONS:\n` +
          `For each pending event above, pick an appropriate slot (respecting routines and existing events), ` +
          `then:\n` +
          `  1. create_calendar_event(title, start="YYYY-MM-DD HH:MM", end="...", ...)\n` +
          `  2. update_pending_event(id=..., scheduled=true)\n\n` +
          `Work through them highest priority first. If a date was specified, use it. ` +
          `If time is flexible, choose a time that doesn't conflict with routines or existing events. ` +
          `Prefer morning slots for high-priority work, afternoons for lower-priority or social events.`
        )

        return { content: lines.join('\n') }
      }

      case 'create_calendar_event': {
        const start = buildEventTime(str(args.start))
        const end = args.end ? buildEventTime(str(args.end)) : defaultEnd(start)
        const result = await createGoogleCalendarEvent({
          calendar: str(args.calendar) || undefined,
          summary: str(args.title),
          start,
          end,
          location: str(args.location) || undefined,
          description: str(args.description) || undefined,
        })
        if (!result.ok) return { content: `create_calendar_event failed: ${result.error}`, is_error: true }
        return { content: `Event created${result.htmlLink ? ': ' + result.htmlLink : ''} (id=${result.id})` }
      }

      case 'update_calendar_event': {
        const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
        const result = await updateGoogleCalendarEvent({
          id: str(args.id),
          calendar: str(args.calendar) || undefined,
          summary: str(args.title) || undefined,
          start: args.start ? buildEventTime(str(args.start)) : undefined,
          end: args.end ? buildEventTime(str(args.end)) : undefined,
          location: str(args.location) || undefined,
          description: str(args.description) || undefined,
        })
        if (!result.ok) return { content: `update_calendar_event failed: ${result.error}`, is_error: true }
        return { content: `Event ${args.id} updated.` }
      }

      case 'delete_calendar_event': {
        const result = await deleteGoogleCalendarEvent({
          id: str(args.id),
          calendar: str(args.calendar) || undefined,
        })
        if (!result.ok) return { content: `delete_calendar_event failed: ${result.error}`, is_error: true }
        return { content: `Event ${args.id} deleted.` }
      }

      case 'defer_action': {
        const runAt = parseSendAt(str(args.runAt))
        if (isNaN(runAt.getTime())) {
          return { content: `defer_action: invalid runAt "${args.runAt}"`, is_error: true }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = await (prisma as any).scheduledTask.create({
          data: { profileId, topic: str(args.topic), runAt },
        })
        return { content: `Deferred action scheduled for ${runAt.toISOString()} (id=${task.id})` }
      }

      // ── Notes ─────────────────────────────────────────────────────────────

      case 'create_note': {
        const expiresAt = new Date(str(args.expiresAt))
        if (isNaN(expiresAt.getTime())) {
          return { content: `create_note: invalid expiresAt "${args.expiresAt}"`, is_error: true }
        }
        // Enforce 2-week max
        const twoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
        const clampedExpiry = expiresAt > twoWeeks ? twoWeeks : expiresAt
        const note = await prisma.note.create({
          data: {
            profileId,
            title: str(args.title),
            content: str(args.content),
            expiresAt: clampedExpiry,
            modalityTarget: str(args.modalityTarget),
            source: modalityId,
          },
        })
        return { content: `Note created: "${note.title}" (id=${note.id}), expires ${clampedExpiry.toISOString().slice(0, 10)}` }
      }

      case 'resolve_note': {
        const id = str(args.id)
        await prisma.note.update({ where: { id }, data: { resolution: 'Resolved' } })
        return { content: `Note ${id} marked Resolved.` }
      }

      case 'ignore_note': {
        const id = str(args.id)
        await prisma.note.update({ where: { id }, data: { resolution: 'Ignored' } })
        return { content: `Note ${id} marked Ignored.` }
      }

      // ── Communication ─────────────────────────────────────────────────────

      case 'search_email': {
        const result = await searchGmail(str(args.query))
        return { content: result }
      }

      case 'read_email': {
        const result = await readGmailMessage(str(args.id))
        return { content: result }
      }

      case 'send_email': {
        const result = await sendGmail({
          to: str(args.to),
          subject: str(args.subject),
          body: str(args.body),
          cc: str(args.cc) || undefined,
          bcc: str(args.bcc) || undefined,
        })
        if (!result.ok) return { content: `send_email failed: ${result.error}`, is_error: true }
        return { content: `Email sent (id=${result.id})` }
      }

      case 'reply_email': {
        const result = await replyGmail({
          threadId: str(args.thread),
          to: str(args.to) || undefined,
          body: str(args.body),
        })
        if (!result.ok) return { content: `reply_email failed: ${result.error}`, is_error: true }
        return { content: `Reply sent (id=${result.id})` }
      }

      case 'create_draft': {
        const result = await createGmailDraft({
          to: str(args.to),
          subject: str(args.subject),
          body: str(args.body),
          cc: str(args.cc) || undefined,
          bcc: str(args.bcc) || undefined,
        })
        if (!result.ok) return { content: `create_draft failed: ${result.error}`, is_error: true }
        return { content: `Draft created (id=${result.id})` }
      }

      case 'schedule_sms': {
        const sendAt = parseSendAt(str(args.sendAt))
        if (isNaN(sendAt.getTime())) {
          return { content: `schedule_sms: invalid sendAt "${args.sendAt}"`, is_error: true }
        }
        const msg = await prisma.scheduledMessage.create({
          data: {
            profileId,
            message: str(args.message),
            sendAt,
            label: str(args.label) || null,
          },
        })
        return { content: `SMS scheduled for ${sendAt.toISOString()} (id=${msg.id})` }
      }

      case 'cancel_sms': {
        const id = str(args.id)
        await prisma.scheduledMessage.delete({ where: { id } }).catch(() => {})
        return { content: `SMS ${id} cancelled (if it existed and had not yet sent).` }
      }

      // ── Drive ─────────────────────────────────────────────────────────────

      case 'search_drive': {
        const result = await searchDrive(str(args.query))
        return { content: result }
      }

      case 'read_drive_file': {
        const result = await readDriveFileContent(str(args.id))
        switch (result.kind) {
          case 'text':
            return { content: `[${result.name}]\n${result.text}` }
          case 'image':
            return { content: `[${result.name}] (image file — cannot display inline)` }
          case 'pdf':
            return { content: `[${result.name}] (PDF — cannot display inline; ask Adam to share as text)` }
          case 'unsupported':
            return { content: `read_drive_file: ${result.note}`, is_error: true }
        }
      }

      case 'create_drive_file': {
        const result = await createDriveFile({
          name: str(args.name),
          content: str(args.content),
          type: args.type === 'text' ? 'text' : 'doc',
          folderId: str(args.folderId) || undefined,
        })
        if (!result.ok) return { content: `create_drive_file failed: ${result.error}`, is_error: true }
        return { content: `Drive file created: "${result.name}" (id=${result.id})${result.link ? ' ' + result.link : ''}` }
      }

      case 'update_drive_file': {
        const result = await updateDriveFile({
          id: str(args.id),
          name: str(args.name) || undefined,
          content: args.content !== undefined ? str(args.content) : undefined,
        })
        if (!result.ok) return { content: `update_drive_file failed: ${result.error}`, is_error: true }
        return { content: `Drive file ${result.id} updated.` }
      }

      case 'delete_drive_file': {
        const result = await deleteDriveFile({
          id: str(args.id),
          permanent: args.permanent === true || args.permanent === 'true',
        })
        if (!result.ok) return { content: `delete_drive_file failed: ${result.error}`, is_error: true }
        return { content: `Drive file ${result.id} ${args.permanent ? 'permanently deleted' : 'moved to Trash'}.` }
      }

      // ── Clients ───────────────────────────────────────────────────────────

      case 'create_client': {
        const client = await prisma.client.create({
          data: {
            profileId,
            name: str(args.name),
            contactName: str(args.contactName) || null,
            contactSecondary: str(args.contactSecondary) || null,
            phone: str(args.phone) || null,
            email: str(args.email) || null,
            businessStructure: str(args.businessStructure) || null,
            status: str(args.status, 'prospect'),
            services: str(args.services) || null,
            grossRevenue: typeof args.grossRevenue === 'number' ? args.grossRevenue : null,
            billingStatus: str(args.billingStatus) || null,
            notes: str(args.notes) || null,
          },
        })
        return { content: `Client created: "${client.name}" (id=${client.id})` }
      }

      case 'update_client': {
        const id = str(args.id)
        const data: Record<string, unknown> = {}
        if (args.name !== undefined) data.name = str(args.name)
        if (args.contactName !== undefined) data.contactName = str(args.contactName) || null
        if (args.contactSecondary !== undefined) data.contactSecondary = str(args.contactSecondary) || null
        if (args.phone !== undefined) data.phone = str(args.phone) || null
        if (args.email !== undefined) data.email = str(args.email) || null
        if (args.businessStructure !== undefined) data.businessStructure = str(args.businessStructure) || null
        if (args.status !== undefined) data.status = str(args.status)
        if (args.services !== undefined) data.services = str(args.services) || null
        if (args.grossRevenue !== undefined) data.grossRevenue = typeof args.grossRevenue === 'number' ? args.grossRevenue : null
        if (args.billingStatus !== undefined) data.billingStatus = str(args.billingStatus) || null
        if (args.notes !== undefined) data.notes = str(args.notes) || null
        if (Object.keys(data).length === 0) return { content: 'update_client: no fields to update' }
        await prisma.client.update({ where: { id }, data })
        return { content: `Client ${id} updated.` }
      }

      case 'delete_client': {
        const id = str(args.id)
        await prisma.client.delete({ where: { id } })
        return { content: `Client ${id} deleted.` }
      }

      // ── Identity ──────────────────────────────────────────────────────────

      case 'update_identity_user': {
        await prisma.profile.update({
          where: { id: profileId },
          data: { aboutUser: str(args.content), aboutUserUpdatedAt: new Date() },
        })
        return { content: 'Identity (aboutUser) updated.' }
      }

      case 'update_identity_self': {
        await prisma.profile.update({
          where: { id: profileId },
          data: { aboutSelf: str(args.content), aboutSelfUpdatedAt: new Date() },
        })
        return { content: 'Identity (aboutSelf) updated.' }
      }

      // ── Memory ────────────────────────────────────────────────────────────

      case 'rewrite_brief': {
        await prisma.modalityBrief.upsert({
          where: { profileId_modalityId: { profileId, modalityId } },
          create: { profileId, modalityId, content: str(args.content) },
          update: { content: str(args.content) },
        })
        return { content: `Brief for ${modalityId} updated.` }
      }

      case 'search_memory': {
        const q = keywordFilter(str(args.query))
        const memories = await prisma.memory.findMany({
          where: {
            profileId,
            archived: false,
            content: { contains: q },
          },
          orderBy: { importance: 'desc' },
          take: 15,
        })
        if (!memories.length) return { content: '(no matching memories found)' }
        return {
          content: memories.map((m) =>
            `[${m.id}] (${m.category}) ${m.content}`
          ).join('\n'),
        }
      }

      case 'search_deep_memory': {
        const q = keywordFilter(str(args.query))
        const docs = await prisma.deepMemory.findMany({
          where: {
            profileId,
            OR: [
              { name: { contains: q } },
              { content: { contains: q } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: 10,
        })
        if (!docs.length) return { content: '(no matching deep memory documents found)' }
        return {
          content: docs.map((d) => {
            const snippet = d.content.slice(0, 200).replace(/\n/g, ' ')
            return `📄 ${d.name}\n   ${snippet}${d.content.length > 200 ? '…' : ''}`
          }).join('\n\n'),
        }
      }

      case 'read_deep_memory': {
        const name = str(args.name)
        const doc = await prisma.deepMemory.findUnique({
          where: { profileId_name: { profileId, name } },
        })
        if (!doc) return { content: `(no deep memory document named "${name}")` }
        return { content: doc.content }
      }

      case 'write_deep_memory': {
        const name = str(args.name)
        const content = str(args.content)
        await prisma.deepMemory.upsert({
          where: { profileId_name: { profileId, name } },
          create: { profileId, name, content, domain: domain ?? null },
          update: { content },
        })
        return { content: `Deep memory document "${name}" written.` }
      }

      case 'log_entry': {
        await prisma.memoryLog.create({
          data: {
            profileId,
            label: str(args.label),
            content: str(args.content),
            domain: domain ?? null,
          },
        })
        return { content: `Log entry recorded: "${args.label}"` }
      }

      case 'search_log': {
        const q = keywordFilter(str(args.query))
        const entries = await prisma.memoryLog.findMany({
          where: {
            profileId,
            OR: [
              { label: { contains: q } },
              { content: { contains: q } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 15,
        })
        if (!entries.length) return { content: '(no matching log entries found)' }
        return {
          content: entries.map((e) =>
            `[${e.createdAt.toISOString().slice(0, 10)}] ${e.label}\n  ${e.content}`
          ).join('\n\n'),
        }
      }

      // ── Focus lock ────────────────────────────────────────────────────────

      case 'lock_focus': {
        const profile = str(args.profile)
        const release = str(args.release) as 'timed' | 'optional'
        const duration = typeof args.duration === 'number' ? args.duration : undefined
        const unlocksAt =
          release === 'timed' && duration
            ? new Date(Date.now() + duration * 60 * 1000)
            : null
        await sendNotification(
          `profile=${profile} release=${release}${duration ? ` duration=${duration}` : ''}`,
          'PENNY_LOCK'
        )
        await prisma.profile.update({
          where: { id: profileId },
          data: {
            focusLocked: true,
            focusProfile: profile,
            focusLockedAt: new Date(),
            focusReleaseType: release,
            focusUnlocksAt: unlocksAt,
          },
        })
        return { content: `Focus locked: profile="${profile}" release=${release}${duration ? ` for ${duration}min` : ''}.` }
      }

      case 'unlock_focus': {
        const reason = str(args.reason) as 'approved' | 'emergency'
        await sendNotification(`reason=${reason}`, 'PENNY_UNLOCK')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unlockData: any = {
          focusLocked: false,
          focusProfile: null,
          focusLockedAt: null,
          focusReleaseType: null,
          focusUnlocksAt: null,
        }
        if (reason === 'emergency') unlockData.focusEmergencyCount = { increment: 1 }
        await prisma.profile.update({ where: { id: profileId }, data: unlockData })
        return { content: `Focus unlocked (reason=${reason}).` }
      }

      case 'update_lock_profiles': {
        await prisma.profile.update({
          where: { id: profileId },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { focusProfiles: str(args.content) } as any,
        })
        return { content: 'Focus lock profiles updated.' }
      }

      // ── Fallthrough ───────────────────────────────────────────────────────

      default:
        return { content: `Tool "${name}" is registered but has no executor. This is a bug.`, is_error: true }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[tool-executor] ${name} failed:`, err)
    return { content: `${name} failed: ${message}`, is_error: true }
  }
}
