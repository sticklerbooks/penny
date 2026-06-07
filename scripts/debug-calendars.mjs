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
const tokenData = await tokenRes.json()
console.log('Token status:', tokenRes.status, '| access_token present:', !!tokenData.access_token, '| error:', tokenData.error ?? 'none')
const { access_token } = tokenData

const listRes = await fetch(
  'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  { headers: { Authorization: `Bearer ${access_token}` } }
)
console.log('calendarList status:', listRes.status)
const rawList = await listRes.text()
console.log('calendarList raw:', rawList.slice(0, 500))
const listData = JSON.parse(rawList)

console.log('All calendars:')
listData.items?.forEach(c => console.log(` - ${c.summary} (${c.id})`))
console.log()

const timeMin = '2026-06-08T00:00:00-04:00'
const timeMax = '2026-06-08T23:59:59-04:00'

const results = await Promise.all(
  listData.items.map(async cal => {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=20`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    )
    const data = await res.json()
    return { cal: cal.summary, items: data.items ?? [] }
  })
)

console.log('Events on June 8th:')
let found = false
results.forEach(({ cal, items }) => {
  items.forEach(e => {
    found = true
    const start = e.start?.dateTime ?? e.start?.date ?? 'unknown'
    const d = new Date(start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    console.log(` [${cal}] ${d}: ${e.summary ?? '(no title)'}`)
  })
})
if (!found) console.log(' (nothing found across all calendars)')
