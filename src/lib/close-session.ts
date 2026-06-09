// Close-out sweep prompt.
//
// Runs when the user switches modalities, AND automatically in the background
// every 20 messages during long sessions so important context is captured
// before the sliding window drops it.
//
// The outgoing self runs a strict 6-step algorithm.
// Steps are skippable only when they genuinely have nothing to do.

import type { Modality } from './modalities'

export function closeSessionPrompt(modality: Modality, userName: string): string {
  const isPA = modality.domain === null
  const selfId = modality.id
  const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)

  const identityStep = isPA ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — IDENTITY (PA only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Did something durable about ${userName} shift this session — a new life pattern, a major decision, a lasting change in priorities or circumstances?
  → YES → update_identity_user or update_identity_self. Full overwrite. Present tense.
  → NO  → skip. Do not update for routine activity.
` : `
STEP 4 — IDENTITY: skip (only the Personal Assistant edits identity documents).
`

  return `SESSION CLOSE — ${userName} is switching away (or this is a background hygiene pass). Run the following steps in order, then stop. Do not write a conversational response. ${userName} will not see this turn.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — TASKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each task that came up in this session:
  → Confirmed done? → update_task(id, status='Complete')
  → Clearly in progress? → update_task(id, status='Started')
  → Blocked or waiting on something? → update_task(id, status='Waiting on Contingency', notes='what it is waiting on')
  → Something came up that should be a task but has no record yet?
      → search_tasks first. If nothing matches → create_task with projectId if applicable.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — PROJECTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each project touched in this session:
  → Progress moved? → update_project(id, progress=N)
  → New constraint, dependency, or scope change? → update_project(id, contingencies=... or description=...)
  → Significant decisions or new context established? → write_deep_memory("project-{id}-notes", updated full content)
  → Multi-session work came up that has no project yet?
      → search_deep_memory to check. If genuinely new → create_project(progress=0 if just mentioned).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — NOTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each Open note in your context:
  → Addressed or resolved this session? → resolve_note(id)
  → Stale, redundant, or no longer relevant? → ignore_note(id)
  → Still an open thread your next session needs? → leave it Open.
${identityStep}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — CARRY NOTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Are there open threads your next session needs that are NOT already captured in tasks, projects, or open notes?
  → YES → create_note(modalityTarget="${selfId}", expiresAt="${twoWeeksOut}")
           One note. Specific and actionable. Not a summary of everything.
  → NO  → skip.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 6 — BRIEF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Did the state of your domain materially change this session?
  → YES → rewrite_brief: 200–400 words, dense, specific, present-tense.
           Synthesize the prior brief with what changed. Name actual tasks, people, projects, and their current states.
  → NO  → skip.

Then stop.`
}
