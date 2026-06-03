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
  const { text, modality } = await req.json()
  if (!text?.trim()) return new Response('No text', { status: 400 })

  const apiKey = process.env.ELEVENLABS_API_KEY

  // Per-modality voice IDs — set these env vars in Railway to give each
  // modality her own voice. Falls back to ELEVENLABS_VOICE_ID for any
  // modality that doesn't have her own var set.
  //   ELEVENLABS_VOICE_ID     — Penny (PA), default fallback
  //   MARGOT_VOICE_ID         — Bookkeeping Secretary
  //   MARTHA_VOICE_ID         — Household Manager
  //   IRIS_VOICE_ID           — Creative Partner
  //   SAGE_VOICE_ID           — Friend / Life Coach
  //   VERA_VOICE_ID           — Political Ally
  const voiceEnvVarMap: Record<string, string> = {
    pa:          'ELEVENLABS_VOICE_ID',
    bookkeeping: 'MARGOT_VOICE_ID',
    household:   'JUNE_VOICE_ID',
    creative:    'IRIS_VOICE_ID',
    friend:      'SAGE_VOICE_ID',
    political:   'VERA_VOICE_ID',
  }
  const envVar = voiceEnvVarMap[modality] ?? 'ELEVENLABS_VOICE_ID'
  const voiceId = process.env[envVar] || process.env.ELEVENLABS_VOICE_ID
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
