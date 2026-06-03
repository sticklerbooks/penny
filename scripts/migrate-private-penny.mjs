// One-time migration: adds Private Penny's identity columns to the Profile table.
// Run with: node scripts/migrate-private-penny.mjs

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
  'ALTER TABLE Profile ADD COLUMN privateAboutUser TEXT',
  'ALTER TABLE Profile ADD COLUMN privateAboutUserUpdatedAt DATETIME',
  'ALTER TABLE Profile ADD COLUMN privateAboutSelf TEXT',
  'ALTER TABLE Profile ADD COLUMN privateAboutSelfUpdatedAt DATETIME',
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
