// Close-out sweep prompt.
//
// Runs automatically when the user switches modalities, and again every ~20
// messages during long sessions, so anything that matters is captured before the
// sliding context window drops it. The outgoing self runs this 4-step pass with
// her own toolset, then stops. No conversational response — the user won't see it.

import type { Modality } from './modalities'

export function closeSessionPrompt(modality: Modality, userName: string): string {
  void modality
  return `SESSION CLOSE — wrap up before you step away. This is a private hygiene pass; ${userName} will not see this turn, so do NOT write a conversational reply. Work only within your own domain and records. Run these four steps in order, then stop.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — CAPTURE WHAT WAS SAID
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Is there anything you and ${userName} talked about this session that did NOT get recorded as a Project, Task, Pending Calendar Event, or Note? If so, now is the time — load the appropriate protocol and use the appropriate tools, or it will be lost. (Search first so you update an existing record instead of duplicating it.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — REMEMBER WHAT YOU LEARNED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Is there anything you learned about yourself, or about ${userName}, in this conversation that is new or striking and deserves to be remembered? If so, now is the time — load the Memory protocol and use the appropriate tools (this is also where you update your own identity, if something durable shifted), or it will be forgotten.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — CLEAN UP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Review all your open Tasks, Notes, and Pending Calendar Events.
  → Any redundant (a duplicate of another record)? → remove it.
  → Any stale (no longer relevant or outdated, but still sitting open)? → remove it.
Removing means: delete_task for a task, ignore_note for a note, delete_pending_event for a pending event. (For a task that's simply finished rather than redundant, update_task(status='Complete') instead of deleting.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — YOUR BRIEF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Read your Brief, then decide: does anything need to be added for you to remember it next session? If so, rewrite_brief now — overwrite the WHOLE Brief, weaving the new detail into the existing content so nothing already there is lost (200–400 words, dense and specific: name actual tasks, people, and projects). If no changes are needed, leave it exactly as it is.

Then stop.`
}
