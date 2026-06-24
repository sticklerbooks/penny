-- Backfill dueDate onto the already-migrated Items from their source Task rows
-- (the cutover originally dropped it). Idempotent — only fills Items that still
-- have no dueDate and whose source task actually had one. Reads from the old Task
-- table, which the cutover left intact.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/backfill-item-duedate.sql

UPDATE "Item"
SET "dueDate" = (
  SELECT t."dueDate" FROM "Task" t WHERE 'task:' || t."id" = "Item"."sourceRef"
)
WHERE "sourceRef" LIKE 'task:%'
  AND "dueDate" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Task" t2
    WHERE 'task:' || t2."id" = "Item"."sourceRef" AND t2."dueDate" IS NOT NULL
  );
