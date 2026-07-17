# Technical debt

- Design and implement separate domain orientations for every submodality. They
  should inherit Penny's global portrait and working agreement, then build their
  own domain-specific coverage without repeating the master intake.
- After the first real intake, review the preserved
  `intake-modality-recommendations` decision matrix with the user and hard-code
  the accepted roster. Dynamic runtime modality creation remains deliberately
  deferred.
- Generate the team roster in `pa.md`, `modality.md`, and `eve.md` from
  `MODALITIES` so the three prompt templates cannot drift.
- Give prompt-template selection an explicit registry field if another
  independent modality is added; today Eve is the only special template.
- Replace scattered `'pa'` defaults with `DEFAULT_MODALITY` where the value means
  "the anchor" rather than an intentional database value.
- Build model-facing tool descriptions per request where they need the user's
  actual name; several static descriptions still say "Adam".
- Replace broad Prisma `any` casts with typed access now that the schema cutover
  is complete.
- Add route/integration tests around chat tool execution, dashboard writes, and
  calendar scheduling. The pure Item/Review tests do not cover those boundaries.
- Confirm whether Google calendar-name normalization for `household` is an
  intentional real calendar alias.
