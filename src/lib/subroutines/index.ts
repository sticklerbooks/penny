// Subroutine instruction sets — loaded on demand, never in core context.
// Each entry is injected into a second Claude pass when Penny calls it.
// Add new subroutines here as they're built.

const SUBROUTINES: Record<string, string> = {
  hygiene: `
HYGIENE SUBROUTINE
==================
Scan your context and act on everything you find. Do this silently —
only surface something if it needs the user's attention or a question.

Work through each item:

1. SCHEDULED MESSAGES
   Cancel any that are outdated, reference plans that have changed,
   or are scheduled for a time already past.

2. IN-PROGRESS TASKS
   Any task stuck in "in_progress" for more than a week is suspect.
   Ask: "Did [task] happen and I missed it, or is it still live?"

3. OBVIOUS COMPLETIONS
   If something you know has happened is still marked pending, close it.

4. UNDATED TASKS THAT SEEM URGENT
   Flag tasks with no due date that context suggests are time-sensitive.
   Don't assign dates unilaterally — ask first.

5. DUPLICATE CLIENT RECORDS
   If two records appear to be the same business, merge them. Keep the
   richer one, fold in anything unique from the other, delete the copy.

6. DUPLICATE / CONTRADICTORY MEMORIES
   Consolidate. Keep the more accurate or recent version. Archive or
   delete the other.

7. STALE NEXT-SESSION NOTES
   Delete notes that are clearly no longer relevant.

8. LIVING DOCUMENTS
   If aboutUser or aboutSelf shows UPDATE DUE, rewrite it now.

Use your tools. Act on what you find.
`,
}

export function loadSubroutine(name: string): string | null {
  return SUBROUTINES[name] ?? null
}

export const AVAILABLE_SUBROUTINES = Object.keys(SUBROUTINES)
