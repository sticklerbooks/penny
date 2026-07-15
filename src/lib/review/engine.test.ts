import { describe, it, expect } from 'vitest'
import { decideStatusChange } from '../items/status'
import { computeChips, chipLabel, type ItemSnapshot } from './deltas'
import { toolsForPhase } from './context'
import { PA_PHASES, SUB_PHASES } from './phases'

describe('decideStatusChange (FSM-gated writes)', () => {
  it('accepts a legal move and stamps timestamps', () => {
    const d = decideStatusChange({ stage: 'planned' }, 'scheduled', new Date('2026-06-23'))
    expect(d.ok).toBe(true)
    expect(d.patch?.stage).toBe('scheduled')
    expect(d.patch?.scheduledAt).toBeInstanceOf(Date)
    expect(d.patch?.stageEnteredAt).toBeInstanceOf(Date)
  })

  it('stamps completedAt on entering done', () => {
    expect(decideStatusChange({ stage: 'scheduled' }, 'done').patch?.completedAt).toBeInstanceOf(Date)
    expect(decideStatusChange({ stage: 'backlog' }, 'done').patch?.completedAt).toBeInstanceOf(Date)
  })

  it('rejects an illegal move with a reason and no patch', () => {
    const d = decideStatusChange({ stage: 'done' }, 'scheduled')
    expect(d.ok).toBe(false)
    expect(d.patch).toBeUndefined()
    expect(d.reason).toMatch(/cannot move done/)
  })

  it('a blocked item can resolve back into any live stage; reopening done cannot', () => {
    expect(decideStatusChange({ stage: 'blocked' }, 'planned').ok).toBe(true)
    expect(decideStatusChange({ stage: 'done' }, 'backlog').ok).toBe(false)
  })
})

describe('computeChips (report from the DB, not the LLM)', () => {
  const snap = (over: Partial<ItemSnapshot>): ItemSnapshot => ({
    id: 'x', name: 'thing', target: 'pa', stage: null, visibility: true,
    type: 'event', priority: 2, duration: null, dayTime: null, projectId: null, dueDate: null, notes: '',
    contingency: '', contingencyUntil: null, ...over,
  })

  it('reports a newly created visible item', () => {
    const before: ItemSnapshot[] = []
    const after = [snap({ id: 'a', name: 'dentist', stage: 'planned' })]
    const chips = computeChips(before, after)
    expect(chips).toEqual([{ kind: 'created', id: 'a', name: 'dentist', target: 'pa', status: 'planned' }])
  })

  it('reports a stage change', () => {
    const before = [snap({ id: 'a', name: 'dentist', stage: 'backlog' })]
    const after = [snap({ id: 'a', name: 'dentist', stage: 'planned' })]
    const chips = computeChips(before, after)
    expect(chips).toEqual([{ kind: 'status', id: 'a', name: 'dentist', from: 'backlog', to: 'planned' }])
  })

  it('reports a deletion when a visible item vanishes', () => {
    const before = [snap({ id: 'a', name: 'gone' })]
    const after: ItemSnapshot[] = []
    expect(computeChips(before, after)).toEqual([{ kind: 'deleted', id: 'a', name: 'gone' }])
  })

  it('shows NOTHING when nothing actually changed (the anti-hallucination guard)', () => {
    const items = [snap({ id: 'a', stage: 'backlog' })]
    expect(computeChips(items, items)).toEqual([])
  })

  it('reports a field edit — the type change that went invisible in the smoke test', () => {
    const before = [snap({ id: 'a', name: 'dentist', type: 'event' })]
    const after = [snap({ id: 'a', name: 'dentist', type: 'task' })]
    expect(computeChips(before, after)).toEqual([
      { kind: 'field', id: 'a', name: 'dentist', field: 'type', from: 'event', to: 'task' },
    ])
  })

  it('reports a priority bump (numbers stringified)', () => {
    const before = [snap({ id: 'a', priority: 2 })]
    const after = [snap({ id: 'a', priority: 4 })]
    expect(computeChips(before, after)).toEqual([
      { kind: 'field', id: 'a', name: 'thing', field: 'priority', from: '2', to: '4' },
    ])
  })

  it('treats an archive (visibility true→false) as a deletion chip', () => {
    const before = [snap({ id: 'a', name: 'old', visibility: true })]
    const after = [snap({ id: 'a', name: 'old', visibility: false })]
    expect(computeChips(before, after)).toEqual([{ kind: 'deleted', id: 'a', name: 'old' }])
  })

  it('chipLabel renders readable text', () => {
    expect(chipLabel({ kind: 'status', id: 'a', name: 'dentist', from: 'backlog', to: 'planned' }))
      .toBe('"dentist" · stage backlog → planned')
  })
})

describe('toolsForPhase (a phase cannot reach outside its job)', () => {
  it('grants triage tools in notes, but withholds them in the scripted submodalities phase', () => {
    expect(toolsForPhase('pa', 'notes')).toContain('write_table')
    expect(toolsForPhase('pa', 'notes')).toContain('mark_discussed')
    expect(toolsForPhase('pa', 'submodalities')).not.toContain('write_table')
  })

  it('every phase can at least finish itself', () => {
    for (const p of PA_PHASES) {
      expect(toolsForPhase('pa', p)).toContain('finish_phase')
    }
    for (const p of SUB_PHASES) {
      expect(toolsForPhase('submodality', p)).toContain('finish_phase')
    }
  })

  it('wrap-up is engine-driven — only finish_phase', () => {
    expect(toolsForPhase('pa', 'wrap-up')).toEqual(['finish_phase'])
  })
})
