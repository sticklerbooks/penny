import { describe, it, expect } from 'vitest'
import { canonLabel, taskToItem, noteToItem, routineToItem } from './cutover'

describe('canonLabel — the label normalization the cutover relies on', () => {
  it('passes stable ids through unchanged', () => {
    expect(canonLabel('bookkeeping')).toBe('bookkeeping')
    expect(canonLabel('pa')).toBe('pa')
  })

  it('maps the actual mislabeled note targets (display names) to ids', () => {
    expect(canonLabel('june')).toBe('household')
    expect(canonLabel('margot')).toBe('bookkeeping')
    expect(canonLabel('remy')).toBe('health')
    expect(canonLabel('nora')).toBe('relationships')
    expect(canonLabel('iris')).toBe('creative')
    expect(canonLabel('ada')).toBe('maker')
  })

  it('maps the stray domain label and falls back to pa for the unknown/empty', () => {
    expect(canonLabel('wellbeing')).toBe('health') // health's domain/alias
    expect(canonLabel(null)).toBe('pa')
    expect(canonLabel('   ')).toBe('pa')
  })
})

describe('taskToItem', () => {
  it('lands in the backlog stage, plain task, label + due date carried', () => {
    const due = new Date('2026-07-15')
    const m = taskToItem({ id: 't1', name: 'File 941', description: 'quarterly', priority: 3, assignedModality: 'margot', projectId: 'p9', status: 'Started', dueDate: due })
    expect(m.sourceRef).toBe('task:t1')
    expect(m.input).toMatchObject({
      target: 'bookkeeping', createdBy: 'bookkeeping', type: 'task',
      projectId: 'p9', priority: 3, stage: 'backlog', sourceRef: 'task:t1', dueDate: due,
    })
  })

  it('a pa task also lands in backlog — same stage regardless of target', () => {
    const m = taskToItem({ id: 't2', name: 'x', description: null, priority: null, assignedModality: 'pa', projectId: null, status: null, dueDate: null })
    expect(m.input.stage).toBe('backlog')
    expect(m.input.priority).toBe(2) // default when null
    expect(m.input.description).toBe('x') // falls back to name
    expect(m.input.dueDate).toBeNull()
  })

  it('clamps an out-of-range priority into 0–5', () => {
    expect(taskToItem({ id: 't', name: 'n', description: 'd', priority: 9, assignedModality: 'pa', projectId: null, status: null, dueDate: null }).input.priority).toBe(5)
  })
})

describe('noteToItem', () => {
  it('lands as a suggestion at the normalized target, backlog stage', () => {
    const m = noteToItem({ id: 'n1', title: 'call mom', content: 'birthday soon', modalityTarget: 'nora', source: 'pa' })
    expect(m.sourceRef).toBe('note:n1')
    expect(m.input).toMatchObject({ target: 'relationships', type: 'suggestion', stage: 'backlog', createdBy: 'pa' })
  })

  it('a pa-targeted note also lands in backlog', () => {
    const m = noteToItem({ id: 'n2', title: 't', content: null, modalityTarget: 'pa', source: 'margot' })
    expect(m.input.stage).toBe('backlog')
    expect(m.input.createdBy).toBe('bookkeeping') // source normalized too
  })
})

describe('routineToItem', () => {
  it('becomes a plain backlog task in its modality (recurring → Project is a manual follow-up if this ever re-runs)', () => {
    const m = routineToItem({ id: 'r1', description: 'Sunday meal prep', priority: 2, assignedModality: 'remy', dayTime: 'Sunday afternoons' })
    expect(m.sourceRef).toBe('routine:r1')
    expect(m.input).toMatchObject({ target: 'health', type: 'task', stage: 'backlog', dayTime: 'Sunday afternoons' })
  })
})
