// Auth gate — Next.js 16 "Proxy" (formerly Middleware). Runs on the Node.js
// runtime, so node:crypto in @/lib/auth is fine here.
//
// Logged-in devices carry the penny_auth cookie and pass straight through;
// everyone else is sent to /login. Auth is skipped entirely until both
// PENNY_PASSWORD and AUTH_SECRET are configured (see lib/auth).

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE, authEnabled, verifyToken } from '@/lib/auth'

// Paths that never require the cookie:
// - the login page and its endpoints
// - the health check (Railway pings it with no cookie)
// - cron endpoints (protected by CRON_SECRET, called by Railway with no cookie)
const PUBLIC_PATHS = ['/login', '/api/login', '/api/logout', '/api/health']

function isPublic(pathname: string): boolean {
  if (pathname.startsWith('/api/cron')) return true
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export function proxy(request: NextRequest) {
  // Auth disabled until configured — never lock anyone out by deploy alone.
  if (!authEnabled()) return NextResponse.next()

  const { pathname } = request.nextUrl
  if (isPublic(pathname)) return NextResponse.next()

  const token = request.cookies.get(AUTH_COOKIE)?.value
  if (verifyToken(token)) return NextResponse.next()

  // Not authenticated: APIs get a clean 401; pages get redirected to login.
  if (pathname.startsWith('/api')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  return NextResponse.redirect(url)
}

export const config = {
  // Run on everything except Next internals and static asset files (the public
  // avatars/backgrounds are .png and must load on the login page unauthenticated).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|woff2?)$).*)'],
}
