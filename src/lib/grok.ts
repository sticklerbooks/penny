// Grok client — OpenAI-compatible API, used exclusively by Private Penny.

import OpenAI from 'openai'

let _grok: OpenAI | null = null

export function getGrok(): OpenAI {
  if (!_grok) {
    _grok = new OpenAI({
      apiKey: process.env.GROK_API_KEY!,
      baseURL: 'https://api.x.ai/v1',
    })
  }
  return _grok
}

// Set GROK_MODEL in Railway to override (e.g. "grok-3-mini")
export const PRIVATE_PENNY_MODEL = process.env.GROK_MODEL || 'grok-3'
