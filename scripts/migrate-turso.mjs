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
  `CREATE TABLE IF NOT EXISTS Client (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    name TEXT NOT NULL,
    contactName TEXT,
    contactSecondary TEXT,
    phone TEXT,
    email TEXT,
    businessStructure TEXT,
    status TEXT NOT NULL DEFAULT 'prospect',
    services TEXT,
    grossRevenue REAL,
    billingStatus TEXT,
    notes TEXT,
    FOREIGN KEY (profileId) REFERENCES Profile(id)
  )`,
  `CREATE TABLE IF NOT EXISTS Memory (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    archived INTEGER NOT NULL DEFAULT 0,
    lastReferenced DATETIME,
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
    clientId TEXT,
    title TEXT NOT NULL,
    description TEXT,
    dueDate DATETIME,
    priority INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending',
    category TEXT,
    pennyNotes TEXT,
    FOREIGN KEY (profileId) REFERENCES Profile(id),
    FOREIGN KEY (clientId) REFERENCES Client(id)
  )`,
  `CREATE TABLE IF NOT EXISTS NextSessionNote (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    content TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (profileId) REFERENCES Profile(id)
  )`,
  `CREATE TABLE IF NOT EXISTS ModalityState (
    id TEXT PRIMARY KEY,
    profileId TEXT NOT NULL,
    modalityId TEXT NOT NULL,
    lastActiveAt DATETIME,
    lastCompletedAt DATETIME,
    UNIQUE (profileId, modalityId)
  )`,
  `CREATE TABLE IF NOT EXISTS ScheduledMessage (
    id TEXT PRIMARY KEY,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    profileId TEXT NOT NULL,
    message TEXT NOT NULL,
    sendAt DATETIME NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    sentAt DATETIME,
    label TEXT,
    FOREIGN KEY (profileId) REFERENCES Profile(id)
  )`,
]

// ALTER statements for existing tables (idempotent via try/catch)
const alters = [
  `ALTER TABLE Task ADD COLUMN category TEXT`,
  `ALTER TABLE Task ADD COLUMN clientId TEXT`,
  `ALTER TABLE Memory ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE Memory ADD COLUMN lastReferenced DATETIME`,
  `ALTER TABLE Profile ADD COLUMN emailCalendarSummary TEXT`,
  `ALTER TABLE Profile ADD COLUMN emailCalendarCachedAt DATETIME`,
  `ALTER TABLE Profile ADD COLUMN aboutUser TEXT`,
  `ALTER TABLE Profile ADD COLUMN aboutUserUpdatedAt DATETIME`,
  `ALTER TABLE Profile ADD COLUMN aboutSelf TEXT`,
  `ALTER TABLE Profile ADD COLUMN aboutSelfUpdatedAt DATETIME`,
  `ALTER TABLE Conversation ADD COLUMN closed INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE Conversation ADD COLUMN activeModality TEXT NOT NULL DEFAULT 'pa'`,
  `ALTER TABLE Task ADD COLUMN domain TEXT`,
  `ALTER TABLE Task ADD COLUMN onMasterList INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE Memory ADD COLUMN domain TEXT`,
  `ALTER TABLE NextSessionNote ADD COLUMN source TEXT`,
  `ALTER TABLE NextSessionNote ADD COLUMN target TEXT`,
  `ALTER TABLE Task ADD COLUMN timing TEXT`,
  `ALTER TABLE Task ADD COLUMN lastReviewed DATETIME`,
]

console.log('Creating tables in Turso...')
for (const sql of statements) {
  const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1]
  await client.execute(sql)
  console.log(`  ✓ ${tableName}`)
}

console.log('Applying ALTERs (skipping already-applied)...')
for (const sql of alters) {
  try {
    await client.execute(sql)
    console.log(`  ✓ ${sql}`)
  } catch (e) {
    if (e.message?.includes('duplicate column')) {
      console.log(`  → already applied: ${sql}`)
    } else {
      console.log(`  ✗ ${sql} — ${e.message}`)
    }
  }
}
console.log('Done! Turso database is ready.')
