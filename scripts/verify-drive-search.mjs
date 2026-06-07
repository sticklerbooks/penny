// Test the exact fullText query searchDrive() builds.
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
console.log('token scopes:', tok.scope)
const token = tok.access_token

for (const query of ['meeting', 'killing', 'Steppenwolf']) {
  const q = `fullText contains '${query.replace(/['\\]/g, '\\$&')}' and trashed = false`
  const params = new URLSearchParams({
    q, pageSize: '15',
    fields: 'files(id,name,mimeType,modifiedTime)',
    orderBy: 'modifiedTime desc',
  })
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await res.json()
  if (!res.ok) {
    console.log(`\nquery "${query}": HTTP ${res.status} — ${data.error?.message}`)
    continue
  }
  console.log(`\nquery "${query}": ${data.files?.length ?? 0} results`)
  for (const f of (data.files ?? []).slice(0, 5)) console.log(`  - ${f.name}`)
}
