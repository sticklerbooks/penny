// In-memory cache for the per-message "preamble" — the heavy fan-out of DB
// queries the chat route runs before the model can start generating. This data
// (memories, tasks, notes, clients, scheduled messages, projects, pending
// events, weekly brief, and each modality's brief + identity) barely changes
// turn-to-turn, but against Turso (remote SQLite) every query is a network
// round-trip. Re-fetching all of it on every keystroke-length voice turn was a
// big chunk of the "thinking" lag.
//
// Strategy:
//   • Module-level cache keyed by profileId. Railway runs a long-lived
//     `next start`, so this persists across requests on the instance.
//   • A short TTL backstop (so out-of-band changes — background memory
//     extraction, cron writes — surface within a minute).
//   • Explicit invalidation on every mutating tool call (see executeTool), so
//     within a live conversation the cache is never stale: the moment Penny
//     writes anything, the next turn refetches.
//
// The Profile row itself is deliberately NOT cached here — it carries focus-lock
// state that must always be fresh, and it's a single cheap query.

import { prisma } from './db'
import type { Memory } from '../generated/prisma/client'
import type { WeeklyBriefSummary, ModalityIdentityLite } from './claude'

const TTL_MS = 60_000 // backstop; writes invalidate explicitly

// ─── Profile-scoped fan-out ──────────────────────────────────────────────────

async function fetchBundle(profileId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  // NOTE: memories are NOT fetched here — they're not rendered into any turn
  // (recall is on-demand via search_memory / search_deep_memory). The
  // email/calendar summary is also not here: it's PA-only and fetched in the
  // chat route just for her (its own 30-min cache covers repeat turns), so the
  // six submodalities never pay the Google + Haiku cost.
  const [tasks, notes, clients, scheduledMessages, weeklyBrief, projects, pendingEvents] =
    await Promise.all([
      prisma.task.findMany({
        where: { profileId, status: { not: 'Complete' } },
      }),
      prisma.note.findMany({
        where: { profileId, resolution: 'Open' },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.client.findMany({
        where: { profileId },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.scheduledMessage.findMany({
        where: { profileId, sent: false },
        orderBy: { sendAt: 'asc' },
      }),
      db.weeklyBrief
        .findFirst({ where: { profileId }, orderBy: { createdAt: 'desc' } })
        .catch(() => null) as Promise<WeeklyBriefSummary | null>,
      prisma.project.findMany({
        where: { profileId, progress: { lt: 10 } },
        orderBy: { updatedAt: 'desc' },
      }).catch(() => []),
      prisma.pendingCalendarEvent.findMany({
        where: { profileId, scheduled: false },
        orderBy: { createdAt: 'desc' },
      }).catch(() => []),
    ])

  return { memories: [] as Memory[], tasks, notes, clients, scheduledMessages, weeklyBrief, projects, pendingEvents }
}

export type ContextBundle = Awaited<ReturnType<typeof fetchBundle>>

// ─── Cache store ─────────────────────────────────────────────────────────────

interface CacheEntry {
  fetchedAt: number
  bundle: ContextBundle
  briefs: Map<string, string | null>            // modalityId → brief content
  identities: Map<string, ModalityIdentityLite | null>
}

const cache = new Map<string, CacheEntry>()

async function entry(profileId: string): Promise<CacheEntry> {
  const hit = cache.get(profileId)
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit
  const bundle = await fetchBundle(profileId)
  const fresh: CacheEntry = { fetchedAt: Date.now(), bundle, briefs: new Map(), identities: new Map() }
  cache.set(profileId, fresh)
  return fresh
}

// ─── Public getters ──────────────────────────────────────────────────────────

// The full profile-scoped fan-out the system prompt is built from.
export async function getContextBundle(profileId: string): Promise<ContextBundle> {
  return (await entry(profileId)).bundle
}

// A modality's running brief (rewrite_brief tool). Cached per modality within the
// same TTL window as the bundle. The ModalityBrief table may not exist yet in the
// live DB, so always catch.
export async function getModalityBrief(profileId: string, modalityId: string): Promise<string | null> {
  const e = await entry(profileId)
  if (e.briefs.has(modalityId)) return e.briefs.get(modalityId) ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rec = await db.modalityBrief
    .findUnique({ where: { profileId_modalityId: { profileId, modalityId } } })
    .catch(() => null) as { content: string } | null
  const content = rec?.content ?? null
  e.briefs.set(modalityId, content)
  return content
}

// A modality's identity (self-portrait + its slice of the user). May not exist
// yet — callers fall back to the persona seed when null.
export async function getModalityIdentity(profileId: string, modalityId: string): Promise<ModalityIdentityLite | null> {
  const e = await entry(profileId)
  if (e.identities.has(modalityId)) return e.identities.get(modalityId) ?? null
  const rec = await prisma.modalityIdentity
    .findUnique({ where: { profileId_modalityId: { profileId, modalityId } } })
    .catch(() => null)
  e.identities.set(modalityId, rec as ModalityIdentityLite | null)
  return rec as ModalityIdentityLite | null
}

// ─── Invalidation ────────────────────────────────────────────────────────────

// Drop everything cached for a profile. Called after any mutating tool so the
// next turn rebuilds context from fresh data.
export function invalidateContext(profileId: string): void {
  cache.delete(profileId)
}
