-- Private, structured intake ledger. The fixed catalog remains in application
-- code; absent rows mean that Penny has not evaluated that catalog area yet.
CREATE TABLE IF NOT EXISTS "IntakeEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "profileId" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "content" TEXT NOT NULL DEFAULT '',
  "evidence" TEXT NOT NULL DEFAULT '',
  "contradictions" TEXT NOT NULL DEFAULT '',
  "openQuestion" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "IntakeEntry_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "Profile" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntakeEntry_profileId_key_key"
  ON "IntakeEntry" ("profileId", "key");
CREATE INDEX IF NOT EXISTS "IntakeEntry_profileId_bucket_idx"
  ON "IntakeEntry" ("profileId", "bucket");
CREATE INDEX IF NOT EXISTS "IntakeEntry_profileId_status_idx"
  ON "IntakeEntry" ("profileId", "status");

ALTER TABLE "Profile" ADD COLUMN "workingAgreement" TEXT;
ALTER TABLE "Profile" ADD COLUMN "workingAgreementUpdatedAt" DATETIME;
