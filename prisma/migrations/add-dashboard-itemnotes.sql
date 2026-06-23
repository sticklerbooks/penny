-- Dashboard: principal→item channel + done/archive lifecycle.
-- Additive and idempotent — safe to re-run. Apply to the live Turso DB:
--
--   turso db shell <db-name> < prisma/migrations/add-dashboard-itemnotes.sql
--
-- Or via scripts/apply-migration.mjs (uses @libsql/client + env), which is how
-- this repo applies migrations locally since the Prisma CLI can't read libsql://.
--
-- What this does:
--   • Creates the ItemNote table (Adam's notes/flags ON a task/event/project)
--   • Adds completedAt + archivedAt to Task and PendingCalendarEvent
--     (events finally get a real "it happened" state, distinct from `scheduled`)

CREATE TABLE IF NOT EXISTS "ItemNote" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profileId"      TEXT NOT NULL,
    "itemType"       TEXT NOT NULL,
    "itemId"         TEXT NOT NULL,
    "kind"           TEXT NOT NULL,
    "body"           TEXT,
    "acknowledged"   BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" DATETIME,
    CONSTRAINT "ItemNote_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ItemNote_profileId_itemType_itemId_idx"
    ON "ItemNote" ("profileId", "itemType", "itemId");

-- SQLite has no "ADD COLUMN IF NOT EXISTS"; these will error harmlessly if the
-- column already exists. The applier script tolerates per-statement failure.
ALTER TABLE "Task" ADD COLUMN "completedAt" DATETIME;
ALTER TABLE "Task" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "PendingCalendarEvent" ADD COLUMN "completedAt" DATETIME;
ALTER TABLE "PendingCalendarEvent" ADD COLUMN "archivedAt" DATETIME;
