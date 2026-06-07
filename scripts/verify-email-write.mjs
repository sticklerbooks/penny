// Safe round-trip: create a Gmail DRAFT (nothing is sent), verify, then delete.
// Exercises the same MIME-build + base64url + auth path that send/reply use.
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

function buildRaw({ to, subject, body }) {
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ].join('\r\n') + '\r\n\r\n' + body
  return Buffer.from(mime, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const t = await token()
const raw = buildRaw({
  to: 'jupitermission1@gmail.com',
  subject: 'Penny draft-test (safe to ignore)',
  body: 'Created by verify-email-write.mjs — this is a draft, nothing was sent.',
})

// CREATE DRAFT
const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
  method: 'POST',
  headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { raw } }),
})
const created = await createRes.json()
console.log('CREATE DRAFT status:', createRes.status)
if (!createRes.ok) {
  console.error('Draft create failed:', JSON.stringify(created, null, 2))
  process.exit(1)
}
console.log('Draft id:', created.id, '| message id:', created.message?.id)

// DELETE DRAFT (clean up)
const delRes = await fetch(
  `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(created.id)}`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }
)
console.log('DELETE DRAFT status:', delRes.status, delRes.ok || delRes.status === 204 ? '(cleaned up)' : '(FAILED)')
