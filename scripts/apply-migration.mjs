// Apply a .sql migration file to the Turso DB, statement by statement.
// The Prisma CLI can't read libsql:// URLs, so additive migrations go through here.
//
//   node scripts/apply-migration.mjs prisma/migrations/add-dashboard-itemnotes.sql
//
// Idempotent-friendly: tolerates "duplicate column" / "already exists" so a
// re-run is safe.

import { createClient } from '@libsql/client'
import { readFileSync, existsSync } from 'fs'

const sqlPath = process.argv[2]
if (!sqlPath) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to.sql>')
  process.exit(1)
}

// Prefer .env.local (dev convention here), fall back to .env.
const envFile = ['.env.local', '.env'].find((f) =>
  existsSync(new URL(`../${f}`, import.meta.url))
)
const envText = readFileSync(new URL(`../${envFile}`, import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText.split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=')
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')]
    })
)

const client = createClient({ url: env.DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })

// Split on ';' at end of line, drop comments + blanks.
const raw = readFileSync(new URL(`../${sqlPath}`, import.meta.url), 'utf8')
const statements = raw
  .split(/;\s*$/m)
  .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
  .filter(Boolean)

const benign = ['duplicate column', 'already exists']

for (const sql of statements) {
  const label = sql.replace(/\s+/g, ' ').slice(0, 70)
  try {
    await client.execute(sql)
    console.log(`✓ ${label}`)
  } catch (e) {
    if (benign.some((b) => e.message?.toLowerCase().includes(b))) {
      console.log(`⚠ skip (exists): ${label}`)
    } else {
      console.error(`✗ FAILED: ${label}\n   ${e.message}`)
    }
  }
}

console.log('\nDone.')
