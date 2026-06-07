// Google API — Gmail + Calendar
// Uses refresh token to get short-lived access tokens. No googleapis package needed.

async function refreshGoogleToken(): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) return null

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  return data.access_token ?? null
}

// ─── Calendar enumeration ────────────────────────────────────────────────────
// Penny has ~10 calendars (Work, Personal, Family, etc.). Querying only
// `primary` misses almost everything, so we fan out across all of them.

type CalEvent = {
  id?: string
  start?: { dateTime?: string; date?: string }
  summary?: string
  location?: string
  description?: string
  // Tagged on by fetchEventsAllCalendars so callers know which calendar an
  // event came from (needed to update/delete it later).
  _calendarId?: string
  _calendarName?: string
}

type CalendarRef = { id: string; name: string }

async function listCalendars(token: string): Promise<CalendarRef[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  return (data.items ?? []).map((c: { id: string; summary?: string; summaryOverride?: string }) => ({
    id: c.id,
    name: c.summaryOverride ?? c.summary ?? c.id,
  }))
}

// Fetch events across every calendar in parallel, then merge + sort by start.
// Each event is tagged with its source calendar's id and name.
async function fetchEventsAllCalendars(
  token: string,
  params: Record<string, string>
): Promise<CalEvent[]> {
  const calendars = await listCalendars(token)
  const query = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', ...params })

  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${query}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json()
      return ((data.items ?? []) as CalEvent[]).map((e) => ({
        ...e,
        _calendarId: cal.id,
        _calendarName: cal.name,
      }))
    })
  )

  const startOf = (e: CalEvent) => e.start?.dateTime ?? e.start?.date ?? ''
  return perCalendar.flat().sort((a, b) => startOf(a).localeCompare(startOf(b)))
}

// Resolve a human calendar name (e.g. "Work", "Household") to its calendar id.
// Omitted / "primary" / "household" all map to the primary calendar, which IS
// the user's "Household" calendar. Unknown names fall back to primary.
async function resolveCalendarId(token: string, name?: string): Promise<string> {
  const n = (name ?? '').trim().toLowerCase()
  if (!n || n === 'primary' || n === 'household') return 'primary'
  const cals = await listCalendars(token)
  const match = cals.find((c) => c.name.toLowerCase() === n)
  return match?.id ?? 'primary'
}

// ─── Session-start snapshot ──────────────────────────────────────────────────

export async function getGoogleSnapshot(): Promise<{ emails: string; calendar: string } | null> {
  const token = await refreshGoogleToken()
  if (!token) return null

  try {
    const [emails, calendar] = await Promise.all([
      fetchRecentGmail(token),
      fetchUpcomingGoogleCalendar(token),
    ])
    return { emails, calendar }
  } catch (e) {
    console.error('Google snapshot error:', e)
    return null
  }
}

async function fetchRecentGmail(token: string): Promise<string> {
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox+newer_than:2d&maxResults=15',
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const list = await listRes.json()
  if (!list.messages?.length) return '(no recent emails)'

  const messages = await Promise.all(
    list.messages.slice(0, 15).map(async (m: { id: string }) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const msg = await r.json()
      const h = Object.fromEntries(
        (msg.payload?.headers ?? []).map((x: { name: string; value: string }) => [x.name, x.value])
      )
      return `From: ${h.From ?? 'unknown'} | Subject: ${h.Subject ?? '(none)'} | ${h.Date ?? ''}\n  ${(msg.snippet ?? '').slice(0, 200)}`
    })
  )
  return messages.join('\n')
}

async function fetchUpcomingGoogleCalendar(token: string): Promise<string> {
  const now = new Date().toISOString()
  const weekOut = new Date(Date.now() + 7 * 864e5).toISOString()
  const items = await fetchEventsAllCalendars(token, {
    timeMin: now,
    timeMax: weekOut,
    maxResults: '20',
  })
  if (!items.length) return '(no upcoming events)'
  return items.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? 'unknown'
    const loc = e.location ? ` @ ${e.location}` : ''
    const d = new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    return `${d}${loc}: ${e.summary ?? '(no title)'}`
  }).join('\n')
}

// ─── On-demand search ────────────────────────────────────────────────────────

export async function searchGmail(query: string): Promise<string> {
  const token = await refreshGoogleToken()
  if (!token) return '(Gmail not configured)'

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const list = await listRes.json()
  if (!list.messages?.length) return `(no Gmail results for "${query}")`

  const messages = await Promise.all(
    list.messages.slice(0, 8).map(async (m: { id: string }) => {
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const msg = await r.json()
      const h = Object.fromEntries(
        (msg.payload?.headers ?? []).map((x: { name: string; value: string }) => [x.name, x.value])
      )
      // Include id + thread so the message can be read in full or replied to.
      return `From: ${h.From ?? 'unknown'} | Subject: ${h.Subject ?? '(none)'} | ${h.Date ?? ''} [id=${msg.id} thread=${msg.threadId}]\n  ${(msg.snippet ?? '').slice(0, 300)}`
    })
  )
  return messages.join('\n---\n')
}

// Fetch one email's full plain-text body on demand (for reading / replying).
export async function readGmailMessage(id: string): Promise<string> {
  const token = await refreshGoogleToken()
  if (!token) return '(Gmail not configured)'

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return `(could not read email ${id})`
  const msg = await res.json()
  const h = Object.fromEntries(
    (msg.payload?.headers ?? []).map((x: { name: string; value: string }) => [x.name, x.value])
  )
  const body = extractPlainText(msg.payload) || msg.snippet || '(no body)'
  return `From: ${h.From ?? 'unknown'}\nTo: ${h.To ?? ''}\nSubject: ${h.Subject ?? '(none)'}\nDate: ${h.Date ?? ''}\n[id=${msg.id} thread=${msg.threadId}]\n\n${body.slice(0, 4000)}`
}

// Walk a Gmail payload tree and pull out the text/plain content.
function extractPlainText(payload: GmailPayload | undefined): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part)
    if (text) return text
  }
  // Fall back to text/html stripped of tags if no plain part exists
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }
  return ''
}

type GmailPayload = {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailPayload[]
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

// ─── Gmail writes ─────────────────────────────────────────────────────────────
// Confirm-first is enforced upstream (in the prompt): Penny describes the email
// and waits for the user's "yes" before emitting a send/reply/draft marker.

export type GmailWriteResult = { ok: boolean; id?: string; error?: string }

// Build an RFC 2822 message and base64url-encode it for the Gmail API.
function buildRawEmail(fields: {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}): string {
  const headers = [
    `To: ${fields.to}`,
    fields.cc ? `Cc: ${fields.cc}` : '',
    fields.bcc ? `Bcc: ${fields.bcc}` : '',
    `Subject: ${fields.subject}`,
    fields.inReplyTo ? `In-Reply-To: ${fields.inReplyTo}` : '',
    fields.references ? `References: ${fields.references}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean)
  const mime = headers.join('\r\n') + '\r\n\r\n' + fields.body
  return Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function sendGmail(input: {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
}): Promise<GmailWriteResult> {
  const token = await refreshGoogleToken()
  if (!token) return { ok: false, error: 'Gmail not configured' }

  const raw = buildRawEmail({ ...input })
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` }
  return { ok: true, id: data.id }
}

export async function replyGmail(input: {
  threadId: string
  body: string
  to?: string
}): Promise<GmailWriteResult> {
  const token = await refreshGoogleToken()
  if (!token) return { ok: false, error: 'Gmail not configured' }

  // Pull the latest message in the thread for reply headers + recipient.
  const threadRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(input.threadId)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=References`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!threadRes.ok) return { ok: false, error: `could not load thread ${input.threadId}` }
  const thread = await threadRes.json()
  const last = thread.messages?.[thread.messages.length - 1]
  const h = Object.fromEntries(
    (last?.payload?.headers ?? []).map((x: { name: string; value: string }) => [x.name.toLowerCase(), x.value])
  )

  const subject = h.subject ?? ''
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`
  const messageId = h['message-id'] ?? ''
  const references = h.references ? `${h.references} ${messageId}`.trim() : messageId

  const raw = buildRawEmail({
    to: input.to ?? h.from ?? '',
    subject: replySubject,
    body: input.body,
    inReplyTo: messageId,
    references,
  })

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, threadId: input.threadId }),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` }
  return { ok: true, id: data.id }
}

export async function createGmailDraft(input: {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
}): Promise<GmailWriteResult> {
  const token = await refreshGoogleToken()
  if (!token) return { ok: false, error: 'Gmail not configured' }

  const raw = buildRawEmail({ ...input })
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` }
  return { ok: true, id: data.id }
}

export async function searchGoogleCalendar(query: string): Promise<string> {
  const token = await refreshGoogleToken()
  if (!token) return '(Google Calendar not configured)'

  const items = await fetchEventsAllCalendars(token, {
    q: query,
    maxResults: '10',
  })
  if (!items.length) return `(no Google Calendar results for "${query}")`
  return items.map((e) => {
    const start = e.start?.dateTime ?? e.start?.date ?? 'unknown'
    const loc = e.location ? ` @ ${e.location}` : ''
    const desc = e.description ? `\n  ${e.description.slice(0, 200)}` : ''
    const d = new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    // Include id + calendar so the event can be updated/deleted later.
    const ref = e.id ? ` [id=${e.id} calendar="${e._calendarName ?? 'Household'}"]` : ''
    return `${d}${loc}: ${e.summary ?? '(no title)'}${ref}${desc}`
  }).join('\n---\n')
}

// ─── Calendar writes ─────────────────────────────────────────────────────────
// Confirm-first is enforced upstream (in the prompt): Penny describes the
// change and waits for the user's "yes" before emitting a write marker.

export type EventTime = { dateTime?: string; date?: string; timeZone?: string }

export type CalendarWriteResult = { ok: boolean; id?: string; htmlLink?: string; error?: string }

export async function createGoogleCalendarEvent(input: {
  calendar?: string
  summary: string
  start: EventTime
  end: EventTime
  location?: string
  description?: string
}): Promise<CalendarWriteResult> {
  const token = await refreshGoogleToken()
  if (!token) return { ok: false, error: 'Google Calendar not configured' }
  const calId = await resolveCalendarId(token, input.calendar)

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: input.summary,
        location: input.location,
        description: input.description,
        start: input.start,
        end: input.end,
      }),
    }
  )
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` }
  return { ok: true, id: data.id, htmlLink: data.htmlLink }
}

export async function updateGoogleCalendarEvent(input: {
  id: string
  calendar?: string
  summary?: string
  start?: EventTime
  end?: EventTime
  location?: string
  description?: string
}): Promise<CalendarWriteResult> {
  const token = await refreshGoogleToken()
  if (!token) return { ok: false, error: 'Google Calendar not configured' }
  const calId = await resolveCalendarId(token, input.calendar)

  // PATCH only the fields that were provided.
  const body: Record<string, unknown> = {}
  if (input.summary !== undefined) body.summary = input.summary
  if (input.location !== undefined) body.location = input.location
  if (input.description !== undefined) body.description = input.description
  if (input.start) body.start = input.start
  if (input.end) body.end = input.end

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(input.id)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  const data = await res.json()
  if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` }
  return { ok: true, id: data.id, htmlLink: data.htmlLink }
}

export async function deleteGoogleCalendarEvent(input: {
  id: string
  calendar?: string
}): Promise<CalendarWriteResult> {
  const token = await refreshGoogleToken()
  if (!token) return { ok: false, error: 'Google Calendar not configured' }
  const calId = await resolveCalendarId(token, input.calendar)

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(input.id)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  )
  // A successful delete returns 204 No Content (sometimes 200). 410 = already gone.
  if (res.ok || res.status === 410) return { ok: true }
  const data = await res.json().catch(() => ({}))
  return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` }
}
