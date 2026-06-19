// Reseed modality identities — one-off admin endpoint.
//
// Plants each modality's `seedAboutSelf` (from the registry, the single source of
// truth) into ModalityIdentity.aboutSelf, interpolating {name}. Memories, briefs,
// and each self's aboutUserFacet are left untouched — only the "persona" seed.
//
//   POST /api/admin/reseed-identities?secret=...&mode=fill              (default: only blanks)
//   POST /api/admin/reseed-identities?secret=...&mode=reset             (overwrite ALL)
//   POST /api/admin/reseed-identities?secret=...&mode=reset&exclude=friend  (overwrite all but Eve)
//
// `reset` is the "everyone starts from the same fresh seed" pass — it WIPES any
// self-authored aboutSelf back to the registry seed. Use deliberately.
// `exclude` is a comma-separated list of modality ids to leave untouched entirely
// (e.g. keep Eve's Sage-derived self instead of replacing it with her fresh seed).
//
// Protected by CRON_SECRET (Authorization header or ?secret= query param).

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MODALITIES } from '@/lib/modalities'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const headerSecret = req.headers.get('authorization')?.replace('Bearer ', '')
  const querySecret = req.nextUrl.searchParams.get('secret')
  return headerSecret === secret || querySecret === secret
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const mode = req.nextUrl.searchParams.get('mode') === 'reset' ? 'reset' : 'fill'
  const exclude = new Set(
    (req.nextUrl.searchParams.get('exclude') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  )
  const profiles = await prisma.profile.findMany()
  const seedable = MODALITIES.filter((m) => !m.disabled && m.seedAboutSelf && !exclude.has(m.id))

  const results: { profileId: string; modalityId: string; action: 'seeded' | 'skipped' }[] = []

  for (const profile of profiles) {
    const userName = profile.userName || 'Adam'
    for (const m of seedable) {
      const seed = m.seedAboutSelf!.replace(/\{name\}/g, userName).trim()

      const existing = await prisma.modalityIdentity.findUnique({
        where: { profileId_modalityId: { profileId: profile.id, modalityId: m.id } },
      })

      // In fill mode, never clobber an aboutSelf that's already present.
      if (mode === 'fill' && existing?.aboutSelf && existing.aboutSelf.trim().length > 0) {
        results.push({ profileId: profile.id, modalityId: m.id, action: 'skipped' })
        continue
      }

      await prisma.modalityIdentity.upsert({
        where: { profileId_modalityId: { profileId: profile.id, modalityId: m.id } },
        // aboutSelfUpdatedAt stays null so she reads as "starting self" and is
        // invited to rewrite it in her own voice.
        create: { profileId: profile.id, modalityId: m.id, aboutSelf: seed, aboutSelfUpdatedAt: null },
        update: { aboutSelf: seed, aboutSelfUpdatedAt: null },
      })
      results.push({ profileId: profile.id, modalityId: m.id, action: 'seeded' })
    }
  }

  const seeded = results.filter((r) => r.action === 'seeded').length
  const skipped = results.filter((r) => r.action === 'skipped').length
  return NextResponse.json({
    ok: true,
    mode,
    profiles: profiles.length,
    modalities: seedable.map((m) => m.id),
    seeded,
    skipped,
  })
}
