import { describe, it, expect } from 'vitest'
import {
  notesExitViolations,
  notesReadExitViolations,
  calendarExitViolations,
  considerationViolations,
  type GuardItem,
} from './guards'

const item = (over: Partial<GuardItem>): GuardItem => ({ id: 'x', name: 'thing', paStatus: null, modalityStatus: null, ...over })

describe('notes phase exit guard (PA)', () => {
  it("BLOCKS while any item is still 'new' — the loop cannot end", () => {
    const queue = [item({ id: 'a', name: 'dentist', paStatus: 'pending' }), item({ id: 'b', name: 'car', paStatus: 'new' })]
    const v = notesExitViolations(queue, new Set(['a', 'b']))
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ id: 'b', name: 'car' })
    expect(v[0].reason).toMatch(/new/)
  })

  it('BLOCKS an item that was triaged but never discussed', () => {
    const queue = [item({ id: 'a', name: 'dentist', paStatus: 'pending' })]
    expect(notesExitViolations(queue, new Set())).toEqual([
      { id: 'a', name: 'dentist', reason: 'not yet discussed this review' },
    ])
  })

  it('PASSES when nothing is new and every item was discussed', () => {
    const queue = [item({ id: 'a', paStatus: 'pending' }), item({ id: 'b', paStatus: 'continuing' })]
    expect(notesExitViolations(queue, new Set(['a', 'b']))).toEqual([])
  })

  it('a pending item LEFT unchanged still passes once discussed (the consideration case)', () => {
    const queue = [item({ id: 'a', paStatus: 'pending' })]
    expect(notesExitViolations(queue, new Set(['a']))).toEqual([])
  })
})

describe('notes-read exit guard (submodality)', () => {
  it("blocks on a 'new' modality status; contingent items may remain (just discussed)", () => {
    const queue = [item({ id: 'a', modalityStatus: 'new' }), item({ id: 'b', modalityStatus: 'contingent' })]
    const v = notesReadExitViolations(queue, new Set(['a', 'b']))
    expect(v.map((x) => x.id)).toEqual(['a']) // contingent is allowed to stay; new is not
  })
})

describe('calendar exit guard', () => {
  it("blocks while anything is still 'schedule' (must be scheduled or pulled)", () => {
    const items = [item({ id: 'a', paStatus: 'scheduled' }), item({ id: 'b', name: 'visit', paStatus: 'schedule' })]
    const v = calendarExitViolations(items)
    expect(v.map((x) => x.id)).toEqual(['b'])
  })

  it('passes when nothing is left queued', () => {
    expect(calendarExitViolations([item({ paStatus: 'scheduled' })])).toEqual([])
  })
})

describe('consideration guard (projects / notes-pass)', () => {
  it('blocks any item not yet discussed, regardless of status', () => {
    const q = [{ id: 'a', name: 'novel' }, { id: 'b', name: 'garden' }]
    expect(considerationViolations(q, new Set(['a'])).map((x) => x.id)).toEqual(['b'])
  })
})
