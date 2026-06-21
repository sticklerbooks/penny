# TODO — technical debt & cleanup

Living backlog. The throughline of the top section: **there should be one registry
(`src/lib/modalities.ts`) that everything reads from.** Today there are several
independent copies of "what the modalities are," which drift and fail silently.

## Hardcoded → should-be-dynamic

### A. Logic that should derive from the registry (highest priority — fails *silently*)

- [ ] **Tool grants** — [`getToolsForModality`](src/lib/tools.ts) is a hardcoded `id`
  switch. The `capabilities` array on each `Modality` is **decorative** — only
  `showClients` in `src/lib/claude.ts` reads it. A new modality silently drops to
  `default` (no project tools, etc.) until the switch is edited.
  *Fix: derive the toolset from `capabilities`.* Root cause of the Nora/Ada/Remy gap.
- [x] **TTS voice map** — `src/app/api/speak/route.ts` now reads `Modality.voiceEnvVar`
  (was a separate hardcoded map that lacked Nora/Ada/Remy and pointed Eve at
  `SAGE_VOICE_ID`). Use as the template for fixing the others.
- [ ] **Roster prose** — `src/prompts/pa.md`, `modality.md`, and `eve.md` each spell
  out the full team in prose, **triplicated**. Every add/rename/drop means editing 3
  files, and they drift (Eve's stored identity still said "Vera").
  *Fix: a `{{ROSTER}}` placeholder generated from the registry — the now-unused
  `renderRoster()` in `modalities.ts` already does this.*
- [ ] **Template selection** — `loadPromptTemplate` in `src/lib/claude.ts` hardcodes
  `independent → eve.md`. A second independent self would wrongly inherit it.
  *Fix: a `templateFile` field, or convention `prompts/{id}.md` with fallback.*

### B. Scattered literals that have a constant/property available

- [ ] **`DEFAULT_MODALITY` is defined but ignored.** `modalities.ts` exports it, but
  `'pa'` is hardcoded in `chat/route.ts`, `ChatInterface.tsx`, `claude.ts`,
  `memory.ts`, and the cron files. *Fix: import the constant.*
- [ ] **`id !== 'pa' && id !== 'lila'` exclusions** in `cron/weekly-reports` and
  `cron/nightly-hygiene`. `'pa'` is really "the anchor" (`domain === null`); `'lila'`
  is redundant (already excluded by `!m.disabled`). *Fix: derive from `domain`/`disabled`.*

### C. Hardcoded user name ("Adam")

- [ ] **Tool descriptions bake in "Adam"** — `src/lib/tools.ts` (~lines 570, 800, 816,
  958, 970) send "Adam" to the model verbatim regardless of `profile.userName`. Tools
  are static module constants, so fixing needs per-request tool-building. Also
  **inconsistent defaults**: `|| 'Adam'` (crons, reseed) vs `|| 'you'` (`claude.ts`).

### D. Dead / duplicate sources of truth

- [ ] **`src/lib/modalities_backup.ts`** — a complete *second* registry with stale data
  (Sage/Vera, `family`/`kids` aliases, old `persona` field). Not imported, but a
  landmine for future searches. (Decided: keep for now — revisit.)
- [ ] **Legacy `renderRoster` / `renderToolkit` / `renderHierarchyRules`** in
  `modalities.ts` — marked "no longer used." Dead, except `renderRoster` is the fix
  for the roster-prose item above.

### E. Minor / confirm-intent

- [ ] **`src/lib/google.ts`** (~line 88) — `n === 'household'` in calendar-name
  normalization. Probably a real calendar named "household," not modality coupling —
  confirm it's intentional.
- [ ] **`src/lib/tool-executor.ts`** (~line 39) — comment listing modality ids is stale
  (missing the new ones). Comment-only.

---

**If only one gets done:** item A1 (derive tools from `capabilities`). It turns the
`capabilities` array from decoration into the real control and removes the most
dangerous hidden switch.
