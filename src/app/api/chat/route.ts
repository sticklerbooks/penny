import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL, PENNY_SEARCH_MODEL, PENNY_FAST_MODEL } from '@/lib/claude'
import { extractAndSaveMemories } from '@/lib/memory'
import { parseActions, executeActions } from '@/lib/actions'
import { getEmailCalendarSummary, executeSearches, SearchAction } from '@/lib/email-calendar'
import { loadSubroutine } from '@/lib/subroutines'
import { getModality, resolveModality, isActionAllowed } from '@/lib/modalities'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const { message, conversationId, isAutoStart, isVoice, switchTo } = await req.json()

  // Get or create the single profile
  let profile = await prisma.profile.findFirst()
  if (!profile) {
    profile = await prisma.profile.create({ data: {} })
  }

  // Get or create conversation
  let convoId = conversationId as string | null
  let existingMessages: { role: string; content: string }[] = []
  let activeModality = 'pa'

  if (convoId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: convoId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (existing) {
      existingMessages = existing.messages
      activeModality = existing.activeModality || 'pa'
    } else {
      convoId = null
    }
  }

  if (!convoId) {
    const newConvo = await prisma.conversation.create({
      data: {
        profileId: profile.id,
        type: profile.intakeComplete ? 'daily' : 'intake',
      },
    })
    convoId = newConvo.id
  }

  // Manual switch (from the header switcher): set the modality before building
  // the prompt so the very next reply comes from the requested modality.
  const manualSwitch = switchTo ? resolveModality(String(switchTo)) : null
  if (manualSwitch && manualSwitch.id !== activeModality) {
    activeModality = manualSwitch.id
    await prisma.conversation.update({
      where: { id: convoId },
      data: { activeModality },
    })
  }

  // Load all context in parallel
  const [memories, tasks, nextSessionNotes, clients, scheduledMessages, emailCalendarSummary] =
    await Promise.all([
      prisma.memory.findMany({
        where: { profileId: profile.id, archived: false },
        orderBy: { importance: 'desc' },
        take: 80,
      }),
      prisma.task.findMany({
        where: { profileId: profile.id },
      }),
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
      // Email/calendar: uses 30-min cache, skips gracefully if not configured
      getEmailCalendarSummary(profile.id).catch(() => null),
    ])

  let systemPrompt = buildSystemPrompt(
    profile,
    memories,
    tasks,
    nextSessionNotes,
    clients,
    scheduledMessages,
    emailCalendarSummary,
    !profile.intakeComplete,
    activeModality
  )

  // Voice/call mode: she's being spoken aloud, so keep it short and natural.
  if (isVoice) {
    systemPrompt += `

═══════════════════════════════════════════════════════════════════════
YOU ARE ON A VOICE CALL RIGHT NOW
═══════════════════════════════════════════════════════════════════════
${profile.userName || 'The user'} is talking to you out loud and hearing your reply spoken back. Keep responses SHORT and conversational — usually one to three sentences. No lists, no markdown, no headers. Talk like a real phone call: natural, warm, to the point. If something needs a long answer, give the short version and offer to go deeper. You can still use your tools silently as normal.`
  }

  // Auto-start: Penny opens cold — silent trigger user never sees.
  // Manual switch with no message: greet as the new modality.
  const isSilentTrigger = isAutoStart || (manualSwitch && !message?.trim())
  const triggerMessage = isAutoStart
    ? 'Please begin. The user has just opened the app for the first time.'
    : manualSwitch && !message?.trim()
    ? `You've just been switched into your ${manualSwitch.displayName} modality. Briefly take over in your new voice and pick up the thread.`
    : message

  const claudeMessages: { role: 'user' | 'assistant'; content: string }[] = [
    ...existingMessages.slice(-20).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: triggerMessage },
  ]

  // Save user message (not for silent triggers)
  if (!isSilentTrigger) {
    await prisma.message.create({
      data: { conversationId: convoId, role: 'user', content: message },
    })
  }

  const stream = await getAnthropic().messages.create({
    model: PENNY_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: claudeMessages,
    stream: true,
  })

  const encoder = new TextEncoder()
  let fullResponse = ''

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            fullResponse += chunk.delta.text
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`
              )
            )
          }
        }

        // Detect intake completion
        const intakeJustCompleted =
          fullResponse.includes('<<INTAKE_COMPLETE>>') && !profile!.intakeComplete
        let workingText = fullResponse.replace('<<INTAKE_COMPLETE>>', '')

        // Parse Penny's action markers
        const { actions, cleanText } = parseActions(workingText)
        workingText = cleanText

        const currentModality = getModality(activeModality)

        // ── Two-pass search flow ──────────────────────────────────────────────
        // If Penny requested email/calendar searches, execute them and give her
        // a second pass with the results before finalising the response.
        const searchActions = actions.filter(
          (a): a is SearchAction =>
            (a.kind === 'search_email' || a.kind === 'search_calendar') &&
            isActionAllowed(currentModality, a.kind)
        )

        if (searchActions.length > 0) {
          const searchResults = await executeSearches(searchActions).catch(
            () => '(search failed)'
          )

          const secondPass = await getAnthropic().messages.create({
            model: PENNY_SEARCH_MODEL,
            max_tokens: 2048,
            system: systemPrompt,
            messages: [
              ...claudeMessages,
              { role: 'assistant', content: workingText },
              {
                role: 'user',
                content: `Here are the search results you requested:\n\n${searchResults}\n\nPlease continue your response with this information.`,
              },
            ],
          })

          const secondText =
            (secondPass.content[0] as { type: string; text: string }).text
          const { cleanText: secondClean, actions: secondActions } =
            parseActions(secondText)
          workingText = secondClean

          // Merge non-search actions from both passes
          actions.push(
            ...secondActions.filter(
              (a) => a.kind !== 'search_email' && a.kind !== 'search_calendar'
            )
          )
        }
        // ─────────────────────────────────────────────────────────────────────

        if (intakeJustCompleted) {
          await prisma.profile.update({
            where: { id: profile!.id },
            data: { intakeComplete: true },
          })
        }

        // Scope this modality's actions — drop anything it isn't allowed to do.
        const scopedActions = actions.filter((a) => isActionAllowed(currentModality, a.kind))

        // ── Modality switch ────────────────────────────────────────────────
        // Penny can hand the baton to another modality (last switch wins).
        const switchAction = [...scopedActions]
          .reverse()
          .find((a) => a.kind === 'switch_modality') as { kind: 'switch_modality'; name: string } | undefined
        const switchTarget = switchAction ? resolveModality(switchAction.name) : null
        const willSwitch = !!switchTarget && switchTarget.id !== currentModality.id

        // ── Subroutine / session-complete flow (skipped when switching) ──────
        const isCompleting = !willSwitch && scopedActions.some((a) => a.kind === 'complete_session')
        const subroutineNames = new Set<string>(
          scopedActions
            .filter((a): a is Extract<typeof a, { kind: 'run_subroutine' }> => a.kind === 'run_subroutine')
            .map((a) => a.name)
        )
        if (isCompleting) subroutineNames.add('hygiene')

        if (subroutineNames.size > 0) {
          const subroutineContent = [...subroutineNames]
            .map((name) => loadSubroutine(name))
            .filter((s): s is string => s !== null)
            .join('\n\n---\n\n')

          if (subroutineContent) {
            const subroutinePrompt = isCompleting
              ? 'Please complete this session. Work through the hygiene checklist above and execute all relevant actions. Leave a brief next_session note — the one thing most worth carrying forward.'
              : 'Please run the requested subroutine(s) now. Execute all relevant actions.'

            const subroutinePass = await getAnthropic().messages.create({
              model: PENNY_FAST_MODEL,
              max_tokens: 2048,
              system: systemPrompt + '\n\n' + subroutineContent,
              messages: [
                ...claudeMessages,
                { role: 'assistant', content: workingText },
                { role: 'user', content: subroutinePrompt },
              ],
            })

            const subroutineText =
              (subroutinePass.content[0] as { type: string; text: string }).text
            const { cleanText: subroutineClean, actions: subroutinePassActions } =
              parseActions(subroutineText)

            // Execute subroutine actions (scoped to the current modality)
            const executableSubroutineActions = subroutinePassActions.filter(
              (a) =>
                isActionAllowed(currentModality, a.kind) &&
                a.kind !== 'search_email' &&
                a.kind !== 'search_calendar' &&
                a.kind !== 'run_subroutine' &&
                a.kind !== 'complete_session' &&
                a.kind !== 'switch_modality'
            )
            if (executableSubroutineActions.length > 0) {
              await executeActions(profile!.id, executableSubroutineActions, {
                domain: currentModality.domain,
                modalityId: currentModality.id,
              })
            }

            // Append subroutine response if it has visible content
            if (subroutineClean.trim()) {
              workingText = workingText + '\n\n' + subroutineClean
            }
          }
        }

        // Handle session completion — close conversation, create fresh-start note
        if (isCompleting) {
          await Promise.all([
            prisma.conversation.update({
              where: { id: convoId! },
              data: { closed: true },
            }),
            prisma.nextSessionNote.create({
              data: {
                profileId: profile!.id,
                content: `🔄 Fresh session — hygiene was run on ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}.`,
              },
            }),
          ])
        }
        // ─────────────────────────────────────────────────────────────────

        // Execute this modality's actions, tagged with its domain.
        const executableActions = scopedActions.filter(
          (a) =>
            a.kind !== 'search_email' &&
            a.kind !== 'search_calendar' &&
            a.kind !== 'run_subroutine' &&
            a.kind !== 'complete_session' &&
            a.kind !== 'switch_modality'
        )
        if (executableActions.length > 0) {
          await executeActions(profile!.id, executableActions, {
            domain: currentModality.domain,
            modalityId: currentModality.id,
          })
        }

        // ── Perform the handoff to the new modality ─────────────────────────
        if (willSwitch && switchTarget) {
          activeModality = switchTarget.id
          await prisma.conversation.update({
            where: { id: convoId! },
            data: { activeModality },
          })

          const handoffSystem = buildSystemPrompt(
            profile, memories, tasks, nextSessionNotes, clients,
            scheduledMessages, emailCalendarSummary, false, activeModality
          )
          const handoffPass = await getAnthropic().messages.create({
            model: PENNY_MODEL,
            max_tokens: 2048,
            system: handoffSystem,
            messages: [
              ...claudeMessages,
              { role: 'assistant', content: workingText || '(handing off)' },
              {
                role: 'user',
                content: `(You are now in your ${switchTarget.displayName} modality. Take over in your new voice and pick up the thread with ${profile!.userName || 'them'} — briefly, naturally.)`,
              },
            ],
          })
          const handoffRaw = (handoffPass.content[0] as { type: string; text: string }).text
          const { cleanText: handoffClean, actions: handoffActions } = parseActions(handoffRaw)
          const handoffExecutable = handoffActions.filter(
            (a) =>
              isActionAllowed(switchTarget, a.kind) &&
              a.kind !== 'search_email' &&
              a.kind !== 'search_calendar' &&
              a.kind !== 'run_subroutine' &&
              a.kind !== 'complete_session' &&
              a.kind !== 'switch_modality'
          )
          if (handoffExecutable.length > 0) {
            await executeActions(profile!.id, handoffExecutable, {
              domain: switchTarget.domain,
              modalityId: switchTarget.id,
            })
          }
          if (handoffClean.trim()) {
            workingText = workingText.trim()
              ? `${workingText}\n\n${handoffClean}`
              : handoffClean
          }
        }

        // Save Penny's final response (after subroutine + handoff appends)
        await prisma.message.create({
          data: {
            conversationId: convoId!,
            role: 'assistant',
            content: workingText,
          },
        })

        // Background memory extraction as safety net
        if (!isSilentTrigger) {
          extractAndSaveMemories(profile!.id, message, workingText).catch(() => {})
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              conversationId: convoId,
              intakeComplete: intakeJustCompleted,
              cleanText: workingText,
              actionsExecuted: executableActions.length,
              sessionComplete: isCompleting ?? false,
              activeModality,
            })}\n\n`
          )
        )
      } catch (err) {
        console.error('Chat stream error:', err)
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: String(err) })}\n\n`
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
      'Connection': 'keep-alive',
    },
  })
}
