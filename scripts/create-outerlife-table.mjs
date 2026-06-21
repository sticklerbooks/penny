// One-off: create the OuterLife table in Turso via the libsql driver, since
// `prisma db push` can't speak the libsql:// scheme. Idempotent (IF NOT EXISTS).
// SQL is exactly what `prisma migrate diff --from-empty --to-schema` generates.
import 'dotenv/config'
import { createClient } from '@libsql/client'

const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const existedBefore = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='OuterLife'"
)
console.log(existedBefore.rows.length ? 'OuterLife already existed.' : 'OuterLife not present — creating.')

await client.execute(`CREATE TABLE IF NOT EXISTS "OuterLife" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "updatedAt" DATETIME NOT NULL,
    "profileId" TEXT NOT NULL,
    "modalityId" TEXT NOT NULL,
    "ledger" TEXT,
    "bible" TEXT,
    "storyline" TEXT,
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "lastTickAt" DATETIME,
    CONSTRAINT "OuterLife_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
)`)

await client.execute(
  'CREATE UNIQUE INDEX IF NOT EXISTS "OuterLife_profileId_modalityId_key" ON "OuterLife"("profileId", "modalityId")'
)

const after = await client.execute("PRAGMA table_info('OuterLife')")
console.log('OuterLife columns:', after.rows.map((r) => r.name).join(', '))
console.log('Done.')
