// Round-trip test: create an event, verify it lands, then delete it.
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

async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  return (await res.json()).access_token
}

const t = await token()

// CREATE
const createRes = await fetch(
  'https://www.googleapis.com/calendar/v3/calendars/primary/events',
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: 'Penny write-test (safe to ignore)',
      description: 'Created by verify-calendar-write.mjs',
      start: { dateTime: '2026-06-20T14:00:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-06-20T15:00:00-04:00', timeZone: 'America/New_York' },
    }),
  }
)
const created = await createRes.json()
console.log('CREATE status:', createRes.status)
if (!createRes.ok) {
  console.error('Create failed:', JSON.stringify(created, null, 2))
  process.exit(1)
}
console.log('Created event id:', created.id, '| link:', created.htmlLink)

// DELETE (clean up)
const delRes = await fetch(
  `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(created.id)}`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }
)
console.log('DELETE status:', delRes.status, delRes.ok || delRes.status === 410 ? '(cleaned up)' : '(FAILED)')
