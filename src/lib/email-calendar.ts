// Orchestrates email/calendar fetching, Haiku summarization, and caching.
// Also handles on-demand search execution for the two-pass chat flow.

import { getAnthropic } from './claude'
import { getGoogleSnapshot, searchGmail, searchGoogleCalendar, readGmailMessage, getGoogleCalendarAgenda, searchDrive, readDriveFile } from './google'
import { getMicrosoftSnapshot, searchOutlook, searchOutlookCalendar } from './microsoft'
import { prisma } from './db'

const HAIKU_MODEL = 'claude-3-5-haiku-20241022'
const CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

// ─── Session-start snapshot ──────────────────────────────────────────────────
// Called once per session (cached for 30 min). Returns a Haiku-distilled
// summary of recent emails and upcoming calendar events. Returns null if
// no email/calendar credentials are configured.

export async function getEmailCalendarSummary(profileId: string): Promise<string | null> {
  // Return cached summary if fresh enough
  const profile = await prisma.profile.findUnique({ where: { id: profileId } })
  if (profile?.emailCalendarSummary && profile?.emailCalendarCachedAt) {
    const age = Date.now() - new Date(profile.emailCalendarCachedAt).getTime()
    if (age < CACHE_TTL_MS) return profile.emailCalendarSummary
  }

  // Fetch fresh data from Google + Microsoft in parallel
  const [google, microsoft] = await Promise.all([
    getGoogleSnapshot().catch(() => null),
    getMicrosoftSnapshot().catch(() => null),
  ])

  if (!google && !microsoft) return null

  // Build the raw data block for Haiku
  const sections: string[] = []
  if (google) {
    sections.push(`=== GMAIL (recent) ===\n${google.emails}`)
    sections.push(`=== GOOGLE CALENDAR (next 7 days) ===\n${google.calendar}`)
  }
  if (microsoft) {
    sections.push(`=== OUTLOOK (recent) ===\n${microsoft.emails}`)
    sections.push(`=== OUTLOOK CALENDAR (next 7 days) ===\n${microsoft.calendar}`)
  }
  const rawData = sections.join('\n\n')

  // Summarize via Haiku — cheap, fast, keeps context tight
  try {
    const res = await getAnthropic().messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are summarizing someone's recent emails and upcoming calendar for their AI assistant.

Be specific: use names, dates, subjects, amounts. Flag anything urgent or time-sensitive.
Skip obvious spam, automated notifications, and routine system emails.
Write in second person ("You have a meeting...", "Josh emailed about...").
Keep it under 300 words. Organize as: emails first, then calendar.

${rawData}`,
      }],
    })

    const summary = (res.content[0] as { type: string; text: string }).text

    // Cache the summary on the profile
    await prisma.profile.update({
      where: { id: profileId },
      data: {
        emailCalendarSummary: summary,
        emailCalendarCachedAt: new Date(),
      },
    })

    return summary
  } catch (e) {
    console.error('Haiku summarization error:', e)
    return null
  }
}

// ─── On-demand search ────────────────────────────────────────────────────────
// Called in the two-pass chat flow when Penny embeds <search_email> or
// <search_calendar> markers. Results are fed back to Penny for a second pass.

export type SearchAction =
  | { kind: 'search_email'; query: string; label?: string }
  | { kind: 'search_calendar'; query: string; label?: string }
  | { kind: 'read_email'; id: string; label?: string }
  | { kind: 'calendar_agenda'; date: string; days?: number; label?: string }
  | { kind: 'search_drive'; query: string; label?: string }
  | { kind: 'read_drive_file'; id: string; label?: string }

export async function executeSearches(searches: SearchAction[]): Promise<string> {
  const results = await Promise.all(
    searches.map(async (s) => {
      const label = s.label ? ` (${s.label})` : ''

      if (s.kind === 'search_email') {
        const [gmail, outlook] = await Promise.all([
          searchGmail(s.query).catch(() => '(Gmail search failed)'),
          searchOutlook(s.query).catch(() => '(Outlook search failed)'),
        ])
        const combined = [
          gmail !== '(Gmail not configured)' ? `Gmail results:\n${gmail}` : null,
          outlook !== '(Outlook not configured)' ? `Outlook results:\n${outlook}` : null,
        ].filter(Boolean).join('\n\n')
        return `EMAIL SEARCH${label}: "${s.query}"\n${combined || '(no email sources configured)'}`
      }

      if (s.kind === 'search_calendar') {
        const [gcal, outlook] = await Promise.all([
          searchGoogleCalendar(s.query).catch(() => '(Google Calendar search failed)'),
          searchOutlookCalendar(s.query).catch(() => '(Outlook Calendar search failed)'),
        ])
        const combined = [
          gcal !== '(Google Calendar not configured)' ? `Google Calendar:\n${gcal}` : null,
          outlook !== '(Outlook Calendar not configured)' ? `Outlook Calendar:\n${outlook}` : null,
        ].filter(Boolean).join('\n\n')
        return `CALENDAR SEARCH${label}: "${s.query}"\n${combined || '(no calendar sources configured)'}`
      }

      if (s.kind === 'read_email') {
        const body = await readGmailMessage(s.id).catch(() => '(failed to read email)')
        return `EMAIL${label} [id=${s.id}]:\n${body}`
      }

      if (s.kind === 'calendar_agenda') {
        const agenda = await getGoogleCalendarAgenda(s.date, s.days ?? 1).catch(() => '(calendar agenda lookup failed)')
        return `CALENDAR AGENDA${label} for ${s.date}${s.days && s.days > 1 ? ` (+${s.days - 1}d)` : ''}:\n${agenda}`
      }

      if (s.kind === 'search_drive') {
        const files = await searchDrive(s.query).catch(() => '(Drive search failed)')
        return `DRIVE SEARCH${label}: "${s.query}"\n${files}`
      }

      if (s.kind === 'read_drive_file') {
        const content = await readDriveFile(s.id).catch(() => '(failed to read Drive file)')
        return `DRIVE FILE${label} [id=${s.id}]:\n${content}`
      }
    })
  )

  return results.filter(Boolean).join('\n\n---\n\n')
}
