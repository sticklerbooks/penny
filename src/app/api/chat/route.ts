import { NextRequest } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db'
import {
  getAnthropic,
  buildSystemPrompt,
  cachedSystem,
  PENNY_MODEL,
} from '@/lib/claude'
import { extractAndSaveMemories } from '@/lib/memory'
import { parseActions } from '@/lib/actions'
import { getModality, resolveModality } from '@/lib/modalities'
import { touchActive } from '@/lib/modality-state'
import { executeTool, type ToolContext } from '@/lib/tool-executor'
import { getToolsForModality } from '@/lib/tools'
import { runAgenticLoop } from '@/lib/agentic-loop'
import { closeSessionPrompt } from '@/lib/close-session'
import { outerLifeEnabled } from '@/lib/outer-life'
import { getContextBundle, getModalityBrief, getModalityIdentity } from '@/lib/context-cache'
import { getEmailCalendarSummary } from '@/lib/email-calendar'

export const dynamic = 'force-dynamic'

// ─── Streaming block accumulator ─────────────────────────────────────────────
// Track content blocks as they arrive in the stream so we can feed tool_use
// blocks back through the agentic loop.
type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; _raw?: string }

function finalizeBlocks(blocks: StreamBlock[]): Anthropic.ContentBlock[] {
  // Parse any accumulated JSON and strip helper fields
  return blocks
    .filter((b) => b.type === 'text' || b.type === 'tool_use')
    .map((b) => {
      if (b.type === 'tool_use') {
        let parsed: Record<string, unknown> = {}
        if (b._raw) {
          try { parsed = JSON.parse(b._raw) } catch { /* keep {} */ }
        }
        return { type: 'tool_use' as const, id: b.id, name: b.name, input: parsed }
      }
      return { type: 'text' as const, text: b.text, citations: [] }
    }) as unknown as Anthropic.ContentBlock[]
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { message, conversationId, isAutoStart, isVoice, switchTo } =
    await req.json()

  // ── Profile ────────────────────────────────────────────────────────────────
  let profile = await prisma.profile.findFirst()
  if (!profile) {
    profile = await prisma.profile.create({ data: {} })
  }

  // ── Conversation: load existing ────────────────────────────────────────────
  let convoId = conversationId as string | null
  let existingMessages: { role: string; content: string }[] = []
  let activeModality = 'pa'

  if (convoId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: convoId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (existing && !existing.closed) {
      existingMessages = existing.messages
      activeModality = existing.activeModality || 'pa'
    } else {
      convoId = null
    }
  }

  // ── Detect manual switch ───────────────────────────────────────────────────
  const manualSwitch = switchTo ? resolveModality(String(switchTo)) : null
  const outgoingModalityId = activeModality
  const isSwitch = !!manualSwitch && manualSwitch.id !== outgoingModalityId

  // ── Load all context (cached) ──────────────────────────────────────────────
  // The heavy profile-scoped fan-out lives in an in-memory cache that any
  // mutating tool invalidates, so this is usually instant and never stale within
  // a conversation. See src/lib/context-cache.ts.
  const { memories, tasks, notes, clients, scheduledMessages, weeklyBrief, projects, pendingEvents } =
    await getContextBundle(profile.id)

  const outgoingModality = getModality(outgoingModalityId)

  // ── Close-out sweep (on switch) ────────────────────────────────────────────
  // The outgoing self runs a full end-of-session pass with its own toolset:
  // tidy its domain, leave a carry-note, refresh its brief (and, for the PA,
  // the identity docs) if the session warrants it.
  //
  // Fire-and-forget (matches the mid-session sweep below) — NOT awaited. The
  // context bundle for THIS request was already snapshotted above, before this
  // runs, so nothing in the current response depends on the sweep finishing
  // first. Awaiting it used to block the new modality's first reply behind up
  // to 6 rounds of the outgoing self's own tool-calling — the dominant cost of
  // "switching feels slow."
  if (isSwitch && existingMessages.length > 0) {
    const snapshotMessages = existingMessages
    void (async () => {
      try {
        const outgoingBrief = await getModalityBrief(profile.id, outgoingModalityId)
        const outgoingIdentity = await getModalityIdentity(profile.id, outgoingModalityId)

        const closeSystem = buildSystemPrompt(
          profile, memories, tasks, notes, clients,
          scheduledMessages, null, false, outgoingModalityId, null, false,
          outgoingBrief, projects, pendingEvents, outgoingIdentity
        )
        const closeCtx: ToolContext = {
          profileId: profile.id,
          modalityId: outgoingModalityId,
          domain: outgoingModality.domain ?? undefined,
        }

        await runAgenticLoop({
          model: PENNY_MODEL,
          maxTokens: 1500,
          system: cachedSystem(closeSystem),
          tools: getToolsForModality(outgoingModalityId),
          initialMessages: [
            ...snapshotMessages.slice(-12).map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
            { role: 'user', content: closeSessionPrompt(outgoingModality, profile!.userName || 'Adam') },
          ],
          ctx: closeCtx,
          maxRounds: 6,
          onToolCall: (name, res) =>
            console.log(`[switch close] ${outgoingModalityId} → ${name} [${res.is_error ? 'ERR' : 'OK'}]`),
        })
      } catch (err) {
        console.error('[switch] close-out sweep failed:', err)
      }
    })()
  }

  // ── Close old convo and open fresh one ────────────────────────────────────
  if (isSwitch) {
    if (convoId) {
      await prisma.conversation.update({ where: { id: convoId }, data: { closed: true } })
    }
    activeModality = manualSwitch!.id
    const newConvo = await prisma.conversation.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { profileId: profile.id, type: 'daily', activeModality } as any,
    })
    convoId = newConvo.id
    existingMessages = []
  } else if (!convoId) {
    const newConvo = await prisma.conversation.create({
      data: {
        profileId: profile.id,
        type: profile.intakeComplete ? 'daily' : 'intake',
        activeModality,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })
    convoId = newConvo.id
  }

  // ── Load modality brief + identity (after switch resolves — activeModality is final) ─
  // Both come from the context cache (per-modality, same TTL as the bundle).
  const modalityBrief = await getModalityBrief(profile.id, activeModality)

  // Per-modality identity (own self-portrait + slice of the user). May not exist
  // yet — buildSystemPrompt falls back to the persona seed when null.
  const modalityIdentity = await getModalityIdentity(profile.id, activeModality)

  // Outer life (FLAGGED) — the Showrunner-authored ledger of this self's life
  // outside work. Table may not exist; always catch. Null unless OUTER_LIFE_ENABLED.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const outerLifeLedger = outerLifeEnabled()
    ? await db.outerLife
        .findUnique({ where: { profileId_modalityId: { profileId: profile.id, modalityId: activeModality } } })
        .then((r: { ledger: string | null } | null) => r?.ledger ?? null)
        .catch(() => null)
    : null

  // Email/calendar snapshot is PA-only — fetch it just for her (its own 30-min
  // cache covers repeat turns), so the six submodalities never pay the Google +
  // Haiku cost for a summary they don't render.
  const emailCalendarSummary =
    getModality(activeModality).domain === null
      ? await getEmailCalendarSummary(profile.id).catch(() => null)
      : null

  // ── Build system prompt ────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    profile, memories, tasks, notes, clients,
    scheduledMessages, emailCalendarSummary,
    !profile.intakeComplete, activeModality, weeklyBrief, false,
    modalityBrief, projects, pendingEvents, modalityIdentity, outerLifeLedger
  )

  const currentModality = getModality(activeModality)

  // ── Trigger message ────────────────────────────────────────────────────────
  const contextCleared = isSwitch
  const isSilentTrigger = isAutoStart || (contextCleared && !message?.trim())

  const triggerMessage = isAutoStart
    ? 'Please begin. The user has just opened the app for the first time.'
    : isSwitch && !message?.trim()
    ? `You're starting a fresh session as ${currentModality.displayName} (${currentModality.role}). Greet ${profile.userName || 'them'} briefly and warmly in your own voice.`
    : message

  // Voice: keep responses short and spoken-word natural
  const finalSystemPrompt = isVoice
    ? systemPrompt +
      `\n\n═══════════════════════════════════════════════════════════════════════
YOU ARE ON A VOICE CALL RIGHT NOW
═══════════════════════════════════════════════════════════════════════
${profile.userName || 'The user'} is talking to you out loud and hearing your reply spoken back. Keep responses SHORT and conversational — usually one to three sentences. No lists, no markdown, no headers. Talk like a real phone call: natural, warm, to the point. You can still use your tools silently as normal.`
    : systemPrompt

  const claudeMessages: Anthropic.MessageParam[] = [
    ...existingMessages.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: triggerMessage },
  ]

  // Save user message (not for silent triggers)
  if (!isSilentTrigger && message?.trim()) {
    await prisma.message.create({
      data: { conversationId: convoId!, role: 'user', content: message },
    })
  }

  const encoder = new TextEncoder()
  let fullResponse = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const ctx: ToolContext = {
          profileId: profile!.id,
          modalityId: activeModality,
          domain: currentModality.domain ?? undefined,
        }
        const tools = getToolsForModality(activeModality)

        // Stream a single model turn: emit text deltas live, accumulate content
        // blocks (including tool_use input JSON), and report the stop reason.
        const streamTurn = async (
          msgs: Anthropic.MessageParam[]
        ): Promise<{ blocks: StreamBlock[]; stopReason: string }> => {
          const blocks: StreamBlock[] = []
          let stopReason = 'end_turn'
          const stream = await getAnthropic().messages.create({
            model: PENNY_MODEL,
            max_tokens: 2048,
            system: cachedSystem(finalSystemPrompt),
            tools,
            messages: msgs,
            stream: true,
          })
          for await (const ev of stream) {
            switch (ev.type) {
              case 'content_block_start':
                if (ev.content_block.type === 'text') {
                  blocks.push({ type: 'text', text: '' })
                } else if (ev.content_block.type === 'tool_use') {
                  blocks.push({
                    type: 'tool_use',
                    id: ev.content_block.id,
                    name: ev.content_block.name,
                    input: {},
                  })
                }
                break

              case 'content_block_delta': {
                const block = blocks[ev.index]
                if (!block) break
                if (ev.delta.type === 'text_delta' && block.type === 'text') {
                  block.text += ev.delta.text
                  fullResponse += ev.delta.text
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ text: ev.delta.text })}\n\n`)
                  )
                } else if (ev.delta.type === 'input_json_delta' && block.type === 'tool_use') {
                  block._raw = (block._raw ?? '') + ev.delta.partial_json
                }
                break
              }

              case 'content_block_stop': {
                const block = blocks[ev.index]
                if (block?.type === 'tool_use' && block._raw) {
                  try { block.input = JSON.parse(block._raw) } catch { /* keep {} */ }
                }
                break
              }

              case 'message_delta':
                stopReason = ev.delta.stop_reason ?? 'end_turn'
                break
            }
          }
          return { blocks, stopReason }
        }

        // First turn + agentic tool loop. EVERY turn is streamed — including
        // continuations after tool calls — so the user sees text appear live
        // and nothing is dropped from the saved message.
        const loopMessages: Anthropic.MessageParam[] = [...claudeMessages]
        const MAX_ROUNDS = 10
        let round = 0

        let turn = await streamTurn(loopMessages)
        let finalized = finalizeBlocks(turn.blocks)
        loopMessages.push({ role: 'assistant', content: finalized })

        while (turn.stopReason === 'tool_use' && round < MAX_ROUNDS) {
          round++

          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const block of finalized) {
            if (block.type !== 'tool_use') continue
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ working: true, tool: block.name })}\n\n`)
            )
            const result = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              ctx
            )
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.content,
              ...(result.is_error ? { is_error: true } : {}),
            })
            console.log(`[chat] ${activeModality} → ${block.name} [${result.is_error ? 'ERR' : 'OK'}]`)
          }

          loopMessages.push({ role: 'user', content: toolResults })
          turn = await streamTurn(loopMessages)
          finalized = finalizeBlocks(turn.blocks)
          loopMessages.push({ role: 'assistant', content: finalized })
        }

        // ════════════════════════════════════════════════════════════════════
        // POST-PROCESSING
        // ════════════════════════════════════════════════════════════════════

        // Detect intake completion marker (written inline by model in old style;
        // new style uses a tool, but keep this check for the transition period)
        const intakeJustCompleted =
          fullResponse.includes('<<INTAKE_COMPLETE>>') && !profile!.intakeComplete
        let workingText = fullResponse.replace('<<INTAKE_COMPLETE>>', '')

        // Strip the only remaining inline marker (artifact) from the visible
        // text and surface it. State mutations all happened via the tool
        // executor above.
        const { actions, cleanText } = parseActions(workingText)
        workingText = cleanText

        // Extract artifact (first one wins)
        const artifactAction = actions.find((a) => a.kind === 'artifact') ?? null

        if (intakeJustCompleted) {
          await prisma.profile.update({
            where: { id: profile!.id },
            data: { intakeComplete: true },
          })
        }

        // Stamp activity for nightly cron tracking
        await touchActive(profile!.id, currentModality.id)

        // Save Penny's response
        await prisma.message.create({
          data: { conversationId: convoId!, role: 'assistant', content: workingText },
        })

        // Background memory extraction
        if (!isSilentTrigger) {
          extractAndSaveMemories(profile!.id, message, workingText).catch(() => {})
        }

        // Mid-session hygiene: every 20 messages, run a background close sweep so
        // important context is captured before the sliding window drops it.
        // +2 for the user message + assistant response just saved (or +1 for silent).
        const newMsgCount = existingMessages.length + (!isSilentTrigger && message?.trim() ? 2 : 1)
        if (newMsgCount >= 20 && newMsgCount % 20 === 0) {
          const midBrief = await getModalityBrief(profile!.id, activeModality)
          const midCloseSystem = buildSystemPrompt(
            profile!, memories, tasks, notes, clients,
            scheduledMessages, emailCalendarSummary, false,
            activeModality, null, false, midBrief, projects, pendingEvents, modalityIdentity
          )
          // (emailCalendarSummary above is the PA-only value from this turn — null
          // for submodalities — which is correct for the hygiene sweep too.)
          const midCtx: ToolContext = {
            profileId: profile!.id,
            modalityId: activeModality,
            domain: currentModality.domain ?? undefined,
          }
          runAgenticLoop({
            model: PENNY_MODEL,
            maxTokens: 1500,
            system: cachedSystem(midCloseSystem),
            tools: getToolsForModality(activeModality),
            initialMessages: [
              ...existingMessages.slice(-12).map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              })),
              { role: 'user', content: closeSessionPrompt(currentModality, profile!.userName || 'Adam') },
            ],
            ctx: midCtx,
            maxRounds: 6,
            onToolCall: (name, res) =>
              console.log(`[mid-session close] ${activeModality} → ${name} [${res.is_error ? 'ERR' : 'OK'}]`),
          }).catch((err) => console.error('[mid-session close] failed:', err))
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              conversationId: convoId,
              intakeComplete: intakeJustCompleted,
              cleanText: workingText,
              activeModality,
              contextCleared,
              artifact: artifactAction
                ? { filename: artifactAction.filename, content: artifactAction.content }
                : null,
            })}\n\n`
          )
        )
      } catch (err) {
        console.error('Chat stream error:', err)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: String(err),
              conversationId: convoId,
            })}\n\n`
          )
        )
      } finally {
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
