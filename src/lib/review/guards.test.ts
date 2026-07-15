import { describe, it, expect } from 'vitest'
import { calendarExitViolations, considerationViolations, type GuardItem } from './guards'

const item = (over: Partial<GuardItem>): GuardItem => ({ id: 'x', name: 'thing', stage: null, ...over })

describe('calendar exit guard', () => {
  it("blocks while anything is still 'planned' (must be scheduled or moved off the queue)", () => {
    const items = [item({ id: 'a', stage: 'scheduled' }), item({ id: 'b', name: 'visit', stage: 'planned' })]
    const v = calendarExitViolations(items)
    expect(v.map((x) => x.id)).toEqual(['b'])
  })

  it('passes when nothing is left queued', () => {
    expect(calendarExitViolations([item({ stage: 'scheduled' })])).toEqual([])
  })
})

describe('consideration guard (notes / projects)', () => {
  it('blocks any item not yet discussed, regardless of stage', () => {
    const q = [{ id: 'a', name: 'novel' }, { id: 'b', name: 'garden' }]
    expect(considerationViolations(q, new Set(['a'])).map((x) => x.id)).toEqual(['b'])
  })

  it('a backlog item left unchanged still passes once discussed — backlog is a legitimate resting place', () => {
    const q = [{ id: 'a', name: 'someday project' }]
    expect(considerationViolations(q, new Set(['a']))).toEqual([])
  })
})
