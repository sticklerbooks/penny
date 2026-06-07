// Parses action markers from Penny's responses and executes them.
// Markers are XML-like tags Penny embeds in her replies; the user never sees them.

import { prisma } from './db'
import { sendNotification } from './pushover'
import {
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  sendGmail,
  replyGmail,
  createGmailDraft,
  type EventTime,
} from './google'

// Parse "YYYY-MM-DD HH:MM" as local time in a given IANA timezone.
// Falls back to direct Date parsing for ISO strings.
function parseSendAt(at: string, tz: string): Date {
  // Try "YYYY-MM-DD HH:MM" format
  const m = at.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/)
  if (m) {
    // Use Intl to figure out the UTC offset for this local time in the given tz
    const localStr = `${m[1]}T${m[2]}:00`
    // Create a date object interpreting the string as UTC, then shift
    const naive = new Date(localStr + 'Z')
    // Get what this UTC time looks like in the target timezone
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    // Binary search would be precise; for simplicity, use offset estimation
    // Get offset by comparing UTC interpretation vs local representation
    const parts = formatter.formatToParts(naive)
    const p = Object.fromEntries(parts.map(p => [p.type, p.value]))
    const tzStr = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`
    const tzDate = new Date(tzStr)
    const offsetMs = tzDate.getTime() - naive.getTime()
    return new Date(naive.getTime() - offsetMs)
  }
  // Fallback: let Date parse it (handles ISO strings)
  return new Date(at)
}

// Build a Google Calendar start/end object from a marker value.
// "YYYY-MM-DD"        → all-day event ({ date })
// "YYYY-MM-DD HH:MM"  → timed event ({ dateTime, timeZone }) in the given tz
function buildEventTime(value: string, tz: string): EventTime {
  const v = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v }
  return { dateTime: parseSendAt(v, tz).toISOString(), timeZone: tz }
}

// Default end when the model omits one: +1 hour for timed events, +1 day
// (exclusive) for all-day events — matching Google's all-day convention.
function defaultEnd(start: EventTime): EventTime {
  if (start.date) {
    const d = new Date(start.date + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    return { date: d.toISOString().slice(0, 10) }
  }
  const d = new Date(start.dateTime!)
  return { dateTime: new Date(d.getTime() + 60 * 60 * 1000).toISOString(), timeZone: start.timeZone }
}

export type PennyAction =
  | { kind: 'create_task'; title: string; due?: string; priority?: number; category?: string; clientId?: string; description?: string; timing?: string; lastReviewed?: string }
  | { kind: 'update_task'; id: string; status?: string; priority?: number; due?: string; clientId?: string; pennyNotes?: string; onMasterList?: boolean; timing?: string; lastReviewed?: string }
  | { kind: 'delete_task'; id: string }
  | { kind: 'create_memory'; category: string; content: string; importance?: number }
  | { kind: 'update_memory'; id: string; content?: string; category?: string; importance?: number; archived?: boolean }
  | { kind: 'delete_memory'; id: string }
  | { kind: 'next_session_note'; content: string; target?: string }
  | { kind: 'resolve_note'; id: string }
  | { kind: 'delete_note'; id: string }
  | { kind: 'create_client'; name: string; contactName?: string; contactSecondary?: string; phone?: string; email?: string; businessStructure?: string; status?: string; services?: string; grossRevenue?: number; billingStatus?: string; notes?: string }
  | { kind: 'update_client'; id: string; name?: string; contactName?: string; contactSecondary?: string; phone?: string; email?: string; businessStructure?: string; status?: string; services?: string; grossRevenue?: number; billingStatus?: string; notes?: string }
  | { kind: 'delete_client'; id: string }
  | { kind: 'schedule_sms'; sendAt: string; message: string; label?: string }
  | { kind: 'cancel_sms'; id: string }
  | { kind: 'search_email'; query: string; label?: string }
  | { kind: 'search_calendar'; query: string; label?: string }
  | { kind: 'read_email'; id: string; label?: string }
  | { kind: 'calendar_agenda'; date: string; days?: number; label?: string }
  | { kind: 'search_drive'; query: string; label?: string }
  | { kind: 'read_drive_file'; id: string; label?: string }
  | { kind: 'send_email'; to: string; subject: string; cc?: string; bcc?: string; body: string }
  | { kind: 'reply_email'; thread: string; to?: string; body: string }
  | { kind: 'create_draft'; to: string; subject: string; cc?: string; bcc?: string; body: string }
  | { kind: 'create_calendar_event'; title: string; start: string; end?: string; calendar?: string; location?: string; description?: string }
  | { kind: 'update_calendar_event'; id: string; calendar?: string; title?: string; start?: string; end?: string; location?: string; description?: string }
  | { kind: 'delete_calendar_event'; id: string; calendar?: string }
  | { kind: 'update_user_profile'; content: string }
  | { kind: 'update_self_notes'; content: string }
  | { kind: 'update_private_user_profile'; content: string }
  | { kind: 'update_private_self_notes'; content: string }
  | { kind: 'update_alt_about_user'; content: string }
  | { kind: 'update_alt_about_self'; content: string }
  | { kind: 'run_subroutine'; name: string }
  | { kind: 'complete_session' }
  | { kind: 'shift_complete' }
  | { kind: 'switch_modality'; name: string }
  | { kind: 'artifact'; filename: string; content: string }
  | { kind: 'schedule_task'; topic: string; runAt: string }
  | { kind: 'lock_focus'; profile: string; release: 'timed' | 'optional'; duration?: number }
  | { kind: 'unlock_focus'; reason: 'approved' | 'emergency' }
  | { kind: 'update_lock_profiles'; content: string }

// Regex patterns for each marker type
const TASK_RE = /<task\s+([^/>]*)\/?>(?:([\s\S]*?)<\/task>)?/gi
const UPDATE_TASK_RE = /<update_task\s+([^/>]*)\/?>/gi
const DELETE_TASK_RE = /<delete_task\s+id=["']([^"']+)["']\s*\/?>/gi
const MEMORY_RE = /<memory\s+([^>]*)>([\s\S]*?)<\/memory>/gi
const UPDATE_MEMORY_RE = /<update_memory\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/update_memory>)/gi
const DELETE_MEMORY_RE = /<delete_memory\s+id=["']([^"']+)["']\s*\/?>/gi
const NEXT_SESSION_RE = /<next_session(\s+[^>]*)?>([\s\S]*?)<\/next_session>/gi
const RESOLVE_NOTE_RE = /<resolve_note\s+id=["']([^"']+)["']\s*\/?>/gi
const DELETE_NOTE_RE = /<delete_note\s+id=["']([^"']+)["']\s*\/?>/gi
const CLIENT_RE = /<client\s+([^>]*)>(?:([\s\S]*?))<\/client>/gi
const UPDATE_CLIENT_RE = /<update_client\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/update_client>)/gi
const DELETE_CLIENT_RE = /<delete_client\s+id=["']([^"']+)["']\s*\/?>/gi
const SCHEDULE_SMS_RE = /<schedule_sms\s+([^>]*)>([\s\S]*?)<\/schedule_sms>/gi
const CANCEL_SMS_RE = /<cancel_sms\s+id=["']([^"']+)["']\s*\/?>/gi
const SEARCH_EMAIL_RE = /<search_email\s+([^/>]*)\/?>/gi
const SEARCH_CALENDAR_RE = /<search_calendar\s+([^/>]*)\/?>/gi
const READ_EMAIL_RE = /<read_email\s+([^/>]*)\/?>/gi
const CALENDAR_AGENDA_RE = /<calendar_agenda\s+([^/>]*)\/?>/gi
const SEARCH_DRIVE_RE = /<search_drive\s+([^/>]*)\/?>/gi
const READ_DRIVE_FILE_RE = /<read_drive_file\s+([^/>]*)\/?>/gi
const SEND_EMAIL_RE = /<send_email\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/send_email>)/gi
const REPLY_EMAIL_RE = /<reply_email\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/reply_email>)/gi
const CREATE_DRAFT_RE = /<create_draft\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/create_draft>)/gi
const CREATE_CAL_EVENT_RE = /<create_calendar_event\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/create_calendar_event>)/gi
const UPDATE_CAL_EVENT_RE = /<update_calendar_event\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/update_calendar_event>)/gi
const DELETE_CAL_EVENT_RE = /<delete_calendar_event\s+([^/>]*)\/?>/gi
const UPDATE_USER_PROFILE_RE = /<update_user_profile>([\s\S]*?)<\/update_user_profile>/gi
const UPDATE_SELF_NOTES_RE = /<update_self_notes>([\s\S]*?)<\/update_self_notes>/gi
const UPDATE_PRIVATE_USER_PROFILE_RE = /<update_private_user_profile>([\s\S]*?)<\/update_private_user_profile>/gi
const UPDATE_PRIVATE_SELF_NOTES_RE = /<update_private_self_notes>([\s\S]*?)<\/update_private_self_notes>/gi
const UPDATE_ALT_ABOUT_USER_RE = /<update_alt_about_user>([\s\S]*?)<\/update_alt_about_user>/gi
const UPDATE_ALT_ABOUT_SELF_RE = /<update_alt_about_self>([\s\S]*?)<\/update_alt_about_self>/gi
const RUN_SUBROUTINE_RE = /<run_subroutine\s+name=["']([^"']+)["']\s*\/?>/gi
const COMPLETE_SESSION_RE = /<complete_session\s*\/?>/gi
const SHIFT_COMPLETE_RE = /<shift_complete\s*\/?>/gi
const SWITCH_MODALITY_RE = /<switch_modality\s+name=["']([^"']+)["']\s*\/?>/gi
const ARTIFACT_RE = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi
const SCHEDULE_TASK_RE = /<schedule_task\s+([^>]*)>([\s\S]*?)<\/schedule_task>/gi
const LOCK_FOCUS_RE = /<lock_focus\s+([^/>]*)\/?>/gi
const UNLOCK_FOCUS_RE = /<unlock_focus\s+([^/>]*)\/?>/gi
const UPDATE_LOCK_PROFILES_RE = /<update_lock_profiles>([\s\S]*?)<\/update_lock_profiles>/gi

// Parse XML attributes from a string like: title="foo" due="2026-06-01" priority="9"
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*["']([^"']*)["']/g
  let m
  while ((m = re.exec(s))) out[m[1]] = m[2]
  return out
}

export function parseActions(text: string): { actions: PennyAction[]; cleanText: string } {
  const actions: PennyAction[] = []

  // create_task
  for (const m of text.matchAll(TASK_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.title) continue
    actions.push({
      kind: 'create_task',
      title: attrs.title,
      due: attrs.due,
      priority: attrs.priority ? parseInt(attrs.priority) : undefined,
      category: attrs.category,
      clientId: attrs.client_id,
      description: (m[2] || attrs.description || '').trim() || undefined,
      timing: attrs.timing,
      lastReviewed: attrs.last_reviewed,
    })
  }

  // update_task
  for (const m of text.matchAll(UPDATE_TASK_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    actions.push({
      kind: 'update_task',
      id: attrs.id,
      status: attrs.status,
      priority: attrs.priority ? parseInt(attrs.priority) : undefined,
      due: attrs.due,
      clientId: attrs.client_id,
      pennyNotes: attrs.notes,
      onMasterList: attrs.master !== undefined ? attrs.master === 'true' : undefined,
      timing: attrs.timing,
      lastReviewed: attrs.last_reviewed,
    })
  }

  // delete_task
  for (const m of text.matchAll(DELETE_TASK_RE)) {
    actions.push({ kind: 'delete_task', id: m[1] })
  }

  // create_memory
  for (const m of text.matchAll(MEMORY_RE)) {
    const attrs = parseAttrs(m[1])
    const content = m[2].trim()
    if (!content) continue
    actions.push({
      kind: 'create_memory',
      category: attrs.category || 'personal',
      content,
      importance: attrs.importance ? parseInt(attrs.importance) : 6,
    })
  }

  // update_memory
  for (const m of text.matchAll(UPDATE_MEMORY_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    const bodyContent = (m[2] || '').trim()
    actions.push({
      kind: 'update_memory',
      id: attrs.id,
      content: bodyContent || attrs.content,
      category: attrs.category,
      importance: attrs.importance ? parseInt(attrs.importance) : undefined,
      archived: attrs.archived !== undefined ? attrs.archived === 'true' : undefined,
    })
  }

  // delete_memory
  for (const m of text.matchAll(DELETE_MEMORY_RE)) {
    actions.push({ kind: 'delete_memory', id: m[1] })
  }

  // next_session (optional target="pa" to pass a note up to the Personal Assistant)
  for (const m of text.matchAll(NEXT_SESSION_RE)) {
    const attrs = m[1] ? parseAttrs(m[1]) : {}
    const content = (m[2] || '').trim()
    if (!content) continue
    actions.push({ kind: 'next_session_note', content, target: attrs.target })
  }

  // resolve_note
  for (const m of text.matchAll(RESOLVE_NOTE_RE)) {
    actions.push({ kind: 'resolve_note', id: m[1] })
  }

  // delete_note
  for (const m of text.matchAll(DELETE_NOTE_RE)) {
    actions.push({ kind: 'delete_note', id: m[1] })
  }

  // create_client
  for (const m of text.matchAll(CLIENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.name) continue
    actions.push({
      kind: 'create_client',
      name: attrs.name,
      contactName: attrs.contact_name,
      contactSecondary: attrs.contact_secondary,
      phone: attrs.phone,
      email: attrs.email,
      businessStructure: attrs.business_structure,
      status: attrs.status,
      services: attrs.services,
      grossRevenue: attrs.gross_revenue ? parseFloat(attrs.gross_revenue) : undefined,
      billingStatus: attrs.billing_status,
      notes: (m[2] || '').trim() || undefined,
    })
  }

  // update_client
  for (const m of text.matchAll(UPDATE_CLIENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    const bodyNotes = (m[2] || '').trim()
    actions.push({
      kind: 'update_client',
      id: attrs.id,
      name: attrs.name,
      contactName: attrs.contact_name,
      contactSecondary: attrs.contact_secondary,
      phone: attrs.phone,
      email: attrs.email,
      businessStructure: attrs.business_structure,
      status: attrs.status,
      services: attrs.services,
      grossRevenue: attrs.gross_revenue ? parseFloat(attrs.gross_revenue) : undefined,
      billingStatus: attrs.billing_status,
      notes: bodyNotes || undefined,
    })
  }

  // delete_client
  for (const m of text.matchAll(DELETE_CLIENT_RE)) {
    actions.push({ kind: 'delete_client', id: m[1] })
  }

  // schedule_sms
  for (const m of text.matchAll(SCHEDULE_SMS_RE)) {
    const attrs = parseAttrs(m[1])
    const message = m[2].trim()
    if (!attrs.at || !message) continue
    actions.push({
      kind: 'schedule_sms',
      sendAt: attrs.at,
      message,
      label: attrs.label,
    })
  }

  // cancel_sms
  for (const m of text.matchAll(CANCEL_SMS_RE)) {
    actions.push({ kind: 'cancel_sms', id: m[1] })
  }

  // search_email
  for (const m of text.matchAll(SEARCH_EMAIL_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.query) continue
    actions.push({ kind: 'search_email', query: attrs.query, label: attrs.label })
  }

  // search_calendar
  for (const m of text.matchAll(SEARCH_CALENDAR_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.query) continue
    actions.push({ kind: 'search_calendar', query: attrs.query, label: attrs.label })
  }

  // read_email
  for (const m of text.matchAll(READ_EMAIL_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    actions.push({ kind: 'read_email', id: attrs.id, label: attrs.label })
  }

  // calendar_agenda — full event list for a specific date (or span of days)
  for (const m of text.matchAll(CALENDAR_AGENDA_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.date) continue
    actions.push({
      kind: 'calendar_agenda',
      date: attrs.date,
      days: attrs.days ? parseInt(attrs.days) : undefined,
      label: attrs.label,
    })
  }

  // search_drive
  for (const m of text.matchAll(SEARCH_DRIVE_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.query) continue
    actions.push({ kind: 'search_drive', query: attrs.query, label: attrs.label })
  }

  // read_drive_file
  for (const m of text.matchAll(READ_DRIVE_FILE_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    actions.push({ kind: 'read_drive_file', id: attrs.id, label: attrs.label })
  }

  // send_email
  for (const m of text.matchAll(SEND_EMAIL_RE)) {
    const attrs = parseAttrs(m[1])
    const body = (m[2] || '').trim()
    if (!attrs.to || !attrs.subject || !body) continue
    actions.push({
      kind: 'send_email',
      to: attrs.to,
      subject: attrs.subject,
      cc: attrs.cc,
      bcc: attrs.bcc,
      body,
    })
  }

  // reply_email
  for (const m of text.matchAll(REPLY_EMAIL_RE)) {
    const attrs = parseAttrs(m[1])
    const body = (m[2] || '').trim()
    if (!attrs.thread || !body) continue
    actions.push({ kind: 'reply_email', thread: attrs.thread, to: attrs.to, body })
  }

  // create_draft
  for (const m of text.matchAll(CREATE_DRAFT_RE)) {
    const attrs = parseAttrs(m[1])
    const body = (m[2] || '').trim()
    if (!attrs.to || !attrs.subject || !body) continue
    actions.push({
      kind: 'create_draft',
      to: attrs.to,
      subject: attrs.subject,
      cc: attrs.cc,
      bcc: attrs.bcc,
      body,
    })
  }

  // create_calendar_event
  for (const m of text.matchAll(CREATE_CAL_EVENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.title || !attrs.start) continue
    actions.push({
      kind: 'create_calendar_event',
      title: attrs.title,
      start: attrs.start,
      end: attrs.end,
      calendar: attrs.calendar,
      location: attrs.location,
      description: (m[2] || attrs.description || '').trim() || undefined,
    })
  }

  // update_calendar_event
  for (const m of text.matchAll(UPDATE_CAL_EVENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    const bodyDesc = (m[2] || '').trim()
    actions.push({
      kind: 'update_calendar_event',
      id: attrs.id,
      calendar: attrs.calendar,
      title: attrs.title,
      start: attrs.start,
      end: attrs.end,
      location: attrs.location,
      description: bodyDesc || attrs.description,
    })
  }

  // delete_calendar_event
  for (const m of text.matchAll(DELETE_CAL_EVENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    actions.push({ kind: 'delete_calendar_event', id: attrs.id, calendar: attrs.calendar })
  }

  // update_user_profile
  for (const m of text.matchAll(UPDATE_USER_PROFILE_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_user_profile', content })
  }

  // update_self_notes
  for (const m of text.matchAll(UPDATE_SELF_NOTES_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_self_notes', content })
  }

  // update_private_user_profile
  for (const m of text.matchAll(UPDATE_PRIVATE_USER_PROFILE_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_private_user_profile', content })
  }

  // update_private_self_notes
  for (const m of text.matchAll(UPDATE_PRIVATE_SELF_NOTES_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_private_self_notes', content })
  }

  // update_alt_about_user
  for (const m of text.matchAll(UPDATE_ALT_ABOUT_USER_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_alt_about_user', content })
  }

  // update_alt_about_self
  for (const m of text.matchAll(UPDATE_ALT_ABOUT_SELF_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_alt_about_self', content })
  }

  // run_subroutine
  for (const m of text.matchAll(RUN_SUBROUTINE_RE)) {
    const name = m[1].trim()
    if (!name) continue
    actions.push({ kind: 'run_subroutine', name })
  }

  // complete_session — use a fresh non-global regex for .test() to avoid
  // mutating lastIndex on the module-level COMPLETE_SESSION_RE used in replace()
  if (/<complete_session\s*\/?>/i.test(text)) {
    actions.push({ kind: 'complete_session' })
  }

  // shift_complete (fresh non-global regex for .test())
  if (/<shift_complete\s*\/?>/i.test(text)) {
    actions.push({ kind: 'shift_complete' })
  }

  // switch_modality
  for (const m of text.matchAll(SWITCH_MODALITY_RE)) {
    const name = m[1].trim()
    if (!name) continue
    actions.push({ kind: 'switch_modality', name })
  }

  // schedule_task — Penny schedules a future check-in for herself
  for (const m of text.matchAll(SCHEDULE_TASK_RE)) {
    const attrs = parseAttrs(m[1])
    const topic = (m[2] || '').trim()
    if (!attrs.run_at || !topic) continue
    actions.push({ kind: 'schedule_task', runAt: attrs.run_at, topic })
  }

  // lock_focus
  for (const m of text.matchAll(LOCK_FOCUS_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.profile || !attrs.release) continue
    const release = attrs.release as 'timed' | 'optional'
    if (release !== 'timed' && release !== 'optional') continue
    actions.push({
      kind: 'lock_focus',
      profile: attrs.profile,
      release,
      duration: attrs.duration ? parseInt(attrs.duration) : undefined,
    })
  }

  // update_lock_profiles
  for (const m of text.matchAll(UPDATE_LOCK_PROFILES_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'update_lock_profiles', content })
  }

  // unlock_focus
  for (const m of text.matchAll(UNLOCK_FOCUS_RE)) {
    const attrs = parseAttrs(m[1])
    const reason = attrs.reason as 'approved' | 'emergency'
    if (reason !== 'approved' && reason !== 'emergency') continue
    actions.push({ kind: 'unlock_focus', reason })
  }

  // artifact — a file Penny generates for the user to download
  for (const m of text.matchAll(ARTIFACT_RE)) {
    const attrs = parseAttrs(m[1])
    const content = m[2] || ''
    const filename = attrs.filename || 'penny-output.txt'
    if (!content.trim()) continue
    actions.push({ kind: 'artifact', filename, content })
  }

  // Strip all marker tags from the displayed/saved text
  const cleanText = text
    .replace(TASK_RE, '')
    .replace(UPDATE_TASK_RE, '')
    .replace(DELETE_TASK_RE, '')
    .replace(MEMORY_RE, '')
    .replace(UPDATE_MEMORY_RE, '')
    .replace(DELETE_MEMORY_RE, '')
    .replace(NEXT_SESSION_RE, '')
    .replace(RESOLVE_NOTE_RE, '')
    .replace(DELETE_NOTE_RE, '')
    .replace(CLIENT_RE, '')
    .replace(UPDATE_CLIENT_RE, '')
    .replace(DELETE_CLIENT_RE, '')
    .replace(SCHEDULE_SMS_RE, '')
    .replace(CANCEL_SMS_RE, '')
    .replace(SEARCH_EMAIL_RE, '')
    .replace(SEARCH_CALENDAR_RE, '')
    .replace(READ_EMAIL_RE, '')
    .replace(CALENDAR_AGENDA_RE, '')
    .replace(SEARCH_DRIVE_RE, '')
    .replace(READ_DRIVE_FILE_RE, '')
    .replace(SEND_EMAIL_RE, '')
    .replace(REPLY_EMAIL_RE, '')
    .replace(CREATE_DRAFT_RE, '')
    .replace(CREATE_CAL_EVENT_RE, '')
    .replace(UPDATE_CAL_EVENT_RE, '')
    .replace(DELETE_CAL_EVENT_RE, '')
    .replace(UPDATE_USER_PROFILE_RE, '')
    .replace(UPDATE_SELF_NOTES_RE, '')
    .replace(UPDATE_PRIVATE_USER_PROFILE_RE, '')
    .replace(UPDATE_PRIVATE_SELF_NOTES_RE, '')
    .replace(UPDATE_ALT_ABOUT_USER_RE, '')
    .replace(UPDATE_ALT_ABOUT_SELF_RE, '')
    .replace(RUN_SUBROUTINE_RE, '')
    .replace(COMPLETE_SESSION_RE, '')
    .replace(SHIFT_COMPLETE_RE, '')
    .replace(SWITCH_MODALITY_RE, '')
    .replace(ARTIFACT_RE, '')
    .replace(SCHEDULE_TASK_RE, '')
    .replace(LOCK_FOCUS_RE, '')
    .replace(UNLOCK_FOCUS_RE, '')
    .replace(UPDATE_LOCK_PROFILES_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { actions, cleanText }
}

export async function executeActions(
  profileId: string,
  actions: PennyAction[],
  ctx: { domain?: string | null; modalityId?: string; altModeScope?: string } = {}
): Promise<void> {
  const domain = ctx.domain ?? null
  const modalityId = ctx.modalityId ?? 'pa'
  const altModeScope = ctx.altModeScope ?? null
  for (const action of actions) {
    try {
      switch (action.kind) {
        case 'create_task':
          await prisma.task.create({
            data: {
              profileId,
              title: action.title,
              description: action.description ?? null,
              dueDate: action.due ? new Date(action.due) : null,
              priority: action.priority ?? 5,
              category: action.category ?? null,
              clientId: action.clientId ?? null,
              domain,
              timing: action.timing ?? null,
              lastReviewed: action.lastReviewed ? new Date(action.lastReviewed) : null,
            },
          })
          break

        case 'update_task': {
          const data: Record<string, unknown> = {}
          if (action.status) data.status = action.status
          if (action.priority !== undefined) data.priority = action.priority
          if (action.due) data.dueDate = new Date(action.due)
          if (action.clientId !== undefined) data.clientId = action.clientId || null
          if (action.pennyNotes) data.pennyNotes = action.pennyNotes
          if (action.onMasterList !== undefined) data.onMasterList = action.onMasterList
          if (action.timing !== undefined) data.timing = action.timing
          if (action.lastReviewed) data.lastReviewed = new Date(action.lastReviewed)
          if (Object.keys(data).length === 0) break
          await prisma.task.update({ where: { id: action.id }, data })
          break
        }

        case 'delete_task':
          await prisma.task.delete({ where: { id: action.id } })
          break

        case 'create_memory':
          await prisma.memory.create({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: {
              profileId,
              category: action.category,
              content: action.content,
              importance: action.importance ?? 6,
              domain,
              altModeScope,
            } as any,
          })
          break

        case 'update_memory': {
          const data: Record<string, unknown> = {}
          if (action.content) data.content = action.content
          if (action.category) data.category = action.category
          if (action.importance !== undefined) data.importance = action.importance
          if (action.archived !== undefined) data.archived = action.archived
          if (Object.keys(data).length === 0) break
          await prisma.memory.update({ where: { id: action.id }, data })
          break
        }

        case 'delete_memory':
          await prisma.memory.delete({ where: { id: action.id } })
          break

        case 'next_session_note':
          await prisma.nextSessionNote.create({
            data: {
              profileId,
              content: action.content,
              source: modalityId,
              target: action.target ?? null,
            },
          })
          break

        case 'resolve_note':
          await prisma.nextSessionNote.update({
            where: { id: action.id },
            data: { resolved: true },
          })
          break

        case 'delete_note':
          await prisma.nextSessionNote.delete({ where: { id: action.id } })
          break

        case 'create_client':
          await prisma.client.create({
            data: {
              profileId,
              name: action.name,
              contactName: action.contactName ?? null,
              contactSecondary: action.contactSecondary ?? null,
              phone: action.phone ?? null,
              email: action.email ?? null,
              businessStructure: action.businessStructure ?? null,
              status: action.status ?? 'prospect',
              services: action.services ?? null,
              grossRevenue: action.grossRevenue ?? null,
              billingStatus: action.billingStatus ?? null,
              notes: action.notes ?? null,
            },
          })
          break

        case 'update_client': {
          const data: Record<string, unknown> = {}
          if (action.name) data.name = action.name
          if (action.contactName !== undefined) data.contactName = action.contactName
          if (action.contactSecondary !== undefined) data.contactSecondary = action.contactSecondary
          if (action.phone !== undefined) data.phone = action.phone
          if (action.email !== undefined) data.email = action.email
          if (action.businessStructure !== undefined) data.businessStructure = action.businessStructure
          if (action.status) data.status = action.status
          if (action.services !== undefined) data.services = action.services
          if (action.grossRevenue !== undefined) data.grossRevenue = action.grossRevenue
          if (action.billingStatus !== undefined) data.billingStatus = action.billingStatus
          if (action.notes !== undefined) data.notes = action.notes
          if (Object.keys(data).length === 0) break
          await prisma.client.update({ where: { id: action.id }, data })
          break
        }

        case 'delete_client':
          await prisma.client.delete({ where: { id: action.id } })
          break

        case 'schedule_sms': {
          // Parse "YYYY-MM-DD HH:MM" in the configured timezone
          const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
          // Build a timezone-aware date by appending tz offset
          const sendAt = parseSendAt(action.sendAt, tz)
          if (!sendAt || isNaN(sendAt.getTime())) {
            console.error(`Invalid schedule_sms date: ${action.sendAt}`)
            break
          }
          await prisma.scheduledMessage.create({
            data: {
              profileId,
              message: action.message,
              sendAt,
              label: action.label ?? null,
            },
          })
          break
        }

        case 'cancel_sms':
          await prisma.scheduledMessage.delete({ where: { id: action.id } }).catch(() => {})
          break

        case 'update_user_profile':
          await prisma.profile.update({
            where: { id: profileId },
            data: { aboutUser: action.content, aboutUserUpdatedAt: new Date() },
          })
          break

        case 'update_self_notes':
          await prisma.profile.update({
            where: { id: profileId },
            data: { aboutSelf: action.content, aboutSelfUpdatedAt: new Date() },
          })
          break

        case 'update_private_user_profile':
          await prisma.profile.update({
            where: { id: profileId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { privateAboutUser: action.content, privateAboutUserUpdatedAt: new Date() } as any,
          })
          break

        case 'update_private_self_notes':
          await prisma.profile.update({
            where: { id: profileId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { privateAboutSelf: action.content, privateAboutSelfUpdatedAt: new Date() } as any,
          })
          break

        case 'update_alt_about_user':
          await prisma.profile.update({
            where: { id: profileId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { altAboutUser: action.content, altAboutUserUpdatedAt: new Date() } as any,
          })
          break

        case 'update_alt_about_self':
          await prisma.profile.update({
            where: { id: profileId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { altAboutSelf: action.content, altAboutSelfUpdatedAt: new Date() } as any,
          })
          break

        case 'schedule_task': {
          const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
          const runAt = parseSendAt(action.runAt, tz)
          if (!runAt || isNaN(runAt.getTime())) {
            console.error(`Invalid schedule_task date: ${action.runAt}`)
            break
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (prisma as any).scheduledTask.create({
            data: { profileId, topic: action.topic, runAt },
          })
          break
        }

        case 'update_lock_profiles':
          await prisma.profile.update({
            where: { id: profileId },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { focusProfiles: action.content } as any,
          })
          break

        case 'lock_focus': {
          const msg = `profile=${action.profile} release=${action.release}${action.duration ? ` duration=${action.duration}` : ''}`
          await sendNotification(msg, 'PENNY_LOCK')
          const unlocksAt =
            action.release === 'timed' && action.duration
              ? new Date(Date.now() + action.duration * 60 * 1000)
              : null
          await prisma.profile.update({
            where: { id: profileId },
            data: {
              focusLocked: true,
              focusProfile: action.profile,
              focusLockedAt: new Date(),
              focusReleaseType: action.release,
              focusUnlocksAt: unlocksAt,
            },
          })
          break
        }

        case 'unlock_focus': {
          await sendNotification(`reason=${action.reason}`, 'PENNY_UNLOCK')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const unlockData: any = {
            focusLocked: false,
            focusProfile: null,
            focusLockedAt: null,
            focusReleaseType: null,
            focusUnlocksAt: null,
          }
          if (action.reason === 'emergency') {
            unlockData.focusEmergencyCount = { increment: 1 }
          }
          await prisma.profile.update({ where: { id: profileId }, data: unlockData })
          break
        }

        case 'send_email': {
          const result = await sendGmail({
            to: action.to,
            cc: action.cc,
            bcc: action.bcc,
            subject: action.subject,
            body: action.body,
          })
          if (!result.ok) console.error(`send_email failed: ${result.error}`)
          break
        }

        case 'reply_email': {
          const result = await replyGmail({ threadId: action.thread, to: action.to, body: action.body })
          if (!result.ok) console.error(`reply_email failed: ${result.error}`)
          break
        }

        case 'create_draft': {
          const result = await createGmailDraft({
            to: action.to,
            cc: action.cc,
            bcc: action.bcc,
            subject: action.subject,
            body: action.body,
          })
          if (!result.ok) console.error(`create_draft failed: ${result.error}`)
          break
        }

        case 'create_calendar_event': {
          const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
          const start = buildEventTime(action.start, tz)
          const end = action.end ? buildEventTime(action.end, tz) : defaultEnd(start)
          const result = await createGoogleCalendarEvent({
            calendar: action.calendar,
            summary: action.title,
            start,
            end,
            location: action.location,
            description: action.description,
          })
          if (!result.ok) console.error(`create_calendar_event failed: ${result.error}`)
          break
        }

        case 'update_calendar_event': {
          const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
          const result = await updateGoogleCalendarEvent({
            id: action.id,
            calendar: action.calendar,
            summary: action.title,
            start: action.start ? buildEventTime(action.start, tz) : undefined,
            end: action.end ? buildEventTime(action.end, tz) : undefined,
            location: action.location,
            description: action.description,
          })
          if (!result.ok) console.error(`update_calendar_event failed: ${result.error}`)
          break
        }

        case 'delete_calendar_event': {
          const result = await deleteGoogleCalendarEvent({ id: action.id, calendar: action.calendar })
          if (!result.ok) console.error(`delete_calendar_event failed: ${result.error}`)
          break
        }

        // Handled in route.ts before executeActions is called — no-op here
        case 'run_subroutine':
        case 'complete_session':
        case 'shift_complete':
        case 'switch_modality':
        case 'search_email':
        case 'search_calendar':
        case 'read_email':
        case 'calendar_agenda':
        case 'search_drive':
        case 'read_drive_file':
          break
      }
    } catch (e) {
      // Log but don't crash — one bad action shouldn't kill the response
      console.error(`Failed to execute ${action.kind}:`, e)
    }
  }
}
