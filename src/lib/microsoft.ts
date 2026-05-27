// Microsoft Graph API — Outlook email + Calendar
// Uses refresh token to get short-lived access tokens.

async function refreshMicrosoftToken(): Promise<string | null> {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET
  const refreshToken = process.env.MICROSOFT_REFRESH_TOKEN
  const tenant = process.env.MICROSOFT_TENANT_ID ?? 'common'
  if (!clientId || !clientSecret || !refreshToken) return null

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read offline_access',
      }),
    }
  )
  const data = await res.json()
  return data.access_token ?? null
}

// ─── Session-start snapshot ──────────────────────────────────────────────────

export async function getMicrosoftSnapshot(): Promise<{ emails: string; calendar: string } | null> {
  const token = await refreshMicrosoftToken()
  if (!token) return null

  try {
    const [emails, calendar] = await Promise.all([
      fetchRecentOutlook(token),
      fetchUpcomingOutlookCalendar(token),
    ])
    return { emails, calendar }
  } catch (e) {
    console.error('Microsoft snapshot error:', e)
    return null
  }
}

async function fetchRecentOutlook(token: string): Promise<string> {
  const since = new Date(Date.now() - 48 * 36e5).toISOString()
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$filter=receivedDateTime ge ${since}&$top=15&$select=subject,from,receivedDateTime,bodyPreview,isRead&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  if (!data.value?.length) return '(no recent emails)'
  return data.value.map((m: { from?: { emailAddress?: { name?: string; address?: string } }; isRead?: boolean; subject?: string; receivedDateTime?: string; bodyPreview?: string }) => {
    const from = m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? 'unknown'
    const unread = m.isRead ? '' : ' [UNREAD]'
    return `From: ${from}${unread} | Subject: ${m.subject ?? '(none)'} | ${m.receivedDateTime ?? ''}\n  ${(m.bodyPreview ?? '').slice(0, 200)}`
  }).join('\n')
}

async function fetchUpcomingOutlookCalendar(token: string): Promise<string> {
  const now = new Date().toISOString()
  const weekOut = new Date(Date.now() + 7 * 864e5).toISOString()
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now}&endDateTime=${weekOut}&$select=subject,start,end,location&$top=20`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  if (!data.value?.length) return '(no upcoming events)'
  return data.value.map((e: { start?: { dateTime?: string }; subject?: string; location?: { displayName?: string } }) => {
    const start = e.start?.dateTime ?? 'unknown'
    const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : ''
    const d = new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    return `${d}${loc}: ${e.subject ?? '(no title)'}`
  }).join('\n')
}

// ─── On-demand search ────────────────────────────────────────────────────────

export async function searchOutlook(query: string): Promise<string> {
  const token = await refreshMicrosoftToken()
  if (!token) return '(Outlook not configured)'

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(query)}"&$top=8&$select=subject,from,receivedDateTime,bodyPreview`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  if (!data.value?.length) return `(no Outlook results for "${query}")`
  return data.value.map((m: { from?: { emailAddress?: { name?: string; address?: string } }; subject?: string; receivedDateTime?: string; bodyPreview?: string }) => {
    const from = m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? 'unknown'
    return `From: ${from} | Subject: ${m.subject ?? '(none)'} | ${m.receivedDateTime ?? ''}\n  ${(m.bodyPreview ?? '').slice(0, 300)}`
  }).join('\n---\n')
}

export async function searchOutlookCalendar(query: string): Promise<string> {
  const token = await refreshMicrosoftToken()
  if (!token) return '(Outlook Calendar not configured)'

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/events?$search="${encodeURIComponent(query)}"&$top=10&$select=subject,start,end,location,bodyPreview`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const data = await res.json()
  if (!data.value?.length) return `(no Outlook Calendar results for "${query}")`
  return data.value.map((e: { start?: { dateTime?: string }; subject?: string; location?: { displayName?: string }; bodyPreview?: string }) => {
    const start = e.start?.dateTime ?? 'unknown'
    const loc = e.location?.displayName ? ` @ ${e.location.displayName}` : ''
    const d = new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const preview = e.bodyPreview ? `\n  ${e.bodyPreview.slice(0, 200)}` : ''
    return `${d}${loc}: ${e.subject ?? '(no title)'}${preview}`
  }).join('\n---\n')
}
