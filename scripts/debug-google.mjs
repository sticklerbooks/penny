// node scripts/debug-google.mjs
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

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env
console.log('Client ID:', GOOGLE_CLIENT_ID ? GOOGLE_CLIENT_ID.slice(0, 20) + '...' : 'MISSING')
console.log('Client Secret:', GOOGLE_CLIENT_SECRET ? '(present)' : 'MISSING')
console.log('Refresh Token:', GOOGLE_REFRESH_TOKEN ? GOOGLE_REFRESH_TOKEN.slice(0, 20) + '...' : 'MISSING')
console.log()

// Step 1: get access token
console.log('--- Refreshing access token ---')
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }),
})
const tokenData = await tokenRes.json()
console.log('Token response status:', tokenRes.status)
console.log('Token data:', JSON.stringify(tokenData, null, 2))
console.log()

if (!tokenData.access_token) {
  console.error('No access token — stopping here.')
  process.exit(1)
}
const token = tokenData.access_token

// Step 2: Gmail
console.log('--- Gmail: list messages ---')
const gmailRes = await fetch(
  'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox+newer_than:2d&maxResults=5',
  { headers: { Authorization: `Bearer ${token}` } }
)
const gmailData = await gmailRes.json()
console.log('Gmail status:', gmailRes.status)
console.log('Gmail response:', JSON.stringify(gmailData, null, 2))
console.log()

// Step 3: Calendar
console.log('--- Google Calendar: upcoming events ---')
const now = new Date().toISOString()
const weekOut = new Date(Date.now() + 7 * 864e5).toISOString()
const calRes = await fetch(
  `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${weekOut}&singleEvents=true&orderBy=startTime&maxResults=5`,
  { headers: { Authorization: `Bearer ${token}` } }
)
const calData = await calRes.json()
console.log('Calendar status:', calRes.status)
console.log('Calendar response:', JSON.stringify(calData, null, 2))
