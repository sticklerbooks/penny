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
  start?: { dateTime?: string; date?: string }
  summary?: string
  location?: string
  description?: string
}

async function listCalendarIds(token: string): Promise<string[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  return (data.items ?? []).map((c: { id: string }) => c.id)
}

// Fetch events across every calendar in parallel, then merge + sort by start.
async function fetchEventsAllCalendars(
  token: string,
  params: Record<string, string>
): Promise<CalEvent[]> {
  const ids = await listCalendarIds(token)
  const query = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', ...params })

  const perCalendar = await Promise.all(
    ids.map(async (id) => {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?${query}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      const data = await res.json()
      return (data.items ?? []) as CalEvent[]
    })
  )

  const startOf = (e: CalEvent) => e.start?.dateTime ?? e.start?.date ?? ''
  return perCalendar.flat().sort((a, b) => startOf(a).localeCompare(startOf(b)))
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
      return `From: ${h.From ?? 'unknown'} | Subject: ${h.Subject ?? '(none)'} | ${h.Date ?? ''}\n  ${(msg.snippet ?? '').slice(0, 300)}`
    })
  )
  return messages.join('\n---\n')
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
    return `${d}${loc}: ${e.summary ?? '(no title)'}${desc}`
  }).join('\n---\n')
}
