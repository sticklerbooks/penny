export interface Artifact {
  filename: string
  content: string
}

const ARTIFACT_RE = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /(\w+)\s*=\s*["']([^"']*)["']/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) attributes[match[1]] = match[2]
  return attributes
}

export function extractArtifact(text: string): { artifact: Artifact | null; cleanText: string } {
  let artifact: Artifact | null = null
  for (const match of text.matchAll(ARTIFACT_RE)) {
    if (artifact || !match[2]?.trim()) continue
    const attributes = parseAttributes(match[1])
    artifact = {
      filename: attributes.filename || 'penny-output.txt',
      content: match[2],
    }
  }

  return {
    artifact,
    cleanText: text.replace(ARTIFACT_RE, '').replace(/\n{3,}/g, '\n\n').trim(),
  }
}
