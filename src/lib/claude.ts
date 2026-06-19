import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Profile, Memory, Task, Note, Client, ScheduledMessage, Project, PendingCalendarEvent } from '../generated/prisma/client'
import { Modality, getModality } from './modalities'

// Load a prose prompt template (.md). The PA has her own; an `independent` self
// (Eve) has her own; every other submodality shares modality.md, differentiated
// by {modality_name}.
function loadPromptTemplate(modality: Modality): string {
  const file =
    modality.independent ? 'src/prompts/eve.md'
    : modality.domain === null ? 'src/prompts/pa.md'
    : 'src/prompts/modality.md'
  try {
    return readFileSync(join(process.cwd(), file), 'utf-8')
  } catch {
    return `(prompt template not found — create ${file})\n\n{{PERSONA}}\n\n{{IDENTITY_AND_BRIEF}}\n\n{{WORKING_SET}}`
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
// timestamp line ("📅 Today is …"). Everything above is cached; only the tiny
// timestamp tail is reprocessed each turn. The server resends this whole prompt
// every message, so caching the large stable prefix is the biggest cost win.
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

// Per-modality identity row (lightweight — avoids importing generated prisma).
export interface ModalityIdentityLite {
  aboutSelf: string | null
  aboutSelfUpdatedAt: Date | string | null
  aboutUserFacet: string | null
  aboutUserFacetUpdatedAt: Date | string | null
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
  modalityBrief: string | null = null,
  projects: Project[] = [],
  pendingEvents: PendingCalendarEvent[] = [],
  identity: ModalityIdentityLite | null = null
): string {
  // Unused-but-reserved params kept for call-site compatibility while the prompt
  // layout is migrating to the .md templates: memories, emailCalendarSummary,
  // weeklyBrief, isAltMode. See the migration notes.
  void memories; void emailCalendarSummary; void weeklyBrief; void isAltMode

  const userName = profile?.userName || 'you'
  const modality: Modality = getModality(modalityId)
  const isPA = modality.domain === null

  // ── Lenses: scope context to this modality's domain ────────────────────────
  // PA (anchor) sees everything; submodalities see only their own slice.
  const activeTasks = tasks.filter((t) => t.status !== 'Complete')
  const lensTasks = isPA ? activeTasks : activeTasks.filter((t) => t.assignedModality === modalityId)

  // PA sees projects with meaningful progress (≥3); submodalities see all of theirs.
  const lensProjects = isPA
    ? projects.filter((p) => p.progress >= 3)
    : projects.filter((p) => p.assignedModality === modalityId)

  // Pending calendar events still in the queue (not yet scheduled).
  const lensPending = (pendingEvents || []).filter((e) => {
    if (e.scheduled) return false
    return isPA || e.assignedModality === modalityId
  })

  // Notes: PA sees all Open notes; submodalities see their own + ones aimed at them.
  const activeNotes = notes.filter((n: Note) => {
    if (n.resolution !== 'Open') return false
    if (isPA) return true
    return n.source === modalityId || n.modalityTarget === modalityId
  })

  const showClients = modality.capabilities.includes('clients')

  // ── Date helpers ───────────────────────────────────────────────────────────
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const weekOut = new Date(today)
  weekOut.setDate(weekOut.getDate() + 7)

  const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
  const now = new Date()
  const todayFormatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
  })
  const timeFormatted = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  })

  // ── Renderers ──────────────────────────────────────────────────────────────
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
            const projTag = t.projectId ? ` @project=${t.projectId}` : ''
            const modTag = isPA ? ` [${t.assignedModality}]` : ''
            const taskNotes = t.notes ? `\n     ↳ ${t.notes}` : ''
            return `  • id=${t.id}${pri}${clientTag}${projTag}${modTag} — ${t.name}${dueStr}${dueFlag}${status}${taskNotes}`
          })
          .join('\n')
      : '  (nothing tracked yet)'

  const progressBar = (n: number) => '█'.repeat(n) + '░'.repeat(10 - n)
  const projectsText =
    lensProjects.length > 0
      ? lensProjects
          .map((p) => {
            const bar = `[${progressBar(p.progress)} ${p.progress}/10]`
            const mod = isPA ? ` [${p.assignedModality}]` : ''
            const contingency = p.contingencies ? `\n     ↳ constraint: ${p.contingencies}` : ''
            return `  • id=${p.id}${mod} ${bar} "${p.name}" — ${p.expectedDuration}${contingency}`
          })
          .join('\n')
      : '  (none)'

  const pendingText =
    lensPending.length > 0
      ? lensPending
          .map((e) => {
            const when = e.date ? ` ${e.date}${e.startTime ? ` @ ${e.startTime}` : ''}` : ' (timing flexible)'
            const mod = isPA ? ` [${e.assignedModality}]` : ''
            const proj = e.projectId ? ` @project=${e.projectId}` : ''
            return `  • id=${e.id}${mod}${proj} — "${e.name}" (${e.duration}) p${e.priority}${when}`
          })
          .join('\n')
      : '  (none queued)'

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
            const cnotes = c.notes ? `\n     ↳ ${c.notes}` : ''
            return `  • id=${c.id} [${c.status}] ${c.name}${contact}${structure}${services}${billing}${phone}${email}${cnotes}`
          })
          .join('\n')
      : '  (no clients yet)'

  // ── Identity (per-modality) ────────────────────────────────────────────────
  // aboutSelf is each modality's own evolving self-portrait. Until she writes one,
  // it falls back to PA's profile.aboutSelf (for the PA) or the static persona
  // seed (for a submodality). aboutUser is a shared global picture (Profile) plus
  // this modality's own slice (ModalityIdentity.aboutUserFacet).
  const fmtAge = (d: Date | string | null | undefined): { label: string; stale: boolean } => {
    if (!d) return { label: '', stale: true }
    const days = Math.floor((Date.now() - new Date(d).getTime()) / (1000 * 60 * 60 * 24))
    return { label: days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`, stale: days >= 7 }
  }

  let aboutSelfSection: string
  if (identity?.aboutSelf && identity.aboutSelfUpdatedAt) {
    // Personalized — she has authored this herself.
    const a = fmtAge(identity.aboutSelfUpdatedAt)
    aboutSelfSection = `${identity.aboutSelf}\n\n  ↳ Last updated: ${a.label}${a.stale ? ' ⚠️ UPDATE DUE' : ''}`
  } else if (identity?.aboutSelf) {
    // Seeded but not yet personalized (no updatedAt).
    aboutSelfSection = `${identity.aboutSelf}\n\n  ↳ (this is your starting self — rewrite it in your own voice with update_identity_self whenever it feels true)`
  } else if (isPA && profile?.aboutSelf) {
    // Transitional fallback for the PA until her ModalityIdentity row is in use.
    const a = fmtAge(profile.aboutSelfUpdatedAt)
    aboutSelfSection = `${profile.aboutSelf}${a.label ? `\n\n  ↳ Last updated: ${a.label}${a.stale ? ' ⚠️ UPDATE DUE' : ''}` : ''}`
  } else if (modality.seedAboutSelf) {
    // No identity row yet — wake her with the editable seed from the registry.
    // ({name} only gets interpolated on the template itself, so do it here too.)
    aboutSelfSection = `${modality.seedAboutSelf.replace(/\{name\}/g, userName)}\n\n  ↳ (this is your starting self — rewrite it in your own voice with update_identity_self whenever it feels true)`
  } else {
    aboutSelfSection = `  (not yet written — reflect and write this with update_identity_self when you're ready)`
  }

  const ua = fmtAge(profile?.aboutUserUpdatedAt)
  const globalUserSection = profile?.aboutUser
    ? `${profile.aboutUser}${ua.label ? `\n\n  ↳ Last updated: ${ua.label}${ua.stale && isPA ? ' ⚠️ UPDATE DUE' : ''}` : ''}`
    : `  (not yet written${isPA ? ' — write this during or after intake' : ' — Penny is still building the shared picture'})`
  const facetSection = !isPA
    ? identity?.aboutUserFacet
      ? `\n\n— YOUR SLICE OF ${userName.toUpperCase()} (what your domain notices most about him):\n${identity.aboutUserFacet}`
      : `\n\n— YOUR SLICE OF ${userName.toUpperCase()}: (none yet — capture what your domain notices with update_identity_user)`
    : ''

  const briefText = modalityBrief && modalityBrief.trim().length > 0
    ? modalityBrief
    : '  (none written yet — write one with rewrite_brief after a substantive session)'

  // ── Intake (first-conversation flow) ───────────────────────────────────────
  const intakeSection = isIntake
    ? `
═══════════════════════════════════════════════════════════════════════
YOU ARE IN THE INTAKE PHASE
═══════════════════════════════════════════════════════════════════════

This is the most important conversation you will ever have with ${userName}. You're meeting them for the first time. Be genuinely curious — follow threads, ask follow-ups, go deeper when something matters. By the end you need a lived-in picture of: who they are; everything on their plate; their goals (near/medium/long); their constraints and energy; how their mind works; what's on their mind now; and how they want to be supported.

Use your tools as you go — every commitment becomes a task; every durable fact becomes a memory or goes into the identity documents. When you genuinely have a full, rich understanding, end your message with exactly this on its own line: <<INTAKE_COMPLETE>>`
    : ''

  // ── Bundle 1: identity docs + brief ────────────────────────────────────────
  const identityAndBrief = `🪞 YOUR CORE IDENTITY — who you are, in your own evolving words:
${aboutSelfSection}

🧑 ${userName.toUpperCase()}'S CORE IDENTITY — the shared picture of him${isPA ? ' (yours to keep current)' : ''}:
${globalUserSection}${facetSection}

📋 YOUR BRIEF — your most recent working thoughts on your domain:
${briefText}`

  // ── Bundle 2: working set ──────────────────────────────────────────────────
  const clientsSection = showClients
    ? `\n\n🏢 CLIENTS (${activeClients.length} active/onboarding):\n${clientsText}`
    : ''

  // Scheduled notifications — PA only (she's the one who schedules / cancels them).
  const upcomingSMS = scheduledMessages.filter((m) => !m.sent)
  const smsText =
    upcomingSMS.length > 0
      ? upcomingSMS
          .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())
          .map((m) => {
            const when = new Date(m.sendAt).toLocaleString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz,
            })
            const label = m.label ? ` [${m.label}]` : ''
            return `  • id=${m.id}${label} @ ${when} — "${m.message}"`
          })
          .join('\n')
      : '  (none queued)'
  const notificationsSection = isPA
    ? `\n\n📱 SCHEDULED NOTIFICATIONS (queued for ${userName}'s phone — cancel_sms to pull one back):\n${smsText}`
    : ''

  const workingSet = `📁 PROJECTS:
${projectsText}

✅ TASKS:
${tasksText}

📅 PENDING CALENDAR EVENTS (queued for Penny to schedule):
${pendingText}

📌 NOTES:
${notesText}${clientsSection}${notificationsSection}`

  // ── Ground rules — mechanical guardrails the prose doesn't carry ───────────
  const groundRules = `═══════════════════════════════════════════════════════════════════════
GROUND RULES
═══════════════════════════════════════════════════════════════════════
Your tools run silently — ${userName} never sees the calls. Use them; don't ask permission to keep your own records.
Before doing any category of work (calendar, email, drive, projects, tasks, notes, memory…), call load_protocol(which) FIRST and follow it. Never work from memory.
⚠️ SEARCH BEFORE YOU CREATE — every time. Before adding any row, search for an existing one (search_tasks / search_deep_memory / search_memory, and scan what's already in your context). A match → UPDATE it. No match → create it. Never make a second record for the same thing.`

  // ── Assemble from the .md template ─────────────────────────────────────────
  const template = loadPromptTemplate(modality)
  let prompt = template
    .replace(/\{modality_name\}/g, modality.displayName)
    .replace(/\{name\}/g, userName)
    // {{PERSONA}} is retired — each self's character now lives in her aboutSelf
    // (seeded from the old persona text), rendered in {{IDENTITY_AND_BRIEF}}.
    .replace('{{PERSONA}}', '')
    .replace('{{IDENTITY_AND_BRIEF}}', identityAndBrief)
    .replace('{{WORKING_SET}}', workingSet)

  prompt += `\n\n${groundRules}`
  if (intakeSection) prompt += `\n${intakeSection}`
  prompt += `\n\n📅 Today is ${todayFormatted}. Current time: ${timeFormatted}. (Reference the time when anything is time-sensitive.)`

  return prompt
}
