// Verify Drive read: token has the scope, API is enabled, search + read work.
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
    client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
  }),
})
const tok = await tokenRes.json()
console.log('Scopes on token:', tok.scope)
console.log()

const token = tok.access_token

// List a few recent files (no query) — proves API access.
const params = new URLSearchParams({
  pageSize: '10',
  fields: 'files(id,name,mimeType,modifiedTime)',
  orderBy: 'modifiedTime desc',
  q: 'trashed = false',
})
const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
  headers: { Authorization: `Bearer ${token}` },
})
const data = await res.json()
console.log('Drive list status:', res.status)
if (!res.ok) {
  console.log('Response:', JSON.stringify(data, null, 2))
  process.exit(1)
}
console.log(`\nMost recent ${data.files?.length ?? 0} files:`)
for (const f of data.files ?? []) {
  console.log(`  ${f.name} [${f.mimeType}] id=${f.id}`)
}

// Try exporting the first Google Doc, if any, to prove read-through works.
const doc = (data.files ?? []).find(f => f.mimeType === 'application/vnd.google-apps.document')
if (doc) {
  const exp = await fetch(
    `https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const text = await exp.text()
  console.log(`\nExported "${doc.name}" (${exp.status}), first 200 chars:`)
  console.log('  ' + text.slice(0, 200).replace(/\n/g, ' '))
} else {
  console.log('\n(no Google Doc among recent files to test export)')
}
