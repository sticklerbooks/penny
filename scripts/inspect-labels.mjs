// Read-only diagnostic: what modality labels + row counts actually exist in the
// live DB right now. Used to plan the Stage-3 cutover (id-vs-display-name drift).
// Touches nothing.
//
//   node scripts/inspect-labels.mjs

import { createClient } from '@libsql/client'
import { readFileSync, existsSync } from 'fs'

const envFile = ['.env.local', '.env'].find((f) => existsSync(new URL(`../${f}`, import.meta.url)))
const envText = readFileSync(new URL(`../${envFile}`, import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
  })
)
const client = createClient({ url: env.DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })

async function distinct(table, col) {
  try {
    const r = await client.execute(`SELECT "${col}" AS v, COUNT(*) AS n FROM "${table}" GROUP BY "${col}" ORDER BY n DESC`)
    return r.rows.map((row) => `${JSON.stringify(row.v)}×${row.n}`)
  } catch (e) {
    return [`(error: ${e.message})`]
  }
}
async function count(table) {
  try {
    const r = await client.execute(`SELECT COUNT(*) AS n FROM "${table}"`)
    return r.rows[0].n
  } catch (e) {
    return `(error: ${e.message})`
  }
}

const KNOWN_IDS = new Set(['pa', 'bookkeeping', 'household', 'relationships', 'maker', 'creative', 'health', 'friend', 'wellbeing', 'emotional', 'political', 'private'])

for (const t of ['Task', 'Project', 'PendingCalendarEvent', 'Routine', 'Note', 'Item']) {
  console.log(`\n=== ${t} (${await count(t)} rows) ===`)
}

console.log('\n--- assignedModality labels ---')
for (const t of ['Task', 'Project', 'PendingCalendarEvent', 'Routine']) {
  console.log(`  ${t}: ${(await distinct(t, 'assignedModality')).join(', ') || '(none)'}`)
}
console.log('\n--- Note.modalityTarget ---\n  ' + (await distinct('Note', 'modalityTarget')).join(', '))
console.log('--- Note.source ---\n  ' + (await distinct('Note', 'source')).join(', '))

// Flag any label that is NOT a known stable id (i.e. a display name or stray value).
console.log('\n--- non-id labels (would need normalizing on cutover) ---')
for (const [t, col] of [['Task', 'assignedModality'], ['Project', 'assignedModality'], ['PendingCalendarEvent', 'assignedModality'], ['Routine', 'assignedModality'], ['Note', 'modalityTarget'], ['Note', 'source']]) {
  const vals = await distinct(t, col)
  const bad = vals.filter((v) => {
    const raw = v.split('×')[0].replace(/^"|"$/g, '')
    return raw && raw !== 'null' && !KNOWN_IDS.has(raw)
  })
  if (bad.length) console.log(`  ${t}.${col}: ${bad.join(', ')}`)
}
console.log('\n(done)')
