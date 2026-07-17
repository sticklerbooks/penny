import { describe, expect, it } from 'vitest'
import { INTAKE_CATALOG, scoreIntake } from './intake'
import { MODALITY_CANDIDATES } from './modality-candidates'
import { parseModalityRecommendation } from './modality-recommendations'
import { getToolsForModality } from './tools'

describe('intake scoring', () => {
  it('starts fully unknown and ineligible', () => {
    const score = scoreIntake([])
    expect(score.percent).toBe(0)
    expect(score.eligible).toBe(false)
    expect(score.unevaluatedKeys).toHaveLength(INTAKE_CATALOG.length)
  })

  it('treats not-applicable as complete knowledge', () => {
    const rows = INTAKE_CATALOG.map((entry) => ({ key: entry.key, status: 'not_applicable' }))
    const score = scoreIntake(rows)
    expect(score.percent).toBe(100)
    expect(score.eligible).toBe(true)
  })

  it('requires every area to advance beyond touched', () => {
    const rows = INTAKE_CATALOG.map((entry) => ({ key: entry.key, status: 'supported' }))
    rows[0].status = 'touched'
    const score = scoreIntake(rows)
    expect(score.eligible).toBe(false)
    expect(score.unevaluatedKeys).toContain(INTAKE_CATALOG[0].key)
  })

  it('requires depth in every bucket, not just nominal coverage', () => {
    const rows = INTAKE_CATALOG.map((entry) => ({ key: entry.key, status: 'provisional' }))
    const score = scoreIntake(rows)
    expect(score.percent).toBe(60)
    expect(score.unevaluatedKeys).toHaveLength(0)
    expect(score.eligible).toBe(false)
  })

  it('has unique stable catalog keys', () => {
    expect(new Set(INTAKE_CATALOG.map((entry) => entry.key)).size).toBe(INTAKE_CATALOG.length)
  })

  it('grants only private intake tools during intake', () => {
    expect(getToolsForModality('pa', { isIntake: true }).map((tool) => tool.name)).toEqual([
      'update_intake_ledger',
      'complete_intake',
    ])
  })

  it('keeps the modality candidate roster complete and uniquely addressable', () => {
    expect(MODALITY_CANDIDATES).toHaveLength(20)
    expect(new Set(MODALITY_CANDIDATES.map((candidate) => candidate.id)).size).toBe(20)
    expect(MODALITY_CANDIDATES.filter((candidate) => candidate.family === 'operator')).toHaveLength(4)
    expect(MODALITY_CANDIDATES.filter((candidate) => candidate.family === 'coach')).toHaveLength(7)
    expect(MODALITY_CANDIDATES.filter((candidate) => candidate.family === 'connector')).toHaveLength(4)
    expect(MODALITY_CANDIDATES.filter((candidate) => candidate.family === 'navigator')).toHaveLength(5)
  })

  it('rejects a casting matrix that drops required decision detail', () => {
    const assessments = MODALITY_CANDIDATES.map((candidate, index) => ({
      candidateId: candidate.id,
      disposition: index < 3 ? 'cast_now' : 'not_applicable',
      stance: index < 3 ? 'build' : null,
      depthEvidence: 'Specific intake evidence.',
      prescriptiveEvidence: 'Specific action-bearing evidence.',
      responsibilities: ['A concrete responsibility.'],
      nonResponsibilities: ['An explicit exclusion.'],
      capabilitiesNeeded: ['A capability description.'],
      overlaps: [],
      exitCondition: 'Reassess when the stated condition changes.',
      uncertainties: [],
      recommendation: 'A specific routing decision.',
    }))
    delete (assessments[0] as Partial<(typeof assessments)[number]>).capabilitiesNeeded
    expect(() => parseModalityRecommendation(JSON.stringify({
      letterToUser: 'A'.repeat(120),
      assessments,
    }))).toThrow(/capabilitiesNeeded/)
  })
})
