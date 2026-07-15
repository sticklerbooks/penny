-- Unify Item.paStatus/modalityStatus into one Item.stage (+ stageEnteredAt),
-- and add Project.kind (goal | ongoing) so progress can become a computed
-- fact for goal-shaped projects instead of a manually-set number. Additive +
-- idempotent — old paStatus/modalityStatus/progress columns are left in place
-- as a rollback safety net; dropping them is a separate, later, confirmed step.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/unify-item-stage.sql
-- Then:   node scripts/backfill-item-stage.mjs

ALTER TABLE "Item" ADD COLUMN "stage" TEXT;
ALTER TABLE "Item" ADD COLUMN "stageEnteredAt" DATETIME;
ALTER TABLE "Project" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'goal';
