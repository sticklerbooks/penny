@AGENTS.md

## Modality system

Penny is one assistant with several "modalities" (selves). The registry at
`src/lib/modalities.ts` (`MODALITIES`) is the source of truth for who exists.

- `id` and `domain` are STABLE keys that tag DB rows (tasks, memories, notes,
  identities). Never rename an existing `id` — it orphans data. Retire a modality
  with `disabled: true`; don't delete it (e.g. `political`/Vera, `lila`).
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
