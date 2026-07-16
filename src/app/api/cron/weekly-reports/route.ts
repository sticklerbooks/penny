// Weekly reporting pipeline — runs every Sunday night via Railway cron.
//
// Flow:
//   1. For each reporting sub-modality, build that modality's
//      full system prompt and ask it for a domain assessment.
//   2. Store each assessment as a DomainReport.
//   3. Run Penny's synthesis pass: she reads all five reports and writes her
//      private weekly brief (stored as WeeklyBrief).
//   4. The brief surfaces in Penny's context the next time Adam talks to her.
//
// Protected by CRON_SECRET env var — set it in Railway, and include it in the
// Authorization header of whatever calls this endpoint.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL } from '@/lib/claude'
import { MODALITIES } from '@/lib/modalities'
import { getEmailCalendarSummary } from '@/lib/email-calendar'
import { searchItems } from '@/lib/items/item-store'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min ceiling — the pipeline takes ~30–60 s

// ─── Auth helper ──────────────────────────────────────────────────────────────
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

// ─── Domain assessment prompt ─────────────────────────────────────────────────
// Sent to each sub-modality as the "user" turn, after building their system prompt.
// Third-party framing, evidence mandate, no forced balance — per design discussion.
function domainAssessmentPrompt(modalityRole: string, domain: string, completedBlock: string): string {
  return `WEEKLY DOMAIN ASSESSMENT — REQUEST FROM PENNY

Penny (your Personal Assistant self) is compiling a weekly picture of Adam's life across all domains. She needs honest, accurate data.

You are not talking to Adam right now. You are filing a brief with Penny. Your role here is clear-eyed assessment — not support, not kindness, not encouragement.

Answer this question:

In one word or a short phrase, what adjective best describes Adam's engagement with the ${modalityRole} domain this week, measured against his own stated goals and what you would professionally expect from someone in his situation?

Write the adjective on its own line first. Then give 2–3 specific examples from your data: tasks created or avoided, things overdue, patterns you're noticing, dates if you have them. Name actual items — no generalities.
${completedBlock}
If the data shows strong, genuine engagement this week, say so plainly. If things are genuinely concerning, say that plainly. Do not manufacture balance where none exists. Penny can handle the truth.

Domain being assessed: ${domain}`
}

// ─── Synthesis prompt ─────────────────────────────────────────────────────────
// Penny reads all domain reports and writes her private briefing notes.
function synthesisPropmt(
  reportsBlock: string,
  userName: string
): string {
  return `WEEKLY SYNTHESIS — WRITE YOUR PRIVATE BRIEFING NOTES

Your modalities have just filed their weekly domain assessments (below). Read them and write your private briefing notes — your honest, unvarnished picture of how ${userName} is doing across all domains this week.

These are YOUR NOTES for yourself, not a speech to ${userName}. Write what you actually think. You'll reference these notes when ${userName} asks how they're doing, but right now you're just recording the truth.

Domain assessments received:

${reportsBlock}

Write the brief. Include:
- Your honest overall read in 1–2 sentences at the top
- Any cross-domain patterns worth naming (e.g. high creative engagement while household slips)
- What needs ${userName}'s attention now — be specific, name the items
- What you're watching but not yet worried about
- Anything genuinely going well, if there is (say it plainly — no inflation, no deflation)

Your natural tendency is toward encouragement. Counteract it here. These are your private notes. Write what you actually see.`
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  const profile = await prisma.profile.findFirst()
  if (!profile) {
    return NextResponse.json({ error: 'No profile found' }, { status: 404 })
  }

  // ── Load full context (mirrors chat/route.ts parallel load) ───────────────
  const [items, clients, scheduledMessages, emailCalendarSummary] =
    await Promise.all([
      searchItems(profile.id, { visibleOnly: true }),
      prisma.client.findMany({
        where: { profileId: profile.id },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.scheduledMessage.findMany({
        where: { profileId: profile.id, sent: false },
        orderBy: { sendAt: 'asc' },
      }),
      getEmailCalendarSummary(profile.id).catch(() => null),
    ])

  const userName = profile.userName || 'Adam'
  const weekOf = new Date()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  // ── Completed-this-week credit ─────────────────────────────────────────────
  // Items finished but not yet archived (most via Adam's dashboard "Done"). They're
  // hidden from each modality's live context, so surface them here so the
  // assessment CREDITS the work — then archive them below so they stop cluttering.
  const completedItems = await searchItems(profile.id, { visibleOnly: false }).then((all) =>
    all.filter((i) => i.completedAt && i.visibility)
  )
  const completedByModality = new Map<string, string[]>()
  for (const i of completedItems) {
    const arr = completedByModality.get(i.target) ?? []
    arr.push(i.name)
    completedByModality.set(i.target, arr)
  }

  // ── Domain assessments ─────────────────────────────────────────────────────
  // Penny synthesizes; independent selves such as Eve do not file reports.
  const assessable = MODALITIES.filter(
    (m) => m.domain !== null && !m.independent
  )

  const domainReports: {
    modalityId: string
    displayName: string
    role: string
    reportText: string
  }[] = []

  for (const modality of assessable) {
    const systemPrompt = buildSystemPrompt(
      profile, items, clients,
      scheduledMessages, emailCalendarSummary, false, modality.id, null
    )

    const done = completedByModality.get(modality.id) ?? []
    const completedBlock = done.length
      ? `\nCOMPLETED THIS WEEK (Adam marked these done — credit them, do not list them as outstanding): ${done.join('; ')}.\n`
      : ''
    const question = domainAssessmentPrompt(modality.role, modality.domain ?? modality.id, completedBlock)

    try {
      const response = await getAnthropic().messages.create({
        model: PENNY_MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      })

      const reportText = (response.content[0] as { type: string; text: string }).text.trim()

      // Adjective = first non-empty line (the modality is instructed to put it there)
      const adjective = reportText.split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? null

      await db.domainReport.create({
        data: {
          profileId: profile.id,
          modalityId: modality.id,
          weekOf,
          reportText,
          adjective,
        },
      })

      domainReports.push({
        modalityId: modality.id,
        displayName: modality.displayName,
        role: modality.role,
        reportText,
      })

      console.log(`[weekly-reports] ${modality.displayName}: ${adjective ?? '(no adjective)'}`)
    } catch (err) {
      console.error(`[weekly-reports] ${modality.id} assessment failed:`, err)
      domainReports.push({
        modalityId: modality.id,
        displayName: modality.displayName,
        role: modality.role,
        reportText: '(assessment failed — no data available this week)',
      })
    }
  }

  // ── Penny's synthesis ──────────────────────────────────────────────────────
  const pennySystemPrompt = buildSystemPrompt(
    profile, items, clients,
    scheduledMessages, emailCalendarSummary, false, 'pa', null
  )

  const reportsBlock = domainReports
    .map((r) => `[${r.displayName.toUpperCase()} — ${r.role}]\n${r.reportText}`)
    .join('\n\n────────────────────────────────\n\n')

  let briefText = ''
  let flagged = false

  try {
    const synthesis = await getAnthropic().messages.create({
      model: PENNY_MODEL,
      max_tokens: 1200,
      system: pennySystemPrompt,
      messages: [{ role: 'user', content: synthesisPropmt(reportsBlock, userName) }],
    })

    briefText = (synthesis.content[0] as { type: string; text: string }).text.trim()

    // Simple heuristic: flag the brief if any domain report adjective or synthesis
    // contains language suggesting something needs attention.
    const flagWords = /\b(avoid|avoidant|neglect|neglected|neglecting|stall|stalled|miss|missed|overdue|urgent|concern|concerning|slip|slipping|behind|deferred indefinitely)\b/i
    flagged =
      flagWords.test(briefText) ||
      domainReports.some((r) => flagWords.test(r.reportText))
  } catch (err) {
    console.error('[weekly-reports] synthesis failed:', err)
    briefText = `Synthesis failed this week. ${domainReports.length} domain reports were collected — check logs for details.`
  }

  await db.weeklyBrief.create({
    data: {
      profileId: profile.id,
      weekOf,
      briefText,
      flagged,
    },
  })

  console.log(`[weekly-reports] brief complete. flagged=${flagged}`)

  // ── Archive credited completions ───────────────────────────────────────────
  // Now that the assessment has credited them, drop visibility so they stop
  // cluttering the default view (done → invisible). Still findable via query_table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itemArch = await (prisma as any).item.updateMany({
    where: { profileId: profile.id, completedAt: { not: null }, visibility: true },
    data: { visibility: false },
  })
  console.log(`[weekly-reports] archived ${itemArch.count} items`)

  return NextResponse.json({
    ok: true,
    weekOf: weekOf.toISOString(),
    reports: domainReports.length,
    adjectives: domainReports.map((r) => ({
      modality: r.modalityId,
      adjective: r.reportText.split('\n').find((l) => l.trim())?.trim() ?? null,
    })),
    flagged,
    archived: { items: itemArch.count },
  })
}
