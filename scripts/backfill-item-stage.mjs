// One-time backfill: compute Item.stage from the old paStatus/modalityStatus
// pair (whichever is "live" for the item's target), and stamp stageEnteredAt
// from the existing updatedAt as the best available approximation.
//
// Additive/idempotent: only touches rows where stage IS NULL, so re-running
// is safe and a row that's already been migrated (or created fresh under the
// new model) is left alone.
//
// Run with: node scripts/backfill-item-stage.mjs

import { createClient } from '@libsql/client'
import { readFileSync, existsSync } from 'fs'

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

// old status (either side) -> new unified stage
const STAGE_MAP = {
  new: 'backlog',
  pending: 'backlog',
  schedule: 'planned',
  'sent-to-PA': 'planned', // already committed by the time it was escalating
  scheduled: 'scheduled',
  contingent: 'blocked',
  completed: 'done',
  'to-delete': 'cancelled',
}

const result = await client.execute(
  `SELECT id, target, paStatus, modalityStatus, updatedAt FROM "Item" WHERE stage IS NULL`
)

console.log(`${result.rows.length} Item rows need a stage backfill.`)

let updated = 0
let skipped = 0

for (const row of result.rows) {
  const isPa = row.target === 'pa'
  const oldStatus = isPa ? row.paStatus : row.modalityStatus
  const stage = STAGE_MAP[oldStatus] ?? 'backlog'

  try {
    await client.execute({
      sql: `UPDATE "Item" SET stage = ?, stageEnteredAt = ? WHERE id = ?`,
      args: [stage, row.updatedAt, row.id],
    })
    updated++
  } catch (e) {
    skipped++
    console.error(`✗ ${row.id}: ${e.message}`)
  }
}

console.log(`\nDone. ${updated} updated, ${skipped} failed.`)
