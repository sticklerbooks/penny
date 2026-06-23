-- Normalize assignedModality from display names → stable modality IDs.
--
-- The model had been tagging tasks/projects with the self's NAME ("margot",
-- "june", "ada", "remy", "iris") instead of her ID ("bookkeeping", "household",
-- "maker", "health", "creative"). The domain lens filters by ID, so every
-- submodality's agenda came up empty and the PA (which ignores the filter) caught
-- everything. This realigns the data; canonModality() in tool-executor keeps new
-- writes canonical so it can't recur.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/normalize-assigned-modality.sql
-- Idempotent — re-running is a no-op once values are already IDs.
--
-- Name → ID map:
--   margot→bookkeeping  june→household  ada→maker  remy→health  iris→creative
--   penny→pa  sage→health (retired wellbeing self)  adam→pa (user name mistag)

UPDATE "Task" SET "assignedModality" = 'bookkeeping' WHERE "assignedModality" = 'margot';
UPDATE "Task" SET "assignedModality" = 'household'   WHERE "assignedModality" = 'june';
UPDATE "Task" SET "assignedModality" = 'maker'       WHERE "assignedModality" = 'ada';
UPDATE "Task" SET "assignedModality" = 'health'      WHERE "assignedModality" IN ('remy', 'sage');
UPDATE "Task" SET "assignedModality" = 'creative'    WHERE "assignedModality" = 'iris';
UPDATE "Task" SET "assignedModality" = 'pa'          WHERE "assignedModality" IN ('penny', 'adam');

UPDATE "Project" SET "assignedModality" = 'bookkeeping' WHERE "assignedModality" = 'margot';
UPDATE "Project" SET "assignedModality" = 'household'   WHERE "assignedModality" = 'june';
UPDATE "Project" SET "assignedModality" = 'maker'       WHERE "assignedModality" = 'ada';
UPDATE "Project" SET "assignedModality" = 'health'      WHERE "assignedModality" IN ('remy', 'sage');
UPDATE "Project" SET "assignedModality" = 'creative'    WHERE "assignedModality" = 'iris';
UPDATE "Project" SET "assignedModality" = 'pa'          WHERE "assignedModality" IN ('penny', 'adam');

UPDATE "PendingCalendarEvent" SET "assignedModality" = 'bookkeeping' WHERE "assignedModality" = 'margot';
UPDATE "PendingCalendarEvent" SET "assignedModality" = 'household'   WHERE "assignedModality" = 'june';
UPDATE "PendingCalendarEvent" SET "assignedModality" = 'maker'       WHERE "assignedModality" = 'ada';
UPDATE "PendingCalendarEvent" SET "assignedModality" = 'health'      WHERE "assignedModality" IN ('remy', 'sage');
UPDATE "PendingCalendarEvent" SET "assignedModality" = 'creative'    WHERE "assignedModality" = 'iris';
UPDATE "PendingCalendarEvent" SET "assignedModality" = 'pa'          WHERE "assignedModality" IN ('penny', 'adam');

UPDATE "Routine" SET "assignedModality" = 'bookkeeping' WHERE "assignedModality" = 'margot';
UPDATE "Routine" SET "assignedModality" = 'household'   WHERE "assignedModality" = 'june';
UPDATE "Routine" SET "assignedModality" = 'maker'       WHERE "assignedModality" = 'ada';
UPDATE "Routine" SET "assignedModality" = 'health'      WHERE "assignedModality" IN ('remy', 'sage');
UPDATE "Routine" SET "assignedModality" = 'creative'    WHERE "assignedModality" = 'iris';
UPDATE "Routine" SET "assignedModality" = 'pa'          WHERE "assignedModality" IN ('penny', 'adam');
