import { describe, it, expect } from 'vitest'
import {
  ITEM_TYPES,
  STAGES,
  STAGE_TRANSITIONS,
  ENTRY_STAGES,
  isItemType,
  isStage,
  canTransitionStage,
  transitionStage,
  nextStages,
  isStageTerminal,
  type Stage,
} from './fsm'

describe('type guards', () => {
  it('accepts members and rejects everything else', () => {
    expect(isItemType('event')).toBe(true)
    expect(isItemType('Ongoing Task')).toBe(false) // spec display label, not the key
    expect(isItemType(null)).toBe(false)
    expect(isStage('planned')).toBe(true)
    expect(isStage('sent-to-PA')).toBe(false) // retired vocabulary, no longer a stage
    expect(isStage(undefined)).toBe(false)
  })
})

describe('structural invariants', () => {
  it('every stage has a transition entry, and targets are all valid stages', () => {
    for (const s of STAGES) {
      expect(STAGE_TRANSITIONS[s]).toBeDefined()
      for (const t of STAGE_TRANSITIONS[s]) expect(isStage(t)).toBe(true)
    }
  })

  it('cancelled is the only hard sink', () => {
    expect(STAGES.filter(isStageTerminal)).toEqual(['cancelled'])
  })

  it('entry stages are themselves valid stages', () => {
    for (const s of ENTRY_STAGES) expect(isStage(s)).toBe(true)
  })

  it('every non-sink stage is reachable from a null entry (no orphans)', () => {
    const reach = (entries: readonly string[], table: Record<string, readonly string[]>) => {
      const seen = new Set<string>(entries)
      const stack = [...entries]
      while (stack.length) {
        for (const next of table[stack.pop()!]) if (!seen.has(next)) { seen.add(next); stack.push(next) }
      }
      return seen
    }
    const reached = reach(ENTRY_STAGES, STAGE_TRANSITIONS as Record<string, readonly string[]>)
    for (const s of STAGES) expect(reached.has(s)).toBe(true)
  })
})

describe('stage moves (unified — same for PA and every submodality)', () => {
  it('null item may only enter at an entry stage', () => {
    for (const s of ENTRY_STAGES) expect(canTransitionStage(null, s)).toBe(true)
    // derived stages are never valid first stages
    expect(canTransitionStage(null, 'scheduled')).toBe(false)
    expect(canTransitionStage(null, 'done')).toBe(false)
    expect(canTransitionStage(null, 'cancelled')).toBe(false)
  })

  it('a backlog item must be triaged out of backlog — every entry stage is reachable', () => {
    for (const s of ['planned', 'blocked', 'done', 'cancelled'] as Stage[]) {
      expect(canTransitionStage('backlog', s)).toBe(true)
    }
  })

  it('planned → blocked (stuck on something outside anyone\'s control)', () => {
    expect(transitionStage('planned', 'blocked')).toEqual({ ok: true, from: 'planned', to: 'blocked' })
  })

  it('backlog may stay backlog (a legitimate, considered resting place)', () => {
    expect(canTransitionStage('backlog', 'backlog')).toBe(true)
  })

  it('blocked → planned (the condition cleared)', () => {
    expect(canTransitionStage('blocked', 'planned')).toBe(true)
  })

  it('planned → scheduled (calendar phase places it)', () => {
    expect(transitionStage('planned', 'scheduled').ok).toBe(true)
  })

  it('done is near-terminal: only cancelled remains', () => {
    expect(nextStages('done')).toEqual(['cancelled'])
    expect(canTransitionStage('done', 'scheduled')).toBe(false)
  })

  it('illegal moves return ok:false with a reason, never throw', () => {
    const r = transitionStage('scheduled', 'backlog')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cannot move scheduled → backlog/)
    const bad = transitionStage('backlog', 'bogus' as Stage)
    expect(bad.ok).toBe(false)
    expect(bad.reason).toMatch(/not a stage/)
  })

  it('cancelled is a sink', () => {
    expect(nextStages('cancelled')).toEqual([])
    expect(canTransitionStage('cancelled', 'backlog')).toBe(false)
  })

  it('an item can be BORN blocked (already known to be stuck at creation)', () => {
    expect(canTransitionStage(null, 'blocked')).toBe(true)
  })

  it('scheduled can be pulled back to planned (plans changed before it happened)', () => {
    expect(canTransitionStage('scheduled', 'planned')).toBe(true)
  })
})
