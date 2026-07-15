import { describe, it, expect } from 'vitest'
import {
  PA_PHASES,
  SUB_PHASES,
  phasesFor,
  firstPhase,
  nextPhase,
  isLastPhase,
  isValidPhase,
} from './phases'
import {
  checkSubmodality,
  notesQueue,
  isFutureContingency,
  OVERDUE_DAYS,
  ATTENTION_THRESHOLD,
  ITEM_COUNT_TOO_MANY,
  type SubmodalityCheck,
} from './selectors'

const now = new Date('2026-06-23T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)

describe('phase sequencing', () => {
  it('PA and submodality have the spec phase walks', () => {
    expect(PA_PHASES).toEqual(['notes', 'projects', 'submodalities', 'calendar', 'wrap-up'])
    expect(SUB_PHASES).toEqual(['notes-read', 'projects', 'wrap-up'])
  })

  it('walks start → end then signals done with null', () => {
    let phase = firstPhase('pa')
    const visited = [phase]
    let guard = 0
    while (true) {
      const n = nextPhase('pa', phase)
      if (n === null) break
      phase = n
      visited.push(phase)
      if (++guard > 20) throw new Error('phase walk did not terminate')
    }
    expect(visited).toEqual([...PA_PHASES])
    expect(isLastPhase('pa', 'wrap-up')).toBe(true)
    expect(nextPhase('pa', 'wrap-up')).toBeNull()
  })

  it('submodality walk likewise terminates at wrap-up', () => {
    expect(nextPhase('submodality', 'projects')).toBe('wrap-up')
    expect(nextPhase('submodality', 'wrap-up')).toBeNull()
    expect(isLastPhase('submodality', 'wrap-up')).toBe(true)
  })

  it('isValidPhase respects the kind (a PA phase is not a submodality phase)', () => {
    expect(isValidPhase('pa', 'submodalities')).toBe(true)
    expect(isValidPhase('submodality', 'submodalities')).toBe(false) // PA-only phase
    expect(isValidPhase('submodality', 'notes-read')).toBe(true)
    expect(isValidPhase('pa', 'notes-read')).toBe(false)
  })

  it('nextPhase on an unknown phase returns null (engine treats as reset)', () => {
    expect(nextPhase('pa', 'bogus' as never)).toBeNull()
  })

  it('phasesFor returns the right sequence', () => {
    expect(phasesFor('pa')).toBe(PA_PHASES)
    expect(phasesFor('submodality')).toBe(SUB_PHASES)
  })
})

describe('submodalities phase — checkSubmodality', () => {
  const base: SubmodalityCheck = { modalityId: 'maker', lastContactAt: daysAgo(1), needsAttention: 0, itemCount: 5 }

  it('books a talk when last contact is older than the overdue threshold', () => {
    const v = checkSubmodality({ ...base, lastContactAt: daysAgo(OVERDUE_DAYS + 1) }, now)
    expect(v.shouldTalk).toBe(true)
    expect(v.reason).toBe('overdue')
  })

  it('does NOT book a talk when fresh and unflagged', () => {
    const v = checkSubmodality({ ...base, lastContactAt: daysAgo(2), needsAttention: 1 }, now)
    expect(v.shouldTalk).toBe(false)
    expect(v.reason).toBeNull()
  })

  it('books a talk when needs-attention exceeds the threshold (even if fresh)', () => {
    const v = checkSubmodality({ ...base, lastContactAt: daysAgo(0), needsAttention: ATTENTION_THRESHOLD + 1 }, now)
    expect(v.shouldTalk).toBe(true)
    expect(v.reason).toBe('needs-attention')
    expect(v.durationMinutes).toBe(60) // flagged → longer
  })

  it('never-contacted reads as overdue', () => {
    const v = checkSubmodality({ ...base, lastContactAt: null }, now)
    expect(v.shouldTalk).toBe(true)
    expect(v.reason).toBe('overdue')
  })

  it('a fresh, lightly-flagged talk is 30 minutes; badly stale is 60', () => {
    expect(checkSubmodality({ ...base, lastContactAt: daysAgo(OVERDUE_DAYS + 1), needsAttention: 0 }, now).durationMinutes).toBe(30)
    expect(checkSubmodality({ ...base, lastContactAt: daysAgo(2 * OVERDUE_DAYS + 1), needsAttention: 0 }, now).durationMinutes).toBe(60)
  })

  it('bumps needs-attention when the item count is out of band, independent of talk', () => {
    expect(checkSubmodality({ ...base, itemCount: 0 }, now).needsAttentionDelta).toBe(1) // too few
    expect(checkSubmodality({ ...base, itemCount: ITEM_COUNT_TOO_MANY + 1 }, now).needsAttentionDelta).toBe(1) // too many
    expect(checkSubmodality({ ...base, itemCount: 5 }, now).needsAttentionDelta).toBe(0) // healthy
  })
})

describe('triage ordering — one shared stage vocabulary for PA and every submodality', () => {
  it('notes phase walks backlog → blocked → done, dropping planned/scheduled/cancelled', () => {
    const items = [
      { id: 'b', stage: 'backlog' as const },
      { id: 'sch', stage: 'scheduled' as const }, // not triaged in notes phase
      { id: 'pl', stage: 'planned' as const }, // already decided — Penny's calendar phase, not here
      { id: 'bl', stage: 'blocked' as const },
      { id: 'd', stage: 'done' as const },
      { id: 'x', stage: 'cancelled' as const },
    ]
    expect(notesQueue(items).map((i) => i.id)).toEqual(['b', 'bl', 'd'])
  })

  it('skips a dated one-off due more than 10 days out, keeps near/undated ones', () => {
    const far = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000)
    const near = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
    const items = [
      { id: 'far', stage: 'backlog' as const, dueDate: far },
      { id: 'near', stage: 'backlog' as const, dueDate: near },
      { id: 'undated', stage: 'backlog' as const, dueDate: null },
    ]
    expect(notesQueue(items, now).map((i) => i.id).sort()).toEqual(['near', 'undated'])
  })

  it('isFutureContingency: only a real, still-future recheck date counts', () => {
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000)
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
    expect(isFutureContingency(future, now)).toBe(true)
    expect(isFutureContingency(past, now)).toBe(false)
    expect(isFutureContingency(null, now)).toBe(false)
    expect(isFutureContingency(undefined, now)).toBe(false)
  })

  it('a blocked item with a future recheck date is skipped entirely, not just deprioritized', () => {
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000)
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
    const items = [
      { id: 'waiting', stage: 'blocked' as const, contingencyUntil: future },
      { id: 'cleared', stage: 'blocked' as const, contingencyUntil: past },
      { id: 'undated', stage: 'blocked' as const, contingencyUntil: null },
    ]
    expect(notesQueue(items, now).map((i) => i.id).sort()).toEqual(['cleared', 'undated'])
  })
})
