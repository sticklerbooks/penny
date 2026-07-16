// Completely clears Penny's application data from the shared Turso database.
// The database schema and migration metadata are preserved.
//
// Run: node scripts/wipe-records.mjs             (dry run)
//      node scripts/wipe-records.mjs --confirm   (irreversible reset)

// Foreign-key dependencies make table order important. Rather than maintain a
// second copy of the schema here, the reset discovers every application table
// and retries blocked deletes until their child tables have been emptied.

import { createClient } from '@libsql/client'
import { readFileSync } from 'fs'

function loadEnvFile(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
        .map((line) => {
          const i = line.indexOf('=')
          return [
            line.slice(0, i).trim(),
            line.slice(i + 1).trim().replace(/^["']|["']$/g, ''),
          ]
        })
    )
  } catch {
    return {}
  }
}

const env = {
  ...loadEnvFile('.env'),
  ...loadEnvFile('.env.local'),
  ...process.env,
}

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured')
}

const client = createClient({
  url: env.DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
})
const dryRun = !process.argv.includes('--confirm')

const tableResult = await client.execute(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
    AND name NOT LIKE 'libsql_%'
    AND name != '_prisma_migrations'
  ORDER BY name
`)

const tables = tableResult.rows.map((row) => String(row.name))
const counts = []

for (const table of tables) {
  const quoted = `"${table.replaceAll('"', '""')}"`
  const result = await client.execute(`SELECT COUNT(*) AS n FROM ${quoted}`)
  counts.push({ table, count: Number(result.rows[0]?.n ?? 0) })
}

const populated = counts.filter(({ count }) => count > 0)
const total = populated.reduce((sum, { count }) => sum + count, 0)

console.log(`Found ${tables.length} application tables and ${total} total rows.`)
for (const { table, count } of populated) console.log(`  ${table}: ${count}`)

if (dryRun) {
  console.log('\nDRY RUN — pass --confirm to permanently delete every row listed above.')
  process.exit(0)
}

console.log('\nDeleting all application data...')
let pending = [...tables]

while (pending.length > 0) {
  const blocked = []
  let deletedThisPass = 0

  for (const table of pending) {
    const quoted = `"${table.replaceAll('"', '""')}"`
    try {
      await client.execute(`DELETE FROM ${quoted}`)
      deletedThisPass++
    } catch (error) {
      blocked.push({ table, error })
    }
  }

  if (blocked.length === 0) break
  if (deletedThisPass === 0) {
    const detail = blocked
      .map(({ table, error }) => `${table}: ${error instanceof Error ? error.message : String(error)}`)
      .join('\n')
    throw new Error(`Could not clear the remaining tables:\n${detail}`)
  }
  pending = blocked.map(({ table }) => table)
}

const remaining = []
for (const table of tables) {
  const quoted = `"${table.replaceAll('"', '""')}"`
  const result = await client.execute(`SELECT COUNT(*) AS n FROM ${quoted}`)
  const count = Number(result.rows[0]?.n ?? 0)
  if (count > 0) remaining.push(`${table}: ${count}`)
}

if (remaining.length > 0) {
  throw new Error(`Reset verification failed:\n${remaining.join('\n')}`)
}

console.log(`Done. Verified all ${tables.length} application tables are empty.`)
