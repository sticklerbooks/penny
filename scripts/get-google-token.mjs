// Run with: node scripts/get-google-token.mjs
// Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local

import http from 'http'
import { readFileSync } from 'fs'
import { URL } from 'url'
import { execSync } from 'child_process'

// Load .env.local manually
const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, '')]
    })
)

const CLIENT_ID = env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI = 'http://localhost:4242/callback'
const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
].join(' ')

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.local')
  process.exit(1)
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES)
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')  // forces a refresh token every time

console.log('\nOpening browser for Google OAuth...')
console.log('If it does not open automatically, visit:\n')
console.log(authUrl.toString())
console.log()

try {
  execSync(`start "" "${authUrl.toString()}"`, { stdio: 'ignore' })
} catch {}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4242')
  if (url.pathname !== '/callback') return

  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    res.end(`<h2>Error: ${error}</h2><p>You can close this tab.</p>`)
    console.error('OAuth error:', error)
    server.close()
    return
  }

  if (!code) {
    res.end('<h2>No code received.</h2>')
    server.close()
    return
  }

  // Exchange code for tokens
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

  if (tokens.error) {
    res.end(`<h2>Token error: ${tokens.error}</h2><p>${tokens.error_description ?? ''}</p>`)
    console.error('Token exchange error:', tokens)
    server.close()
    return
  }

  res.end('<h2>Success! You can close this tab and return to the terminal.</h2>')

  console.log('='.repeat(60))
  console.log('Add this to your .env.local:')
  console.log('='.repeat(60))
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
  console.log('='.repeat(60))

  server.close()
})

server.listen(4242, () => {
  console.log('Waiting for Google to redirect back (listening on port 4242)...')
})
