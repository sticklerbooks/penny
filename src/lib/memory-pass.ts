// The end_chat memory pass — replaces both the old per-turn background
// extractor (memory.ts, retired) and the abandoned type='memory' Item idea.
//
// Runs ONCE per modality, only when the user clicks End Chat, over every
// message that modality has sent since her last pass (ModalityState.
// lastMemoryPassAt — null means "ever"). She reads the whole transcript at
// once and follows the 'memory' protocol: search first, write what's durable
// to deep memory / the log / identity, then rewrite her brief. See
// src/lib/protocols.ts's 'memory' case for the exact instructions she follows.
//
// Deliberately NOT live-chat-callable — see MEMORY_PASS_TOOLS in tools.ts.

import { prisma } from './db'
import { PENNY_MODEL } from './claude'
import { runAgenticLoop } from './agentic-loop'
import { MEMORY_PASS_TOOLS } from './tools'
import { getProtocol } from './protocols'
import { getModality, MODALITIES } from './modalities'
import type { ToolContext } from './tool-executor'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => prisma as any

// Hard ceiling on how much transcript goes into one pass's system prompt. Sized
// against Sonnet's 200k-token context: measured against this DB's actual history
// (PA's full backlog alone is ~214k estimated tokens — already over budget on its
// own), 600k chars (~150k tokens at the usual ~4 chars/token) leaves ~50k tokens of
// headroom for the protocol text, identity/brief, tool schemas, and the handful of
// tool-call rounds the agentic loop accumulates — generous without risking a
// context-length error. A backlog bigger than this is chunked across multiple
// passes (see below), not dropped.
const TRANSCRIPT_CHAR_BUDGET = 600_000

export interface MemoryPassResult {
  modalityId: string
  messageCount: number
  rounds: number
  toolCallsExecuted: number
  hitLimit: boolean
  /** True if there's still backlog older-than-`since` left for a future pass
   *  (this pass's char budget cut off before reaching "now"). */
  hasMoreBacklog: boolean
}

/** Every modality with at least one message since its last memory pass (or
 *  ever, if it's never run). Drives the "every modality that talked" fan-out
 *  in /api/chat/end. */
export async function modalitiesPendingMemoryPass(profileId: string): Promise<string[]> {
  const liveModalityIds = new Set(MODALITIES.map((m) => m.id))

  const convos = await prisma.conversation.findMany({
    where: { profileId },
    select: { activeModality: true, messages: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  const lastMessageByModality = new Map<string, Date>()
  for (const c of convos) {
    if (!liveModalityIds.has(c.activeModality)) continue
    const latest = c.messages[0]?.createdAt
    if (!latest) continue
    const prev = lastMessageByModality.get(c.activeModality)
    if (!prev || latest > prev) lastMessageByModality.set(c.activeModality, latest)
  }
  if (lastMessageByModality.size === 0) return []

  const states = await db().modalityState.findMany({
    where: { profileId, modalityId: { in: [...lastMessageByModality.keys()] } },
  })
  const lastPassByModality = new Map<string, Date | null>(
    states.map((s: { modalityId: string; lastMemoryPassAt: Date | null }) => [s.modalityId, s.lastMemoryPassAt])
  )

  return [...lastMessageByModality.entries()]
    .filter(([modalityId, latestMessage]) => {
      const lastPass = lastPassByModality.get(modalityId)
      return !lastPass || latestMessage > lastPass
    })
    .map(([modalityId]) => modalityId)
}

/** Run one modality's memory pass. Returns null if there's nothing new to process. */
export async function runMemoryPass(profileId: string, modalityId: string): Promise<MemoryPassResult | null> {
  const state = await db().modalityState.findUnique({
    where: { profileId_modalityId: { profileId, modalityId } },
  })
  const since: Date = state?.lastMemoryPassAt ?? new Date(0)

  const profile = await prisma.profile.findUnique({ where: { id: profileId } })
  const userName = profile?.userName || 'Adam'
  const modality = getModality(modalityId)
  const isPA = modality.domain === null

  const conversations = await prisma.conversation.findMany({
    where: { profileId, activeModality: modalityId, messages: { some: { createdAt: { gt: since } } } },
    include: { messages: { where: { createdAt: { gt: since } }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  })
  const allMessages = conversations.flatMap((c) => c.messages)
  if (allMessages.length === 0) return null

  // Chronological FIFO chunk, not a recency window: a backlog bigger than the
  // budget gets its OLDEST unprocessed slice this pass (always at least one
  // message, even if it alone busts the budget — forward progress over safety
  // margin in that edge case). The cursor then advances only to the end of what
  // was actually processed, so the next pass picks up exactly where this one
  // stopped instead of skipping straight to "now" and losing the rest.
  let runningChars = 0
  let cutIndex = allMessages.length
  for (let i = 0; i < allMessages.length; i++) {
    runningChars += allMessages[i].content.length
    if (runningChars > TRANSCRIPT_CHAR_BUDGET && i > 0) {
      cutIndex = i
      break
    }
  }
  const messages = allMessages.slice(0, cutIndex)
  const hasMoreBacklog = cutIndex < allMessages.length

  const identity = await prisma.modalityIdentity
    .findUnique({ where: { profileId_modalityId: { profileId, modalityId } } })
    .catch(() => null)
  const aboutSelf =
    identity?.aboutSelf ?? modality.seedAboutSelf?.replace(/\{name\}/g, userName) ?? `You are ${modality.displayName}.`

  const briefRec = await db().modalityBrief
    .findUnique({ where: { profileId_modalityId: { profileId, modalityId } } })
    .catch(() => null)
  const currentBrief: string = briefRec?.content?.trim() || '(none written yet)'

  const transcript = messages
    .map((m) => `${m.role === 'user' ? userName : modality.displayName}: ${m.content}`)
    .join('\n\n')

  const protocolText = getProtocol('memory', { isPA, name: userName })

  const backlogNote = hasMoreBacklog
    ? `\n\n(This is the oldest unprocessed chunk of a larger backlog — there's more after this; it'll come up in a future pass. Don't worry about anything past where this transcript ends.)`
    : ''

  const system = `You are ${modality.displayName} — ${modality.role}.

${aboutSelf}

YOUR CURRENT BRIEF (what you last knew about your domain):
${currentBrief}

${protocolText}

═══════════════════════════════════════════════════════════════════════
TRANSCRIPT SINCE YOUR LAST MEMORY PASS (${messages.length} messages)${backlogNote}
═══════════════════════════════════════════════════════════════════════
${transcript}`

  const ctx: ToolContext = { profileId, modalityId, domain: modality.domain ?? undefined }

  const result = await runAgenticLoop({
    model: PENNY_MODEL,
    maxTokens: 4096,
    system,
    tools: MEMORY_PASS_TOOLS,
    initialMessages: [{ role: 'user', content: 'Run your memory protocol now, over the transcript above.' }],
    ctx,
  })

  // Advance the cursor only to the last message actually processed — not to
  // "now". When the backlog fit entirely, that's effectively the same thing;
  // when it didn't, this is what makes the next pass resume right after this
  // chunk instead of skipping the unprocessed remainder forever.
  const cursor = messages[messages.length - 1].createdAt
  await db().modalityState.upsert({
    where: { profileId_modalityId: { profileId, modalityId } },
    create: { profileId, modalityId, lastMemoryPassAt: cursor },
    update: { lastMemoryPassAt: cursor },
  })

  return {
    modalityId,
    messageCount: messages.length,
    rounds: result.rounds,
    toolCallsExecuted: result.toolCallsExecuted,
    hitLimit: result.hitLimit,
    hasMoreBacklog,
  }
}
