// Minimal single-password auth for Penny.
//
// One shared password (PENNY_PASSWORD) unlocks the app. On success we set a
// long-lived signed cookie so that device stays logged in; new devices hit the
// login wall. The cookie value is an HMAC over a constant, signed with
// AUTH_SECRET — it can't be forged without the secret, and rotating AUTH_SECRET
// logs every device out.
//
// SAFETY: auth is only ENFORCED when both env vars are set. If either is
// missing, auth is disabled (fail-open) so deploying this code can't lock
// anyone out before the env vars are configured on the host.

import crypto from 'node:crypto'

export const AUTH_COOKIE = 'penny_auth'

const PASSWORD = process.env.PENNY_PASSWORD
const SECRET = process.env.AUTH_SECRET

export function authEnabled(): boolean {
  return !!PASSWORD && !!SECRET
}

// The expected cookie value: a stable signed token.
export function expectedToken(): string {
  return crypto.createHmac('sha256', SECRET ?? '').update('penny-auth-v1').digest('hex')
}

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function verifyPassword(input: string): boolean {
  if (!PASSWORD) return false
  return safeEqual(input, PASSWORD)
}

export function verifyToken(token: string | undefined): boolean {
  if (!token || !SECRET) return false
  return safeEqual(token, expectedToken())
}
