// Backdoor — read what the Showrunner has written for each self.
//
// FLAGGED: 404s unless OUTER_LIFE_ENABLED=true. Sits behind the app's login proxy.
// Returns everything, including the private `bible` and `storyline` that the
// modalities themselves never see — this is the window for tuning the Showrunner.
//
//   GET /api/outer-life

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MODALITIES } from '@/lib/modalities'
import { outerLifeEnabled } from '@/lib/outer-life'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!outerLifeEnabled()) {
    return NextResponse.json({ error: 'Outer life is off — set OUTER_LIFE_ENABLED=true.' }, { status: 404 })
  }

  const profile = await prisma.profile.findFirst()
  if (!profile) {
    return NextResponse.json({ error: 'No profile found' }, { status: 404 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.outerLife.findMany({ where: { profileId: profile.id } }).catch(() => [])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byId = new Map<string, any>(rows.map((r: { modalityId: string }) => [r.modalityId, r]))

  const cast = MODALITIES.filter((m) => !m.disabled).map((m) => {
    const r = byId.get(m.id)
    return {
      modality: m.id,
      name: m.displayName,
      role: m.role,
      seeded: !!r?.seeded,
      lastTickAt: r?.lastTickAt ?? null,
      ledger: r?.ledger ?? null,        // the part she sees
      storyline: r?.storyline ?? null,  // private
      bible: r?.bible ?? null,          // private
    }
  })

  return NextResponse.json({ ok: true, cast })
}
