// ElevenLabs TTS endpoint — called by call mode after Penny's response is ready.
// Streams audio/mpeg back to the client.

import { NextRequest } from 'next/server'

export const dynamic = 'force-dynamic'

// Strip markdown and clean text for natural speech
function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.*?)\*/g, '$1')        // *italic*
    .replace(/`([^`]+)`/g, '$1')        // `code`
    .replace(/#+\s+/g, '')              // ## headers
    .replace(/\n{2,}/g, '. ')           // paragraph breaks → pause
    .replace(/\n/g, ', ')               // line breaks → short pause
    .replace(/—/g, ', ')                // em dashes
    .trim()
}

export async function POST(req: NextRequest) {
  const { text } = await req.json()
  if (!text?.trim()) return new Response('No text', { status: 400 })

  const apiKey = process.env.ELEVENLABS_API_KEY
  const voiceId = process.env.ELEVENLABS_VOICE_ID
  if (!apiKey || !voiceId) {
    return new Response('ElevenLabs not configured', { status: 503 })
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleanForSpeech(text),
        model_id: 'eleven_turbo_v2_5',  // fast + cheap, good quality
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    console.error('[speak] ElevenLabs error:', res.status, err)
    return new Response('TTS failed', { status: 500 })
  }

  return new Response(res.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    },
  })
}
