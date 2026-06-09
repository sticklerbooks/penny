// One-time migration: add focus lock columns to Turso
// Run with: node scripts/migrate-focus-lock.mjs

import { createClient } from '@libsql/client'
import { readFileSync } from 'fs'

// Parse .env.local
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const env = Object.fromEntries(
  envText.split('\n')
    .filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => {
      const idx = line.indexOf('=')
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
      return [key, val]
    })
)

const client = createClient({
  url: env.DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
})

const statements = [
  `ALTER TABLE "Profile" ADD COLUMN "focusLocked" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "Profile" ADD COLUMN "focusProfile" TEXT`,
  `ALTER TABLE "Profile" ADD COLUMN "focusLockedAt" DATETIME`,
  `ALTER TABLE "Profile" ADD COLUMN "focusReleaseType" TEXT`,
  `ALTER TABLE "Profile" ADD COLUMN "focusUnlocksAt" DATETIME`,
  `ALTER TABLE "Profile" ADD COLUMN "focusEmergencyCount" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "Profile" ADD COLUMN "focusProfiles" TEXT`,
]

for (const sql of statements) {
  try {
    await client.execute(sql)
    const col = sql.match(/ADD COLUMN "(\w+)"/)?.[1] ?? sql
    console.log(`✓ Added column: ${col}`)
  } catch (e) {
    const col = sql.match(/ADD COLUMN "(\w+)"/)?.[1] ?? '?'
    if (e.message?.toLowerCase().includes('duplicate column')) {
      console.log(`⚠ Already exists (skipping): ${col}`)
    } else {
      console.error(`✗ Failed on ${col}: ${e.message}`)
    }
  }
}

console.log('\nDone.')
