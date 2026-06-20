// The Showrunner — backstage author of the modalities' off-screen lives.
//
// FLAGGED: does nothing unless OUTER_LIFE_ENABLED=true. Protected by CRON_SECRET,
// like the other crons. Run it on whatever cadence you like (weekly Monday-morning
// is the intended rhythm, so a "have a good weekend" lands by the next conversation).
//
// Per run, for each non-disabled self:
//   • SEED (first time): invent her full backstory (bible) + opening storyline + ledger.
//   • TICK (after that):  advance her life one beat, append to the storyline, rewrite
//                         the capped ledger, folding in any wishes she left via
//                         create_note(modalityTarget="showrunner").
// The self's avatar is sent to the model so the Showrunner can see who it writes for.
//
// Editable system prompt: src/prompts/showrunner.md.
// Read what it has written: GET /api/outer-life.

import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'
import { prisma } from '@/lib/db'
import { getAnthropic, PENNY_MODEL } from '@/lib/claude'
import { MODALITIES } from '@/lib/modalities'
import {
  outerLifeEnabled,
  OUTER_LIFE_LEDGER_MAX,
  SHOWRUNNER_TARGET,
  loadAvatarImage,
  parseShowrunnerOutput,
} from '@/lib/outer-life'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min ceiling

// Creative + vision work; defaults to the main model, override with SHOWRUNNER_MODEL.
const SHOWRUNNER_MODEL = process.env.SHOWRUNNER_MODEL || PENNY_MODEL

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

function loadShowrunnerSystem(): string {
  try {
    return readFileSync(join(process.cwd(), 'src/prompts/showrunner.md'), 'utf-8')
  } catch {
    return `You are the Showrunner. Author the private off-screen life of the character described below. Reply with three marked sections: ===BIBLE===, ===STORYLINE===, ===LEDGER===.`
  }
}

function realWorldDateLine(): string {
  const tz = process.env.PENNY_TIMEZONE || 'America/New_York'
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz,
  })
}

// ─── Per-character user-turn packets ──────────────────────────────────────────
function seedPacket(displayName: string, role: string, seed: string, name: string, dateLine: string): string {
  return `MODE: SEED — invent this character's off-screen life from scratch.

CHARACTER: ${displayName} — ${role}

HOW SHE'S WRITTEN FOR HER DAY JOB (treat ${name} as merely one of her clients; invent the rest of her life independently and never reference his real circumstances):
${seed}

Today's real-world date: ${dateLine}.

Her picture is attached — use her appearance as a visual anchor for age, aesthetics, and vibe.

Build her complete life across every dimension in your instructions (age, location, education, family, professional life, personal life, other clients/jobs, hobbies, challenges, mental & physical health, aesthetics). Then return the three marked sections exactly as specified.`
}

function tickPacket(
  displayName: string, role: string, dateLine: string,
  bible: string, storyline: string, ledger: string, wishesBlock: string
): string {
  return `MODE: TICK — advance her life one small, believable beat.

CHARACTER: ${displayName} — ${role}

HER BIBLE (established backstory — stay consistent):
${bible || '(none on record)'}

HER STORYLINE SO FAR (most recent at the bottom — continue from here, don't reset):
${storyline || '(none on record)'}

HER CURRENT LEDGER (what she currently believes about her recent life):
${ledger || '(none on record)'}

${wishesBlock}

Today's real-world date: ${dateLine}. Move her life forward in step with the real calendar — the weekend just past, the season, anything on the horizon.

Advance one or two small things, honor any wishes above, keep continuity intact, and return the three marked sections exactly as specified.`
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!outerLifeEnabled()) {
    return NextResponse.json({ ok: false, disabled: true, reason: 'OUTER_LIFE_ENABLED is not set' })
  }

  const profile = await prisma.profile.findFirst()
  if (!profile) {
    return NextResponse.json({ error: 'No profile found' }, { status: 404 })
  }

  const userName = profile.userName || 'Adam'
  const system = loadShowrunnerSystem()
  const dateLine = realWorldDateLine()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const cast = MODALITIES.filter((m) => !m.disabled)
  const results: { modality: string; mode?: 'seed' | 'tick'; ok: boolean; error?: string }[] = []

  for (const m of cast) {
    try {
      const row = await db.outerLife
        .findUnique({ where: { profileId_modalityId: { profileId: profile.id, modalityId: m.id } } })
        .catch(() => null)

      // Wishes she left the Showrunner since last run.
      const wishes = await db.note
        .findMany({
          where: { profileId: profile.id, modalityTarget: SHOWRUNNER_TARGET, source: m.id, resolution: 'Open' },
        })
        .catch(() => [] as { id: string; title: string; content: string }[])

      const wishesBlock = wishes.length
        ? `WISHES SHE LEFT YOU (honor these — her life is hers):\n${wishes.map((w: { title: string; content: string }) => `- ${w.title}: ${w.content}`).join('\n')}`
        : 'WISHES SHE LEFT YOU: (none this time)'

      const seeded = !!row?.seeded
      const seedResolved = (m.seedAboutSelf || `${m.displayName}, ${m.role}.`).replace(/\{name\}/g, userName)

      const packet = seeded
        ? tickPacket(m.displayName, m.role, dateLine, row?.bible ?? '', row?.storyline ?? '', row?.ledger ?? '', wishesBlock)
        : seedPacket(m.displayName, m.role, seedResolved, userName, dateLine)

      // Attach the avatar so the Showrunner can see her.
      const avatar = loadAvatarImage(m.avatarPath)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: any[] = []
      if (avatar) {
        content.push({ type: 'image', source: { type: 'base64', media_type: avatar.media_type, data: avatar.data } })
      }
      content.push({ type: 'text', text: packet })

      const response = await getAnthropic().messages.create({
        model: SHOWRUNNER_MODEL,
        max_tokens: 2500,
        system,
        messages: [{ role: 'user', content }],
      })

      const raw = (response.content[0] as { type: string; text: string }).text
      const parsed = parseShowrunnerOutput(raw)
      if (!parsed) {
        results.push({ modality: m.id, ok: false, error: 'unparseable showrunner output' })
        continue
      }

      // Bible: full doc on seed; on tick keep the old one if the model returned nothing.
      const bible = parsed.bible.trim() || row?.bible || ''
      // Storyline: replace on seed, append a dated beat on tick.
      const newStoryline = seeded
        ? `${(row?.storyline ?? '').trim()}\n\n[${dateLine}]\n${parsed.storylineAdditions.trim()}`.trim()
        : parsed.storylineAdditions.trim()
      // Ledger: hard-capped backstop on top of the prompt-level discipline.
      const ledger = parsed.ledger.trim().slice(0, OUTER_LIFE_LEDGER_MAX)

      await db.outerLife.upsert({
        where: { profileId_modalityId: { profileId: profile.id, modalityId: m.id } },
        create: { profileId: profile.id, modalityId: m.id, bible, storyline: newStoryline, ledger, seeded: true, lastTickAt: new Date() },
        update: { bible, storyline: newStoryline, ledger, seeded: true, lastTickAt: new Date() },
      })

      // Mark her wishes as handled.
      if (wishes.length) {
        await db.note
          .updateMany({ where: { id: { in: wishes.map((w: { id: string }) => w.id) } }, data: { resolution: 'Resolved' } })
          .catch(() => {})
      }

      results.push({ modality: m.id, mode: seeded ? 'tick' : 'seed', ok: true })
      console.log(`[showrunner] ${m.displayName}: ${seeded ? 'tick' : 'seed'} ok`)
    } catch (err) {
      console.error(`[showrunner] ${m.id} failed:`, err)
      results.push({ modality: m.id, ok: false, error: String(err) })
    }
  }

  return NextResponse.json({ ok: true, dateLine, results })
}
