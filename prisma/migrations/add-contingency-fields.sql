-- Adds the dated contingency mechanism: a real date field so Review can skip an
-- item/project entirely while it's genuinely on hold, instead of asking the same
-- "did you hear back from the IRS yet?" question every time. Item gets a fresh
-- contingency/contingencyUntil pair; Project already had a free-text
-- `contingencies` field, so it only needs the paired date.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-contingency-fields.sql

ALTER TABLE "Item" ADD COLUMN "contingency" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Item" ADD COLUMN "contingencyUntil" DATETIME;
ALTER TABLE "Project" ADD COLUMN "contingencyUntil" DATETIME;
