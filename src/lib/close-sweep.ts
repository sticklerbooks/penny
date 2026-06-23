// Shared close-out sweep. The outgoing self runs the 4-step hygiene pass
// (capture / remember / clean up + answer Adam's flags / brief) with its own
// toolset, then stops — no conversational reply.
//
// Used by:
//   • the chat route on a manual modality switch (and the mid-session sweep)
//   • the dashboard's abandoned-session wrap-up (POST /api/wrap-abandoned),
//     which fires when Adam reopens the app having left a session mid-stream.

import { prisma } from './db'
import { buildSystemPrompt, cachedSystem, PENNY_MODEL } from './claude'
import { getModality } from './modalities'
import { getToolsForModality } from './tools'
import { runAgenticLoop } from './agentic-loop'
import { closeSessionPrompt } from './close-session'
import { getContextBundle, getModalityBrief, getModalityIdentity } from './context-cache'
import type { ToolContext } from './tool-executor'

export async function runCloseSweep(opts: {
  profileId: string
  modalityId: string
  messages: { role: string; content: string }[]
}): Promise<void> {
  const { profileId, modalityId, messages } = opts
  if (messages.length === 0) return

  const profile = await prisma.profile.findUnique({ where: { id: profileId } })
  const { memories, tasks, notes, clients, scheduledMessages, projects, pendingEvents, itemNotes } =
    await getContextBundle(profileId)
  const brief = await getModalityBrief(profileId, modalityId)
  const identity = await getModalityIdentity(profileId, modalityId)
  const modality = getModality(modalityId)

  const system = buildSystemPrompt(
    profile, memories, tasks, notes, clients,
    scheduledMessages, null, false, modalityId, null, false,
    brief, projects, pendingEvents, identity, null, itemNotes
  )
  const ctx: ToolContext = {
    profileId,
    modalityId,
    domain: modality.domain ?? undefined,
  }

  await runAgenticLoop({
    model: PENNY_MODEL,
    maxTokens: 1500,
    system: cachedSystem(system),
    tools: getToolsForModality(modalityId),
    initialMessages: [
      ...messages.slice(-12).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: closeSessionPrompt(modality, profile?.userName || 'Adam') },
    ],
    ctx,
    maxRounds: 6,
    onToolCall: (name, res) =>
      console.log(`[close sweep] ${modalityId} → ${name} [${res.is_error ? 'ERR' : 'OK'}]`),
  })
}
