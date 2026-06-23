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
  notesPassQueue,
  paNotesQueue,
  subNotesReadQueue,
  OVERDUE_DAYS,
  ATTENTION_THRESHOLD,
  ITEM_COUNT_TOO_MANY,
  type SubmodalityCheck,
} from './selectors'

const now = new Date('2026-06-23T12:00:00Z')
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000)

describe('phase sequencing', () => {
  it('PA and submodality have the spec phase walks', () => {
    expect(PA_PHASES).toEqual(['greeting', 'notes', 'projects', 'submodalities', 'user', 'calendar', 'wrap-up'])
    expect(SUB_PHASES).toEqual(['greeting', 'notes-read', 'projects', 'user', 'notes-pass', 'wrap-up'])
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
    expect(nextPhase('submodality', 'notes-pass')).toBe('wrap-up')
    expect(nextPhase('submodality', 'wrap-up')).toBeNull()
    expect(isLastPhase('submodality', 'wrap-up')).toBe(true)
  })

  it('isValidPhase respects the kind (a PA phase is not a submodality phase)', () => {
    expect(isValidPhase('pa', 'submodalities')).toBe(true)
    expect(isValidPhase('submodality', 'submodalities')).toBe(false) // PA-only phase
    expect(isValidPhase('submodality', 'notes-pass')).toBe(true)
    expect(isValidPhase('pa', 'notes-pass')).toBe(false)
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

describe('notes-pass queue (Note 2 — sweeps items made this session)', () => {
  const sessionStart = daysAgo(0) // started "now"
  const earlier = daysAgo(3)

  it('always includes sent-to-PA items, whenever they were made', () => {
    const q = notesPassQueue(
      [{ id: 'a', modalityStatus: 'sent-to-PA', createdAt: earlier }],
      sessionStart
    )
    expect(q.map((i) => i.id)).toEqual(['a'])
  })

  it('includes an undecided item minted THIS session (the gap Note 2 closes)', () => {
    const q = notesPassQueue(
      [{ id: 'fresh', modalityStatus: 'new', createdAt: new Date(now.getTime() + 1000) }],
      sessionStart
    )
    expect(q.map((i) => i.id)).toEqual(['fresh'])
  })

  it('excludes an undecided item made in a PRIOR session (already triaged earlier)', () => {
    const q = notesPassQueue(
      [{ id: 'old', modalityStatus: 'pending', createdAt: earlier }],
      sessionStart
    )
    expect(q).toEqual([])
  })

  it('excludes already-resolved items even when minted this session', () => {
    const future = new Date(now.getTime() + 1000)
    const q = notesPassQueue(
      [
        { id: 'done', modalityStatus: 'completed', createdAt: future },
        { id: 'gone', modalityStatus: 'to-delete', createdAt: future },
      ],
      sessionStart
    )
    expect(q).toEqual([])
  })
})

describe('triage ordering', () => {
  it('PA notes phase walks pending → continuing → new, dropping other statuses', () => {
    const items = [
      { id: 'n', paStatus: 'new' as const },
      { id: 'sch', paStatus: 'scheduled' as const }, // not triaged in notes phase
      { id: 'c', paStatus: 'continuing' as const },
      { id: 'p', paStatus: 'pending' as const },
    ]
    expect(paNotesQueue(items).map((i) => i.id)).toEqual(['p', 'c', 'n'])
  })

  it('submodality notes-read walks pending → new → completed → blocked', () => {
    const items = [
      { id: 'b', modalityStatus: 'blocked' as const },
      { id: 'd', modalityStatus: 'completed' as const },
      { id: 'n', modalityStatus: 'new' as const },
      { id: 'p', modalityStatus: 'pending' as const },
      { id: 's', modalityStatus: 'sent-to-PA' as const }, // not in notes-read order
    ]
    expect(subNotesReadQueue(items).map((i) => i.id)).toEqual(['p', 'n', 'd', 'b'])
  })
})
