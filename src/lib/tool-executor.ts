// Tool executor — maps Anthropic tool_use calls to DB / API actions.
// Returns a result string that goes back to the model as tool_result content.
//
// Usage:
//   const { content, is_error } = await executeTool(name, args, ctx)
//
// Downloadable artifacts remain inline because they are returned through the
// streaming response rather than mutating external state.

import { prisma } from './db'
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
import { getProtocol, LIVE_PROTOCOL_NAMES, type ProtocolName } from './protocols'
import { invalidateContext } from './context-cache'
import { executeReviewTool, type ReviewToolContext } from './items/item-tools'
import { searchItems } from './items/item-store'
import { startOrResumeReview } from './review/session'
import type { ReviewKind } from './review/phases'

// Item and Project table tools delegate to the same executor Review uses.
const TABLE_TOOL_NAMES = new Set(['query_table', 'write_table'])

// Read-only tools — these never change anything the system-prompt context cache
// holds, so they leave it intact. Everything else invalidates the cache after it
// runs so the next turn rebuilds context from fresh data (see context-cache.ts).
const READ_ONLY_TOOLS = new Set<string>([
  'load_protocol',
  'query_table',
  'read_project_notes',
  'read_calendar_day',
  'search_calendar',
  'schedule_planned_items',
  'search_email',
  'read_email',
  'search_drive',
  'read_drive_file',
  'search_deep_memory',
  'read_deep_memory',
  'search_log',
])

// ─── Context ─────────────────────────────────────────────────────────────────

export interface ToolContext {
  profileId: string
  modalityId: string
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

  // Any tool that can write drops this profile's cached context so the next turn
  // rebuilds from fresh data. Safe to do up front: the current turn already
  // loaded its context before any tool ran; the cache is next read next turn.
  if (!READ_ONLY_TOOLS.has(name)) invalidateContext(profileId)

  if (TABLE_TOOL_NAMES.has(name)) {
    return executeReviewTool(name, args, ctx as ReviewToolContext) // no reviewSessionId outside Review — see item-tools.ts
  }

  try {
    switch (name) {

      // ── Protocol loader ───────────────────────────────────────────────────

      case 'load_protocol': {
        const which = str(args.which) as ProtocolName
        if (!LIVE_PROTOCOL_NAMES.includes(which)) {
          return {
            content: `Unknown protocol "${which}". Available: ${LIVE_PROTOCOL_NAMES.join(', ')}`,
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

      // ── Review handoff ────────────────────────────────────────────────────

      case 'start_review': {
        const kind: ReviewKind = modalityId === 'pa' ? 'pa' : 'submodality'
        const { session, resumed } = await startOrResumeReview(profileId, kind, modalityId)
        // Structured so the chat route can detect this and flip the UI into
        // Review mode — see the reviewStarted handling in app/api/chat/route.ts.
        return {
          content: JSON.stringify({
            started: true, resumed,
            kind: session.kind, modalityId: session.modalityId, phase: session.phase,
          }),
        }
      }

      case 'complete_intake': {
        await prisma.profile.update({
          where: { id: profileId },
          data: { intakeComplete: true },
        })
        return { content: 'Intake completed.' }
      }

      // ── Projects ──────────────────────────────────────────────────────────
      // Create/update go through query_table/write_table (table='project'),
      // dispatched above via TABLE_TOOL_NAMES. What's left here is the one cell
      // that lives in a different table (the DeepMemory notes doc) and the
      // cascading delete — neither is a plain project-row write.

      case 'read_project_notes': {
        const id = str(args.id)
        const docName = `project-${id}-notes`
        const doc = await prisma.deepMemory.findUnique({
          where: { profileId_name: { profileId, name: docName } },
        })
        if (!doc) return { content: `(no notes found for project ${id})` }
        return { content: doc.content }
      }

      case 'delete_project': {
        const id = str(args.id)
        // Unlink rather than cascade-delete items that pointed at this project.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).item.updateMany({ where: { projectId: id }, data: { projectId: null } })
        await prisma.deepMemory.deleteMany({ where: { profileId, name: `project-${id}-notes` } }).catch(() => {})
        await prisma.project.delete({ where: { id } })
        return { content: `Project ${id} deleted (linked items kept, unlinked).` }
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

      case 'schedule_planned_items': {
        // Load every Item at stage='planned', from ANY
        // target. There's no separate "escalated to Penny" hand-off anymore: a
        // submodality committing to something (moving it to 'planned') IS what
        // puts it in Penny's queue, since she's the only one who places things on
        // the calendar. Read two weeks of calendar, then return a full briefing so
        // the model can place events with create_calendar_event +
        // write_table(stage='scheduled').

        const allItems = await searchItems(profileId, {})
        const planned = allItems.filter((i) => i.stage === 'planned')
          .sort((a, b) => b.priority - a.priority)

        if (planned.length === 0) {
          return { content: 'There are no planned items to schedule.' }
        }

        // Read the next 14 days of calendar for slot-finding context
        const today = new Date().toISOString().slice(0, 10)
        const calendarText = await getGoogleCalendarAgenda(today, 14).catch(
          () => '(calendar unavailable)'
        )

        const lines: string[] = [
          `PLANNED ITEMS — ${planned.length} item(s) to place:\n`,
        ]

        for (const evt of planned) {
          const dateHint = evt.dueDate ? ` | target date: ${evt.dueDate.toISOString().slice(0, 10)}` : ' | date flexible'
          const timeHint = evt.dayTime ? ` @ ${evt.dayTime}` : ' | time flexible'
          lines.push(
            `• [id=${evt.id} p${evt.priority}] "${evt.name}" — duration: ${evt.duration ?? 'unspecified'}${dateHint}${timeHint}` +
            (evt.description ? `\n  Notes: ${evt.description}` : '')
          )
        }

        lines.push(`\nCALENDAR — next 14 days:\n${calendarText}`)

        lines.push(
          `\nINSTRUCTIONS:\n` +
          `For each planned item above, pick an appropriate slot (respecting existing events), then:\n` +
          `  1. create_calendar_event(title, start="YYYY-MM-DD HH:MM", end="...", ...)\n` +
          `  2. write_table(table='item', id=..., fields={ stage: 'scheduled' })\n\n` +
          `Work through them highest priority first. If a date was specified, use it. ` +
          `If time is flexible, choose a time that doesn't conflict with existing events. ` +
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
        // PA owns the global, shared picture of the user (Profile.aboutUser).
        // A submodality maintains only her own slice (ModalityIdentity.aboutUserFacet).
        const m = getModality(modalityId)
        if (m.domain === null) {
          await prisma.profile.update({
            where: { id: profileId },
            data: { aboutUser: str(args.content), aboutUserUpdatedAt: new Date() },
          })
          return { content: 'Identity (shared aboutUser) updated.' }
        }
        await prisma.modalityIdentity.upsert({
          where: { profileId_modalityId: { profileId, modalityId } },
          create: { profileId, modalityId, aboutUserFacet: str(args.content), aboutUserFacetUpdatedAt: new Date() },
          update: { aboutUserFacet: str(args.content), aboutUserFacetUpdatedAt: new Date() },
        })
        return { content: 'Identity (your slice of the user) updated.' }
      }

      case 'update_identity_self': {
        // Each modality owns its own self-portrait in ModalityIdentity.
        await prisma.modalityIdentity.upsert({
          where: { profileId_modalityId: { profileId, modalityId } },
          create: { profileId, modalityId, aboutSelf: str(args.content), aboutSelfUpdatedAt: new Date() },
          update: { aboutSelf: str(args.content), aboutSelfUpdatedAt: new Date() },
        })
        return { content: 'Identity (your self-portrait) updated.' }
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
