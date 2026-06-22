// Read-only viewer for everything the selves carry: each modality's identity
// (aboutSelf + its slice of the user), its running brief, the latest weekly
// brief + the domain reports that fed it, and all memories grouped by domain.
//
// There's no write here — it's the missing "let me just read what they know"
// window. Renders plain HTML so it's legible on a phone.
//
//   GET /api/admin/view?secret=$CRON_SECRET            (everything)
//   GET /api/admin/view?secret=...&format=json         (raw JSON instead)
//
// Protected by CRON_SECRET (Authorization header or ?secret= query param).

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { MODALITIES, getModality } from '@/lib/modalities'

export const dynamic = 'force-dynamic'

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const headerSecret = req.headers.get('authorization')?.replace('Bearer ', '')
  const querySecret = req.nextUrl.searchParams.get('secret')
  return headerSecret === secret || querySecret === secret
}

function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function when(d: Date | string | null | undefined): string {
  if (!d) return ''
  return new Date(d).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const profile = await prisma.profile.findFirst()
  if (!profile) return NextResponse.json({ error: 'No profile found' }, { status: 404 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const [identities, briefs, memories, weeklyBrief, domainReports] = await Promise.all([
    prisma.modalityIdentity.findMany({ where: { profileId: profile.id } }),
    db.modalityBrief.findMany({ where: { profileId: profile.id } }).catch(() => []),
    prisma.memory.findMany({
      where: { profileId: profile.id, archived: false },
      orderBy: [{ domain: 'asc' }, { importance: 'desc' }],
    }),
    db.weeklyBrief.findFirst({ where: { profileId: profile.id }, orderBy: { createdAt: 'desc' } }).catch(() => null),
    db.domainReport.findMany({ where: { profileId: profile.id }, orderBy: { weekOf: 'desc' }, take: 20 }).catch(() => []),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const identityBy = new Map<string, any>(identities.map((i) => [i.modalityId, i]))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const briefBy = new Map<string, any>((briefs as any[]).map((b) => [b.modalityId, b]))
  // Latest domain report per modality (reports are ordered newest-first).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestReportBy = new Map<string, any>()
  for (const r of domainReports as { modalityId: string }[]) {
    if (!latestReportBy.has(r.modalityId)) latestReportBy.set(r.modalityId, r)
  }

  if (req.nextUrl.searchParams.get('format') === 'json') {
    return NextResponse.json({ profile: { id: profile.id, userName: profile.userName }, identities, briefs, weeklyBrief, domainReports, memories })
  }

  const active = MODALITIES.filter((m) => !m.disabled)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const memByDomain = new Map<string, any[]>()
  for (const m of memories) {
    const key = m.domain ?? '(global)'
    if (!memByDomain.has(key)) memByDomain.set(key, [])
    memByDomain.get(key)!.push(m)
  }

  const card = (title: string, color: string, body: string) =>
    `<section style="border-left:4px solid ${color};background:#161922;border-radius:10px;padding:16px 18px;margin:0 0 18px;">
      <h2 style="margin:0 0 10px;font-size:16px;color:${color};">${esc(title)}</h2>${body}
    </section>`

  const field = (label: string, value: string | null | undefined, meta = '') =>
    `<div style="margin:0 0 12px;">
      <div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#7a8190;margin-bottom:3px;">${esc(label)}${meta ? ` · <span style="text-transform:none;letter-spacing:0;">${esc(meta)}</span>` : ''}</div>
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.55;color:#dfe3ea;">${value && value.trim() ? esc(value) : '<span style="color:#5a606e;">— empty —</span>'}</div>
    </div>`

  const modalityCards = active.map((m) => {
    const idn = identityBy.get(m.id)
    const br = briefBy.get(m.id)
    const rep = latestReportBy.get(m.id)
    const parts = [
      field('About self', idn?.aboutSelf, idn?.aboutSelfUpdatedAt ? `updated ${when(idn.aboutSelfUpdatedAt)}` : 'seed (not yet self-authored)'),
      field('Its slice of the user', idn?.aboutUserFacet, idn?.aboutUserFacetUpdatedAt ? `updated ${when(idn.aboutUserFacetUpdatedAt)}` : ''),
      field('Running brief', br?.content),
    ]
    if (rep) parts.push(field('Latest domain report', rep.reportText, `week of ${when(rep.weekOf)}${rep.adjective ? ` · “${rep.adjective}”` : ''}`))
    return card(`${m.emoji} ${m.displayName} — ${m.role}`, m.color, parts.join(''))
  }).join('')

  const pa = getModality('pa')
  const weeklyCard = weeklyBrief
    ? card(
        `📊 Penny's Weekly Brief${weeklyBrief.flagged ? ' ⚠️ flagged' : ''}`,
        pa.color,
        field('Synthesis', weeklyBrief.briefText, `week of ${when(weeklyBrief.weekOf)}`)
      )
    : card('📊 Penny\'s Weekly Brief', pa.color,
        '<div style="color:#5a606e;font-size:14px;">No weekly brief has been generated yet. The Sunday-night cron creates this.</div>')

  const memCards = [...memByDomain.entries()].map(([domain, mems]) => {
    const color = MODALITIES.find((m) => m.domain === domain)?.color ?? '#7a8190'
    const rows = mems.map((mem) =>
      `<li style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#dfe3ea;">
        <span style="color:#7a8190;">[${mem.importance}]</span> ${esc(mem.content)}
        <span style="color:#5a606e;font-size:12px;"> · ${esc(mem.category)}</span>
      </li>`
    ).join('')
    return card(`🧠 Memories — ${domain} (${mems.length})`, color, `<ul style="margin:0;padding-left:0;list-style:none;">${rows}</ul>`)
  }).join('')

  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Penny — selves viewer</title></head>
<body style="margin:0;background:#0B0C10;color:#dfe3ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:760px;margin:0 auto;padding:24px 16px 64px;">
  <h1 style="font-size:20px;margin:0 0 4px;">Penny — what the selves know</h1>
  <p style="color:#7a8190;font-size:13px;margin:0 0 24px;">Read-only · ${esc(profile.userName || 'Adam')} · generated ${when(new Date())}</p>
  ${weeklyCard}
  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#7a8190;margin:28px 0 12px;">Identities &amp; briefs</h2>
  ${modalityCards}
  <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#7a8190;margin:28px 0 12px;">Memories</h2>
  ${memCards || '<p style="color:#5a606e;">No memories yet.</p>'}
</div>
</body></html>`

  return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
