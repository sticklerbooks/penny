import { getAnthropic, PENNY_FAST_MODEL } from './claude'
import { prisma } from '@/lib/db'

interface ExtractedMemory {
  category: string
  content: string
  importance: number
}

interface ExtractedTask {
  title: string
  description?: string
  dueDate?: string
  priority: number
}

interface ExtractionResult {
  memories: ExtractedMemory[]
  tasks: ExtractedTask[]
  userName?: string
}

export async function extractAndSaveMemories(
  profileId: string,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  const prompt = `You are analyzing a short conversation exchange to extract important facts to remember.

User said: "${userMessage}"

Assistant (Penny) said: "${assistantMessage}"

Extract anything genuinely worth remembering about the user. Be selective — quality over quantity. Only extract concrete, specific, useful information.

Categories:
- personal: name, family, location, life situation
- work: job, role, workplace, professional context
- goal: something they want to achieve
- constraint: time limits, energy patterns, competing demands
- mindset: how they think, work style, what motivates or derails them
- emotional: how they're feeling, what's weighing on them
- preference: how they like to communicate, be reminded, supported

Also extract any tasks or commitments mentioned (things they need to do, deadlines).

Respond with valid JSON only:
{
  "memories": [
    { "category": "...", "content": "specific thing to remember", "importance": 1-10 }
  ],
  "tasks": [
    { "title": "...", "description": "optional", "dueDate": "YYYY-MM-DD or null", "priority": 1-10 }
  ],
  "userName": "their first name if mentioned, otherwise null"
}`

  try {
    const response = await getAnthropic().messages.create({
      model: PENNY_FAST_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    })

    const content = response.content[0]
    if (content.type !== 'text') return

    const jsonMatch = content.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return

    const extracted: ExtractionResult = JSON.parse(jsonMatch[0])

    // Save memories
    if (extracted.memories?.length) {
      await prisma.memory.createMany({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: extracted.memories.map((m) => ({
          profileId,
          category: m.category || 'personal',
          content: m.content,
          importance: Math.min(10, Math.max(1, m.importance || 5)),
        })) as any,
      })
    }

    // Save tasks
    if (extracted.tasks?.length) {
      for (const task of extracted.tasks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma.task.create as any)({
          data: {
            profileId,
            name: task.title,
            description: task.description ?? '',
            dueDate: task.dueDate ? new Date(task.dueDate) : null,
            priority: Math.min(4, Math.max(1, task.priority || 2)),
            assignedModality: 'pa',
            status: 'Unstarted',
          },
        })
      }
    }

    // Update name if found
    if (extracted.userName) {
      await prisma.profile.update({
        where: { id: profileId },
        data: { userName: extracted.userName },
      })
    }
  } catch {
    // Silent fail — this is background work
  }
}
