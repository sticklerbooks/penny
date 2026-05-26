// One-time script to create tables in Turso
// Run with: node scripts/migrate-turso.mjs

import { createClient } from '@libsql/client'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local manually
const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
const env = Object.fromEntries(
  envFile
    .split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split('=').map(s => s.trim().replace(/^"|"$/g, '')))
    .filter(pair => pair.length === 2)
)

const client = createClient({
  url: env.DATABASE_URL,
  authToken: env.TURSO_AUTH_TOKEN,
})

const statements = [
  `CREATE TABLE IF NOT EXISTS Profile (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    userName TEXT,
    intakeComplete INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS Memory (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    FOREIGN KEY (profileId) REFERENCES Profile(id)
  )`,
  `CREATE TABLE IF NOT EXISTS Conversation (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    type TEXT NOT NULL,
    FOREIGN KEY (profileId) REFERENCES Profile(id)
  )`,
  `CREATE TABLE IF NOT EXISTS Message (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    conversationId TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    FOREIGN KEY (conversationId) REFERENCES Conversation(id)
  )`,
  `CREATE TABLE IF NOT EXISTS Task (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    dueDate DATETIME,
    priority INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending',
    pennyNotes TEXT,
    FOREIGN KEY (profileId) REFERENCES Profile(id)
  )`,
]

console.log('Creating tables in Turso...')
for (const sql of statements) {
  const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]
  await client.execute(sql)
  console.log(`  ✓ ${tableName}`)
}
console.log('Done! Turso database is ready.')
