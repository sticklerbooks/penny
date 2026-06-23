// The review runner — executes ONE step of the active review: any scripted prep for
// the phase, then a single LLM turn (the conversation), then the engine diffs the
// DB to produce the chips and decides whether to advance. The LLM never decides
// what "happened" — the chips come from the before/after snapshot, not its words.

import { prisma } from '@/lib/db'
import { getModality } from '@/lib/modalities'
import { getAnthropic, cachedSystem, PENNY_MODEL } from '@/lib/claude'
import { runAgenticLoop } from '@/lib/agentic-loop'
import { searchItems, type ItemRow } from '@/lib/items/item-store'
import { reviewToolSchemas, executeReviewTool, type ReviewToolContext } from '@/lib/items/item-tools'
import { computeChips, type ItemSnapshot, type EngineChip } from './deltas'
import { toolsForPhase, phaseInstructions } from './context'
import { paNotesQueue, subNotesReadQueue, notesPassQueue } from './selectors'
import { activeReview, advanceReview, type ReviewSessionRow } from './session'
import { runSubmodalitiesPrep, runNotesPassCopyUp, runWrapUp } from './scripted'
import type { ReviewKind, Phase } from './phases'
import type { PaStatus, ModalityStatus } from '@/lib/items/fsm'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

export interface ReviewStepResult {
  phase: Phase
  kind: ReviewKind
  modalityId: string
  text: string
  chips: EngineChip[]
  advanced: boolean
  done: boolean
}

async function snapshot(profileId: string): Promise<ItemSnapshot[]> {
  const items = await searchItems(profileId, { visibleOnly: false })
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    target: i.target,
    paStatus: i.paStatus,
    modalityStatus: i.modalityStatus,
    visibility: i.visibility,
  }))
}

function fmtItems(items: ItemRow[]): string {
  if (!items.length) return '  (none)'
  return items
    .map((i) => {
      const status = i.target === 'pa' ? `pa=${i.paStatus}` : `mod=${i.modalityStatus}`
      return `  • [${i.id}] "${i.name}" — ${i.type}, ${status}, p${i.priority}${i.duration ? `, ${i.duration}` : ''}`
    })
    .join('\n')
}

// The items the active phase puts in front of the self, already ordered per spec.
async function loadPhaseItems(
  profileId: string,
  kind: ReviewKind,
  modalityId: string,
  phase: Phase,
  sessionStartedAt: Date
): Promise<string> {
  if (kind === 'pa' && phase === 'notes') {
    const items = await searchItems(profileId, { target: 'pa' })
    return fmtItems(paNotesQueue(items.map((i) => ({ ...i, paStatus: i.paStatus as PaStatus | null }))) as ItemRow[])
  }
  if (kind === 'submodality' && phase === 'notes-read') {
    const items = await searchItems(profileId, { target: modalityId })
    return fmtItems(subNotesReadQueue(items.map((i) => ({ ...i, modalityStatus: i.modalityStatus as ModalityStatus | null }))) as ItemRow[])
  }
  if (kind === 'submodality' && phase === 'notes-pass') {
    const items = await searchItems(profileId, { target: modalityId })
    const queue = notesPassQueue(
      items.map((i) => ({ id: i.id, modalityStatus: i.modalityStatus as ModalityStatus | null, createdAt: i.createdAt })),
      sessionStartedAt
    )
    const ids = new Set(queue.map((q) => q.id))
    return fmtItems(items.filter((i) => ids.has(i.id)))
  }
  if (kind === 'pa' && phase === 'calendar') {
    const items = (await searchItems(profileId, { target: 'pa' })).filter((i) => i.paStatus === 'schedule')
    return fmtItems(items)
  }
  if (kind === 'pa' && phase === 'submodalities') {
    const items = (await searchItems(profileId, { target: 'pa' })).filter(
      (i) => i.name.startsWith('Talk to ') && i.paStatus === 'schedule'
    )
    return fmtItems(items)
  }
  if (phase === 'projects') {
    const projects = await db().project.findMany({
      where: {
        profileId,
        ...(kind === 'pa' ? { progress: { gte: 3, lte: 9 } } : { assignedModality: modalityId }),
        visibility: true,
      },
    })
    if (!projects.length) return '  (none)'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return projects.map((p: any) => `  • [${p.id}] "${p.name}" — ${p.progress}/10`).join('\n')
  }
  return '  (none)'
}

async function buildReviewPrompt(
  profileId: string,
  kind: ReviewKind,
  modalityId: string,
  phase: Phase,
  userName: string
): Promise<string> {
  const modality = getModality(modalityId)
  const identity = await db().modalityIdentity.findUnique({
    where: { profileId_modalityId: { profileId, modalityId } },
  })
  const aboutSelf: string =
    identity?.aboutSelf ?? modality.seedAboutSelf?.replace(/\{name\}/g, userName) ?? `You are ${modality.displayName}.`

  const items = await loadPhaseItems(profileId, kind, modalityId, phase, new Date(0))
  const phaseNum = '' // header is rendered client-side from the persisted pointer

  return `You are ${modality.displayName} — ${modality.role}.

${aboutSelf}

═══════════════════════════════════════════════════════════════
${phaseInstructions(kind, phase, userName)}${phaseNum}
═══════════════════════════════════════════════════════════════

ITEMS IN THIS PHASE:
${items}

Stay conversational and brief — this is ${userName}'s review, not a monologue. Record real changes with your tools as you go; never just say you'll do something. 📅 Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
}

async function runPhaseTurn(
  profileId: string,
  session: ReviewSessionRow,
  kind: ReviewKind,
  phase: Phase,
  messages: ChatMsg[],
  userName: string
): Promise<{ text: string; finishRequested: boolean }> {
  const system = await buildReviewPrompt(profileId, kind, session.modalityId, phase, userName)
  const tools = reviewToolSchemas(toolsForPhase(kind, phase))
  const ctx: ReviewToolContext = {
    profileId,
    modalityId: session.modalityId,
    domain: getModality(session.modalityId).domain ?? undefined,
    reviewSessionId: session.id,
  }

  const initial = messages.length ? messages : [{ role: 'user' as const, content: '(begin this phase)' }]
  const result = await runAgenticLoop({
    model: PENNY_MODEL,
    maxTokens: 1200,
    system: cachedSystem(system),
    tools,
    initialMessages: initial,
    ctx,
    executeToolFn: (n, a, c) => executeReviewTool(n, a, c as ReviewToolContext),
  })
  return { text: result.finalText, finishRequested: !!ctx.finishRequested }
}

/** Run one step of the active review for this profile. `messages` is the phase
 *  conversation so far (the caller holds chat history). */
export async function runReviewStep(profileId: string, messages: ChatMsg[]): Promise<ReviewStepResult> {
  const session = await activeReview(profileId)
  if (!session) throw new Error('no active review')
  const kind = session.kind as ReviewKind
  const phase = session.phase as Phase
  const profile = await prisma.profile.findFirst()
  const userName = profile?.userName || 'Adam'

  // Scripted prep that must happen before the self sees the phase.
  if (kind === 'pa' && phase === 'submodalities') await runSubmodalitiesPrep(profileId)

  const before = await snapshot(profileId)
  const { text, finishRequested } = await runPhaseTurn(profileId, session, kind, phase, messages, userName)
  const after = await snapshot(profileId)
  const chips = computeChips(before, after)

  if (finishRequested) {
    if (kind === 'submodality' && phase === 'notes-pass') await runNotesPassCopyUp(profileId, session.startedAt)
    if (phase === 'wrap-up') await runWrapUp(profileId, session.modalityId)
    const adv = await advanceReview(session.id)
    return { phase, kind, modalityId: session.modalityId, text, chips, advanced: true, done: adv.done }
  }
  return { phase, kind, modalityId: session.modalityId, text, chips, advanced: false, done: false }
}
