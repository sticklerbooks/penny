// Per-modality activity tracking. Drives "which modalities need a nightly
// Shift Complete" — a modality is "dirty" when lastActiveAt > lastCompletedAt.

import { prisma } from './db'

// Stamp that a modality was active this turn.
export async function touchActive(profileId: string, modalityId: string): Promise<void> {
  const now = new Date()
  await prisma.modalityState.upsert({
    where: { profileId_modalityId: { profileId, modalityId } },
    create: { profileId, modalityId, lastActiveAt: now },
    update: { lastActiveAt: now },
  }).catch(() => {})
}

// Stamp that a modality just ran a Shift/Session Complete.
export async function touchCompleted(profileId: string, modalityId: string): Promise<void> {
  const now = new Date()
  await prisma.modalityState.upsert({
    where: { profileId_modalityId: { profileId, modalityId } },
    create: { profileId, modalityId, lastCompletedAt: now },
    update: { lastCompletedAt: now },
  }).catch(() => {})
}

// Modalities that have been used since they last completed (i.e. need a Shift
// Complete tonight). Used by the nightly cron in a later phase.
export async function dirtyModalities(profileId: string): Promise<string[]> {
  const states = await prisma.modalityState.findMany({ where: { profileId } })
  return states
    .filter((s) => s.lastActiveAt && (!s.lastCompletedAt || s.lastActiveAt > s.lastCompletedAt))
    .map((s) => s.modalityId)
}
