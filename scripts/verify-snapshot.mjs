import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, '')]
    })
)

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
})
const { access_token: token } = await tokenRes.json()

const listRes = await fetch(
  'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  { headers: { Authorization: `Bearer ${token}` } }
)
const ids = ((await listRes.json()).items ?? []).map(c => c.id)

const now = new Date().toISOString()
const weekOut = new Date(Date.now() + 7 * 864e5).toISOString()
const query = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: now, timeMax: weekOut, maxResults: '20' })

const perCal = await Promise.all(ids.map(async id => {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events?${query}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  return ((await res.json()).items ?? [])
}))

const startOf = e => e.start?.dateTime ?? e.start?.date ?? ''
const items = perCal.flat().sort((a, b) => startOf(a).localeCompare(startOf(b)))

console.log('Upcoming 7 days across ALL calendars:\n')
items.forEach(e => {
  const start = startOf(e)
  const d = new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  console.log(`  ${d}: ${e.summary ?? '(no title)'}`)
})
