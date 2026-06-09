// Agentic tool-use loop for Penny.
//
// Replaces the single-call parseActions / executeActions pattern.
// The loop runs until stop_reason === 'end_turn' or a safety limit is hit.
//
// Usage (hygiene / non-streaming):
//   const result = await runAgenticLoop({ model, maxTokens, system, tools, initialMessages, ctx })
//
// Usage (chat route / streaming) — see chat/route.ts for the streaming variant.
//
// Tool results are fed back to the model as user messages. The model sees
// success/failure for each call and can retry or adjust before finishing.

import Anthropic from '@anthropic-ai/sdk'
import { getAnthropic } from './claude'
import { executeTool, type ToolContext } from './tool-executor'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgenticLoopOptions {
  model: string
  maxTokens: number
  /** System prompt — either a plain string or an array of blocks (for cache_control). */
  system: string | Anthropic.TextBlockParam[]
  tools: Anthropic.Tool[]
  initialMessages: Anthropic.MessageParam[]
  ctx: ToolContext
  /** Maximum tool-call rounds before the loop is forced to stop. Default: 12. */
  maxRounds?: number
  /** Called after each tool executes. Useful for logging / progress indicators. */
  onToolCall?: (name: string, result: { content: string; is_error?: boolean }) => void
}

export interface AgenticLoopResult {
  /** Full conversation including all assistant turns and tool_result turns. */
  messages: Anthropic.MessageParam[]
  /** Number of tool-call rounds executed. */
  rounds: number
  /** Total individual tool calls executed across all rounds. */
  toolCallsExecuted: number
  /** Text content from the final assistant turn (the user-visible reply). */
  finalText: string
  /** True if the loop was stopped by maxRounds rather than end_turn. */
  hitLimit: boolean
}

// ─── Loop ────────────────────────────────────────────────────────────────────

export async function runAgenticLoop(opts: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const {
    model,
    maxTokens,
    system,
    tools,
    initialMessages,
    ctx,
    maxRounds = 12,
    onToolCall,
  } = opts

  const client = getAnthropic()
  const messages: Anthropic.MessageParam[] = [...initialMessages]

  let rounds = 0
  let toolCallsExecuted = 0
  let finalText = ''
  let hitLimit = false

  while (true) {
    const systemParam: Anthropic.TextBlockParam[] = typeof system === 'string'
      ? [{ type: 'text' as const, text: system }]
      : system

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemParam,
      tools,
      messages,
    })

    // Append the full assistant content block (preserves tool_use blocks for history).
    messages.push({ role: 'assistant', content: response.content })

    // Extract any text content for the caller (the user-visible part).
    finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')

    // Done — model finished naturally.
    if (response.stop_reason === 'end_turn') break

    // Unexpected stop — bail out.
    if (response.stop_reason !== 'tool_use') {
      console.warn(`[agentic-loop] Unexpected stop_reason: ${response.stop_reason}`)
      break
    }

    // Safety: don't loop forever.
    if (rounds >= maxRounds) {
      console.warn(`[agentic-loop] Hit maxRounds (${maxRounds}) — stopping.`)
      hitLimit = true
      break
    }

    // Collect all tool_use blocks from this turn.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0) {
      // stop_reason was 'tool_use' but no blocks — shouldn't happen, bail.
      console.warn('[agentic-loop] stop_reason=tool_use but no tool_use blocks found.')
      break
    }

    // Execute all tool calls for this round (sequentially to avoid DB races).
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    for (const block of toolUseBlocks) {
      const args = (block.input ?? {}) as Record<string, unknown>
      const result = await executeTool(block.name, args, ctx)

      toolCallsExecuted++
      onToolCall?.(block.name, result)

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.is_error,
      })
    }

    // Feed all results back as one user message, then loop.
    messages.push({ role: 'user', content: toolResults })
    rounds++
  }

  return { messages, rounds, toolCallsExecuted, finalText, hitLimit }
}

// ─── Convenience: extract text from a messages array ─────────────────────────

/** Collect all text from assistant turns in a messages array. */
export function extractAllText(messages: Anthropic.MessageParam[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    if (typeof m.content === 'string') {
      parts.push(m.content)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' && 'text' in block) {
          parts.push(block.text as string)
        }
      }
    }
  }
  return parts.join('\n\n')
}
