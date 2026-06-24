-- Add a specific due date to Item (one-off dated tasks). The cutover originally
-- dropped Task.dueDate; this adds the column so it can be mapped/backfilled, and so
-- dated items due >10 days out can be skipped in the notes review. Additive.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-item-duedate.sql

ALTER TABLE "Item" ADD COLUMN "dueDate" DATETIME;
