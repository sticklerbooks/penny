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
import {
  notesExitViolations,
  notesReadExitViolations,
  calendarExitViolations,
  considerationViolations,
  type GuardViolation,
  type GuardItem,
} from './guards'
import { activeReview, advanceReview, discussedIds, type ReviewSessionRow } from './session'
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
    type: i.type,
    priority: i.priority,
    duration: i.duration,
    dayTime: i.dayTime,
    projectId: i.projectId,
    dueDate: i.dueDate ? new Date(i.dueDate).toISOString().slice(0, 10) : null,
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

  void phaseNum
  return `You are ${modality.displayName} — ${modality.role}.

${aboutSelf}

━━━ OUTPUT RULES — these override everything ━━━
• Write ONLY what you'd say out loud to ${userName}. NEVER print your tools, a tool list, a plan, or your step-by-step reasoning — your tools fire silently and ${userName} never sees them. Your first words are a normal greeting or the first item, nothing else.
• NEVER send an empty or filler message (no "…", no "one moment"). EVERY message must do one of three things: ask ${userName} a question, raise the next item, or — when the phase is genuinely finished — call finish_phase.
• Act as you talk: the instant you two decide something, make the change with the tool right then. There is no "later," no "let me go do these now."

═══ THIS PHASE ═══
${phaseInstructions(kind, phase, userName)}

ITEMS IN THIS PHASE (only your own — stay in your lane):
${items}

Mark each item handled (mark_discussed) as you finish with it — even one you leave unchanged. finish_phase is the ONLY thing that advances; "we're done" does nothing, and if it reports something still blocking, fix that and call it again. Keep each turn short; make your changes, say your piece, and let ${userName} answer.

📅 Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.`
}

// The phase exit predicate, evaluated against the LIVE DB each time finish_phase is
// called. Re-reads the session's discussed set (mark_discussed mutates it mid-turn).
// Empty result = the phase may finish; otherwise the offenders block it.
async function phaseViolations(
  profileId: string,
  kind: ReviewKind,
  phase: Phase,
  modalityId: string,
  sessionId: string,
  sessionStartedAt: Date
): Promise<GuardViolation[]> {
  const sess: ReviewSessionRow = await db().reviewSession.findUnique({ where: { id: sessionId } })
  const discussed = new Set(discussedIds(sess))
  const asGuard = (i: ItemRow): GuardItem => ({ id: i.id, name: i.name, paStatus: i.paStatus, modalityStatus: i.modalityStatus })

  if (kind === 'pa' && phase === 'notes') {
    const items = await searchItems(profileId, { target: 'pa' })
    const queue = paNotesQueue(items.map((i) => ({ ...i, paStatus: i.paStatus as PaStatus | null }))) as ItemRow[]
    return notesExitViolations(queue.map(asGuard), discussed)
  }
  if (kind === 'submodality' && phase === 'notes-read') {
    const items = await searchItems(profileId, { target: modalityId })
    const queue = subNotesReadQueue(items.map((i) => ({ ...i, modalityStatus: i.modalityStatus as ModalityStatus | null }))) as ItemRow[]
    return notesReadExitViolations(queue.map(asGuard), discussed)
  }
  if (kind === 'pa' && phase === 'calendar') {
    const items = await searchItems(profileId, { target: 'pa' })
    return calendarExitViolations(items.map(asGuard))
  }
  if (phase === 'projects') {
    const projects = await db().project.findMany({
      where: {
        profileId,
        ...(kind === 'pa' ? { progress: { gte: 3, lte: 9 } } : { assignedModality: modalityId }),
        visibility: true,
      },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return considerationViolations(projects.map((p: any) => ({ id: p.id, name: p.name })), discussed)
  }
  if (kind === 'submodality' && phase === 'notes-pass') {
    const items = await searchItems(profileId, { target: modalityId })
    const queue = notesPassQueue(
      items.map((i) => ({ id: i.id, modalityStatus: i.modalityStatus as ModalityStatus | null, createdAt: i.createdAt })),
      sessionStartedAt
    )
    return considerationViolations(queue.map((q) => ({ id: q.id, name: items.find((i) => i.id === q.id)?.name ?? q.id })), discussed)
  }
  // greeting / user / submodalities / wrap-up: conversational — no item gate.
  return []
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
    exitCheck: () => phaseViolations(profileId, kind, phase, session.modalityId, session.id, session.startedAt),
  }

  // Sanitize the conversation for the Anthropic API: drop empty-content turns (a
  // near-empty "…" reply would be rejected), and guarantee it starts with a user
  // message — an auto-opened phase puts the self's greeting first, which the API
  // refuses as a leading assistant turn.
  let conv = messages.filter((m) => m.content && m.content.trim())
  if (conv.length && conv[0].role !== 'user') {
    conv = [{ role: 'user', content: "(let's keep going)" }, ...conv]
  }
  const initial = conv.length ? conv : [{ role: 'user' as const, content: '(begin this phase)' }]
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

  // The single chokepoint: re-verify the exit guard against the live DB right before
  // advancing, regardless of how finishRequested got set. There is no path past here
  // while any item still blocks the phase.
  if (finishRequested) {
    const blocking = await phaseViolations(profileId, kind, phase, session.modalityId, session.id, session.startedAt)
    if (blocking.length === 0) {
      if (kind === 'submodality' && phase === 'notes-pass') await runNotesPassCopyUp(profileId, session.startedAt)
      if (phase === 'wrap-up') await runWrapUp(profileId, session.modalityId)
      const adv = await advanceReview(session.id)
      return { phase, kind, modalityId: session.modalityId, text, chips, advanced: true, done: adv.done }
    }
  }
  return { phase, kind, modalityId: session.modalityId, text, chips, advanced: false, done: false }
}
