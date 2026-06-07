import { NextRequest, NextResponse } from 'next/server'
import { AUTH_COOKIE, authEnabled, verifyPassword, expectedToken } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const password = String(body?.password ?? '')

  // If auth isn't configured, there's nothing to log into — say so plainly.
  if (!authEnabled()) {
    return NextResponse.json({ ok: true, note: 'auth not configured' })
  }

  if (!verifyPassword(password)) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set(AUTH_COOKIE, expectedToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365, // ~1 year — keeps this device logged in
  })
  return res
}
