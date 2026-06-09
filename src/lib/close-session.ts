// Close-out sweep prompt.
//
// Runs when the user switches away from a modality (and, via the nightly cron,
// when a modality has been active). The outgoing self gets its full toolset and
// is asked to tidy its domain, leave itself a carry-note, and refresh its brief
// (and, for the PA, the identity documents) if the session warrants it.

import type { Modality } from './modalities'

export function closeSessionPrompt(modality: Modality, userName: string): string {
  const isPA = modality.domain === null
  const selfId = modality.id
  const domain = modality.domain ?? 'pa'
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const identityStep = isPA
    ? `\n━━━ IDENTITY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You alone own the identity documents. If something durable about ${userName} shifted this session, fold it in with update_identity_user / update_identity_self. Only for genuinely durable changes — not routine activity. Then resolve the notes you acted on (resolve_note) and ignore the stale ones (ignore_note).\n`
    : ''

  return `SESSION CLOSE — ${userName} is switching away from you. Do your end-of-session sweep, then stop. No conversation, no goodbye message — ${userName} won't see this turn.

Work only within your domain (${domain}) and your own records. Be a clean, decisive professional.

━━━ 1. TIDY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Mark tasks Complete that you can confirm are done; set Started on anything clearly in progress; add notes to anything stalled or being avoided.
- Resolve notes you handled (resolve_note); ignore ones that are stale or redundant (ignore_note).
${identityStep}
━━━ 2. CARRY NOTE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If there are open threads your next session should pick up, leave yourself one note: create_note with modalityTarget="${selfId}", expiresAt="${twoWeeksOut}". If something genuinely belongs with Penny, use modalityTarget="pa" — only if it truly warrants it. If everything's closed, skip this.

━━━ 3. BRIEF ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
If this session meaningfully changed the state of your domain, refresh your running brief with rewrite_brief — 200–400 words, dense and specific (name actual tasks and people), synthesizing the prior brief with what's new. If nothing substantive changed, leave it.

Use your tools, then stop.`
}
