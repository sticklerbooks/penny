import { NextRequest } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db'
import {
  getAnthropic,
  buildSystemPrompt,
  cachedSystem,
  PENNY_MODEL,
  WeeklyBriefSummary,
} from '@/lib/claude'
import { extractAndSaveMemories } from '@/lib/memory'
import { parseActions } from '@/lib/actions'
import { getModality, resolveModality } from '@/lib/modalities'
import { getEmailCalendarSummary } from '@/lib/email-calendar'
import { touchActive } from '@/lib/modality-state'
import { executeTool, type ToolContext } from '@/lib/tool-executor'
import { getToolsForModality } from '@/lib/tools'
import { runAgenticLoop } from '@/lib/agentic-loop'
import { closeSessionPrompt } from '@/lib/close-session'

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

  // ── Load all context in parallel ───────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const [memories, tasks, notes, clients, scheduledMessages, emailCalendarSummary, weeklyBrief, projects] =
    await Promise.all([
      prisma.memory.findMany({
        where: { profileId: profile.id, archived: false },
        orderBy: { importance: 'desc' },
        take: 80,
      }),
      prisma.task.findMany({
        where: { profileId: profile.id, status: { not: 'Complete' } },
      }),
      prisma.note.findMany({
        where: { profileId: profile.id, resolution: 'Open' },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.client.findMany({
        where: { profileId: profile.id },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.scheduledMessage.findMany({
        where: { profileId: profile.id, sent: false },
        orderBy: { sendAt: 'asc' },
      }),
      getEmailCalendarSummary(profile.id).catch(() => null),
      db.weeklyBrief
        .findFirst({
          where: { profileId: profile.id },
          orderBy: { createdAt: 'desc' },
        })
        .catch(() => null) as Promise<WeeklyBriefSummary | null>,
      prisma.project.findMany({
        where: { profileId: profile.id, progress: { lt: 10 } },
        orderBy: { updatedAt: 'desc' },
      }).catch(() => [] as import('../../../generated/prisma/client').Project[]),
    ])


  const outgoingModality = getModality(outgoingModalityId)

  // ── Close-out sweep (on switch) ────────────────────────────────────────────
  // The outgoing self runs a full end-of-session pass with its own toolset:
  // tidy its domain, leave a carry-note, refresh its brief (and, for the PA,
  // the identity docs) if the session warrants it. Runs synchronously so the
  // carry-note exists before the next session reads its context.
  if (isSwitch && existingMessages.length > 0) {
    const outgoingBriefRecord = await db.modalityBrief
      .findUnique({ where: { profileId_modalityId: { profileId: profile.id, modalityId: outgoingModalityId } } })
      .catch(() => null) as { content: string } | null

    const closeSystem = buildSystemPrompt(
      profile, memories, tasks, notes, clients,
      scheduledMessages, emailCalendarSummary, false, outgoingModalityId, null, false,
      outgoingBriefRecord?.content ?? null, projects
    )
    const closeCtx: ToolContext = {
      profileId: profile.id,
      modalityId: outgoingModalityId,
      domain: outgoingModality.domain ?? undefined,
    }

    try {
      await runAgenticLoop({
        model: PENNY_MODEL,
        maxTokens: 1500,
        system: cachedSystem(closeSystem),
        tools: getToolsForModality(outgoingModalityId),
        initialMessages: [
          ...existingMessages.slice(-12).map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: closeSessionPrompt(outgoingModality, profile.userName || 'Adam') },
        ],
        ctx: closeCtx,
        maxRounds: 6,
        onToolCall: (name, res) =>
          console.log(`[switch close] ${outgoingModalityId} → ${name} [${res.is_error ? 'ERR' : 'OK'}]`),
      })
    } catch (err) {
      console.error('[switch] close-out sweep failed:', err)
    }
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {
        profileId: profile.id,
        type: profile.intakeComplete ? 'daily' : 'intake',
        activeModality,
      } as any,
    })
    convoId = newConvo.id
  }

  // ── Load modality brief (after switch resolves — activeModality is final) ─
  // The ModalityBrief table may not exist yet in the live DB, so always catch.
  const modalityBriefRecord = await db.modalityBrief
    .findUnique({ where: { profileId_modalityId: { profileId: profile.id, modalityId: activeModality } } })
    .catch(() => null) as { content: string } | null
  const modalityBrief = modalityBriefRecord?.content ?? null

  // ── Build system prompt ────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    profile, memories, tasks, notes, clients,
    scheduledMessages, emailCalendarSummary,
    !profile.intakeComplete, activeModality, weeklyBrief, false,
    modalityBrief, projects
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
          const midBriefRecord = await db.modalityBrief
            .findUnique({ where: { profileId_modalityId: { profileId: profile!.id, modalityId: activeModality } } })
            .catch(() => null) as { content: string } | null
          const midCloseSystem = buildSystemPrompt(
            profile!, memories, tasks, notes, clients,
            scheduledMessages, emailCalendarSummary, false,
            activeModality, null, false, midBriefRecord?.content ?? null, projects
          )
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
