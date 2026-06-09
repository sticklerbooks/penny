-- Penny v2 schema migration
-- ─────────────────────────────────────────────────────────────────────────────
-- Run ONCE against the live Turso DB BEFORE deploying the v2 code:
--
--   turso db shell <db-name> < prisma/migrations/migrate-to-v2.sql
--
-- Or via the Turso HTTP API (replace <token> and <db-host>):
--
--   curl -sX POST "https://<db-host>/v2/pipeline" \
--     -H "Authorization: Bearer <token>" \
--     -H "Content-Type: application/json" \
--     -d '{"requests":[{"type":"execute","stmt":{"sql":"<SQL here>"}}]}'
--
-- What this does:
--   • Creates 7 new tables (Project, PendingCalendarEvent, Routine, Note,
--     ModalityBrief, DeepMemory, MemoryLog)
--   • Migrates Task from old schema (title/domain/pennyNotes/…)
--     to new schema (name/assignedModality/notes/status/…)
--     — existing task data is preserved; old table saved as Task_old_backup
--   • Migrates existing NextSessionNote rows into Note (if the table exists)
--
-- ASSUMPTIONS: Run this against a DB still on the OLD schema (Task has 'title').
-- If the migration was already applied (Task has 'name'), skip the Task section.
-- ─────────────────────────────────────────────────────────────────────────────

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- ── 1. New tables (all IF NOT EXISTS — safe to re-run) ───────────────────────

CREATE TABLE IF NOT EXISTS "Project" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL,
    "profileId"        TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "description"      TEXT NOT NULL,
    "progress"         INTEGER NOT NULL DEFAULT 0,
    "expectedDuration" TEXT NOT NULL,
    "contingencies"    TEXT,
    "assignedModality" TEXT NOT NULL,
    CONSTRAINT "Project_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PendingCalendarEvent" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL,
    "profileId"        TEXT NOT NULL,
    "projectId"        TEXT,
    "name"             TEXT NOT NULL,
    "description"      TEXT,
    "date"             TEXT,
    "startTime"        TEXT,
    "duration"         TEXT NOT NULL,
    "location"         TEXT,
    "priority"         INTEGER NOT NULL DEFAULT 2,
    "assignedModality" TEXT NOT NULL DEFAULT 'pa',
    "scheduled"        BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt"      DATETIME,
    CONSTRAINT "PendingCalendarEvent_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Routine" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL,
    "profileId"        TEXT NOT NULL,
    "description"      TEXT NOT NULL,
    "frequency"        TEXT NOT NULL,
    "priority"         INTEGER NOT NULL,
    "flexibility"      INTEGER NOT NULL,
    "dayTime"          TEXT,
    "assignedModality" TEXT NOT NULL,
    CONSTRAINT "Routine_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Note" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      DATETIME NOT NULL,
    "profileId"      TEXT NOT NULL,
    "title"          TEXT NOT NULL,
    "content"        TEXT NOT NULL,
    "expiresAt"      DATETIME NOT NULL,
    "modalityTarget" TEXT NOT NULL,
    "source"         TEXT,
    "resolution"     TEXT NOT NULL DEFAULT 'Open',
    CONSTRAINT "Note_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ModalityBrief" (
    "id"         TEXT NOT NULL PRIMARY KEY,
    "updatedAt"  DATETIME NOT NULL,
    "profileId"  TEXT NOT NULL,
    "modalityId" TEXT NOT NULL,
    "content"    TEXT,
    CONSTRAINT "ModalityBrief_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ModalityBrief_profileId_modalityId_key"
    ON "ModalityBrief" ("profileId", "modalityId");

CREATE TABLE IF NOT EXISTS "DeepMemory" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "profileId" TEXT NOT NULL,
    "domain"    TEXT,
    "name"      TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    CONSTRAINT "DeepMemory_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeepMemory_profileId_name_key"
    ON "DeepMemory" ("profileId", "name");

CREATE TABLE IF NOT EXISTS "MemoryLog" (
    "id"        TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profileId" TEXT NOT NULL,
    "domain"    TEXT,
    "label"     TEXT NOT NULL,
    "content"   TEXT NOT NULL,
    CONSTRAINT "MemoryLog_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ── 2. Migrate NextSessionNote → Note (if the old table still exists) ─────────
-- NextSessionNote had: id, createdAt, profileId, content, target, resolved
-- OR IGNORE prevents duplicate-key errors if this is re-run.

INSERT OR IGNORE INTO "Note" (
    id, createdAt, updatedAt, profileId,
    title, content, expiresAt, modalityTarget, source, resolution
)
SELECT
    n.id,
    n.createdAt,
    n.createdAt,                              -- no updatedAt on old table
    n.profileId,
    'Carried note',
    n.content,
    datetime(n.createdAt, '+14 days'),
    COALESCE(n.target, 'pa'),
    'pa',
    CASE WHEN n.resolved = 1 THEN 'Resolved' ELSE 'Open' END
FROM "NextSessionNote" n;

-- ── 3. Migrate Task (old → new schema) ───────────────────────────────────────
--
-- Old schema columns:
--   id, createdAt, updatedAt, profileId, clientId,
--   title, description, domain, category,
--   onMasterList, timing, pennyNotes, lastReviewed,
--   dueDate, priority
--
-- New schema columns:
--   id, createdAt, updatedAt, profileId, clientId, projectId,
--   linkedCalendarEventId, name, description (NOT NULL), dueDate,
--   dueTime, priority, contingentOn, assignedModality, status, notes
--
-- Field mapping:
--   title       → name
--   description → description (COALESCE to '')
--   domain      → assignedModality (COALESCE to 'pa')
--   pennyNotes  → notes
--   (done col)  → status ('Complete' or 'Unstarted')

CREATE TABLE "Task_v2" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "createdAt"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            DATETIME NOT NULL,
    "profileId"            TEXT NOT NULL,
    "clientId"             TEXT,
    "projectId"            TEXT,
    "linkedCalendarEventId" TEXT,
    "name"                 TEXT NOT NULL,
    "description"          TEXT NOT NULL DEFAULT '',
    "dueDate"              DATETIME,
    "dueTime"              TEXT,
    "priority"             INTEGER NOT NULL DEFAULT 2,
    "contingentOn"         TEXT,
    "assignedModality"     TEXT NOT NULL DEFAULT 'pa',
    "status"               TEXT NOT NULL DEFAULT 'Unstarted',
    "notes"                TEXT,
    CONSTRAINT "Task_v2_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_v2_clientId_fkey"
        FOREIGN KEY ("clientId") REFERENCES "Client" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_v2_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "Project" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "Task_v2" (
    id, createdAt, updatedAt, profileId, clientId,
    name, description, dueDate, priority, assignedModality, status, notes
)
SELECT
    id,
    createdAt,
    updatedAt,
    profileId,
    clientId,
    title,
    COALESCE(description, ''),
    dueDate,
    COALESCE(priority, 2),
    COALESCE(domain, 'pa'),
    -- Old table may or may not have a 'done' column; default all to Unstarted.
    -- If you had a done column and want to preserve it, update manually after:
    --   UPDATE Task SET status='Complete' WHERE id IN (SELECT id FROM Task_old_backup WHERE done=1);
    'Unstarted',
    pennyNotes
FROM "Task";

-- Preserve old data (in case you need to roll back or check it)
ALTER TABLE "Task" RENAME TO "Task_old_backup";
ALTER TABLE "Task_v2" RENAME TO "Task";

COMMIT;
PRAGMA foreign_keys = ON;

-- ── Post-migration: restore status for completed tasks ────────────────────────
-- If your old Task table had a `done` boolean column, run this separately:
--
--   UPDATE Task SET status = 'Complete'
--   WHERE id IN (SELECT id FROM Task_old_backup WHERE done = 1);
--
-- ── Verify ────────────────────────────────────────────────────────────────────
-- Run these after applying to confirm everything looks right:
--
--   SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
--   SELECT count(*) AS task_count FROM Task;
--   SELECT id, name, assignedModality, status FROM Task LIMIT 10;
--   SELECT count(*) AS note_count FROM Note;
--   SELECT count(*) AS deep_memory_count FROM DeepMemory;
