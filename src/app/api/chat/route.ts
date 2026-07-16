import { NextRequest } from 'next/server'
import type Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/db'
import {
  getAnthropic,
  buildSystemPrompt,
  cachedSystem,
  PENNY_MODEL,
} from '@/lib/claude'
import { extractArtifact } from '@/lib/artifact'
import { getModality, resolveModality } from '@/lib/modalities'
import { touchActive } from '@/lib/modality-state'
import { executeTool, type ToolContext } from '@/lib/tool-executor'
import { getToolsForModality } from '@/lib/tools'
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
  const { items, clients, scheduledMessages, weeklyBrief, projects } =
    await getContextBundle(profile.id)

  // (The old switch-triggered close-out sweep lived here — retired. It existed
  // to catch uncaptured items/staleness from a tool surface that didn't prevent
  // them; the Item tools are correct by construction, so there's nothing left
  // for a prose broom pass to do. A real script-driven "end chat" replaces it.)

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

  // Email/calendar snapshot is PA-only — fetch it just for her (its own 30-min
  // cache covers repeat turns), so the six submodalities never pay the Google +
  // Haiku cost for a summary they don't render.
  const emailCalendarSummary =
    getModality(activeModality).domain === null
      ? await getEmailCalendarSummary(profile.id).catch(() => null)
      : null

  // ── Build system prompt ────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    profile, items, clients,
    scheduledMessages, emailCalendarSummary,
    !profile.intakeComplete, activeModality, weeklyBrief,
    modalityBrief, projects, modalityIdentity
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
        // "Open" (app launch / fresh greeting after a switch) is a silent trigger
        // with no user message — it should be exactly one DB read (already done
        // above) → one message to Claude → one response. Withholding tools here
        // makes that a guarantee, not a hope: with no tools to call, the model
        // can never produce a tool_use stop reason, so the loop below can't
        // iterate. Regular conversation still gets the full toolset and its
        // legitimate multi-round tool use.
        const tools = isSilentTrigger ? undefined : getToolsForModality(activeModality)

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

        // Set when a start_review tool call lands — reported in the final SSE
        // event so the client can hand this conversation off to the Review UI
        // without losing the messages already on screen.
        let reviewStarted: { kind: string; modalityId: string; phase: string } | null = null

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
            if (block.name === 'start_review' && !result.is_error) {
              try {
                const parsed = JSON.parse(result.content)
                reviewStarted = { kind: parsed.kind, modalityId: parsed.modalityId, phase: parsed.phase }
              } catch { /* malformed — just skip the handoff */ }
            }
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

        const intakeState = profile!.intakeComplete
          ? profile
          : await prisma.profile.findUnique({ where: { id: profile!.id } })
        const intakeJustCompleted = !profile!.intakeComplete && !!intakeState?.intakeComplete
        let workingText = fullResponse

        const { artifact, cleanText } = extractArtifact(workingText)
        workingText = cleanText

        // Stamp activity for nightly cron tracking
        await touchActive(profile!.id, currentModality.id)

        // Save Penny's response
        await prisma.message.create({
          data: { conversationId: convoId!, role: 'assistant', content: workingText },
        })

        // (Per-turn background memory extraction lived here — retired. Memory
        // now runs once per modality at end_chat, over the full transcript;
        // see src/lib/memory-pass.ts and the 'memory' protocol.)

        // (The old mid-session 20-message hygiene sweep lived here — retired for
        // the same reason as the switch sweep above.)

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              conversationId: convoId,
              intakeComplete: intakeJustCompleted,
              cleanText: workingText,
              activeModality,
              contextCleared,
              reviewStarted,
              artifact,
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
