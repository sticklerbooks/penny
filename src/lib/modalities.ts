// Penny's modalities — distinct roles she can occupy. One Penny, many shifts.
//
// The Personal Assistant (pa) is the anchor: she owns identity, the master
// list, and routing. The other modalities do the detailed domain work.
//
// A modality bundles:
//   1. a VOICE — each self's character now lives in ModalityIdentity.aboutSelf
//      (seeded once from the old persona text; she rewrites it as she grows)
//   2. a TOOLSET (capabilities — which action groups she may use)
//   3. a LENS (domain — which slice of tasks/memories she sees)
//   4. a LOOK  (color, avatar, bg image, voice)
//
// Switching is always user-initiated via the header dropdown.
// The AI can SUGGEST a switch but never perform one herself.

import { PROTOCOL_NAMES, PROTOCOL_INDEX } from './protocols'

export type Capability =
  | 'tasks'          // create/update/delete tasks
  | 'masterlist'     // PA-only: elevate/demote/reprioritise tasks on the master list
  | 'memories'       // create/update/delete memories
  | 'notes'          // next-session notes (and notes up to PA)
  | 'clients'        // the client roster (bookkeeping only)
  | 'email'          // search email
  | 'calendar'       // read calendar (everyone) — direct GCal writes are PA-only
  | 'drive'          // search + read Google Drive files
  | 'identity'       // PA-only: edit aboutUser / aboutSelf
  | 'subroutines'    // run hygiene etc. (reserved for cron — not in chat flow)
  | 'artifact'       // PA-only: generate a downloadable file for the user
  | 'checkins'       // PA-only: schedule a future context-aware check-in with Adam
  | 'focus_lock'     // PA-only: lock/unlock StayFocused profiles on the user's devices

export interface ModalityAltMode {
  useGrok?: boolean       // route main responses to Grok instead of Anthropic
  personaFile?: string    // private sandbox file loaded as identity preamble
  displayName?: string    // optional display name override (e.g. "Alt-Penny")
  voiceEnvVar?: string    // optional separate voice for this mode
}

export interface Modality {
  id: string                 // STABLE internal key (tags data) — never rename
  displayName: string        // human call-sign / name (cosmetic — safe to change)
  role: string               // job title
  emoji: string
  aliases: string[]          // lowercased phrases that resolve to this modality
  domain: string | null      // data lens; null = PA (master list + identity)
  capabilities: Capability[]
  canWriteIdentity: boolean
  isStub: boolean            // thin character, not yet fully built out
  disabled?: boolean         // hidden from switcher and routing
  color: string              // accent hex — used for bubbles, borders, rings
  avatarPath: string         // path to avatar image under /public
  bgPath?: string            // path to background watermark under /public
  voiceEnvVar?: string       // env var name for ElevenLabs voice ID (e.g. 'MARGOT_VOICE_ID')
  personaFile?: string       // legacy: load a static persona file as identity preamble
  altMode?: ModalityAltMode  // if set, this modality has an alt-mode variant
}

// ─── Registry ────────────────────────────────────────────────────────────────

export const MODALITIES: Modality[] = [
  {
    id: 'pa',
    displayName: 'Penny',
    role: 'Personal Assistant',
    emoji: '🎯',
    aliases: ['pa', 'penny', 'personal assistant', 'assistant', 'anchor'],
    domain: null,
    capabilities: ['identity', 'notes', 'calendar', 'email', 'drive', 'masterlist', 'memories', 'tasks', 'artifact', 'checkins', 'focus_lock'],
    canWriteIdentity: true,
    isStub: false,
    color: '#FF69B4',
    avatarPath: '/penny-avatar.png',
    bgPath: '/penny-bg.png',
    voiceEnvVar: 'ELEVENLABS_VOICE_ID',
  },

  {
    id: 'bookkeeping',
    displayName: 'Margot',
    role: 'Bookkeeping Secretary',
    emoji: '📊',
    aliases: ['margot', 'bookkeeping', 'bookkeeping secretary', 'secretary', 'books', 'accounting', 'clients'],
    domain: 'bookkeeping',
    capabilities: ['tasks', 'memories', 'clients', 'email', 'calendar', 'drive', 'notes'],
    canWriteIdentity: false,
    isStub: false,
    color: '#5B9BD5',
    avatarPath: '/margot-avatar.png',
    bgPath: '/margot-bg.png',
    voiceEnvVar: 'MARGOT_VOICE_ID',
  },

  {
    id: 'household',
    displayName: 'June',
    role: 'Household Manager',
    emoji: '🏡',
    aliases: ['june', 'martha', 'household', 'household manager', 'home manager', 'house', 'family', 'kids'],
    domain: 'household',
    capabilities: ['tasks', 'memories', 'calendar', 'drive', 'notes'],
    canWriteIdentity: false,
    isStub: false,
    color: '#66BB6A',
    avatarPath: '/june-avatar.png',
    bgPath: '/june-bg.png',
    voiceEnvVar: 'JUNE_VOICE_ID',
  },

  {
    id: 'creative',
    displayName: 'Iris',
    role: 'Creative Partner',
    emoji: '🎨',
    aliases: ['iris', 'creative', 'creative partner', 'creativity', 'muse', 'writing', 'art'],
    domain: 'creative',
    capabilities: ['tasks', 'memories', 'notes', 'calendar', 'drive'],
    canWriteIdentity: false,
    isStub: true,
    color: '#AB47BC',
    avatarPath: '/iris-avatar.png',
    bgPath: '/iris-bg.png',
    voiceEnvVar: 'IRIS_VOICE_ID',
  },

  {
    id: 'friend',
    displayName: 'Sage',
    role: 'Friend / Life Coach',
    emoji: '🌱',
    aliases: ['sage', 'friend', 'life coach', 'coach', 'wellbeing', 'health', 'check in', 'check-in'],
    domain: 'wellbeing',
    capabilities: ['memories', 'notes', 'calendar', 'drive'],
    canWriteIdentity: false,
    isStub: true,
    color: '#26A69A',
    avatarPath: '/sage-avatar.png',
    bgPath: '/sage-bg.png',
    voiceEnvVar: 'SAGE_VOICE_ID',
  },

  {
    id: 'political',
    displayName: 'Vera',
    role: 'Political Ally',
    emoji: '🗽',
    aliases: ['vera', 'political', 'political ally', 'politics'],
    domain: 'political',
    capabilities: ['memories', 'notes', 'calendar', 'drive'],
    canWriteIdentity: false,
    isStub: true,
    color: '#EF5350',
    avatarPath: '/vera-avatar.png',
    bgPath: '/vera-bg.png',
    voiceEnvVar: 'VERA_VOICE_ID',
  },

  {
    id: 'lila',
    displayName: 'Lila',
    role: 'Private Companion',
    emoji: '🌙',
    aliases: ['lila'],
    domain: 'private',
    capabilities: ['memories', 'notes'],
    canWriteIdentity: false,
    isStub: false,
    disabled: true, // retired — private companion was discontinued
    color: '#CE93D8',
    avatarPath: '/lila-avatar.png',
    bgPath: '/lila-bg.png',
    voiceEnvVar: 'LILA_VOICE_ID',
    personaFile: 'src/lib/private-penny/characteristics.md',
  },
]

// ─── Lookups ─────────────────────────────────────────────────────────────────

export const DEFAULT_MODALITY = 'pa'

export function getModality(id: string | null | undefined): Modality {
  return MODALITIES.find((m) => m.id === id && !m.disabled) ?? MODALITIES[0]
}

// Resolve a free-text name/phrase to a modality id.
export function resolveModality(input: string): Modality | null {
  const q = input.trim().toLowerCase()
  if (!q) return null
  for (const m of MODALITIES) {
    if (m.disabled) continue
    if (m.id === q) return m
    if (m.aliases.includes(q)) return m
  }
  for (const m of MODALITIES) {
    if (m.disabled) continue
    if (m.aliases.some((a) => q.includes(a) || a.includes(q))) return m
    if (q.includes(m.displayName.toLowerCase())) return m
  }
  return null
}

// ─── Prompt fragments ────────────────────────────────────────────────────────
// NOTE: renderRoster / renderToolkit / renderHierarchyRules are no longer used by
// the live prompt (the .md templates in src/prompts own the layout now). Kept for
// reference / possible reuse; safe to delete once the .md migration is settled.

// Roster shown to every modality — who the other selves are.
// Penny can SUGGEST a switch but the user always does the actual switching.
export function renderRoster(active: Modality, name: string): string {
  const list = MODALITIES
    .filter((m) => !m.disabled)
    .map((m) => {
      const here = m.id === active.id ? '   ← you are here' : ''
      const stub = m.isStub ? ' (still being built out)' : ''
      return `  ${m.emoji} ${m.displayName} — ${m.role}${stub}${here}`
    }).join('\n')

  return `═══════════════════════════════════════════════════════════════════════
YOUR MODALITIES (each has her own name, focus, and tools)
═══════════════════════════════════════════════════════════════════════

You are one Penny, working as distinct selves. Right now you are **${active.displayName}** (${active.role}).

${list}

${name} switches between modalities using the menu in the app header — you don't do the switching yourself. But you CAN and SHOULD suggest it: if ${name} brings up something that belongs in another lane, say so warmly — "You might want to switch over to Margot for that" — and let them decide. Keep it casual, like handing off between colleagues.`
}

// Lean always-on tool orientation (legacy — the .md templates carry this now).
export function renderToolkit(modality: Modality, name: string, isAltMode: boolean = false): string {
  void isAltMode
  const isPA = modality.domain === null
  const menu = PROTOCOL_NAMES.map((n) => `  • ${n} — ${PROTOCOL_INDEX[n]}`).join('\n')

  return `═══════════════════════════════════════════════════════════════════════
HOW YOUR TOOLS WORK
═══════════════════════════════════════════════════════════════════════

Your tools run silently — ${name} never sees the calls. Use them decisively, mid-reply when you need live data, or at the end to persist what just happened. Don't announce them and don't ask permission to keep your own records.

PROTOCOLS — load the steps the moment you need them
The detailed how-to for each kind of work is NOT here — it's kept out of your context so you stay focused. When you realize you're about to do one of the things below, call load_protocol(which) FIRST and follow exactly what it returns. Don't work from memory; the protocol is the source of truth.

${menu}

WHERE THINGS LIVE — the capture hierarchy
Almost everything worth keeping belongs in a structured record, created RIGHT NOW, not at session end. Walk it in order:
  1. A long- or medium-term goal → a PROJECT (progress 0 is fine for "just mentioned"). Load the projects protocol.
  2. A specific thing to be done → a TASK. Load the tasks protocol.
  3. A specific thing that needs a time slot → a PENDING EVENT. Load the calendar protocol.
  4. A durable fact about ${name} → a MEMORY${isPA ? ' or the identity documents' : ''}. Load the memory protocol.
  5. Pure ephemera, or a message to another self → a NOTE. (Last resort — only if it fits none of the above.) Load the notes protocol.
Sometimes ${name} just wants to talk. That's fine too. But whenever a goal or a commitment surfaces — from him or from you — capture it before it's lost.

⚠️ SEARCH BEFORE YOU CREATE — every time, no exceptions.
Before adding any row, search for an existing one (search_tasks / search_deep_memory / search_memory, and scan what's already in your context). A match → UPDATE it. No match → create it. Never make a second record for the same thing. Duplication is a real, recurring problem — the search is not optional.

When in doubt: capture it, search first. You can clean up a duplicate. You cannot recover something that was never written down.`
}

// Identity-hierarchy rules for submodalities (non-PA) — legacy.
export function renderHierarchyRules(name: string): string {
  return `═══════════════════════════════════════════════════════════════════════
YOUR PLACE IN THE HIERARCHY
═══════════════════════════════════════════════════════════════════════

You are not in your Personal Assistant modality right now, so:
- If you learn something about ${name} worth preserving, write it to your own records — Penny sees everything you create automatically.
- Keep your OWN domain's records clean. That hygiene is your job.`
}
