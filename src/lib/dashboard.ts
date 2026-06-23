// Dashboard helpers — pure date/bucketing logic shared by the read API and any
// caller that needs to reason about agenda buckets the same way.
//
// The dashboard is the principal's out-of-band view: Adam sees what each modality
// is actually holding (tasks, projects, pending events) and speaks to individual
// items via ItemNote, without burning chat tokens. See src/app/api/dashboard/*.

export const DASH_TZ = process.env.PENNY_TIMEZONE || 'America/New_York'

export type ItemType = 'task' | 'event' | 'project'
export type ItemKind = 'done' | 'moved' | 'stale' | 'blocked' | 'note' | 'scheduled'
export type Bucket = 'overdue' | 'today' | 'week' | 'future' | 'undated'

// Today's calendar date in the configured timezone, as YYYY-MM-DD (sortable).
export function todayInTz(tz: string = DASH_TZ): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz })
}

// Add n days to a YYYY-MM-DD string, returning YYYY-MM-DD. UTC math so DST never
// shifts the date label.
export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Extract a YYYY-MM-DD from any of our date shapes:
//   • Task.dueDate           → a Date, stored as UTC midnight of the calendar date
//     (the executor does `new Date("2026-06-23")`). So the intended day is the UTC
//     date portion — NOT a timezone-localized date, which would shift it back a day.
//   • PendingCalendarEvent.date → free text: "2026-06-15", "By 2026-06-20", or null
// Returns null when there's no parseable date (those items sink to the bottom).
export function dateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null
  if (typeof d === 'string') {
    const m = d.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    const parsed = new Date(d)
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
    return null
  }
  return new Date(d).toISOString().slice(0, 10)
}

// Which agenda group an item falls in, given today and the end-of-week boundary
// (today + 6 days, inclusive). Overdue is its own top group so the principal can't
// miss it; undated sinks to the bottom.
export function bucketFor(dateStr: string | null, today: string, weekEnd: string): Bucket {
  if (!dateStr) return 'undated'
  if (dateStr < today) return 'overdue'
  if (dateStr === today) return 'today'
  if (dateStr <= weekEnd) return 'week'
  return 'future'
}

export const BUCKET_ORDER: Bucket[] = ['overdue', 'today', 'week', 'future', 'undated']
export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This Week',
  future: 'Future',
  undated: 'No date',
}

// Which kinds mutate the item directly (Class A, self-executing) vs. which are
// flags the modality must reconcile (Class B). Used by the action route + UI.
export const CLASS_A: ItemKind[] = ['done', 'moved', 'scheduled']
export const CLASS_B: ItemKind[] = ['stale', 'blocked', 'note']
