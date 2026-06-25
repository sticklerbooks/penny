// Prewarm endpoint — called by the client on app open and when the modality
// switcher opens, so the first real turn for a self isn't paying full cold-start
// cost. It does the two serial things that otherwise block the first token:
//
//   1. Warms the in-memory context bundle (the Turso fan-out + the email/calendar
//      summary), so the foreground chat turn reads it instantly.
//   2. Fires a tiny (max_tokens: 1) model call with that self's cached system
//      prefix, so the Anthropic prompt cache is warm (1h TTL) when the real
//      message lands.
//
// Best-effort and cheap: any failure is swallowed. Not auth-gated beyond the
// app's normal login gate (it reads nothing sensitive back to the caller).

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, cachedSystem, PENNY_MODEL } from '@/lib/claude'
import { getModality } from '@/lib/modalities'
import { getContextBundle, getModalityBrief, getModalityIdentity } from '@/lib/context-cache'
import { getEmailCalendarSummary } from '@/lib/email-calendar'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  try {
    const { modalityId } = await req.json().catch(() => ({ modalityId: 'pa' }))
    const id = typeof modalityId === 'string' && modalityId ? modalityId : 'pa'

    const profile = await prisma.profile.findFirst()
    if (!profile) return NextResponse.json({ ok: false, reason: 'no profile' })

    // (1) Warm the context bundle — this is the expensive serial part.
    const { memories, items, clients, scheduledMessages, weeklyBrief, projects } =
      await getContextBundle(profile.id)

    // (2) Warm the prompt cache for this self with a throwaway 1-token call.
    // Email/calendar is PA-only, mirroring the chat route, so the warmed prefix
    // matches the real call's cached prefix exactly.
    const [brief, identity, emailCalendarSummary] = await Promise.all([
      getModalityBrief(profile.id, id),
      getModalityIdentity(profile.id, id),
      getModality(id).domain === null
        ? getEmailCalendarSummary(profile.id).catch(() => null)
        : Promise.resolve(null),
    ])

    const system = buildSystemPrompt(
      profile, memories, items, clients,
      scheduledMessages, emailCalendarSummary,
      !profile.intakeComplete, id, weeklyBrief,
      brief, projects, identity
    )

    await getAnthropic().messages
      .create({
        model: PENNY_MODEL,
        max_tokens: 1,
        system: cachedSystem(system),
        messages: [{ role: 'user', content: 'warm' }],
      })
      .catch(() => {})

    return NextResponse.json({ ok: true, modalityId: getModality(id).id })
  } catch {
    return NextResponse.json({ ok: false })
  }
}
