-- Stage 3 prep: provenance column on Item so the cutover (active Task/Note →
-- Item) is idempotent (skip rows already migrated) and reversible (delete by
-- sourceRef). Additive + idempotent.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-item-sourceref.sql

ALTER TABLE "Item" ADD COLUMN "sourceRef" TEXT;
