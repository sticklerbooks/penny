// Verify the image content-block path with a programmatically-valid PNG.
import { readFileSync } from 'fs'
import zlib from 'zlib'
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

// Build a valid 2x2 solid-blue PNG.
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
const w = 2, h = 2
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
ihdr[8] = 8; ihdr[9] = 2 // 8-bit, RGB
const raw = Buffer.concat(Array.from({ length: h }, () =>
  Buffer.concat([Buffer.from([0]), ...Array.from({ length: w }, () => Buffer.from([30, 90, 220]))])
))
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]).toString('base64')

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const model = env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

try {
  const res = await client.messages.create({
    model,
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What color is this image? One word.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      ],
    }],
  })
  const text = res.content.find(b => b.type === 'text')?.text ?? ''
  console.log('Image block accepted ✓  model said:', JSON.stringify(text.trim()))
} catch (e) {
  console.error('REJECTED:', e.message)
}
