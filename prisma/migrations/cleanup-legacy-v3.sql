-- Destructive post-reset cleanup. The application tables were emptied first.

DROP TABLE IF EXISTS "Task";
DROP TABLE IF EXISTS "PendingCalendarEvent";
DROP TABLE IF EXISTS "Routine";
DROP TABLE IF EXISTS "Note";
DROP TABLE IF EXISTS "ItemNote";
DROP TABLE IF EXISTS "OuterLife";
DROP TABLE IF EXISTS "Memory";
DROP TABLE IF EXISTS "NextSessionNote";

ALTER TABLE "Profile" DROP COLUMN "aboutSelf";
ALTER TABLE "Profile" DROP COLUMN "aboutSelfUpdatedAt";
ALTER TABLE "Profile" DROP COLUMN "privateAboutUser";
ALTER TABLE "Profile" DROP COLUMN "privateAboutUserUpdatedAt";
ALTER TABLE "Profile" DROP COLUMN "privateAboutSelf";
ALTER TABLE "Profile" DROP COLUMN "privateAboutSelfUpdatedAt";
ALTER TABLE "Profile" DROP COLUMN "altAboutUser";
ALTER TABLE "Profile" DROP COLUMN "altAboutUserUpdatedAt";
ALTER TABLE "Profile" DROP COLUMN "altAboutSelf";
ALTER TABLE "Profile" DROP COLUMN "altAboutSelfUpdatedAt";
ALTER TABLE "Profile" DROP COLUMN "focusLocked";
ALTER TABLE "Profile" DROP COLUMN "focusProfile";
ALTER TABLE "Profile" DROP COLUMN "focusLockedAt";
ALTER TABLE "Profile" DROP COLUMN "focusReleaseType";
ALTER TABLE "Profile" DROP COLUMN "focusUnlocksAt";
ALTER TABLE "Profile" DROP COLUMN "focusEmergencyCount";
ALTER TABLE "Profile" DROP COLUMN "focusProfiles";

ALTER TABLE "Conversation" DROP COLUMN "isAltMode";

ALTER TABLE "Item" DROP COLUMN "paStatus";
ALTER TABLE "Item" DROP COLUMN "modalityStatus";
ALTER TABLE "Item" DROP COLUMN "calendarEventId";
ALTER TABLE "Item" DROP COLUMN "escalatedToId";
ALTER TABLE "Item" DROP COLUMN "sourceRef";
