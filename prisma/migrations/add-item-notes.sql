-- Free-write notes log on Item, additive to whatever a self already created. Lets
-- a self append context to an existing item instead of minting a duplicate Item
-- every time she learns something new about it.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-item-notes.sql

ALTER TABLE "Item" ADD COLUMN "notes" TEXT NOT NULL DEFAULT '';
