// One-time migration: adds alt-mode columns to Memory and Conversation tables.
// Run with: node scripts/migrate-alt-mode.mjs

import { createClient } from '@libsql/client'
import 'dotenv/config'

const url = process.env.DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const db = createClient({ url, authToken })

const columns = [
  'ALTER TABLE Memory ADD COLUMN altModeScope TEXT',
  'ALTER TABLE Conversation ADD COLUMN isAltMode INTEGER NOT NULL DEFAULT 0',
]

for (const sql of columns) {
  try {
    await db.execute(sql)
    console.log(`✓ ${sql}`)
  } catch (err) {
    if (err.message?.includes('duplicate column')) {
      console.log(`— already exists: ${sql}`)
    } else {
      console.error(`✗ ${sql}`)
      console.error(err.message)
    }
  }
}

console.log('\nDone.')
