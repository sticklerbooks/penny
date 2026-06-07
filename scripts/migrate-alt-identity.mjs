// One-time migration: adds alt-Penny's own identity columns to Profile.
// Run with: node scripts/migrate-alt-identity.mjs

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
  'ALTER TABLE Profile ADD COLUMN altAboutUser TEXT',
  'ALTER TABLE Profile ADD COLUMN altAboutUserUpdatedAt DATETIME',
  'ALTER TABLE Profile ADD COLUMN altAboutSelf TEXT',
  'ALTER TABLE Profile ADD COLUMN altAboutSelfUpdatedAt DATETIME',
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
