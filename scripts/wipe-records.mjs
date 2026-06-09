// Wipes Tasks, Memories, and NextSessionNotes from Turso.
// Preserves: Profile, Client, ScheduledMessage, ScheduledTask, Conversation, Message.
// Run: node scripts/wipe-records.mjs
// Add --confirm to actually execute (dry-run by default).

import { createClient } from '@libsql/client'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
)

const client = createClient({ url: env.DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })
const dryRun = !process.argv.includes('--confirm')

// Domain memories (creative, political, wellbeing, private) have real signal —
// preserve them. The domain=null flood is what's killing context and costing money.
const KEEP_DOMAINS = ['creative', 'political', 'wellbeing', 'private']
const keepClause = KEEP_DOMAINS.map(d => `'${d}'`).join(', ')

const counts = await Promise.all([
  client.execute('SELECT COUNT(*) as n FROM Task'),
  client.execute(`SELECT COUNT(*) as n FROM Memory WHERE domain IS NULL OR domain NOT IN (${keepClause})`),
  client.execute(`SELECT COUNT(*) as n FROM Memory WHERE domain IN (${keepClause})`),
  client.execute('SELECT COUNT(*) as n FROM NextSessionNote'),
])

const [tasks, wipeMems, keepMems, notes] = counts.map(r => r.rows[0].n)
console.log(`Will delete: ${tasks} tasks, ${wipeMems} memories (domain=null), ${notes} notes`)
console.log(`Will keep:   ${keepMems} memories (creative, political, wellbeing, private)`)
console.log(`Preserving:  Profile, Client, ScheduledMessage, ScheduledTask, Conversation, Message\n`)

if (dryRun) {
  console.log('DRY RUN — pass --confirm to execute.')
} else {
  console.log('Executing...')
  await client.execute('DELETE FROM Task')
  await client.execute(`DELETE FROM Memory WHERE domain IS NULL OR domain NOT IN (${keepClause})`)
  await client.execute('DELETE FROM NextSessionNote')
  console.log('Done. Penny starts fresh on next conversation.')
}
