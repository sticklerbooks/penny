// Verify the calendar_agenda day-range logic + id output for a given date.
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

const tz = env.PENNY_TIMEZONE || 'America/New_York'

function startOfDayInTz(date, tz) {
  const naive = new Date(date + 'T00:00:00Z')
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(naive).map(x => [x.type, x.value]))
  const asTz = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)
  const offset = asTz.getTime() - naive.getTime()
  return new Date(naive.getTime() - offset)
}

async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  })
  return (await res.json()).access_token
}

const date = '2026-06-08'
const t = await token()
const start = startOfDayInTz(date, tz)
const end = new Date(start.getTime() + 864e5)
console.log(`Day window for ${date} (${tz}):`)
console.log('  timeMin:', start.toISOString())
console.log('  timeMax:', end.toISOString())
console.log()

const listRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
  headers: { Authorization: `Bearer ${t}` },
})
const cals = ((await listRes.json()).items ?? []).map(c => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id }))

const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: start.toISOString(), timeMax: end.toISOString(), maxResults: '50' })
const per = await Promise.all(cals.map(async cal => {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${q}`, { headers: { Authorization: `Bearer ${t}` } })
  return ((await r.json()).items ?? []).map(e => ({ ...e, _calendarName: cal.name }))
}))
const items = per.flat().sort((a, b) => (a.start?.dateTime ?? a.start?.date ?? '').localeCompare(b.start?.dateTime ?? b.start?.date ?? ''))

console.log(`Agenda for ${date}:`)
items.forEach(e => {
  const s = e.start?.dateTime ?? e.start?.date ?? 'unknown'
  const d = new Date(s).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  console.log(`  ${d}: ${e.summary ?? '(no title)'} [id=${e.id} calendar="${e._calendarName}"]`)
})
