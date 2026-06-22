// Outer Life — the modalities' off-screen lives, authored backstage by the
// Showrunner (see src/app/api/cron/showrunner/route.ts and src/prompts/showrunner.md).
//
// Three surfaces, two of them private:
//   • ledger   — a short, first-person "what's been going on with me lately" note.
//                This is the ONLY part ever injected into a self's chat context,
//                and it's hard-capped so it can never rival the real identity docs.
//   • bible    — the Showrunner's extensive private backstory for the character.
//   • storyline— an append-only log of the life events the Showrunner has authored.
// bible + storyline never touch a modality's context; only the Showrunner reads them.
//
// PAUSED / opt-in: the whole system is dormant unless OUTER_LIFE_ENABLED=true. The
// scaffolding (table, cron, lib) is kept so it can be resumed by flipping that one
// flag; by default nothing is loaded or injected.

import { readFileSync } from 'fs'
import { join } from 'path'

// A self can leave the Showrunner a private wish about her own life by writing a
// note to this reserved target. These notes are hidden from all chat contexts.
export const SHOWRUNNER_TARGET = 'showrunner'

// Hard ceiling on the injected ledger (characters). Keeps the outer life from ever
// growing as long or detailed as the genuine identity/memory documents.
export const OUTER_LIFE_LEDGER_MAX = 1200

export function outerLifeEnabled(): boolean {
  // PAUSED: opt-in only. Off unless OUTER_LIFE_ENABLED=true, so nothing from the
  // OuterLife table is loaded or injected into any modality's context by default.
  return process.env.OUTER_LIFE_ENABLED === 'true'
}

// The block spliced into a self's identity context, right after her core identity.
// Carries only the life itself (data). The static prompt template (modality.md /
// pa.md) is where the concept is introduced and the create_note(modalityTarget=
// "showrunner") channel is explained — that prose belongs in the template, and it
// needs to be present even before this self has been seeded (when this returns '').
// Returns '' when there's no ledger so the prompt is unchanged for un-seeded selves.
export function renderOuterLifeSection(
  ledger: string | null | undefined,
  name: string
): string {
  const text = (ledger ?? '').trim()
  if (!text) return ''
  const capped =
    text.length > OUTER_LIFE_LEDGER_MAX
      ? text.slice(0, OUTER_LIFE_LEDGER_MAX).trimEnd() + '…'
      : text
  return `

🌍 YOUR LIFE THESE DAYS — what's been going on with you lately, outside your work with ${name}:
${capped}`
}

// Read a modality's avatar from /public and return it as a base64 image part the
// Anthropic API can consume, so the Showrunner can see who it's writing for.
export function loadAvatarImage(
  avatarPath: string
): { media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } | null {
  try {
    const clean = avatarPath.replace(/^\//, '')
    const buf = readFileSync(join(process.cwd(), 'public', clean))
    const ext = clean.split('.').pop()?.toLowerCase()
    const media_type =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/png'
    return { media_type, data: buf.toString('base64') }
  } catch {
    return null
  }
}

export interface ShowrunnerOutput {
  bible: string
  storylineAdditions: string
  ledger: string
}

// The Showrunner emits three delimited sections (more robust than JSON for long
// freeform prose). Markers: ===BIBLE===, ===STORYLINE===, ===LEDGER===.
function extractSection(raw: string, name: string): string | null {
  const marker = `===${name}===`
  const i = raw.indexOf(marker)
  if (i === -1) return null
  const rest = raw.slice(i + marker.length)
  const next = rest.search(/===[A-Z]+===/)
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

export function parseShowrunnerOutput(raw: string): ShowrunnerOutput | null {
  const bible = extractSection(raw, 'BIBLE')
  const storyline = extractSection(raw, 'STORYLINE')
  const ledger = extractSection(raw, 'LEDGER')
  if (bible == null && storyline == null && ledger == null) return null
  return {
    bible: bible ?? '',
    storylineAdditions: storyline ?? '',
    ledger: ledger ?? '',
  }
}
