import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getAnthropic, buildSystemPrompt, PENNY_MODEL } from '@/lib/claude'
import { extractAndSaveMemories } from '@/lib/memory'

export async function POST(req: NextRequest) {
  console.log('API KEY present:', !!process.env.ANTHROPIC_API_KEY, '| starts with:', process.env.ANTHROPIC_API_KEY?.slice(0, 10))
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

  // Load context
  const [memories, tasks] = await Promise.all([
    prisma.memory.findMany({
      where: { profileId: profile.id },
      orderBy: { importance: 'desc' },
      take: 60,
    }),
    prisma.task.findMany({
      where: { profileId: profile.id },
      orderBy: { priority: 'desc' },
    }),
  ])

  const systemPrompt = buildSystemPrompt(profile, memories, tasks, !profile.intakeComplete)

  // Build message history for Claude
  // Auto-start: Penny opens cold — use a silent trigger the user never sees
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

  // Stream from Claude
  const stream = await getAnthropic().messages.create({
    model: PENNY_MODEL,
    max_tokens: 1024,
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

        // Strip intake completion marker before saving
        const intakeJustCompleted =
          fullResponse.includes('<<INTAKE_COMPLETE>>') && !profile!.intakeComplete
        const cleanResponse = fullResponse.replace('<<INTAKE_COMPLETE>>', '').trim()

        // Save Penny's response
        await prisma.message.create({
          data: {
            conversationId: convoId!,
            role: 'assistant',
            content: cleanResponse,
          },
        })

        // Mark intake complete
        if (intakeJustCompleted) {
          await prisma.profile.update({
            where: { id: profile!.id },
            data: { intakeComplete: true },
          })
        }

        // Background memory extraction (fire and forget)
        if (!isAutoStart) {
          extractAndSaveMemories(profile!.id, message, cleanResponse).catch(() => {})
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              done: true,
              conversationId: convoId,
              intakeComplete: intakeJustCompleted,
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
      'Connection': 'keep-alive',
    },
  })
}
