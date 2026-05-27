// One-time script to get a Microsoft OAuth refresh token.
// Run with: node scripts/setup-microsoft-oauth.mjs
//
// Before running:
//   1. Go to portal.azure.com → Microsoft Entra ID → App registrations → New registration
//   2. Name: "Penny", Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
//   3. Redirect URI: Web → http://localhost:3001/callback
//   4. After creating: go to "Certificates & secrets" → New client secret → copy the Value
//   5. Go to "API permissions" → Add permission → Microsoft Graph → Delegated:
//      - Mail.Read
//      - Calendars.Read
//      - offline_access (should be there by default)
//   6. Copy Application (client) ID and the client secret into .env.local:
//      MICROSOFT_CLIENT_ID=...
//      MICROSOFT_CLIENT_SECRET=...
//      MICROSOFT_TENANT_ID=common   (use 'common' for personal + work accounts)
//   7. Run this script

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

const CLIENT_ID = env.MICROSOFT_CLIENT_ID
const CLIENT_SECRET = env.MICROSOFT_CLIENT_SECRET
const TENANT = env.MICROSOFT_TENANT_ID ?? 'common'
const REDIRECT_URI = 'http://localhost:3001/callback'
const SCOPES = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Calendars.Read offline_access'

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set in .env.local')
  process.exit(1)
}

const authUrl =
  `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&response_mode=query`

console.log('\n📋  Opening Microsoft authorization page...')
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

  try {
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
          scope: SCOPES,
        }),
      }
    )
    const tokens = await tokenRes.json()

    if (tokens.refresh_token) {
      console.log('✅  Success! Add this to your .env.local:\n')
      console.log(`MICROSOFT_REFRESH_TOKEN=${tokens.refresh_token}\n`)
    } else {
      console.error('❌  No refresh token returned.')
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
