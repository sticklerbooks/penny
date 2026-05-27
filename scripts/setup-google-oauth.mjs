// One-time script to get a Google OAuth refresh token.
// Run with: node scripts/setup-google-oauth.mjs
//
// Before running:
//   1. Go to console.cloud.google.com
//   2. Create a project, enable Gmail API and Google Calendar API
//   3. Create OAuth 2.0 credentials (Web application type)
//   4. Add http://localhost:3001/callback as an authorized redirect URI
//   5. Copy your client_id and client_secret into .env.local as:
//      GOOGLE_CLIENT_ID=...
//      GOOGLE_CLIENT_SECRET=...
//   6. Run this script — it opens a browser, you authorize, it prints your refresh token

import http from 'http'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local
const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
const env = Object.fromEntries(
  envFile.split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const idx = line.indexOf('=')
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')]
    })
    .filter(pair => pair.length === 2 && pair[0])
)

const CLIENT_ID = env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI = 'http://localhost:3001/callback'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ')

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.local')
  process.exit(1)
}

const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`

console.log('\n📋  Opening Google authorization page...')
console.log('\nIf it doesn\'t open automatically, paste this URL into your browser:\n')
console.log(authUrl)
console.log('\nWaiting for authorization...\n')

// Try to open browser
try {
  const { exec } = await import('child_process')
  const cmd = process.platform === 'win32' ? `start "" "${authUrl}"` :
              process.platform === 'darwin' ? `open "${authUrl}"` :
              `xdg-open "${authUrl}"`
  exec(cmd)
} catch {}

// Listen for the OAuth callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3001')
  const code = url.searchParams.get('code')

  if (!code) {
    res.end('No code received. Try again.')
    return
  }

  res.end('<html><body><h2>✅ Authorized! Check your terminal for the refresh token.</h2></body></html>')

  // Exchange code for tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenRes.json()

    if (tokens.refresh_token) {
      console.log('✅  Success! Add this to your .env.local:\n')
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`)
    } else {
      console.error('❌  No refresh token returned. Make sure you used prompt=consent and access_type=offline.')
      console.error('Full response:', JSON.stringify(tokens, null, 2))
    }
  } catch (e) {
    console.error('❌  Token exchange failed:', e)
  }

  server.close()
})

server.listen(3001, () => {
  // listening
})
