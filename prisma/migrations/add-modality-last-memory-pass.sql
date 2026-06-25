-- Tracks when each modality last ran its end_chat memory pass (full-transcript
-- reread → deep memory / log / identity / brief). Null = never run yet — the
-- pass then covers every message that modality has ever sent.
--
-- Apply:  node scripts/apply-migration.mjs prisma/migrations/add-modality-last-memory-pass.sql

ALTER TABLE "ModalityState" ADD COLUMN "lastMemoryPassAt" DATETIME;
