// Parses the remaining inline XML markers from Penny's responses.
//
// State mutations (tasks, notes, memory, email, calendar, clients, identity,
// focus lock, etc.) are ALL handled by the Anthropic tool-use API via
// executeTool() in tool-executor.ts. The only thing still expressed as inline
// XML is the `artifact` marker (a downloadable file embedded in the reply),
// because it carries file content in the message body rather than a tool call.
//
// parseActions() also strips a few legacy control markers from the displayed
// text as a defensive measure, in case a model echoes an old-style tag.

export type PennyAction = { kind: 'artifact'; filename: string; content: string }

const ARTIFACT_RE = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi

// Legacy control markers — no longer emitted, but stripped if they appear so
// they never leak into the visible/saved text.
const LEGACY_STRIP_RE =
  /<\/?(?:complete_session|shift_complete|switch_modality|run_subroutine)\b[^>]*>/gi

// Parse XML attributes from a string like: filename="foo.csv"
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*["']([^"']*)["']/g
  let m
  while ((m = re.exec(s))) out[m[1]] = m[2]
  return out
}

export function parseActions(text: string): { actions: PennyAction[]; cleanText: string } {
  const actions: PennyAction[] = []

  // artifact — a file Penny generates for the user to download
  for (const m of text.matchAll(ARTIFACT_RE)) {
    const attrs = parseAttrs(m[1])
    const content = m[2] || ''
    const filename = attrs.filename || 'penny-output.txt'
    if (!content.trim()) continue
    actions.push({ kind: 'artifact', filename, content })
  }

  const cleanText = text
    .replace(ARTIFACT_RE, '')
    .replace(LEGACY_STRIP_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { actions, cleanText }
}
