@AGENTS.md

## ⚠️ Push back on ideas — HIGH PRIORITY

When I propose an idea or feature, do NOT just code it. First judge whether it
actually makes the app better. If it looks half-baked, off-purpose, or like a
random impulse rather than a real improvement, say so and make me justify it.
If it conflicts with Penny's overall purpose, push back — at least a little —
before writing any code. I would rather argue with you for a minute than ship a
crazy idea. Being a yes-man here is failing the job.

## Database migrations (Turso + Prisma)

The datasource is a `libsql://` URL (Turso), not a file path — the standard
`prisma db push` / `prisma migrate dev` flow does NOT work here and fails with
`P1013: scheme not recognized`. Don't try it; use this flow instead:

1. Edit `prisma/schema.prisma` as normal.
2. `npx prisma generate` to refresh the TS client (`src/generated/prisma` — not
   committed; Railway regenerates it on deploy via `postinstall`).
3. Hand-write the equivalent SQL as a new file under `prisma/migrations/*.sql`.
   Keep it additive and idempotent: `CREATE TABLE IF NOT EXISTS`, and for
   `ALTER TABLE ... ADD COLUMN` just let it fail harmlessly if the column already
   exists (the applier script tolerates this — see next step).
4. Apply it to the live DB: `node scripts/apply-migration.mjs prisma/migrations/<file>.sql`.
   It reads `DATABASE_URL`/`TURSO_AUTH_TOKEN` from `.env.local` (falls back to
   `.env`) and runs each statement, tolerating "duplicate column" / "already
   exists" so re-running is safe.
5. **There is no separate dev database** — this applies straight to the one
   shared Turso DB other deployed instances read too (see Penny hosting memory).
   Additive changes (new table, nullable column) are low-risk to run
   immediately; anything destructive (drop/rename/non-null backfill) needs
   explicit confirmation first, same as any other production change.

(The older one-off `scripts/migrate-*.mjs` files predate `apply-migration.mjs`
and hand-roll the same pattern — prefer the generic script for new work.)

## Modality system

Penny is one assistant with several "modalities" (selves). The registry at
`src/lib/modalities.ts` (`MODALITIES`) is the source of truth for who exists.

- `id` and `domain` are STABLE keys that tag DB rows (tasks, memories, notes,
  identities). Never rename an existing `id` — it orphans data. Retire a modality
  with `disabled: true`; don't delete it (e.g. `political`/Vera, `lila`).
- ⚠️ **Convention: internal modality references use the stable `id`** (e.g.
  `'bookkeeping'`), never `displayName` (`'Margot'`). This was violated for a long
  time — `Task`/`Project`/`PendingCalendarEvent`/`Routine.assignedModality` were
  written with display names, which silently broke the domain lens (a
  submodality's own agenda came up empty; PA, which has no filter, caught
  everything). Fixed 2026-06-23: `canonModality()` in `src/lib/tool-executor.ts`
  normalizes every write via `resolveModality()`; historical rows were repaired
  by `prisma/migrations/normalize-assigned-modality.sql`. If you add a new
  column that tags a row with a modality, write the `id`, and route it through
  `canonModality()` (or `resolveModality(...).id`) rather than trusting the
  caller.
  - **Sanctioned exception:** `Memory.domain` / `DeepMemory.domain` /
    `MemoryLog.domain` intentionally store `Modality.domain`, NOT `id` — that's
    how Remy inherits old Sage-era memories under `wellbeing` and Eve's are
    tagged `emotional` (her id is `friend`). This is a deliberate, older
    convention for data continuity, not the same bug — don't "fix" it to `id`
    without a dedicated migration that accounts for that lineage.
  - ⚠️ TODO (deferred — needs a dedicated pass, not yet done): audit every other
    place a modality is referenced internally for the same id/domain/name drift
    (routing, notifications, anywhere else a modality is stored as free text).
- Each self's character lives in `ModalityIdentity.aboutSelf` (per-profile, in the
  DB), seeded from `Modality.seedAboutSelf`. Reseed via
  `POST /api/admin/reseed-identities?secret=$CRON_SECRET` — `mode=fill` (default)
  only fills blanks, `mode=reset` overwrites all, `exclude=id1,id2` skips selves.
- Eve (`id: 'friend'`, `independent: true`) is a peer to Penny, NOT a submodality:
  excluded from weekly reports + nightly note-escalation, and uses her own prompt
  template `src/prompts/eve.md`.

⚠️ Adding/renaming/dropping a modality is NOT just a registry edit. Several places
hardcode modality logic instead of deriving it from the registry and WILL drift —
they fail silently, so update them together:
  - `getToolsForModality` in `src/lib/tools.ts` — tool grants are a switch keyed off
    `id`, NOT the `capabilities` array (which is currently decorative, read only by
    `showClients`). A missing case silently falls back to minimal tools.
  - The team roster is written in PROSE in `src/prompts/pa.md`, `modality.md`, AND
    `eve.md` — all three must be edited.
  - `loadPromptTemplate` in `src/lib/claude.ts` picks the `.md` template per modality.
  - After changing the registry, reseed identities (above).

## Off-limits directory

`src/lib/private-penny/` is a private sandbox. Do not read, open, reference, or modify any file inside it.

`src/lib/pa-alt/` is a private sandbox. Do not read, open, reference, or modify any file inside it.
