// Engine chips — the visible, factual "what actually changed" markers shown during
// a review (max-visibility, per design). Computed PURELY by diffing a snapshot of
// the items before a turn against the snapshot after. This is the "report from the
// DB, not from the LLM" mechanism: if the model claimed it did something the diff
// doesn't show, no chip appears — and the claim stands exposed.

export interface ItemSnapshot {
  id: string
  name: string
  target: string
  paStatus: string | null
  modalityStatus: string | null
  visibility: boolean
  // Tracked editable fields — so a change to any of these can't slip past unseen.
  type: string
  priority: number
  duration: string | null
  dayTime: string | null
  projectId: string | null
  dueDate: string | null // ISO date (YYYY-MM-DD) so it compares by value, not ref
  notes: string
  contingency: string
  contingencyUntil: string | null // ISO date, same reasoning as dueDate
}

// The editable fields a `field` chip reports on (name + the update_item surface).
const TRACKED_FIELDS = ['name', 'type', 'priority', 'duration', 'dayTime', 'projectId', 'dueDate', 'notes', 'contingency', 'contingencyUntil'] as const

export type EngineChip =
  | { kind: 'created'; id: string; name: string; target: string; status: string }
  | { kind: 'status'; id: string; name: string; side: 'pa' | 'modality'; from: string | null; to: string }
  | { kind: 'field'; id: string; name: string; field: string; from: string | null; to: string | null }
  | { kind: 'deleted'; id: string; name: string }

/** Diff two item snapshots into the chips to show for this turn. */
export function computeChips(before: ItemSnapshot[], after: ItemSnapshot[]): EngineChip[] {
  const beforeById = new Map(before.map((i) => [i.id, i]))
  const afterById = new Map(after.map((i) => [i.id, i]))
  const chips: EngineChip[] = []

  // Created or newly-visible: present after, absent (or invisible) before.
  for (const a of after) {
    const b = beforeById.get(a.id)
    if (!a.visibility) continue // not shown
    if (!b || !b.visibility) {
      chips.push({
        kind: 'created',
        id: a.id,
        name: a.name,
        target: a.target,
        status: a.paStatus ?? a.modalityStatus ?? 'new',
      })
    }
  }

  // Status + field changes, for items present (and visible) in both snapshots.
  for (const a of after) {
    const b = beforeById.get(a.id)
    if (!b || !a.visibility || !b.visibility) continue
    if (a.paStatus !== b.paStatus) {
      chips.push({ kind: 'status', id: a.id, name: a.name, side: 'pa', from: b.paStatus, to: a.paStatus ?? '∅' })
    }
    if (a.modalityStatus !== b.modalityStatus) {
      chips.push({ kind: 'status', id: a.id, name: a.name, side: 'modality', from: b.modalityStatus, to: a.modalityStatus ?? '∅' })
    }
    for (const f of TRACKED_FIELDS) {
      if (a[f] !== b[f]) {
        const str = (v: string | number | null) => (v === null ? null : String(v))
        chips.push({ kind: 'field', id: a.id, name: a.name, field: f, from: str(b[f]), to: str(a[f]) })
      }
    }
  }

  // Deleted or archived: present+visible before, now gone or hidden.
  for (const b of before) {
    if (!b.visibility) continue
    const a = afterById.get(b.id)
    if (!a || !a.visibility) {
      chips.push({ kind: 'deleted', id: b.id, name: b.name })
    }
  }

  return chips
}

/** One-line label for a chip — the text shown in the `engine · …` marker. */
export function chipLabel(c: EngineChip): string {
  switch (c.kind) {
    case 'created':
      return `new item · "${c.name}" · target = ${c.target} · ${c.status}`
    case 'status':
      return `"${c.name}" · ${c.side}Status ${c.from ?? '∅'} → ${c.to}`
    case 'field':
      // notes can be long free text — show that it changed, not the full diff.
      return c.field === 'notes'
        ? `"${c.name}" · notes updated`
        : `"${c.name}" · ${c.field} ${c.from ?? '∅'} → ${c.to ?? '∅'}`
    case 'deleted':
      return `deleted · "${c.name}"`
  }
}
