// Stage-3 cutover mappers — old Task / Note / Routine → new Item input. PURE +
// unit-tested. Every modality label is normalized to a stable id here (this is
// where the ~8 display-name notes like "june"/"margot" get fixed), and the old
// status/type vocabularies are translated to the new model. The migration endpoint
// (api/admin/cutover) just loops these over the live rows.

import { resolveModality } from '@/lib/modalities'
import type { CreateItemInput } from './item-store'

/** Normalize any modality label (stable id OR display name OR alias) → stable id.
 *  Falls back to 'pa' for anything unrecognized, so nothing lands unowned. */
export function canonLabel(raw: string | null | undefined): string {
  if (!raw) return 'pa'
  return resolveModality(raw)?.id ?? 'pa'
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))

// Place a migrated item on the correct lifecycle side: PA-owned items use paStatus,
// a submodality's own items use modalityStatus.
function sided(target: string, status: 'new' | 'pending' | 'continuing'): Partial<CreateItemInput> {
  return target === 'pa'
    ? { paStatus: status, modalityStatus: undefined }
    : { modalityStatus: status, paStatus: undefined }
}

export interface OldTask {
  id: string
  name: string
  description: string | null
  priority: number | null
  assignedModality: string | null
  projectId: string | null
  status: string | null
}

export interface OldNote {
  id: string
  title: string
  content: string | null
  modalityTarget: string | null
  source: string | null
}

export interface OldRoutine {
  id: string
  description: string
  priority: number | null
  assignedModality: string | null
  dayTime: string | null
}

export interface Mapped {
  input: CreateItemInput
  sourceRef: string
}

// A task → an ongoing item, owned by its (normalized) modality, landing as pending
// (active, known — not 'new', so the first review isn't 103 forced triages). The
// review can reclassify type/status from there.
export function taskToItem(t: OldTask): Mapped {
  const target = canonLabel(t.assignedModality)
  return {
    input: {
      name: t.name,
      description: t.description || t.name,
      type: 'ongoing',
      target,
      createdBy: target,
      projectId: t.projectId ?? null,
      priority: clamp(t.priority ?? 2, 0, 5),
      sourceRef: `task:${t.id}`,
      ...sided(target, 'pending'),
    },
    sourceRef: `task:${t.id}`,
  }
}

// A note → a suggestion aimed at its (normalized) target, landing as 'new' so the
// next review is guaranteed to force it to a real status. createdBy = its source.
export function noteToItem(n: OldNote): Mapped {
  const target = canonLabel(n.modalityTarget)
  return {
    input: {
      name: n.title,
      description: n.content || n.title,
      type: 'suggestion',
      target,
      createdBy: canonLabel(n.source),
      priority: 2,
      sourceRef: `note:${n.id}`,
      ...sided(target, 'new'),
    },
    sourceRef: `note:${n.id}`,
  }
}

// A routine → a continuing (recurring source) item in its modality's world.
export function routineToItem(r: OldRoutine): Mapped {
  const target = canonLabel(r.assignedModality)
  return {
    input: {
      name: r.description.slice(0, 60),
      description: r.description,
      type: 'ongoing',
      target,
      createdBy: target,
      priority: clamp(r.priority ?? 2, 0, 5),
      dayTime: r.dayTime ?? null,
      sourceRef: `routine:${r.id}`,
      ...sided(target, 'continuing'),
    },
    sourceRef: `routine:${r.id}`,
  }
}
