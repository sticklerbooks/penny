import { getAnthropic, PENNY_MODEL } from './claude'
import { prisma } from './db'
import {
  MODALITY_CANDIDATES,
  MODALITY_CANDIDATE_INDEX,
  renderModalityCandidateRoster,
} from './modality-candidates'

export const CAST_SYNTHESIS_MODEL = process.env.PENNY_SYNTHESIS_MODEL || PENNY_MODEL

export const CAST_DISPOSITIONS = [
  'cast_now',
  'penny',
  'eve',
  'map',
  'waiting',
  'not_applicable',
] as const

export type CastDisposition = (typeof CAST_DISPOSITIONS)[number]
type Stance = 'build' | 'maintain' | 'repair'

export interface ModalityAssessment {
  candidateId: string
  disposition: CastDisposition
  stance: Stance | null
  depthEvidence: string
  prescriptiveEvidence: string
  responsibilities: string[]
  nonResponsibilities: string[]
  capabilitiesNeeded: string[]
  overlaps: string[]
  exitCondition: string
  uncertainties: string[]
  recommendation: string
}

export interface ModalityRecommendationResult {
  version: 1
  generatedAt: string
  letterToUser: string
  assessments: ModalityAssessment[]
}

interface IntakeDocuments {
  userPortrait: string
  currentState: string
  workingAgreement: string
  launchBrief: string
}

function synthesisSystem(userName: string): string {
  return `You are Penny performing a one-time cast assessment after completing intake with ${userName}.

THE GATE
- Deep + prescriptive: eligible for its own modality.
- Deep + not prescriptive: Eve holds the interior; do not cast an obligation-producing self.
- Shallow + prescriptive: Penny handles it as ordinary hygiene.
- Shallow + not prescriptive: keep it represented in the map/context without personifying it.
- A genuinely deep and prescriptive domain may be marked waiting when it loses to the active-cast ceiling.

Recommend 3–5 standing modalities. Rank rather than hoard: every self is another demand stream. Assess EVERY candidate, including the ones you reject. Work from intake evidence, distinguish stated preference from lived evidence, and state uncertainty honestly. Do not invent names, avatars, appearance, voices, or flirtatious texture. This pass chooses functions only.

FORBIDDEN PRESCRIPTIONS
Never cast a modality to steward recovery/sobriety, disordered eating, or self-harm. Route interior support to Eve and recommend appropriate human help. A Wellness Coach may help locate professional care but may not own those domains.

PENNY AND EVE
Penny is the broad anchor: tracking, routing, and shallow prescriptive hygiene. Eve is the non-prescriptive emotional counterweight: presence without turning the interior into obligations.

CANDIDATE ROSTER
${renderModalityCandidateRoster()}

Respond with ONLY JSON in this exact shape:
{
  "letterToUser": "A warm, specific 200–500 word explanation of the proposed cast and what was deliberately not personified.",
  "assessments": [{
    "candidateId": "one exact candidate id",
    "disposition": "cast_now|penny|eve|map|waiting|not_applicable",
    "stance": "build|maintain|repair|null",
    "depthEvidence": "specific evidence or why evidence is absent",
    "prescriptiveEvidence": "specific action-bearing need or why none exists",
    "responsibilities": ["concrete functions for this user"],
    "nonResponsibilities": ["explicit exclusions"],
    "capabilitiesNeeded": ["tool capability descriptions, not invented tool names"],
    "overlaps": ["candidate ids or Penny/Eve"],
    "exitCondition": "specific ending or reassessment condition",
    "uncertainties": ["what remains unclear"],
    "recommendation": "2–4 sentences explaining this routing decision"
  }]
}

There must be exactly one assessment for each of the ${MODALITY_CANDIDATES.length} candidate ids.`
}

export function parseModalityRecommendation(text: string): ModalityRecommendationResult {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('casting synthesis returned no JSON object')
  const raw = JSON.parse(text.slice(start, end + 1)) as Partial<ModalityRecommendationResult>
  const errors: string[] = []
  if (!raw.letterToUser || raw.letterToUser.trim().length < 100) errors.push('letterToUser is missing or too short')
  if (!Array.isArray(raw.assessments)) errors.push('assessments is not an array')
  const assessments = Array.isArray(raw.assessments) ? raw.assessments : []
  const ids = assessments.map((assessment) => assessment?.candidateId)
  const expectedIds = new Set(MODALITY_CANDIDATES.map((candidate) => candidate.id))
  for (const id of expectedIds) {
    if (ids.filter((candidateId) => candidateId === id).length !== 1) errors.push(`expected exactly one assessment for ${id}`)
  }
  for (const assessment of assessments) {
    if (!assessment || !MODALITY_CANDIDATE_INDEX[assessment.candidateId]) errors.push(`unknown candidate ${assessment?.candidateId}`)
    if (!CAST_DISPOSITIONS.includes(assessment?.disposition as CastDisposition)) errors.push(`invalid disposition for ${assessment?.candidateId}`)
    if (assessment?.stance !== null && !['build', 'maintain', 'repair'].includes(String(assessment?.stance))) errors.push(`invalid stance for ${assessment?.candidateId}`)
    if (assessment?.disposition === 'cast_now' && assessment.stance === null) errors.push(`cast_now requires a stance for ${assessment?.candidateId}`)
    for (const field of ['depthEvidence', 'prescriptiveEvidence', 'exitCondition'] as const) {
      if (!assessment?.[field]?.trim()) errors.push(`missing ${field} for ${assessment?.candidateId}`)
    }
    for (const field of ['responsibilities', 'nonResponsibilities', 'capabilitiesNeeded', 'overlaps', 'uncertainties'] as const) {
      if (!Array.isArray(assessment?.[field])) errors.push(`${field} is not an array for ${assessment?.candidateId}`)
    }
    if (!assessment?.recommendation?.trim()) errors.push(`missing recommendation for ${assessment?.candidateId}`)
  }
  const castCount = assessments.filter((assessment) => assessment?.disposition === 'cast_now').length
  if (castCount < 3 || castCount > 5) errors.push(`cast_now count ${castCount} is outside 3–5`)
  if (errors.length) throw new Error(errors.join('; '))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    letterToUser: raw.letterToUser!.trim(),
    assessments: assessments as ModalityAssessment[],
  }
}

export async function generateModalityRecommendations(
  profileId: string,
  documents: IntakeDocuments
): Promise<{ result: ModalityRecommendationResult; toolSummary: string }> {
  const [profile, entries] = await Promise.all([
    prisma.profile.findUnique({ where: { id: profileId } }),
    prisma.intakeEntry.findMany({ where: { profileId }, orderBy: [{ bucket: 'asc' }, { key: 'asc' }] }),
  ])
  if (!profile) throw new Error('profile not found for casting synthesis')
  const evidence = entries.map((entry) => {
    const parts = [`[${entry.status}] ${entry.key}: ${entry.content}`]
    if (entry.evidence) parts.push(`evidence: ${entry.evidence}`)
    if (entry.contradictions) parts.push(`tension: ${entry.contradictions}`)
    if (entry.openQuestion) parts.push(`unclear: ${entry.openQuestion}`)
    return parts.join('\n  ')
  }).join('\n')
  const userName = profile.userName || 'the user'
  const userContent = `FINAL INTAKE DOCUMENTS

USER PORTRAIT
${documents.userPortrait}

CURRENT STATE
${documents.currentState}

WORKING AGREEMENT
${documents.workingAgreement}

IMMEDIATE HANDOFF
${documents.launchBrief}

PRIVATE INTAKE LEDGER
${evidence}`

  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await getAnthropic().messages.create({
      model: CAST_SYNTHESIS_MODEL,
      max_tokens: 12000,
      system: synthesisSystem(userName),
      messages: [{
        role: 'user',
        content: attempt === 0
          ? userContent
          : `${userContent}\n\nYour previous response failed code validation: ${lastError}. Regenerate the complete JSON from scratch and correct every violation.`,
      }],
    })
    const text = response.content.find((block) => block.type === 'text')
    if (!text || text.type !== 'text') {
      lastError = 'no text response'
      continue
    }
    try {
      const result = parseModalityRecommendation(text.text)
      await prisma.deepMemory.upsert({
        where: { profileId_name: { profileId, name: 'intake-modality-recommendations' } },
        create: { profileId, name: 'intake-modality-recommendations', domain: null, content: JSON.stringify(result, null, 2) },
        update: { content: JSON.stringify(result, null, 2) },
      })
      const castNow = result.assessments
        .filter((assessment) => assessment.disposition === 'cast_now')
        .map((assessment) => MODALITY_CANDIDATE_INDEX[assessment.candidateId].label)
      const waiting = result.assessments
        .filter((assessment) => assessment.disposition === 'waiting')
        .map((assessment) => MODALITY_CANDIDATE_INDEX[assessment.candidateId].label)
      const toolSummary = [
        'The complete private modality decision matrix has been preserved as intake-modality-recommendations.',
        '',
        result.letterToUser,
        '',
        `Recommend now: ${castNow.join(', ')}.`,
        waiting.length ? `Deep but waiting: ${waiting.join(', ')}.` : 'No additional deep domains are waiting behind the active-cast ceiling.',
      ].join('\n')
      return { result, toolSummary }
    } catch (error) {
      lastError = String(error)
    }
  }
  throw new Error(`casting synthesis failed validation twice: ${lastError}`)
}
