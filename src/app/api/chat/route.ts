import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL, PENNY_SEARCH_MODEL, PENNY_FAST_MODEL, WeeklyBriefSummary } from '@/lib/claude'
import { getGrok, PRIVATE_PENNY_MODEL } from '@/lib/grok'
import { extractAndSaveMemories } from '@/lib/memory'
import { parseActions, executeActions } from '@/lib/actions'
import { getEmailCalendarSummary, executeSearches, SearchAction } from '@/lib/email-calendar'
import { getModality, resolveModality, isActionAllowed } from '@/lib/modalities'
import { touchActive } from '@/lib/modality-state'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { message, conversationId, isAutoStart, isVoice, switchTo, activateAltMode } = await req.json()

  // ── Profile ────────────────────────────────────────────────────────────────
  let profile = await prisma.profile.findFirst()
  if (!profile) {
    profile = await prisma.profile.create({ data: {} })
  }

  // ── Conversation: load existing ────────────────────────────────────────────
  let convoId = conversationId as string | null
  let existingMessages: { role: string; content: string }[] = []
  let activeModality = 'pa'
  let isAltMode = false

  if (convoId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: convoId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (existing && !existing.closed) {
      existingMessages = existing.messages
      activeModality = existing.activeModality || 'pa'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isAltMode = (existing as any).isAltMode ?? false
    } else {
      convoId = null
    }
  }

  // ── Detect manual switch ───────────────────────────────────────────────────
  const manualSwitch = switchTo ? resolveModality(String(switchTo)) : null
  const outgoingModalityId = activeModality // save before any change
  const isSwitch = !!manualSwitch && manualSwitch.id !== outgoingModalityId

  // ── Detect alt-mode toggle ─────────────────────────────────────────────────
  // activateAltMode: true = enter alt-mode, false = exit alt-mode
  // Only applies if the current modality has an altMode config.
  const currentModalityForAlt = getModality(activeModality)
  const isAltToggle =
    !isSwitch &&
    activateAltMode !== undefined &&
    activateAltMode !== isAltMode &&
    !!currentModalityForAlt.altMode

  // ── Load all context in parallel ───────────────────────────────────────────
  // Load before the farewell pass (which uses outgoing modality context) and
  // also before the main pass (which uses incoming modality context).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const [memories, tasks, nextSessionNotes, clients, scheduledMessages, emailCalendarSummary, weeklyBrief] =
    await Promise.all([
      prisma.memory.findMany({
        where: { profileId: profile.id, archived: false },
        orderBy: { importance: 'desc' },
        take: 80,
      }),
      prisma.task.findMany({ where: { profileId: profile.id } }),
      prisma.nextSessionNote.findMany({
        where: { profileId: profile.id, resolved: false },
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
      // Weekly brief — only used by PA, but cheap to load for all modalities
      db.weeklyBrief.findFirst({
        where: { profileId: profile.id },
        orderBy: { createdAt: 'desc' },
      }).catch(() => null) as Promise<WeeklyBriefSummary | null>,
    ])

  const outgoingModality = getModality(outgoingModalityId)

  // ── Farewell note pass (on switch, if there's something to wrap up) ────────
  // Outgoing modality writes a next_session note summarizing open threads.
  // Runs before the old convo is closed, so it has message context.
  // Alt-mode toggles don't get a farewell pass — same modality, just mode change.
  if (isSwitch && existingMessages.length > 0) {
    const farewellSystem = buildSystemPrompt(
      profile, memories, tasks, nextSessionNotes, clients,
      scheduledMessages, emailCalendarSummary, false, outgoingModalityId, null, false
    )
    const farewellInstruction = `CONTEXT HAND-OFF: ${profile.userName || 'The user'} has switched to a different modality. Write exactly ONE <next_session> note summarizing any open threads, pending items, or things your next session should know. Be concise. Use markers only — no visible text. If nothing is open, write: <next_session>Closed cleanly — no open items.</next_session>`

    try {
      const farewellPass = await getAnthropic().messages.create({
        model: PENNY_FAST_MODEL,
        max_tokens: 512,
        system: farewellSystem + '\n\n' + farewellInstruction,
        messages: [
          ...existingMessages.slice(-10).map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user', content: 'Please write your farewell note now.' },
        ],
      })
      const farewellRaw = (farewellPass.content[0] as { type: string; text: string }).text
      const { actions: farewellActions } = parseActions(farewellRaw)
      const farewellNotes = farewellActions.filter(
        (a) => a.kind === 'next_session_note'
      )
      if (farewellNotes.length > 0) {
        await executeActions(profile.id, farewellNotes, {
          domain: outgoingModality.domain,
          modalityId: outgoingModalityId,
        })
      }
    } catch (err) {
      // Farewell pass failing is non-fatal — continue with the switch
      console.error('[switch] farewell pass failed:', err)
    }
  }

  // ── Close old convo and open fresh one (on switch or alt-mode toggle) ───────
  if (isSwitch) {
    if (convoId) {
      await prisma.conversation.update({ where: { id: convoId }, data: { closed: true } })
    }
    activeModality = manualSwitch!.id
    isAltMode = false
    const newConvo = await prisma.conversation.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { profileId: profile.id, type: 'daily', activeModality } as any,
    })
    convoId = newConvo.id
    existingMessages = []
  } else if (isAltToggle) {
    // Alt-mode toggle: close current convo, open fresh one in the new mode
    if (convoId) {
      await prisma.conversation.update({ where: { id: convoId }, data: { closed: true } })
    }
    isAltMode = activateAltMode as boolean
    const newConvo = await prisma.conversation.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { profileId: profile.id, type: 'daily', activeModality, isAltMode } as any,
    })
    convoId = newConvo.id
    existingMessages = []
  } else if (!convoId) {
    // No existing convo — create one
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

  // ── Build system prompt ────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(
    profile, memories, tasks, nextSessionNotes, clients,
    scheduledMessages, emailCalendarSummary,
    !profile.intakeComplete, activeModality, weeklyBrief, isAltMode
  )

  const currentModality = getModality(activeModality)

  // ── Determine trigger message ──────────────────────────────────────────────
  const contextCleared = isSwitch || isAltToggle
  const isSilentTrigger = isAutoStart || (contextCleared && !message?.trim())
  const altDisplayName = currentModality.altMode?.displayName || 'your alt mode'

  const triggerMessage = isAutoStart
    ? 'Please begin. The user has just opened the app for the first time.'
    : isSwitch && !message?.trim()
    ? `You're starting a fresh session as ${currentModality.displayName} (${currentModality.role}). Greet ${profile.userName || 'them'} briefly and warmly in your own voice.`
    : isAltToggle && !message?.trim() && isAltMode
    ? `You're entering ${altDisplayName}. Greet ${profile.userName || 'them'} briefly and warmly in this mode's voice.`
    : isAltToggle && !message?.trim() && !isAltMode
    ? `You're returning to your primary mode. Greet ${profile.userName || 'them'} briefly and warmly.`
    : message

  // Voice mode: keep responses short and spoken-word natural
  const finalSystemPrompt = isVoice
    ? systemPrompt + `\n\n═══════════════════════════════════════════════════════════════════════
YOU ARE ON A VOICE CALL RIGHT NOW
═══════════════════════════════════════════════════════════════════════
${profile.userName || 'The user'} is talking to you out loud and hearing your reply spoken back. Keep responses SHORT and conversational — usually one to three sentences. No lists, no markdown, no headers. Talk like a real phone call: natural, warm, to the point. You can still use your tools silently as normal.`
    : systemPrompt

  const claudeMessages: { role: 'user' | 'assistant'; content: string }[] = [
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

  // ── Alt-mode scope: tag memories saved during alt-mode ─────────────────────
  const altModeScope = isAltMode ? activeModality : undefined

  // ── Grok routing: Lila always, or any modality in alt-mode with useGrok ────
  const useGrok = activeModality === 'lila' || (isAltMode && !!currentModality.altMode?.useGrok)

  const encoder = new TextEncoder()
  let fullResponse = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        // ── Main response ──────────────────────────────────────────────────────
        if (useGrok) {
          const grokStream = await getGrok().chat.completions.create({
            model: PRIVATE_PENNY_MODEL,
            max_tokens: 2048,
            messages: [
              { role: 'system', content: finalSystemPrompt },
              ...claudeMessages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
              })),
            ],
            stream: true,
          })
          for await (const chunk of grokStream) {
            const text = chunk.choices[0]?.delta?.content
            if (text) {
              fullResponse += text
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`))
            }
          }
        } else {
          const anthropicStream = await getAnthropic().messages.create({
            model: PENNY_MODEL,
            max_tokens: 2048,
            system: finalSystemPrompt,
            messages: claudeMessages,
            stream: true,
          })
          for await (const chunk of anthropicStream) {
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
              fullResponse += chunk.delta.text
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`))
            }
          }
        }

        // Detect intake completion
        const intakeJustCompleted =
          fullResponse.includes('<<INTAKE_COMPLETE>>') && !profile!.intakeComplete
        let workingText = fullResponse.replace('<<INTAKE_COMPLETE>>', '')

        // Parse and scope actions
        const { actions, cleanText } = parseActions(workingText)
        workingText = cleanText

        // Scope to what this modality is allowed to do
        const scopedActions = actions.filter((a) => isActionAllowed(currentModality, a.kind))

        // ── Two-pass search flow (always Anthropic — mechanical pass) ─────────
        const searchActions = actions.filter(
          (a): a is SearchAction =>
            (a.kind === 'search_email' || a.kind === 'search_calendar') &&
            isActionAllowed(currentModality, a.kind)
        )

        if (searchActions.length > 0) {
          const searchResults = await executeSearches(searchActions).catch(() => '(search failed)')

          const secondPass = await getAnthropic().messages.create({
            model: PENNY_SEARCH_MODEL,
            max_tokens: 2048,
            system: finalSystemPrompt,
            messages: [
              ...claudeMessages,
              { role: 'assistant', content: workingText },
              {
                role: 'user',
                content: `Here are the search results you requested:\n\n${searchResults}\n\nPlease continue your response with this information.`,
              },
            ],
          })

          const secondText = (secondPass.content[0] as { type: string; text: string }).text
          const { cleanText: secondClean, actions: secondActions } = parseActions(secondText)
          workingText = secondClean
          scopedActions.push(
            ...secondActions
              .filter((a) => a.kind !== 'search_email' && a.kind !== 'search_calendar')
              .filter((a) => isActionAllowed(currentModality, a.kind))
          )
        }
        // ─────────────────────────────────────────────────────────────────────

        if (intakeJustCompleted) {
          await prisma.profile.update({
            where: { id: profile!.id },
            data: { intakeComplete: true },
          })
        }

        // Extract artifact (PA-only — first one wins if multiple)
        const artifactAction = scopedActions.find(
          (a): a is Extract<typeof a, { kind: 'artifact' }> => a.kind === 'artifact'
        ) ?? null

        // Execute actions (filtering non-executable kinds)
        // Alt-mode memories are tagged with altModeScope so primary mode can't see them
        const executableActions = scopedActions.filter(
          (a) =>
            a.kind !== 'search_email' &&
            a.kind !== 'search_calendar' &&
            a.kind !== 'run_subroutine' &&
            a.kind !== 'complete_session' &&
            a.kind !== 'shift_complete' &&
            a.kind !== 'switch_modality' &&
            a.kind !== 'artifact'
        )
        if (executableActions.length > 0) {
          await executeActions(profile!.id, executableActions, {
            domain: currentModality.domain,
            modalityId: currentModality.id,
            altModeScope,
          })
        }

        // Stamp activity for nightly cron tracking
        await touchActive(profile!.id, currentModality.id)

        // Save Penny's response
        await prisma.message.create({
          data: { conversationId: convoId!, role: 'assistant', content: workingText },
        })

        // Background memory extraction (tagged with altModeScope if in alt-mode)
        if (!isSilentTrigger) {
          extractAndSaveMemories(profile!.id, message, workingText, altModeScope).catch(() => {})
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              conversationId: convoId,
              intakeComplete: intakeJustCompleted,
              cleanText: workingText,
              actionsExecuted: executableActions.length,
              activeModality,
              isAltMode,
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
          encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
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
      'Connection': 'keep-alive',
    },
  })
}
