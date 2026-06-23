// Smoke-test helper for the review engine. Seeds clearly-marked TEST items into the
// Item table, lists them, and cleans them up afterward. NOT part of the app.
//
//   node scripts/smoke-review.mjs seed     # insert TEST items, print profile id
//   node scripts/smoke-review.mjs list     # show all items
//   node scripts/smoke-review.mjs cleanup  # delete TEST items + any "Talk to %" booked during the test

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
const cmd = process.argv[2]
const now = new Date().toISOString()
const rid = () => 'test_' + Math.random().toString(36).slice(2) + Date.now().toString(36)

if (cmd === 'seed') {
  const p = await client.execute('SELECT id FROM "Profile" LIMIT 1')
  if (!p.rows.length) { console.error('no profile'); process.exit(1) }
  const profileId = p.rows[0].id
  const items = [
    { name: 'TEST: dentist follow-up', description: 'Flagged last week — book the next cleaning.', type: 'event', paStatus: 'pending' },
    { name: 'TEST: car registration', description: 'Renew the tag before it lapses.', type: 'event', paStatus: 'new' },
  ]
  for (const it of items) {
    await client.execute({
      sql: 'INSERT INTO "Item" (id, createdAt, updatedAt, profileId, name, description, type, createdBy, target, priority, paStatus, visibility) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)',
      args: [rid(), now, now, profileId, it.name, it.description, it.type, 'pa', 'pa', 2, it.paStatus],
    })
    console.log('seeded:', it.name, '·', it.paStatus)
  }
  console.log('profileId:', profileId)
} else if (cmd === 'list') {
  const r = await client.execute('SELECT id, name, type, target, paStatus, modalityStatus, visibility FROM "Item" ORDER BY createdAt')
  console.log(JSON.stringify(r.rows, null, 2))
} else if (cmd === 'cleanup') {
  const r = await client.execute(`DELETE FROM "Item" WHERE name LIKE 'TEST:%' OR name LIKE 'Talk to %'`)
  console.log('deleted rows:', r.rowsAffected)
} else {
  console.error('usage: seed | list | cleanup')
  process.exit(1)
}
