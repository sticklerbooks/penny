-- Stage 1 of the phase-engine redesign: the unified Item table + the additive
-- Project / ModalityState columns the new model needs.
--
-- PURELY ADDITIVE and idempotent. The new Item table is empty and nothing queries
-- it yet (the Stage 3 cutover migrates/retires the old Task/Note/PendingCalendarEvent/
-- Routine rows). The Project/ModalityState columns are nullable or defaulted, so
-- existing reads are unaffected. The applier tolerates "duplicate column" /
-- "already exists", so re-running is safe.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-item-model.sql

-- ── The unified work item ──────────────────────────────────────────────────────
-- Lifecycle rules live in src/lib/items/fsm.ts, never in SQL. paStatus /
-- modalityStatus are free-text here (SQLite has no enums); the FSM is the gate.
CREATE TABLE IF NOT EXISTS "Item" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       DATETIME NOT NULL,
    "profileId"       TEXT NOT NULL,
    "projectId"       TEXT,
    "name"            TEXT NOT NULL,
    "description"     TEXT NOT NULL,
    "type"            TEXT NOT NULL,                  -- event | ongoing | memory | suggestion
    "createdBy"       TEXT NOT NULL,                  -- modality id
    "target"          TEXT NOT NULL,                  -- modality id or 'pa'
    "priority"        INTEGER NOT NULL DEFAULT 2,     -- 0–5
    "duration"        TEXT,
    "dayTime"         TEXT,
    "paStatus"        TEXT,                           -- see fsm.ts PA_STATUSES
    "modalityStatus"  TEXT,                           -- see fsm.ts MODALITY_STATUSES
    "visibility"      BOOLEAN NOT NULL DEFAULT true,
    "completedAt"     DATETIME,
    "scheduledAt"     DATETIME,
    "calendarEventId" TEXT,
    "escalatedToId"   TEXT,
    CONSTRAINT "Item_profileId_fkey"
        FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Item_profileId_target_idx"    ON "Item" ("profileId", "target");
CREATE INDEX IF NOT EXISTS "Item_profileId_projectId_idx" ON "Item" ("profileId", "projectId");

-- ── Project additions ──────────────────────────────────────────────────────────
-- (ADD COLUMN fails harmlessly if the column already exists; applier tolerates it.)
ALTER TABLE "Project" ADD COLUMN "termType"   TEXT;
ALTER TABLE "Project" ADD COLUMN "visibility" BOOLEAN NOT NULL DEFAULT true;

-- ── ModalityState additions ────────────────────────────────────────────────────
ALTER TABLE "ModalityState" ADD COLUMN "needsAttention" INTEGER NOT NULL DEFAULT 0;
