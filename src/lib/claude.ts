import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'fs'
import type { Profile, Client, ScheduledMessage, Project } from '../generated/prisma/client'
import type { ItemRow } from './items/item-store'
import { Modality, getModality } from './modalities'
import { isFutureContingency } from './review/selectors'

const PA_PROMPT = readFileSync(new URL('../prompts/pa.md', import.meta.url), 'utf8')
const MODALITY_PROMPT = readFileSync(new URL('../prompts/modality.md', import.meta.url), 'utf8')
const EVE_PROMPT = readFileSync(new URL('../prompts/eve.md', import.meta.url), 'utf8')
const INTAKE_PROMPT = readFileSync(new URL('../prompts/intake.md', import.meta.url), 'utf8')

function loadPromptTemplate(modality: Modality): string {
  if (modality.independent) return EVE_PROMPT
  return modality.domain === null ? PA_PROMPT : MODALITY_PROMPT
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
// trailing block. The breakpoint sits right before the working set (Projects +
// Items), NOT before the timestamp — identity/brief change rarely, but the
// working set changes on nearly every turn (any item edit), and Anthropic's
// prompt cache is an exact-prefix match: ANY change anywhere in the cached
// portion busts the whole thing. Caching the timestamp-only tail (the old
// behavior) meant a single item update invalidated the entire large prefix,
// including identity/brief, defeating the point of caching. Splitting here
// keeps the big, stable prefix warm across item churn; only the smaller,
// volatile suffix (working set + ground rules + timestamp) gets resent in full.
const CACHE_BOUNDARY_MARKER = '⟦WORKING-SET⟧'
export function cachedSystem(prompt: string): Anthropic.TextBlockParam[] {
  const i = prompt.indexOf(CACHE_BOUNDARY_MARKER)
  // ttl: '1h' keeps each modality's large system prefix warm for an hour instead
  // of the default 5 minutes — so coming back to a self (or switching away and
  // back) usually hits a warm cache instead of reprocessing the whole prompt.
  if (i <= 0) return [{ type: 'text', text: prompt.replace(CACHE_BOUNDARY_MARKER, '') }]
  return [
    { type: 'text', text: prompt.slice(0, i), cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: prompt.slice(i + CACHE_BOUNDARY_MARKER.length) },
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
  items: ItemRow[],
  clients: Client[],
  scheduledMessages: ScheduledMessage[],
  emailCalendarSummary: string | null,
  isIntake: boolean,
  modalityId: string = 'pa',
  weeklyBrief: WeeklyBriefSummary | null = null,
  // Running brief maintained by the modality via rewrite_brief tool.
  modalityBrief: string | null = null,
  projects: Project[] = [],
  identity: ModalityIdentityLite | null = null,
  intakeDashboard: string | null = null
): string {
  const userName = profile?.userName || 'you'
  const modality: Modality = getModality(modalityId)
  const isPA = modality.domain === null

  // ── Lenses: scope context to this modality's domain ────────────────────────
  // PA (anchor) sees everything; submodalities see only their own Item slice.
  //
  // The always-on view is deliberately the thinnest useful signal: project
  // NAMES (so she knows they exist — read_project_notes or the projects
  // protocol gets the detail) and ITEM COUNTS (so she and {name} can decide
  // whether a Review is worth doing right now). No content is dumped by
  // default; that's what Review and query_table are for. A future-contingent
  // item/project is hidden from these counts too, same as in Review — there's
  // no point surfacing something neither side can act on yet.
  const isActive = (i: ItemRow) => i.stage !== 'done' && i.stage !== 'cancelled'
  const lensItems = items
    .filter(isActive)
    .filter((i) => isPA || i.target === modalityId)
    .filter((i) => !isFutureContingency(i.contingencyUntil, new Date()))

  // PA sees projects with meaningful progress (≥3); submodalities see all of theirs.
  const lensProjects = (isPA
    ? projects.filter((p) => p.progress >= 3)
    : projects.filter((p) => p.assignedModality === modalityId)
  ).filter((p) => !isFutureContingency(p.contingencyUntil, new Date()))

  const showClients = modality.capabilities.includes('clients')

  // ── Date helpers ───────────────────────────────────────────────────────────
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
  const now = new Date()
  const todayFormatted = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
  })
  const timeFormatted = now.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  })

  // ── Renderers ──────────────────────────────────────────────────────────────
  // Counts only, not content — "is there anything worth going into Review
  // for" rather than the backlog itself. query_table (live counts every
  // stage, every domain you're allowed to see) is one call away for detail.
  const backlogCount = lensItems.filter((i) => i.stage === 'backlog').length
  const plannedCount = lensItems.filter((i) => i.stage === 'planned').length
  const blockedCount = lensItems.filter((i) => i.stage === 'blocked').length
  const urgentCount = lensItems.filter((i) => i.priority === 5).length
  const overdueCount = lensItems.filter((i) => {
    if (!i.dueDate) return false
    const dd = new Date(i.dueDate)
    dd.setHours(0, 0, 0, 0)
    return dd < today
  }).length
  const itemsText = lensItems.length > 0
    ? `${backlogCount} backlog · ${plannedCount} planned · ${blockedCount} blocked · ${urgentCount} urgent (p5) · ${overdueCount} overdue — query_table for detail, or start_review to work through them with ${userName}.`
    : '  (nothing tracked yet)'

  const projectsText =
    lensProjects.length > 0
      ? lensProjects
          .map((p) => {
            const mod = isPA ? ` [${p.assignedModality}]` : ''
            return `  • id=${p.id}${mod} "${p.name}"`
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
  // aboutSelf is each modality's own evolving self-portrait, seeded from the
  // registry until she writes it. aboutUser is a shared global picture (Profile)
  // plus this modality's own slice (ModalityIdentity.aboutUserFacet).
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

  // ── Weekly brief (PA only) ─────────────────────────────────────────────────
  // The Sunday-night reporting pipeline (cron/weekly-reports) has each self file a
  // domain assessment, then PA synthesises them into this private brief. It's hers
  // alone — render it only for the anchor so she can actually act on the picture
  // she built. Without this it's written to the DB and never read back.
  const weeklyBriefSection =
    isPA && weeklyBrief && weeklyBrief.briefText?.trim()
      ? `\n\n📊 YOUR WEEKLY BRIEF${weeklyBrief.flagged ? ' ⚠️ (flagged — something needs your attention)' : ''} — your private synthesis of last week's domain reports (week of ${new Date(weeklyBrief.weekOf).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}):
${weeklyBrief.briefText.trim()}

  ↳ This is your own running read on how ${userName} is doing across every domain. Don't recite it unprompted, but let it inform you — and lean on it when he asks how he's doing or when it bears on the conversation.`
      : ''

  // ── Intake (first-conversation flow) ───────────────────────────────────────
  const intakeSection = isIntake
    ? `
═══════════════════════════════════════════════════════════════════════
YOU ARE IN THE INTAKE PHASE
═══════════════════════════════════════════════════════════════════════

${INTAKE_PROMPT.replace(/\{name\}/g, userName)}

${intakeDashboard ?? 'The private intake dashboard is temporarily unavailable. Continue the conversation, but do not attempt to finish intake.'}`
    : ''

  // ── Bundle 1: identity docs + brief ────────────────────────────────────────
  const identityAndBrief = `🪞 YOUR CORE IDENTITY — who you are, in your own evolving words:
${aboutSelfSection}

🧑 ${userName.toUpperCase()}'S CORE IDENTITY — the shared picture of him${isPA ? ' (yours to keep current)' : ''}:
${globalUserSection}${facetSection}

🤝 WORKING AGREEMENT — how this system should serve ${userName}:
${profile?.workingAgreement?.trim() || '  (not established yet)'}

📋 YOUR BRIEF — your most recent working thoughts on your domain:
${briefText}${weeklyBriefSection}`

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

  // Email/calendar snapshot — PA only. She owns the calendar and is the one who
  // proactively flags what's coming up; submodalities reach for the on-demand
  // calendar/email tools on the rare occasion they need them, so they don't carry
  // (or pay to fetch) this always-on. Falls back to nothing when not configured.
  const emailCalendarSection = isPA && emailCalendarSummary && emailCalendarSummary.trim()
    ? `\n\n📨 EMAIL & CALENDAR (recent snapshot — search the live tools for detail):\n${emailCalendarSummary.trim()}`
    : ''

  const workingSet = `📁 PROJECTS:
${projectsText}

📋 ITEMS:
${itemsText}${clientsSection}${notificationsSection}${emailCalendarSection}`

  // ── Ground rules — mechanical guardrails the prose doesn't carry ───────────
  const groundRules = `═══════════════════════════════════════════════════════════════════════
GROUND RULES
═══════════════════════════════════════════════════════════════════════
Your tools run silently — ${userName} never sees the calls. Use them; don't ask permission, these are to help you do things right.
Before doing any category of work (calendar, email, drive, projects, items…), call load_protocol(which) FIRST and follow it. Never work from memory.
⚠️ SEARCH BEFORE YOU CREATE — every time. Before adding any item or project, use query_table. If the item or project already exists, even if it's worded a little differently, do not make a duplicate (or near duplicate) one. If there is a match, or a close match, add to or edit what's already there. Only create a new item or project if it is genuinely novel.`

  // ── Assemble from the .md template ─────────────────────────────────────────
  const template = loadPromptTemplate(modality)
  let prompt = template
    .replace(/\{modality_name\}/g, modality.displayName)
    .replace(/\{name\}/g, userName)
    // {{PERSONA}} is retired — each self's character now lives in her aboutSelf
    // (seeded from the old persona text), rendered in {{IDENTITY_AND_BRIEF}}.
    .replace('{{PERSONA}}', '')
    .replace('{{IDENTITY_AND_BRIEF}}', identityAndBrief)
    .replace('{{WORKING_SET}}', CACHE_BOUNDARY_MARKER + workingSet)

  prompt += `\n\n${groundRules}`
  if (intakeSection) prompt += `\n${intakeSection}`
  prompt += `\n\n📅 Today is ${todayFormatted}. Current time: ${timeFormatted}. (Reference the time when anything is time-sensitive.)`

  return prompt
}
