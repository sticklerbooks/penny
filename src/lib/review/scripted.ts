// Scripted phase work — the deterministic mutations the engine performs ITSELF, so
// the LLM is never asked to "remember" to do them. Each runs at a defined point in
// the phase walk (see runner.ts). All idempotent enough to survive a re-run.

import { prisma } from '@/lib/db'
import { MODALITIES } from '@/lib/modalities'
import { checkSubmodality, type SubmodalityVerdict } from './selectors'
import { notesPassQueue } from './selectors'
import {
  createItem,
  setItemStatus,
  hardDeleteItem,
  searchItems,
} from '@/lib/items/item-store'
import type { ModalityStatus } from '@/lib/items/fsm'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

const submodalities = () => MODALITIES.filter((m) => !m.disabled && m.domain !== null && !m.independent)

// ─── submodalities phase (Penny) ────────────────────────────────────────────────
// Book a "talk to <self>" for any self that's overdue/flagged, and bump attention
// for any whose item count is out of band. Runs BEFORE Penny sees the phase.
export async function runSubmodalitiesPrep(
  profileId: string,
  now: Date = new Date()
): Promise<SubmodalityVerdict[]> {
  const verdicts: SubmodalityVerdict[] = []
  for (const m of submodalities()) {
    const state = await db().modalityState.findUnique({
      where: { profileId_modalityId: { profileId, modalityId: m.id } },
    })
    const items = await searchItems(profileId, { target: m.id })
    const verdict = checkSubmodality(
      {
        modalityId: m.id,
        lastContactAt: state?.lastCompletedAt ?? null,
        needsAttention: state?.needsAttention ?? 0,
        itemCount: items.length,
      },
      now
    )
    verdicts.push(verdict)

    if (verdict.shouldTalk) {
      // Dedup: don't book a second talk if one is already queued/scheduled.
      const existing = await searchItems(profileId, { target: 'pa' })
      const already = existing.some(
        (i) => i.name === `Talk to ${m.displayName}` && (i.paStatus === 'schedule' || i.paStatus === 'scheduled')
      )
      if (!already) {
        await createItem(profileId, {
          name: `Talk to ${m.displayName}`,
          description: `Check in on ${m.displayName} (${m.role}) — ${verdict.reason}.`,
          type: 'event',
          target: 'pa',
          createdBy: 'pa',
          duration: `${verdict.durationMinutes} min`,
          priority: 3,
          paStatus: 'schedule',
        })
      }
    }

    if (verdict.needsAttentionDelta) {
      await db().modalityState.upsert({
        where: { profileId_modalityId: { profileId, modalityId: m.id } },
        update: { needsAttention: (state?.needsAttention ?? 0) + verdict.needsAttentionDelta },
        create: { profileId, modalityId: m.id, needsAttention: verdict.needsAttentionDelta },
      })
    }
  }
  return verdicts
}

// ─── notes-pass phase (submodality) ─────────────────────────────────────────────
// For each item flagged sent-to-PA, spawn a fresh PA-targeted copy and return the
// original to pending (it keeps living in the self's world). Runs when notes-pass
// completes. Uses the same Note-2 queue the self reviewed.
export async function runNotesPassCopyUp(
  profileId: string,
  sessionStartedAt: Date
): Promise<{ copied: number }> {
  const all = await searchItems(profileId, {})
  const queue = notesPassQueue(
    all.map((i) => ({ id: i.id, modalityStatus: i.modalityStatus as ModalityStatus | null, createdAt: i.createdAt })),
    sessionStartedAt
  )
  const byId = new Map(all.map((i) => [i.id, i]))
  let copied = 0
  for (const q of queue) {
    if (q.modalityStatus !== 'sent-to-PA') continue // only the ones actually escalated
    const it = byId.get(q.id)!
    await createItem(profileId, {
      name: it.name,
      description: it.description,
      type: it.type,
      target: 'pa',
      createdBy: it.createdBy,
      projectId: it.projectId,
      priority: it.priority,
      duration: it.duration,
      dayTime: it.dayTime,
      paStatus: 'new',
    })
    await setItemStatus(it.id, 'modality', 'pending') // sent-to-PA → pending
    copied++
  }
  return { copied }
}

// ─── wrap-up phase (both) ───────────────────────────────────────────────────────
// Hard-delete everything flagged to-delete, then reset the reviewed self's state:
// date of last contact = now, needs-attention = 0. (Memory-writing + brief rewrite
// are left to the self's own tools / a later pass.)
export async function runWrapUp(
  profileId: string,
  modalityId: string,
  now: Date = new Date()
): Promise<{ deleted: number }> {
  const all = await searchItems(profileId, { visibleOnly: false })
  let deleted = 0
  for (const it of all) {
    if (it.paStatus === 'to-delete' || it.modalityStatus === 'to-delete') {
      await hardDeleteItem(it.id)
      deleted++
    }
  }
  await db().modalityState.upsert({
    where: { profileId_modalityId: { profileId, modalityId } },
    update: { lastCompletedAt: now, needsAttention: 0 },
    create: { profileId, modalityId, lastCompletedAt: now, needsAttention: 0 },
  })
  return { deleted }
}
