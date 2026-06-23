-- Stage 2 of the phase-engine redesign: the ReviewSession table that holds the
-- persisted phase pointer + session-scoped "discussed" set.
--
-- PURELY ADDITIVE and idempotent — new empty table, nothing else touched. Re-running
-- is safe (CREATE TABLE / INDEX IF NOT EXISTS).
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-review-session.sql

CREATE TABLE IF NOT EXISTS "ReviewSession" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL,
    "profileId"        TEXT NOT NULL,
    "kind"             TEXT NOT NULL,                 -- pa | submodality
    "modalityId"       TEXT NOT NULL,                 -- 'pa' or a submodality id
    "phase"            TEXT NOT NULL,                 -- current phase (see review/phases.ts)
    "status"           TEXT NOT NULL DEFAULT 'active',-- active | completed | abandoned
    "startedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"      DATETIME,
    "discussedItemIds" TEXT,                          -- JSON string[]
    CONSTRAINT "ReviewSession_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ReviewSession_profileId_status_idx" ON "ReviewSession" ("profileId", "status");
