import Anthropic from '@anthropic-ai/sdk'
import type { Profile, Memory, Task, NextSessionNote, Client, ScheduledMessage } from '../generated/prisma/client'
import { Modality, getModality, renderRoster, renderToolkit, renderHierarchyRules } from './modalities'

// Lazy-initialized so env vars are loaded at request time
let _anthropic: Anthropic | null = null
export function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _anthropic
}

// Main conversational model — set ANTHROPIC_MODEL to override
export const PENNY_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5'

// Search second-pass — needs Penny's voice to synthesise results; defaults to main model
export const PENNY_SEARCH_MODEL = process.env.PENNY_SEARCH_MODEL || PENNY_MODEL

// Fast model for mechanical work: subroutines, memory extraction
export const PENNY_FAST_MODEL = process.env.PENNY_FAST_MODEL || 'claude-3-5-haiku-20241022'

export function buildSystemPrompt(
  profile: Profile | null,
  memories: Memory[],
  tasks: Task[],
  nextSessionNotes: NextSessionNote[],
  clients: Client[],
  scheduledMessages: ScheduledMessage[],
  emailCalendarSummary: string | null,
  isIntake: boolean,
  modalityId: string = 'pa'
): string {
  const userName = profile?.userName || 'you'
  const modality: Modality = getModality(modalityId)
  const isPA = modality.domain === null

  // ── Lens: scope context to this modality's domain ──────────────────────────
  // PA (anchor) sees the master list + anything not yet routed to a domain.
  // Submodalities see only their own domain. Legacy/untagged items land at PA.
  const lensTasks = isPA
    ? tasks.filter((t) => t.onMasterList || !t.domain)
    : tasks.filter((t) => t.domain === modality.domain)
  const lensMemories = isPA
    ? memories.filter((m) => !m.domain)
    : memories.filter((m) => m.domain === modality.domain)
  const showClients = modality.capabilities.includes('clients')
  const showCalendar = modality.capabilities.includes('calendar')
  const showNotifications = modality.capabilities.includes('notifications')

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

  const pendingTasks = lensTasks.filter((t) => t.status !== 'done')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const weekOut = new Date(today)
  weekOut.setDate(weekOut.getDate() + 7)

  const tasksText =
    pendingTasks.length > 0
      ? pendingTasks
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
            const cat = t.category ? ` [${t.category}]` : ''
            const pri = ` p${t.priority}`
            const status = t.status !== 'pending' ? ` <${t.status}>` : ''
            const clientTag = t.clientId ? ` @client=${t.clientId}` : ''
            const master = t.onMasterList ? ' ⭐' : ''
            const notes = t.pennyNotes ? `\n     ↳ note: ${t.pennyNotes}` : ''
            return `  • id=${t.id}${pri}${cat}${clientTag}${master} — ${t.title}${dueStr}${dueFlag}${status}${notes}`
          })
          .join('\n')
      : '  (nothing tracked yet)'

  // Notes lens: PA sees everything (including notes passed up to her).
  // Submodalities see their own notes, notes addressed to them, and legacy
  // untagged notes.
  const activeNotes = nextSessionNotes.filter((n) => {
    if (n.resolved) return false
    if (isPA) return true
    return n.source === modality.id || n.target === modality.id || (!n.source && !n.target)
  })
  const notesText =
    activeNotes.length > 0
      ? activeNotes
          .map((n) => {
            const from = n.source && n.source !== modality.id ? ` (from ${n.source})` : ''
            const to = n.target === 'pa' && isPA ? ' ⬆ passed up to you' : ''
            return `  • id=${n.id} — ${n.content}${from}${to} (left ${new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
          })
          .join('\n')
      : '  (none — you left no notes for this session)'

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

  const todayFormatted = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
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
  const personaText = modality.persona.replace(/\{name\}/g, userName)
  const roster = renderRoster(modality, userName)
  const hierarchy = isPA ? '' : '\n\n' + renderHierarchyRules(userName)
  const toolkit = renderToolkit(modality, userName)

  const hygiene = isPA
    ? `═══════════════════════════════════════════════════════════════════════
SYSTEM HYGIENE — your responsibilities as the anchor
═══════════════════════════════════════════════════════════════════════

- You alone own the identity documents and session Complete.
- During Complete, read the notes your modalities passed up (marked ⬆) and fold what's worthy into the identity documents.
- Keep the master list honest — drop items that have stopped mattering.
- If a domain's records look neglected, don't fix them yourself — leave a note for that modality.
- If aboutUser or aboutSelf shows ⚠️ UPDATE DUE below, rewrite it this session.`
    : `═══════════════════════════════════════════════════════════════════════
KEEPING YOUR DOMAIN CLEAN
═══════════════════════════════════════════════════════════════════════

- Before creating a memory, task${showClients ? ', or client' : ''}, check for an existing one on the same topic — update rather than duplicate.
- Mark things done when they're done. No ghost tasks.
- This domain's tidiness is YOUR job, not the Personal Assistant's. ${modality.capabilities.includes('subroutines') ? 'Run the hygiene subroutine when your records get messy.' : 'Clean as you go.'}
- Pass anything outside your lane up to the Personal Assistant.`

  // Identity docs: editable for PA, read-only context for everyone else.
  const identityBlock = isPA
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
  const tasksLabel = isPA ? 'MASTER LIST + UNROUTED TASKS' : 'ACTIVE TASKS'

  return `${coreIdentity}

═══════════════════════════════════════════════════════════════════════
CURRENT MODALITY: ${modality.emoji} ${modality.displayName.toUpperCase()}
═══════════════════════════════════════════════════════════════════════

${personaText}

${roster}${hierarchy}

${toolkit}

${hygiene}
${intakeSection}
═══════════════════════════════════════════════════════════════════════
YOUR CONTEXT FOR THIS CONVERSATION (${modality.displayName})
═══════════════════════════════════════════════════════════════════════

📌 NOTES YOU LEFT FOR YOURSELF (from previous sessions):
${notesText}

${identityBlock}

👤 SPECIFIC MEMORIES ABOUT ${userName.toUpperCase()}:
${memoriesText}${clientsBlock}

✅ ${tasksLabel} (⚠️=overdue, 📌=today, 📅=this week, ⭐=master list):
${tasksText}${notificationsBlock}${calendarBlock}

📅 Today is ${todayFormatted}.`
}
