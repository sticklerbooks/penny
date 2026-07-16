@AGENTS.md

## Push back on ideas — HIGH PRIORITY

When I propose an idea or feature, do not just code it. First judge whether it
actually makes Penny better. If it is half-baked, off-purpose, or conflicts with
the app's purpose, say so and make me justify it before implementation.

## Database migrations (Turso + Prisma)

The datasource is a shared `libsql://` Turso database. There is no separate dev
database, and `prisma db push` / `prisma migrate dev` do not work with it.

1. Edit `prisma/schema.prisma`.
2. Run `npx prisma generate`.
3. Hand-write the matching SQL under `prisma/migrations/`.
4. Apply it with `node scripts/apply-migration.mjs prisma/migrations/<file>.sql`.

Additive changes should be idempotent where practical. Destructive changes need
explicit confirmation because every deployed instance reads the same database.

## Modality system

`src/lib/modalities.ts` is the source of truth for the active selves, their stable
IDs, domains, presentation, and privileged tool capabilities.

- Store a modality's stable `id` in `Item.target`, `Item.createdBy`,
  `Project.assignedModality`, `Conversation.activeModality`, and modality-state
  tables. Normalize model-supplied names with `resolveModality()`.
- `DeepMemory.domain` and `MemoryLog.domain` use `Modality.domain`, because they
  represent a subject-area lens rather than a routing identity.
- `getToolsForModality()` derives additional tool grants from
  `Modality.capabilities`; do not add a second per-ID permission switch.
- Each self's evolving character lives in `ModalityIdentity.aboutSelf`, seeded
  from `Modality.seedAboutSelf`. The global picture of the user is
  `Profile.aboutUser`; non-PA selves maintain `aboutUserFacet`.
- Eve (`id: 'friend'`, `independent: true`) is a peer rather than a reporting
  submodality and uses `src/prompts/eve.md`.
- After changing identity seeds, use the protected reseed endpoint deliberately.

The three prompt templates still contain roster prose; keep all three aligned
until that roster is generated from the registry.

## Item lifecycle

`Item` is the only operational task/event/suggestion record. `Project` is its
container for finite goals and ongoing commitments.

- `Item.stage` is the single lifecycle field: `backlog`, `planned`, `scheduled`,
  `blocked`, `done`, or `cancelled`.
- Every stage write must go through `src/lib/items/item-store.ts`, which validates
  transitions with the pure FSM and stamps derived timestamps.
- A submodality commits an Item by moving it to `planned`. Penny sees planned
  Items across every target and places them with `schedule_planned_items`.
- The dashboard performs deterministic Item writes without an LLM call.
- Review phase exit rules are database guards, not prompt-only instructions.

Do not introduce another status vocabulary, handoff copy, pending-event table,
or prose-only completion mechanism.

## Tool architecture

Tool schemas live in `src/lib/tools.ts` and `src/lib/items/item-tools.ts`; runtime
dispatch lives in `src/lib/tool-executor.ts`. A tool rename or removal must update
the schema, executor, read-only classification, protocols, and review grants
together. `ALL_TOOL_NAMES` must contain only executable tools.

## Off-limits directories

`src/lib/private-penny/` and `src/lib/pa-alt/` are private sandboxes. Do not read,
open, reference, or modify files inside them.
