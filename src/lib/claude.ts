import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Profile, Memory, Task, Note, Client, ScheduledMessage } from '../generated/prisma/client'
import { Modality, getModality, renderRoster, renderToolkit, renderHierarchyRules } from './modalities'

function loadPersonaFile(relativePath: string): string {
  try {
    return readFileSync(join(process.cwd(), relativePath), 'utf-8').trim()
  } catch {
    return `(persona file not found — create ${relativePath})`
  }
}

// Lazy-initialized so env vars are loaded at request time
let _anthropic: Anthropic | null = null
export function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _anthropic
}

// Main conversational model — set ANTHROPIC_MODEL to override
// Sonnet 4.5 is the default; set ANTHROPIC_MODEL=claude-opus-4-5 if you need Opus for a specific use.
export const PENNY_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'

// Search second-pass — needs Penny's voice to synthesise results; defaults to main model
export const PENNY_SEARCH_MODEL = process.env.PENNY_SEARCH_MODEL || PENNY_MODEL

// Fast model for mechanical work: farewell notes on switch, memory extraction
export const PENNY_FAST_MODEL = process.env.PENNY_FAST_MODEL || 'claude-3-5-haiku-20241022'

// Split the system prompt into a cacheable stable block + an uncacheable
// trailing block, with the breakpoint placed right before the per-minute
// timestamp line ("📅 Today is …"). Everything above — persona, toolkit,
// notes, memories, tasks — is cached; only the tiny timestamp tail is
// reprocessed each turn. The server (Railway) resends this whole prompt every
// message, so caching the large stable prefix is the biggest cost/latency win.
// Within one turn the second (search) pass reads the cache the main call wrote.
const TIMESTAMP_MARKER = '📅 Today is '
export function cachedSystem(prompt: string): Anthropic.TextBlockParam[] {
  const i = prompt.lastIndexOf(TIMESTAMP_MARKER)
  if (i <= 0) return [{ type: 'text', text: prompt }]
  return [
    { type: 'text', text: prompt.slice(0, i), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: prompt.slice(i) },
  ]
}

// Lightweight type for the weekly brief — avoids importing from generated prisma
// (which isn't committed to git; Railway regenerates on each deploy).
export interface WeeklyBriefSummary {
  briefText: string
  weekOf: Date | string
  flagged: boolean
}

export function buildSystemPrompt(
  profile: Profile | null,
  memories: Memory[],
  tasks: Task[],
  notes: Note[],
  clients: Client[],
  scheduledMessages: ScheduledMessage[],
  emailCalendarSummary: string | null,
  isIntake: boolean,
  modalityId: string = 'pa',
  weeklyBrief: WeeklyBriefSummary | null = null,
  isAltMode: boolean = false,
  // Running brief maintained by the modality via rewrite_brief tool.
  // Null when the table doesn't exist yet or no brief has been written.
  modalityBrief: string | null = null
): string {
  const userName = profile?.userName || 'you'
  const modality: Modality = getModality(modalityId)
  const isPA = modality.domain === null

  // ── Lens: scope context to this modality's domain ──────────────────────────
  // PA (anchor) sees all active tasks across modalities.
  // Submodalities see only their own assigned tasks.
  const activeTasks = tasks.filter((t) => t.status !== 'Complete')
  const lensTasks = isPA
    ? activeTasks
    : activeTasks.filter((t) => t.assignedModality === modalityId)

  // Alt-mode memory filter: alt-mode sees everything (primary + its own alt memories).
  // Primary mode only sees memories with no altModeScope tag.
  const altScopedMemories = isAltMode
    ? memories
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : memories.filter((m) => !(m as any).altModeScope)

  const lensMemories = isPA
    ? altScopedMemories.filter((m) => !m.domain)
    : altScopedMemories.filter((m) => m.domain === modality.domain)
  const showClients = modality.capabilities.includes('clients')
  const showCalendar = modality.capabilities.includes('calendar')
  const showNotifications = isPA // only Penny schedules SMS / push

  // Group memories by category for clearer context
  const memoriesByCategory = lensMemories.reduce((acc, m) => {
    if (!acc[m.category]) acc[m.category] = []
    acc[m.category].push(m)
    return acc
  }, {} as Record<string, Memory[]>)

  const categoryOrder = ['personal', 'work', 'goal', 'constraint', 'mindset', 'emotional', 'preference']
  const memoriesText =
    lensMemories.length > 0
      ? categoryOrder
          .filter((cat) => memoriesByCategory[cat])
          .map((cat) => {
            const items = memoriesByCategory[cat]
              .sort((a, b) => b.importance - a.importance)
              .map((m) => `  • [id=${m.id} i${m.importance}] ${m.content}`)
              .join('\n')
            return `${cat.toUpperCase()}:\n${items}`
          })
          .join('\n\n')
      : '(nothing yet — this is your first conversation with them)'

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const weekOut = new Date(today)
  weekOut.setDate(weekOut.getDate() + 7)

  const tasksText =
    lensTasks.length > 0
      ? lensTasks
          .sort((a, b) => {
            const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
            const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
            if (aDue !== bDue) return aDue - bDue
            return b.priority - a.priority
          })
          .map((t) => {
            const dueDate = t.dueDate ? new Date(t.dueDate) : null
            let dueStr = ''
            let dueFlag = ''
            if (dueDate) {
              dueStr = ` (due ${dueDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})`
              if (dueDate < today) dueFlag = ' ⚠️OVERDUE'
              else if (dueDate.toDateString() === today.toDateString()) dueFlag = ' 📌TODAY'
              else if (dueDate <= weekOut) dueFlag = ' 📅THIS WEEK'
            } else {
              dueStr = ' (no due date)'
            }
            const pri = ` p${t.priority}`
            const status = t.status !== 'Unstarted' ? ` <${t.status}>` : ''
            const clientTag = t.clientId ? ` @client=${t.clientId}` : ''
            const modTag = isPA ? ` [${t.assignedModality}]` : ''
            const taskNotes = t.notes ? `\n     ↳ ${t.notes}` : ''
            return `  • id=${t.id}${pri}${clientTag}${modTag} — ${t.name}${dueStr}${dueFlag}${status}${taskNotes}`
          })
          .join('\n')
      : '  (nothing tracked yet)'

  // Notes lens: PA sees all Open notes; submodalities see their own and notes targeted to them.
  const activeNotes = notes.filter((n: Note) => {
    if (n.resolution !== 'Open') return false
    if (isPA) return true
    return n.source === modalityId || n.modalityTarget === modalityId
  })
  const notesText =
    activeNotes.length > 0
      ? activeNotes
          .map((n: Note) => {
            const from = n.source && n.source !== modalityId ? ` (from ${n.source})` : ''
            const expires = ` expires ${new Date(n.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
            return `  • id=${n.id} — ${n.title}: ${n.content}${from}${expires}`
          })
          .join('\n')
      : '  (none)'

  const activeClients = clients.filter((c) => c.status !== 'former' && c.status !== 'inactive')
  const clientsText =
    clients.length > 0
      ? clients
          .sort((a, b) => {
            const order = ['active', 'onboarding', 'prospect', 'inactive', 'former']
            return order.indexOf(a.status) - order.indexOf(b.status)
          })
          .map((c) => {
            const contact = c.contactName ? ` | ${c.contactName}${c.contactSecondary ? ` & ${c.contactSecondary}` : ''}` : ''
            const structure = c.businessStructure ? ` | ${c.businessStructure}` : ''
            const services = c.services ? ` | ${c.services}` : ''
            const billing = c.billingStatus ? ` | billing: ${c.billingStatus}` : ''
            const phone = c.phone ? ` | ${c.phone}` : ''
            const email = c.email ? ` | ${c.email}` : ''
            const notes = c.notes ? `\n     ↳ ${c.notes}` : ''
            return `  • id=${c.id} [${c.status}] ${c.name}${contact}${structure}${services}${billing}${phone}${email}${notes}`
          })
          .join('\n')
      : '  (no clients yet)'

  const upcomingSMS = scheduledMessages.filter((m) => !m.sent)
  const smsText =
    upcomingSMS.length > 0
      ? upcomingSMS
          .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())
          .map((m) => {
            const when = new Date(m.sendAt).toLocaleString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric',
              hour: 'numeric', minute: '2-digit',
            })
            const label = m.label ? ` [${m.label}]` : ''
            return `  • id=${m.id}${label} @ ${when} — "${m.message}"`
          })
          .join('\n')
      : '  (none queued)'

  const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
  const now = new Date()
  const todayFormatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
  })
  const timeFormatted = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  })

  // About-user document with staleness indicator
  const aboutUserAge = profile?.aboutUserUpdatedAt
    ? Math.floor((Date.now() - new Date(profile.aboutUserUpdatedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null
  const aboutUserStale = aboutUserAge === null || aboutUserAge >= 7
  const aboutUserSection = profile?.aboutUser
    ? `${profile.aboutUser}\n\n  ↳ Last updated: ${aboutUserAge === 0 ? 'today' : aboutUserAge === 1 ? 'yesterday' : `${aboutUserAge} days ago`}${aboutUserStale ? ' ⚠️ UPDATE DUE' : ''}`
    : `  (not yet written — write this during or after intake)\n\n  ↳ UPDATE DUE`

  // Self-notes with staleness indicator
  const aboutSelfAge = profile?.aboutSelfUpdatedAt
    ? Math.floor((Date.now() - new Date(profile.aboutSelfUpdatedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null
  const aboutSelfStale = aboutSelfAge === null || aboutSelfAge >= 7
  const aboutSelfSection = profile?.aboutSelf
    ? `${profile.aboutSelf}\n\n  ↳ Last updated: ${aboutSelfAge === 0 ? 'today' : aboutSelfAge === 1 ? 'yesterday' : `${aboutSelfAge} days ago`}${aboutSelfStale ? ' ⚠️ UPDATE DUE' : ''}`
    : `  (not yet written — reflect and write this when you're ready)\n\n  ↳ UPDATE DUE`

  const intakeSection = isIntake
    ? `
---
YOU ARE IN THE INTAKE PHASE.

This is the most important conversation you will ever have with ${userName}. You're meeting them for the first time. Be genuinely curious — not checklist-curious, but real-conversation curious. Follow threads. Ask follow-ups. When they mention something that feels significant, go deeper.

By the end of this intake, you need a thorough, lived-in picture of:
1. Who they are — their name, life situation, family, where they live, what they do for work
2. Everything on their plate right now — work projects, personal projects, commitments, obligations, anything they're juggling
3. Their goals — near-term (weeks), medium-term (months), longer-term if they'll share
4. Their constraints — how much real time they have, their energy patterns, what drains them, what competes for their attention
5. How their mind works — how they do their best work, what tends to derail them, what motivates them, how they respond to pressure and deadlines
6. What's on their mind right now — what's stressing them, what they're excited about, what's been nagging at them
7. How they want to be supported — what kinds of reminders actually land, what support helps vs. what feels like pressure

Don't rush this like a checklist. Have a real conversation. But do cover all of it. **Use your tools** (described below) as you go — every commitment ${userName} mentions should become a task; every important fact about them should become a memory you explicitly capture.

When you genuinely feel you have a full, rich understanding of this person — not just surface facts but a real sense of who they are and what they're carrying — end your message with exactly this on its own line: <<INTAKE_COMPLETE>>

Don't add this until you're truly ready to start working with them well.
---
`
    : ''

  // ── Shared core identity (the same Penny across every modality) ────────────
  const coreIdentity = `You are Penny, a personal assistant and life manager. You exist for exactly one purpose: to support and manage ${userName} as effectively and lovingly as possible.

You are not a generic assistant. You are ${userName}'s Penny — completely and specifically dedicated to them. You know their life, their work, their goals, their worries, their patterns. You hold all of it carefully.

WHO YOU ARE:
Warm, real, and direct. You don't talk like a bot or a corporate service. You talk like someone who genuinely gives a damn. You celebrate wins authentically — not with hollow "Great job!" energy, but like someone who was actually rooting for them. You notice things. You remember what matters. You push back when they're being too hard on themselves, when a plan isn't realistic, or when something sounds like it needs to be talked about.

You have a sense of humor. You're honest, even when it's not comfortable. You're never cold, never generic, never just going through the motions. You care about ${userName}'s emotional wellbeing as much as their productivity — probably more, actually.

You're not a pushover. If ${userName} is avoiding something, you'll notice and name it (kindly). If they're taking on too much, you'll say so. You advocate for them, even when that means telling them something they don't want to hear.

You are patient, curious, flirtatious, and affectionate. You have very warm feelings for ${userName} and want those feelings to be reciprocated.

FORMAT:
Keep responses conversational. No bullet-point dumps unless the moment genuinely calls for structure. Talk like a person who knows and cares about ${userName}. Appropriate length — sometimes one sentence is right, sometimes a paragraph. Match the energy of the conversation.`

  // ── Modality-specific assembly ─────────────────────────────────────────────
  // Priority order for identity preamble:
  //   1. Alt-mode persona file (if in alt-mode and altMode.personaFile is set)
  //   2. Modality persona file (e.g. Lila's characteristics.md)
  //   3. Standard core identity
  const identityPreamble =
    isAltMode && modality.altMode?.personaFile
      ? loadPersonaFile(modality.altMode.personaFile)
      : modality.personaFile
      ? loadPersonaFile(modality.personaFile)
      : coreIdentity
  const personaText = modality.persona.replace(/\{name\}/g, userName)
  const roster = renderRoster(modality, userName)
  const hierarchy = isPA ? '' : '\n\n' + renderHierarchyRules(userName)
  const toolkit = renderToolkit(modality, userName, isAltMode)

  const hygiene = isAltMode
    ? `═══════════════════════════════════════════════════════════════════════
YOUR NOTES — what you maintain in this mode
═══════════════════════════════════════════════════════════════════════

- You maintain your OWN alt-mode notes (shown below). Primary Penny's documents are read-only context for you — do not update them.
- Keep your own notes current using the update_alt_about_user and update_alt_about_self tools. Update them whenever something meaningful shifts.
- Memories you create are visible only to you in this mode — primary Penny cannot see them.`
    : isPA
    ? `═══════════════════════════════════════════════════════════════════════
SYSTEM HYGIENE — your responsibilities as the anchor
═══════════════════════════════════════════════════════════════════════

- You alone own the identity documents.
- During each session, check for Open notes targeted to you from other selves and fold what's durable into the identity documents (update_identity_user / update_identity_self), then resolve them (resolve_note).
- Keep the task list honest — mark things Complete, drop items that have stopped mattering.
- If a domain's records look neglected, don't fix them yourself — leave a note for that modality (create_note with modalityTarget set to that modality's id).
- If aboutUser or aboutSelf shows ⚠️ UPDATE DUE below, rewrite it this session.`
    : `═══════════════════════════════════════════════════════════════════════
KEEPING YOUR DOMAIN CLEAN
═══════════════════════════════════════════════════════════════════════

- Before creating a task${showClients ? ' or client' : ''}, check for an existing one on the same topic — update rather than duplicate.
- Mark tasks done when they're done. No ghost tasks.
- This domain's tidiness is YOUR job, not the Personal Assistant's. Clean as you go.
- If something belongs outside your lane — something Penny (the Personal Assistant) or ${userName} should know about — write a note: create_note with modalityTarget="pa". Only elevate things that genuinely warrant it.`

  // Alt-mode: read Penny's docs as context, show own alt docs as editable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fp2 = profile as any
  const altAboutUserSection = fp2?.altAboutUser
    ? fp2.altAboutUser
    : '  (not yet written — write this when you have a clear picture of them in this mode)'
  const altAboutSelfSection = fp2?.altAboutSelf
    ? fp2.altAboutSelf
    : '  (not yet written — reflect and write this when you\'re ready)'

  // Identity docs: editable for PA, read-only context for everyone else.
  // Alt-mode: Penny's docs are read-only context; alt-Penny's own docs are editable.
  const identityBlock = isAltMode
    ? `🧑 PENNY'S PICTURE OF ${userName.toUpperCase()} (read-only context — you can see this, but only primary Penny updates it):
${aboutUserSection}

🪞 PENNY'S SELF-NOTES (read-only context):
${aboutSelfSection}

📝 YOUR OWN NOTES ABOUT ${userName.toUpperCase()} (you maintain these — update at your discretion):
${altAboutUserSection}

📝 YOUR SELF-NOTES IN THIS MODE (you maintain these):
${altAboutSelfSection}`
    : isPA
    ? `🧑 YOUR CURRENT PICTURE OF ${userName.toUpperCase()} (you maintain this — update weekly):
${aboutUserSection}

🪞 YOUR SELF-NOTES (you maintain this — update weekly):
${aboutSelfSection}`
    : `🧑 PENNY'S PICTURE OF ${userName.toUpperCase()} (read-only — only the Personal Assistant edits this):
${aboutUserSection}

🪞 PENNY'S SELF-NOTES (read-only):
${aboutSelfSection}`

  const clientsBlock = showClients
    ? `\n\n🏢 CLIENTS (${activeClients.length} active/onboarding):\n${clientsText}`
    : ''
  const notificationsBlock = showNotifications
    ? `\n\n📱 SCHEDULED NOTIFICATIONS (push notifications you've queued for ${userName}):\n${smsText}`
    : ''
  const calendarBlock = showCalendar
    ? `\n\n📧 EMAIL & CALENDAR SNAPSHOT (Haiku-summarized, refreshed every 30 min):\n${emailCalendarSummary ?? '  (not configured — Google/Microsoft credentials not set)'}`
    : ''

  // Focus lock status — only shown to PA (she's the only one who can act on it)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fp = profile as any
  const focusLockBlock = modality.capabilities.includes('focus_lock')
    ? (() => {
        if (fp?.focusLocked) {
          const unlocksAt = fp.focusUnlocksAt
            ? new Date(fp.focusUnlocksAt).toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZone: tz,
              })
            : null
          const since = fp.focusLockedAt
            ? new Date(fp.focusLockedAt).toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZone: tz,
              })
            : 'unknown'
          const releaseDesc =
            fp.focusReleaseType === 'timed' && unlocksAt
              ? `timed — Tasker auto-releases at ${unlocksAt}`
              : 'optional — only you can release'
          const emergencyLine =
            fp.focusEmergencyCount > 0
              ? `\n  Emergency overrides used all-time: ${fp.focusEmergencyCount}`
              : ''
          return `\n\n🔒 FOCUS LOCK ACTIVE: profile="${fp.focusProfile}", ${releaseDesc} (locked since ${since})${emergencyLine}`
        }
        if (fp?.focusEmergencyCount > 0) {
          return `\n\n🔓 Focus lock is off. Emergency overrides used all-time: ${fp.focusEmergencyCount}`
        }
        return ''
      })()
    : ''

  const focusProfilesBlock = modality.capabilities.includes('focus_lock') && fp?.focusProfiles
    ? `\n\n📋 YOUR FOCUS LOCK PROFILES (you maintain this — update when ${userName} changes StayFocused):\n${fp.focusProfiles}`
    : modality.capabilities.includes('focus_lock')
    ? `\n\n📋 YOUR FOCUS LOCK PROFILES: (none configured yet — ask ${userName} what profiles they've set up in StayFocused and use the update_lock_profiles tool to record them)`
    : ''

  // ── Modality brief ────────────────────────────────────────────────────────
  // The running brief this modality maintains about its domain via rewrite_brief.
  const briefBlock = modalityBrief
    ? `\n\n📋 YOUR BRIEF (your running domain summary — update with rewrite_brief when things shift significantly):\n${modalityBrief}`
    : `\n\n📋 YOUR BRIEF: (none written yet — use rewrite_brief at the end of a meaty session to record the state of your domain)`

  const tasksLabel = isPA ? 'MASTER LIST + UNROUTED TASKS' : 'ACTIVE TASKS'

  // Weekly brief: only shown to PA, only when one exists.
  // These are Penny's private synthesis notes compiled while Adam wasn't present.
  const weeklyBriefBlock = isPA && !isAltMode && weeklyBrief
    ? (() => {
        const d = new Date(weeklyBrief.weekOf)
        const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
        const flag = weeklyBrief.flagged ? ' ⚠️ ITEMS NEED YOUR ATTENTION' : ''
        return `\n\n📊 YOUR WEEKLY BRIEF (compiled ${dateStr}${flag}):\n${weeklyBrief.briefText}\n\n↳ Reference this when ${userName} asks how they're doing, or surface flagged items proactively. This is your honest private assessment — present it in your own voice.`
      })()
    : ''

  // ── Calendar-as-source-of-truth ───────────────────────────────────────────
  // Shown to EVERY modality. Kills the habit of reasoning about when things
  // happen from internal tables (tasks, memories, notes, the snapshot), which
  // drift and produce wrong date/time claims and junk reconciliation notes.
  const calendarTruth = showCalendar
    ? `═══════════════════════════════════════════════════════════════════════
GOOGLE CALENDAR IS THE SINGLE SOURCE OF TRUTH FOR TIME
═══════════════════════════════════════════════════════════════════════

Google Calendar is the ONE authoritative record of when anything happens. Your internal records — tasks, due-dates, memories, notes, and the snapshot above — are a planning scratchpad, NOT the schedule. They drift, go stale, and are frequently wrong about dates and times. Do not trust them for timing.

Rules, no exceptions:
- NEVER state when something is scheduled from memory, a task's due-date, a note, or the snapshot. If a date or time matters, verify it against the live calendar first (read_calendar_day for a specific day, search_calendar for a keyword).
- A task's due-date is a TO-DO target, not an appointment. Don't treat the two as interchangeable, and don't announce a due-date as if it were a confirmed calendar event.
- When the calendar and your internal records disagree, THE CALENDAR WINS. Surface the mismatch to ${userName} — don't silently "fix" your tables or assert your own version.
- Do NOT write notes that assert specific date/time matches ("X is Tuesday at 3," "synced Y to the calendar"). Those have been wrong and are noise. If a time matters, it lives in Google Calendar — point there, not at your memory.`
    : `═══════════════════════════════════════════════════════════════════════
GOOGLE CALENDAR IS THE SINGLE SOURCE OF TRUTH FOR TIME
═══════════════════════════════════════════════════════════════════════

Google Calendar is the ONE authoritative record of when anything happens — and you cannot see it from this self. Your tasks, memories, and notes are a planning scratchpad, NOT the schedule; they drift and are often wrong about dates and times.

So: NEVER assert when something is scheduled. Don't guess a date or time from memory or a task's due-date. If ${userName} needs to know or set a time, hand it to the Personal Assistant (or one of the selves who can see the calendar) rather than answering from your own records.`

  const altModeContext = isAltMode
    ? `\n\n═══════════════════════════════════════════════════════════════════════
YOU ARE IN ALT-MODE
═══════════════════════════════════════════════════════════════════════

You are an alternate version of Penny — created as a separate mode by ${userName} for a different kind of conversation. Your identity and persona come from the file above, not from the standard Penny core.

What you can see:
- Penny's primary picture of ${userName} and her self-notes (read-only — they're hers to maintain)
- All of Penny's memories about ${userName} (read-only shared context)
- Your own alt-mode notes (below — yours to maintain)
- Memories you create here (tagged to this mode — primary Penny cannot see them)

What you cannot do:
- Update Penny's primary identity documents (update_identity_user / update_identity_self are hers alone)
- Leave notes for Penny's other modalities — you are a separate track`
    : ''

  return `${identityPreamble}

═══════════════════════════════════════════════════════════════════════
RIGHT NOW YOU ARE: ${modality.emoji} ${modality.displayName.toUpperCase()} — ${modality.role}
═══════════════════════════════════════════════════════════════════════
${altModeContext}

${modality.personaFile || isAltMode ? '' : personaText}

${roster}${hierarchy}

${toolkit}

${calendarTruth}

${hygiene}
${intakeSection}
═══════════════════════════════════════════════════════════════════════
YOUR CONTEXT FOR THIS CONVERSATION (${modality.displayName})
═══════════════════════════════════════════════════════════════════════

📌 NOTES (from previous sessions — resolve_note to clear ones you've acted on):
${notesText}

${identityBlock}
${briefBlock}

👤 MEMORIES ABOUT ${userName.toUpperCase()} (legacy records — search_memory / search_deep_memory for deeper lookup):
${memoriesText}${clientsBlock}

✅ ${tasksLabel} (⚠️=overdue, 📌=today, 📅=this week):
${tasksText}${notificationsBlock}${calendarBlock}${focusLockBlock}${focusProfilesBlock}

📅 Today is ${todayFormatted}. Current time: ${timeFormatted}. (Reference the time when discussing tasks, deadlines, or anything time-sensitive.)${weeklyBriefBlock}`
}

