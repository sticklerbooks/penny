import { describe, it, expect } from 'vitest'
import { decideStatusChange } from '../items/status'
import { computeChips, chipLabel, type ItemSnapshot } from './deltas'
import { toolsForPhase } from './context'
import { PA_PHASES, SUB_PHASES } from './phases'

describe('decideStatusChange (FSM-gated writes)', () => {
  it('accepts a legal PA move and stamps timestamps', () => {
    const d = decideStatusChange('pa', { paStatus: 'schedule', modalityStatus: null }, 'scheduled', new Date('2026-06-23'))
    expect(d.ok).toBe(true)
    expect(d.patch?.paStatus).toBe('scheduled')
    expect(d.patch?.scheduledAt).toBeInstanceOf(Date)
  })

  it('stamps completedAt on completion (either side)', () => {
    expect(decideStatusChange('pa', { paStatus: 'scheduled', modalityStatus: null }, 'completed').patch?.completedAt).toBeInstanceOf(Date)
    expect(decideStatusChange('modality', { paStatus: null, modalityStatus: 'pending' }, 'completed').patch?.completedAt).toBeInstanceOf(Date)
  })

  it('rejects an illegal move with a reason and no patch', () => {
    const d = decideStatusChange('pa', { paStatus: 'completed', modalityStatus: null }, 'scheduled')
    expect(d.ok).toBe(false)
    expect(d.patch).toBeUndefined()
    expect(d.reason).toMatch(/cannot move completed/)
  })

  it('a submodality escalation is legal; reopening a completed item is not', () => {
    expect(decideStatusChange('modality', { paStatus: null, modalityStatus: 'pending' }, 'sent-to-PA').ok).toBe(true)
    expect(decideStatusChange('modality', { paStatus: null, modalityStatus: 'completed' }, 'pending').ok).toBe(false)
  })
})

describe('computeChips (report from the DB, not the LLM)', () => {
  const snap = (over: Partial<ItemSnapshot>): ItemSnapshot => ({
    id: 'x', name: 'thing', target: 'pa', paStatus: null, modalityStatus: null, visibility: true,
    type: 'event', priority: 2, duration: null, dayTime: null, projectId: null, dueDate: null, notes: '',
    contingency: '', contingencyUntil: null, ...over,
  })

  it('reports a newly created visible item', () => {
    const before: ItemSnapshot[] = []
    const after = [snap({ id: 'a', name: 'dentist', paStatus: 'schedule' })]
    const chips = computeChips(before, after)
    expect(chips).toEqual([{ kind: 'created', id: 'a', name: 'dentist', target: 'pa', status: 'schedule' }])
  })

  it('reports a status change on the side that moved', () => {
    const before = [snap({ id: 'a', name: 'dentist', paStatus: 'pending' })]
    const after = [snap({ id: 'a', name: 'dentist', paStatus: 'continuing' })]
    const chips = computeChips(before, after)
    expect(chips).toEqual([{ kind: 'status', id: 'a', name: 'dentist', side: 'pa', from: 'pending', to: 'continuing' }])
  })

  it('reports a deletion when a visible item vanishes', () => {
    const before = [snap({ id: 'a', name: 'gone' })]
    const after: ItemSnapshot[] = []
    expect(computeChips(before, after)).toEqual([{ kind: 'deleted', id: 'a', name: 'gone' }])
  })

  it('shows NOTHING when nothing actually changed (the anti-hallucination guard)', () => {
    const items = [snap({ id: 'a', paStatus: 'pending' })]
    expect(computeChips(items, items)).toEqual([])
  })

  it('reports a field edit — the type change that went invisible in the smoke test', () => {
    const before = [snap({ id: 'a', name: 'dentist', type: 'event' })]
    const after = [snap({ id: 'a', name: 'dentist', type: 'ongoing' })]
    expect(computeChips(before, after)).toEqual([
      { kind: 'field', id: 'a', name: 'dentist', field: 'type', from: 'event', to: 'ongoing' },
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
    expect(chipLabel({ kind: 'status', id: 'a', name: 'dentist', side: 'pa', from: 'pending', to: 'continuing' }))
      .toBe('"dentist" · paStatus pending → continuing')
  })
})

describe('toolsForPhase (a phase cannot reach outside its job)', () => {
  it('grants triage tools in notes, but withholds them in the scripted submodalities phase', () => {
    expect(toolsForPhase('pa', 'notes')).toContain('set_item_status')
    expect(toolsForPhase('pa', 'notes')).toContain('mark_discussed')
    expect(toolsForPhase('pa', 'submodalities')).not.toContain('set_item_status')
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
