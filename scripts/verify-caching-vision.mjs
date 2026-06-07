// Verify (1) prompt caching reads back, and (2) the image content-block shape
// is accepted by the API.
import { readFileSync } from 'fs'
import Anthropic from '@anthropic-ai/sdk'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=')
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, '')]
    })
)

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

// Mirror cachedSystem(): split before the timestamp marker, cache the prefix.
function cachedSystem(prompt) {
  const marker = '📅 Today is '
  const i = prompt.lastIndexOf(marker)
  if (i <= 0) return [{ type: 'text', text: prompt }]
  return [
    { type: 'text', text: prompt.slice(0, i), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: prompt.slice(i) },
  ]
}

// Build a big stable system prompt (well over the 2048-token min for Sonnet 4.6)
// plus a volatile timestamp tail.
const stable = ('You are Penny, a warm and capable personal assistant. ' +
  'You hold the throughline of who the user is and how they are doing. ').repeat(120)
const systemPrompt = stable + '\n\n📅 Today is Sun, Jun 7. Current time: 1:45 PM.'

console.log('Model:', model)
console.log('--- Caching: two identical-prefix calls ---')
for (let i = 1; i <= 2; i++) {
  const res = await client.messages.create({
    model,
    max_tokens: 16,
    system: cachedSystem(systemPrompt),
    messages: [{ role: 'user', content: 'Say "ok".' }],
  })
  const u = res.usage
  console.log(`call ${i}: cache_write=${u.cache_creation_input_tokens} cache_read=${u.cache_read_input_tokens} input=${u.input_tokens}`)
}

console.log('\n--- Vision: image content block accepted? ---')
// 1x1 red PNG
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAWjR9awAAAABJRU5ErkJggg=='
try {
  const res = await client.messages.create({
    model,
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Reply with one word: what color is this image?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ],
    }],
  })
  const text = res.content.find(b => b.type === 'text')?.text ?? ''
  console.log('image block accepted ✓  model said:', JSON.stringify(text.trim()))
} catch (e) {
  console.error('image block REJECTED:', e.message)
}
