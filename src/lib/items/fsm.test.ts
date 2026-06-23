import { describe, it, expect } from 'vitest'
import {
  ITEM_TYPES,
  PA_STATUSES,
  MODALITY_STATUSES,
  PA_TRANSITIONS,
  MODALITY_TRANSITIONS,
  PA_ENTRY_STATES,
  MODALITY_ENTRY_STATES,
  isItemType,
  isPaStatus,
  isModalityStatus,
  canTransitionPa,
  canTransitionModality,
  transitionPa,
  transitionModality,
  nextPaStatuses,
  nextModalityStatuses,
  isPaTerminal,
  isModalityTerminal,
  type PaStatus,
  type ModalityStatus,
} from './fsm'

describe('type guards', () => {
  it('accepts members and rejects everything else', () => {
    expect(isItemType('event')).toBe(true)
    expect(isItemType('Ongoing Task')).toBe(false) // spec display label, not the key
    expect(isItemType(null)).toBe(false)
    expect(isPaStatus('scheduled')).toBe(true)
    expect(isPaStatus('sent-to-PA')).toBe(false) // that's a modality status
    expect(isPaStatus(undefined)).toBe(false)
    expect(isModalityStatus('sent-to-PA')).toBe(true)
    expect(isModalityStatus('scheduled')).toBe(false) // that's a PA status
  })
})

describe('structural invariants', () => {
  it('every PA status has a transition entry, and targets are all valid statuses', () => {
    for (const s of PA_STATUSES) {
      expect(PA_TRANSITIONS[s]).toBeDefined()
      for (const t of PA_TRANSITIONS[s]) expect(isPaStatus(t)).toBe(true)
    }
  })

  it('every modality status has a transition entry, and targets are all valid statuses', () => {
    for (const s of MODALITY_STATUSES) {
      expect(MODALITY_TRANSITIONS[s]).toBeDefined()
      for (const t of MODALITY_TRANSITIONS[s]) expect(isModalityStatus(t)).toBe(true)
    }
  })

  it('to-delete is the only hard sink on each side', () => {
    expect(PA_STATUSES.filter(isPaTerminal)).toEqual(['to-delete'])
    expect(MODALITY_STATUSES.filter(isModalityTerminal)).toEqual(['to-delete'])
  })

  it('entry states are themselves valid statuses', () => {
    for (const s of PA_ENTRY_STATES) expect(isPaStatus(s)).toBe(true)
    for (const s of MODALITY_ENTRY_STATES) expect(isModalityStatus(s)).toBe(true)
  })

  it('every non-sink state is reachable from a null entry (no orphans)', () => {
    const reach = (entries: readonly string[], table: Record<string, readonly string[]>) => {
      const seen = new Set<string>(entries)
      const stack = [...entries]
      while (stack.length) {
        for (const next of table[stack.pop()!]) if (!seen.has(next)) { seen.add(next); stack.push(next) }
      }
      return seen
    }
    const paReach = reach(PA_ENTRY_STATES, PA_TRANSITIONS as Record<string, readonly string[]>)
    for (const s of PA_STATUSES) expect(paReach.has(s)).toBe(true)
    const modReach = reach(MODALITY_ENTRY_STATES, MODALITY_TRANSITIONS as Record<string, readonly string[]>)
    for (const s of MODALITY_STATUSES) expect(modReach.has(s)).toBe(true)
  })
})

describe('PA-side review moves (from the spec)', () => {
  it('null item may only enter at an entry state', () => {
    for (const s of PA_ENTRY_STATES) expect(canTransitionPa(null, s)).toBe(true)
    // derived states are never valid first states
    expect(canTransitionPa(null, 'scheduled')).toBe(false)
    expect(canTransitionPa(null, 'completed')).toBe(false)
    expect(canTransitionPa(null, 'to-delete')).toBe(false)
  })

  it('a new note must be triaged out of new', () => {
    // notes phase: none may be left as new — every entry status is reachable
    for (const s of ['pending', 'schedule', 'continuing', 'completed', 'to-delete'] as PaStatus[]) {
      expect(canTransitionPa('new', s)).toBe(true)
    }
  })

  it('pending → continuing (reclassify a pending event as an ongoing task)', () => {
    expect(transitionPa('pending', 'continuing')).toEqual({ ok: true, from: 'pending', to: 'continuing' })
  })

  it('pending may stay pending', () => {
    expect(canTransitionPa('pending', 'pending')).toBe(true)
  })

  it('continuing → pending (collapse an ongoing task to a single event)', () => {
    expect(canTransitionPa('continuing', 'pending')).toBe(true)
  })

  it('schedule → scheduled (calendar phase places it)', () => {
    expect(transitionPa('schedule', 'scheduled').ok).toBe(true)
  })

  it('completed is near-terminal: only to-delete remains', () => {
    expect(nextPaStatuses('completed')).toEqual(['to-delete'])
    expect(canTransitionPa('completed', 'scheduled')).toBe(false)
  })

  it('illegal moves return ok:false with a reason, never throw', () => {
    const r = transitionPa('scheduled', 'new')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cannot move scheduled → new/)
    const bad = transitionPa('new', 'bogus' as PaStatus)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/not a PA status/)
  })

  it('to-delete is a sink', () => {
    expect(nextPaStatuses('to-delete')).toEqual([])
    expect(canTransitionPa('to-delete', 'pending')).toBe(false)
  })
})

describe('modality-side review moves (from the spec)', () => {
  it('null item may only enter at an entry state', () => {
    for (const s of MODALITY_ENTRY_STATES) expect(canTransitionModality(null, s)).toBe(true)
    expect(canTransitionModality(null, 'sent-to-PA')).toBe(false)
    expect(canTransitionModality(null, 'completed')).toBe(false)
  })

  it('pending → sent-to-PA (escalate for scheduling)', () => {
    expect(transitionModality('pending', 'sent-to-PA').ok).toBe(true)
  })

  it('sent-to-PA → pending (notes-pass returns the original after copying it up)', () => {
    expect(nextModalityStatuses('sent-to-PA')).toEqual(['pending', 'to-delete'])
    expect(canTransitionModality('sent-to-PA', 'pending')).toBe(true)
  })

  it('blocked can be moved off blocked', () => {
    for (const s of ['pending', 'sent-to-PA', 'completed', 'to-delete'] as ModalityStatus[]) {
      expect(canTransitionModality('blocked', s)).toBe(true)
    }
    expect(canTransitionModality('blocked', 'blocked')).toBe(false) // must actually move
  })

  it('illegal moves return ok:false with a reason', () => {
    const r = transitionModality('completed', 'pending')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cannot move completed → pending/)
  })
})
