import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from './db'
import { generateModalityRecommendations } from './modality-recommendations'

export const INTAKE_STATUSES = [
  'touched',
  'provisional',
  'supported',
  'known',
  'not_applicable',
] as const

export type IntakeStatus = (typeof INTAKE_STATUSES)[number]
export type IntakeBucket = 'identity' | 'state' | 'relationship' | 'handoff'

export interface IntakeCatalogEntry {
  key: string
  bucket: IntakeBucket
  label: string
  kind: 'fact' | 'observation' | 'forecast' | 'preference' | 'condition'
}

const entries = (
  bucket: IntakeBucket,
  kind: IntakeCatalogEntry['kind'],
  values: Array<[string, string]>
): IntakeCatalogEntry[] => values.map(([key, label]) => ({ key, bucket, kind, label }))

export const INTAKE_CATALOG: IntakeCatalogEntry[] = [
  ...entries('identity', 'fact', [
    ['bio.preferred_name', 'preferred name and form of address'],
    ['bio.pronouns', 'pronouns'],
    ['bio.age', 'age or date of birth'],
    ['bio.location', 'location and timezone'],
    ['bio.household', 'household composition'],
    ['bio.romantic_situation', 'partner or romantic situation'],
    ['bio.dependents', 'children and other dependents'],
    ['bio.family', 'important family members'],
    ['bio.friendships_community', 'important friendships and communities'],
    ['bio.employment', 'employment'],
    ['bio.business', 'business or self-employment'],
    ['bio.education', 'education and professional background'],
    ['bio.health_access', 'material health conditions or accessibility needs'],
    ['bio.financial_reality', 'major ongoing financial realities'],
    ['bio.recurring_obligations', 'significant recurring obligations'],
    ['bio.life_history', 'relevant life history and major transitions'],
  ]),
  ...entries('identity', 'observation', [
    ['portrait.values', 'values and sources of meaning'],
    ['portrait.strengths', 'strengths and competencies'],
    ['portrait.attention', 'attention and executive-function patterns'],
    ['portrait.energy', 'energy rhythms'],
    ['portrait.stress', 'stress responses'],
    ['portrait.avoidance', 'avoidance and procrastination patterns'],
    ['portrait.sensitivities', 'sources of shame, defensiveness, or sensitivity'],
    ['portrait.delight', 'sources of delight, absorption, and aliveness'],
    ['portrait.work_obligation', 'relationship to work and obligation'],
    ['portrait.rest_pleasure', 'relationship to rest and pleasure'],
    ['portrait.decisions', 'how decisions are made'],
    ['portrait.feedback', 'responses to pressure, praise, criticism, and accountability'],
    ['portrait.priority_gaps', 'recurring gaps between stated priorities and lived behavior'],
  ]),

  ...entries('state', 'condition', [
    ['now.demands', 'current responsibilities, demands, and open obligations'],
    ['now.capacity', 'current time, energy, and practical capacity'],
    ['now.work_business', 'current employment and business conditions'],
    ['now.home_people', 'current household and relationship conditions'],
    ['now.health', 'current physical and mental health state'],
    ['now.money', 'current financial pressures and flexibility'],
    ['now.pressures', 'active pressures, risks, and instability'],
    ['now.opportunities', 'current opportunities and sources of momentum'],
  ]),
  ...entries('state', 'forecast', [
    ['month.events', 'known events and deadlines in the next month'],
    ['month.load', 'expected load and capacity during the next month'],
    ['month.changes', 'likely changes, risks, and opportunities during the next month'],
    ['month.desired', 'what the user hopes is different one month from now'],
    ['six_month.trajectory', 'likely life and work trajectory over six months'],
    ['six_month.milestones', 'known milestones, transitions, and constraints over six months'],
    ['six_month.risks', 'six-month risks and opportunities'],
    ['six_month.desired', 'what the user hopes is different six months from now'],
    ['year.trajectory', 'likely life and work trajectory over the next year'],
    ['year.milestones', 'known milestones, transitions, and constraints over the next year'],
    ['year.risks', 'one-year risks and opportunities'],
    ['year.desired', 'what the user hopes is different one year from now'],
  ]),

  ...entries('relationship', 'preference', [
    ['interaction.tone', 'preferred tone'],
    ['interaction.length', 'preferred response length and level of detail'],
    ['interaction.questions', 'when to ask questions versus provide an answer'],
    ['interaction.challenge', 'when and how to challenge assumptions'],
    ['interaction.directness', 'tolerance for direct confrontation'],
    ['interaction.warmth', 'desired emotional warmth'],
    ['interaction.playfulness', 'appropriate humor, playfulness, or flirtation'],
    ['interaction.avoidance', 'whether and how Penny should name avoidance'],
    ['interaction.overwhelm', 'how Penny should respond to overwhelm'],
    ['interaction.presence', 'how to recognize when the user wants company rather than action'],
    ['interaction.commitment', 'how to distinguish brainstorming from commitment'],
    ['interaction.records', 'what should never automatically become an operational record'],
    ['interaction.permission', 'which actions require explicit permission'],
    ['longterm.proactivity', 'desired degree and style of proactivity'],
    ['longterm.reminders', 'reminder and notification tolerance'],
    ['longterm.accountability', 'preferred accountability style'],
    ['longterm.reviews', 'useful review and check-in cadence'],
    ['longterm.goals', 'how often goals should be revisited'],
    ['longterm.abandonment', 'how to treat abandoned commitments'],
    ['longterm.release', 'when something should be allowed to disappear'],
    ['longterm.memory', 'what should be remembered permanently'],
    ['longterm.privacy', 'what should remain private, temporary, or compartmentalized'],
    ['longterm.sharing', 'how modalities should share information'],
    ['longterm.boundaries', 'where modality boundaries should remain firm'],
    ['longterm.success', 'what successful use looks like after one month, six months, and a year'],
    ['persona.emotional_role', 'emotional purpose of Penny and the cast'],
    ['persona.practical_role', 'practical responsibility of Penny and the cast'],
    ['persona.domain_tone', 'how persona tone should vary by domain'],
    ['persona.failure_modes', 'persona behavior that would become irritating, manipulative, or unsafe'],
    ['persona.initiative', 'how much initiative personas should take'],
    ['persona.texture', 'useful relationship textures and differences among personas'],
    ['persona.routing', 'what each persona should route elsewhere or never do'],
  ]),

  ...entries('handoff', 'condition', [
    ['handoff.deadlines', 'hard deadlines during the next two weeks'],
    ['handoff.promises', 'promises already made to other people'],
    ['handoff.crises', 'active crises or likely harm if something is neglected'],
    ['handoff.in_motion', 'work already underway that should not be disrupted'],
    ['handoff.blocking_decisions', 'decisions currently blocking other work'],
    ['handoff.capacity', 'realistic time and energy available this week'],
    ['handoff.volatility', 'conditions likely to change abruptly'],
    ['handoff.relief', 'what could create meaningful immediate relief'],
    ['handoff.not_ready', 'what the user is not ready to address'],
    ['handoff.leave_alone', 'what Penny should leave alone'],
    ['handoff.first_help', 'what the user most wants help with first'],
    ['handoff.first_modality', 'which modality should conduct its orientation first'],
  ]),
]

export const INTAKE_INDEX = Object.fromEntries(
  INTAKE_CATALOG.map((entry) => [entry.key, entry])
) as Record<string, IntakeCatalogEntry>

export const STATUS_VALUE: Record<'unknown' | IntakeStatus, number> = {
  unknown: 0,
  touched: 0.25,
  provisional: 0.6,
  supported: 0.85,
  known: 1,
  not_applicable: 1,
}

export interface IntakeEntryLike {
  key: string
  status: string
  content?: string | null
  evidence?: string | null
  contradictions?: string | null
  openQuestion?: string | null
}

export interface IntakeBucketScore {
  bucket: IntakeBucket
  percent: number
  unknown: number
  touched: number
  provisional: number
  complete: number
  total: number
}

export interface IntakeScore {
  percent: number
  eligible: boolean
  buckets: IntakeBucketScore[]
  unevaluatedKeys: string[]
  weakKeys: string[]
}

export function scoreIntake(rows: IntakeEntryLike[]): IntakeScore {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const buckets = (['identity', 'state', 'relationship', 'handoff'] as IntakeBucket[]).map((bucket) => {
    const catalog = INTAKE_CATALOG.filter((entry) => entry.bucket === bucket)
    const statuses = catalog.map((entry) => {
      const status = byKey.get(entry.key)?.status
      return status && status in STATUS_VALUE ? status as IntakeStatus : 'unknown'
    })
    const sum = statuses.reduce((total, status) => total + STATUS_VALUE[status], 0)
    return {
      bucket,
      percent: Math.round((sum / catalog.length) * 100),
      unknown: statuses.filter((status) => status === 'unknown').length,
      touched: statuses.filter((status) => status === 'touched').length,
      provisional: statuses.filter((status) => status === 'provisional').length,
      complete: statuses.filter((status) => status === 'known' || status === 'not_applicable').length,
      total: catalog.length,
    }
  })
  const unevaluatedKeys = INTAKE_CATALOG
    .filter((entry) => !byKey.has(entry.key) || byKey.get(entry.key)?.status === 'touched')
    .map((entry) => entry.key)
  const weakKeys = INTAKE_CATALOG
    .filter((entry) => ['unknown', 'touched', 'provisional'].includes(byKey.get(entry.key)?.status ?? 'unknown'))
    .map((entry) => entry.key)
  const percent = Math.round(
    buckets.reduce((sum, bucket) => sum + bucket.percent * bucket.total, 0) /
    buckets.reduce((sum, bucket) => sum + bucket.total, 0)
  )
  return {
    percent,
    eligible: unevaluatedKeys.length === 0 && buckets.every((bucket) => bucket.percent >= 75),
    buckets,
    unevaluatedKeys,
    weakKeys,
  }
}

function appendUnique(existing: string, additions: unknown): string {
  const current = existing.split('\n').map((line) => line.trim()).filter(Boolean)
  const incoming = Array.isArray(additions)
    ? additions.map(String)
    : additions ? [String(additions)] : []
  return [...new Set([...current, ...incoming.map((line) => line.trim()).filter(Boolean)])].join('\n')
}

export async function getIntakeDashboard(profileId: string): Promise<{
  rows: IntakeEntryLike[]
  score: IntakeScore
  text: string
}> {
  const rows = await prisma.intakeEntry.findMany({ where: { profileId } })
  const score = scoreIntake(rows)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const lines: string[] = [
    'PRIVATE INTAKE DASHBOARD — never reveal this apparatus to the user.',
    `Overall completeness: ${score.percent}% · mechanically eligible to finish: ${score.eligible ? 'yes' : 'no'}`,
  ]
  for (const bucket of score.buckets) {
    lines.push(`\n${bucket.bucket.toUpperCase()} — ${bucket.percent}%`)
    for (const entry of INTAKE_CATALOG.filter((candidate) => candidate.bucket === bucket.bucket)) {
      const row = byKey.get(entry.key)
      if (!row) {
        lines.push(`- [unknown] ${entry.key}: ${entry.label}`)
        continue
      }
      const content = row.content?.trim() ? ` — ${row.content.trim()}` : ''
      lines.push(`- [${row.status}] ${entry.key}: ${entry.label}${content}`)
      if (row.evidence?.trim()) lines.push(`  evidence: ${row.evidence.trim().replace(/\n/g, ' / ').slice(-600)}`)
      if (row.contradictions?.trim()) lines.push(`  tension: ${row.contradictions.trim().replace(/\n/g, ' / ').slice(-600)}`)
      if (row.openQuestion?.trim()) lines.push(`  still unclear: ${row.openQuestion.trim()}`)
    }
  }
  return { rows, score, text: lines.join('\n') }
}

interface IntakeUpdate {
  key?: unknown
  status?: unknown
  content?: unknown
  evidence?: unknown
  contradictions?: unknown
  open_question?: unknown
}

export async function updateIntakeLedger(profileId: string, rawUpdates: unknown): Promise<string> {
  if (!Array.isArray(rawUpdates)) throw new Error('updates must be an array')
  const changed: string[] = []
  for (const raw of rawUpdates as IntakeUpdate[]) {
    const key = String(raw.key ?? '')
    const catalog = INTAKE_INDEX[key]
    if (!catalog) throw new Error(`unknown intake key: ${key}`)
    const status = String(raw.status ?? '') as IntakeStatus
    if (!INTAKE_STATUSES.includes(status)) throw new Error(`invalid intake status for ${key}: ${status}`)
    const existing = await prisma.intakeEntry.findUnique({
      where: { profileId_key: { profileId, key } },
    })
    const content = raw.content === undefined ? existing?.content ?? '' : String(raw.content)
    const evidence = appendUnique(existing?.evidence ?? '', raw.evidence)
    const contradictions = appendUnique(existing?.contradictions ?? '', raw.contradictions)
    const openQuestion = raw.open_question === undefined
      ? existing?.openQuestion ?? ''
      : String(raw.open_question ?? '')
    await prisma.intakeEntry.upsert({
      where: { profileId_key: { profileId, key } },
      create: { profileId, bucket: catalog.bucket, key, status, content, evidence, contradictions, openQuestion },
      update: { bucket: catalog.bucket, status, content, evidence, contradictions, openQuestion },
    })
    if (key === 'bio.preferred_name' && ['supported', 'known'].includes(status) && content.trim()) {
      await prisma.profile.update({ where: { id: profileId }, data: { userName: content.trim() } })
    }
    changed.push(key)
  }
  const { score } = await getIntakeDashboard(profileId)
  const bucketSummary = score.buckets.map((bucket) => `${bucket.bucket} ${bucket.percent}%`).join(' · ')
  if (changed.length === 0) {
    return `Private ledger audited; this turn changed no entries. ${bucketSummary}. Finish eligible: ${score.eligible ? 'yes' : 'no'}.`
  }
  return `Private ledger updated (${changed.join(', ')}). ${bucketSummary}. Finish eligible: ${score.eligible ? 'yes' : 'no'}.`
}

interface IntakeCompletion {
  user_portrait?: unknown
  current_state?: unknown
  working_agreement?: unknown
  launch_brief?: unknown
}

export async function completeIntake(profileId: string, input: IntakeCompletion): Promise<{
  ok: boolean
  content: string
}> {
  const { score } = await getIntakeDashboard(profileId)
  if (!score.eligible) {
    const weakest = score.weakKeys.slice(0, 12).join(', ')
    return {
      ok: false,
      content: `Intake is not mechanically ready. Private weak/unevaluated areas: ${weakest || '(none)'}. Continue naturally; do not expose this message.`,
    }
  }
  const userPortrait = String(input.user_portrait ?? '').trim()
  const currentState = String(input.current_state ?? '').trim()
  const workingAgreement = String(input.working_agreement ?? '').trim()
  const launchBrief = String(input.launch_brief ?? '').trim()
  if ([userPortrait, currentState, workingAgreement, launchBrief].some((value) => value.length < 120)) {
    return { ok: false, content: 'Each final intake document must be specific and at least 120 characters. Continue privately.' }
  }
  // Casting is part of completion, not an optional epilogue. If the separate
  // synthesis cannot produce a valid assessment of every candidate, intake
  // remains open rather than silently losing the recommendation.
  const recommendations = await generateModalityRecommendations(profileId, {
    userPortrait,
    currentState,
    workingAgreement,
    launchBrief,
  })
  const now = new Date()
  await prisma.$transaction([
    prisma.profile.update({
      where: { id: profileId },
      data: {
        intakeComplete: true,
        aboutUser: userPortrait,
        aboutUserUpdatedAt: now,
        workingAgreement,
        workingAgreementUpdatedAt: now,
      },
    }),
    prisma.deepMemory.upsert({
      where: { profileId_name: { profileId, name: 'intake-current-state' } },
      create: { profileId, name: 'intake-current-state', content: currentState, domain: null },
      update: { content: currentState },
    }),
    prisma.deepMemory.upsert({
      where: { profileId_name: { profileId, name: 'intake-working-agreement' } },
      create: { profileId, name: 'intake-working-agreement', content: workingAgreement, domain: null },
      update: { content: workingAgreement },
    }),
    prisma.deepMemory.upsert({
      where: { profileId_name: { profileId, name: 'intake-launch-brief' } },
      create: { profileId, name: 'intake-launch-brief', content: launchBrief, domain: null },
      update: { content: launchBrief },
    }),
    prisma.modalityBrief.upsert({
      where: { profileId_modalityId: { profileId, modalityId: 'pa' } },
      create: { profileId, modalityId: 'pa', content: `CURRENT STATE\n${currentState}\n\nIMMEDIATE HANDOFF\n${launchBrief}` },
      update: { content: `CURRENT STATE\n${currentState}\n\nIMMEDIATE HANDOFF\n${launchBrief}` },
    }),
  ])
  return {
    ok: true,
    content: [
      'Intake finalized. The private portrait, state map, working agreement, launch brief, and complete modality assessment are saved.',
      '',
      recommendations.toolSummary,
    ].join('\n'),
  }
}

export const INTAKE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'update_intake_ledger',
    description: 'MANDATORY FIRST ACTION after every substantive user reply during intake: privately audit what the user just said against what is already known, then add or revise every affected area. Pass an empty updates array when the reply truly changes nothing. Never mention this tool, its keys, statuses, evidence, or scores to the user.',
    input_schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', enum: INTAKE_CATALOG.map((entry) => entry.key) },
              status: { type: 'string', enum: [...INTAKE_STATUSES] },
              content: { type: 'string', description: 'Current fact or interpretation. For bio.preferred_name, use only the exact preferred name.' },
              evidence: { type: 'array', items: { type: 'string' }, description: 'New concrete supporting observations to append.' },
              contradictions: { type: 'array', items: { type: 'string' }, description: 'New tensions or counterevidence to append.' },
              open_question: { type: 'string', description: 'What remains unclear; empty string clears it.' },
            },
            required: ['key', 'status', 'content'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'complete_intake',
    description: 'Finalize intake only when the private dashboard is mechanically eligible and your own understanding is specific enough. Saves four durable documents, generates and preserves the complete modality-candidate assessment, and ends intake.',
    input_schema: {
      type: 'object',
      properties: {
        user_portrait: { type: 'string', description: 'Durable, specific portrait: biography, patterns, values, strengths, tensions, and how this person tends to move through life.' },
        current_state: { type: 'string', description: 'Dated state map covering now, next month, six months, and one year, with uncertainty stated honestly.' },
        working_agreement: { type: 'string', description: 'How Penny and the cast should behave in single interactions and over long-term use, including boundaries and persona calibration.' },
        launch_brief: { type: 'string', description: 'Short-lived immediate operating conditions: deadlines, promises, capacity, hazards, relief, what to leave alone, and the best first handoff. No invented project list.' },
      },
      required: ['user_portrait', 'current_state', 'working_agreement', 'launch_brief'],
    },
  },
]

export const INTAKE_TOOL_NAMES = new Set(INTAKE_TOOLS.map((tool) => tool.name))
