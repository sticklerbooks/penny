// Read-only: list unresolved next-session notes so we can spot the junk.
import { createClient } from '@libsql/client'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^["']|["']$/g, '')]
    })
)

const client = createClient({ url: env.DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })

const res = await client.execute(
  `SELECT id, source, target, resolved, content, createdAt
   FROM "NextSessionNote"
   WHERE resolved = 0
   ORDER BY createdAt DESC`
)

console.log(`Unresolved next-session notes: ${res.rows.length}\n`)
for (const r of res.rows) {
  const when = r.createdAt ? String(r.createdAt).slice(0, 16) : '?'
  console.log(`[${when}] ${r.source} → ${r.target ?? 'self'}`)
  console.log(`  id=${r.id}`)
  console.log(`  ${String(r.content).replace(/\s+/g, ' ').slice(0, 200)}`)
  console.log()
}
