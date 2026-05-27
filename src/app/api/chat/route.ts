import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL } from '@/lib/claude'
import { extractAndSaveMemories } from '@/lib/memory'
import { parseActions, executeActions } from '@/lib/actions'

export async function POST(req: NextRequest) {
  const { message, conversationId, isAutoStart } = await req.json()

  // Get or create the single profile
  let profile = await prisma.profile.findFirst()
  if (!profile) {
    profile = await prisma.profile.create({ data: {} })
  }

  // Get or create conversation
  let convoId = conversationId as string | null
  let existingMessages: { role: string; content: string }[] = []

  if (convoId) {
    const existing = await prisma.conversation.findUnique({
      where: { id: convoId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (existing) {
      existingMessages = existing.messages
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

  // Load context — memories, tasks, notes, clients, and scheduled messages
  const [memories, tasks, nextSessionNotes, clients, scheduledMessages] = await Promise.all([
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
  ])

  const systemPrompt = buildSystemPrompt(
    profile,
    memories,
    tasks,
    nextSessionNotes,
    clients,
    scheduledMessages,
    !profile.intakeComplete
  )

  // Auto-start: Penny opens cold — silent trigger user never sees
  const triggerMessage = isAutoStart
    ? 'Please begin. The user has just opened the app for the first time.'
    : message

  const claudeMessages: { role: 'user' | 'assistant'; content: string }[] = [
    ...existingMessages.slice(-30).map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: triggerMessage },
  ]

  // Save user message (not for auto-start triggers)
  if (!isAutoStart) {
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

        // Parse Penny's action markers (tasks, memories, notes) and strip from display
        const { actions, cleanText } = parseActions(workingText)
        workingText = cleanText

        // Save Penny's clean response (without markers)
        await prisma.message.create({
          data: {
            conversationId: convoId!,
            role: 'assistant',
            content: workingText,
          },
        })

        if (intakeJustCompleted) {
          await prisma.profile.update({
            where: { id: profile!.id },
            data: { intakeComplete: true },
          })
        }

        // Execute Penny's actions (create tasks, memories, notes)
        if (actions.length > 0) {
          await executeActions(profile!.id, actions)
        }

        // Background extraction as a safety net (catches what Penny missed)
        if (!isAutoStart) {
          extractAndSaveMemories(profile!.id, message, workingText).catch(() => {})
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              conversationId: convoId,
              intakeComplete: intakeJustCompleted,
              cleanText: workingText, // frontend swaps in clean text to remove any flashed markers
              actionsExecuted: actions.length,
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
