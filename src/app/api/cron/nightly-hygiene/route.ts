// Nightly hygiene cron — RETIRED. This used to run a prose-driven LLM pass each
// night to catch duplicates/staleness left over from a tool surface that didn't
// prevent them. The Item tool surface (search-first creation, append_note instead
// of minting a new item) is correct by construction, so this job no longer has
// anything to clean up. Kept as a 200 no-op rather than deleted outright, in case
// the external Railway cron schedule still calls it — remove the schedule there
// when convenient.

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, ran: [], message: 'Nightly hygiene retired — the Item tool surface no longer needs a broom pass.' })
}
