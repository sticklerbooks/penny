'use client'

// Client-side TTS playback for TEXT mode. Fetches /api/speak and plays the clip,
// streaming via MediaSource when the browser supports it (so audio starts on the
// first bytes) and falling back to a buffered <audio> otherwise.
//
// Unlike CallMode's player this is single-clip (one whole message) with no mic,
// no sentence queue, no interrupt-to-listen — it just speaks a message aloud.
// Used by the per-message 🔊 button and the "speak replies" header toggle.

export interface SpeechHandle {
  stop: () => void
  done: Promise<void>
}

function appendChunk(sb: SourceBuffer, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sb.removeEventListener('updateend', ok)
      sb.removeEventListener('error', err)
    }
    const ok = () => { cleanup(); resolve() }
    const err = () => { cleanup(); reject(new Error('appendBuffer error')) }
    sb.addEventListener('updateend', ok)
    sb.addEventListener('error', err)
    try { sb.appendBuffer(chunk as BufferSource) } catch (e) { cleanup(); reject(e) }
  })
}

export function playClip(text: string, modality: string): SpeechHandle {
  const ac = new AbortController()
  let audio: HTMLAudioElement | null = null
  let stopped = false

  const done = (async () => {
    let res: Response
    try {
      res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, modality }),
        signal: ac.signal,
      })
    } catch { return }
    if (stopped || !res.ok || !res.body) return

    const canStream =
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('audio/mpeg')

    // Fallback: buffer the whole clip, then play.
    if (!canStream) {
      try {
        const blob = await res.blob()
        if (stopped) return
        const url = URL.createObjectURL(blob)
        audio = new Audio(url)
        await new Promise<void>((resolve) => {
          audio!.onended = () => { URL.revokeObjectURL(url); resolve() }
          audio!.onerror = () => { URL.revokeObjectURL(url); resolve() }
          audio!.onpause = () => { if (stopped) { URL.revokeObjectURL(url); resolve() } }
          audio!.play().catch(() => resolve())
        })
      } catch { /* skip */ }
      return
    }

    // Stream via MediaSource: start playing as the first bytes land.
    await new Promise<void>((resolve) => {
      const ms = new MediaSource()
      audio = new Audio()
      const objUrl = URL.createObjectURL(ms)
      audio.src = objUrl
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        try { URL.revokeObjectURL(objUrl) } catch { /* noop */ }
        resolve()
      }
      audio.onended = finish
      audio.onerror = finish
      audio.onpause = () => { if (stopped) finish() }

      ms.addEventListener('sourceopen', () => {
        let sb: SourceBuffer
        try { sb = ms.addSourceBuffer('audio/mpeg') } catch { finish(); return }
        const reader = res.body!.getReader()
        ;(async () => {
          try {
            while (true) {
              if (stopped) break
              const { done: rDone, value } = await reader.read()
              if (rDone) break
              await appendChunk(sb, value)
              if (audio!.paused && !stopped) audio!.play().catch(() => {})
            }
          } catch {
            /* append/codec error — fall through to endOfStream */
          } finally {
            try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
            if (stopped) finish()
            else if (audio!.paused) audio!.play().catch(() => finish())
          }
        })()
      })
    })
  })()

  return {
    stop: () => { stopped = true; ac.abort(); audio?.pause() },
    done,
  }
}

// ─── Sentence-streamed speaker ───────────────────────────────────────────────
// Speaks text sentence-by-sentence as it arrives, the way CallMode does: audio
// starts on the FIRST complete sentence instead of waiting for the whole reply.
// Feed it the cumulative text as it streams, then call finish(). Also works for
// a complete message (feed once, finish) — used by the per-message replay button.

// The text we're willing to speak: hard-stop at an <artifact> block.
function speakablePrefix(raw: string): string {
  const a = raw.search(/<artifact\b/i)
  return a >= 0 ? raw.slice(0, a) : raw
}

// Strip any control marker that slipped into the text stream.
function stripMarkers(s: string): string {
  return s
    .replace(/<<INTAKE_COMPLETE>>/g, '')
    .replace(/<\/?(?:complete_session|shift_complete|switch_modality|run_subroutine|artifact)\b[^>]*>/gi, '')
    .trim()
}

// Pull complete sentences off the front of a buffer, leaving the trailing
// (still-incomplete) fragment. Splits on whitespace after . ! ? …
function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const parts = buf.split(/(?<=[.!?…])\s+/)
  const rest = parts.pop() ?? ''
  return { sentences: parts, rest }
}

export class SentenceSpeaker {
  private queue: string[] = []
  private buf = ''
  private flushedLen = 0
  private draining = false
  private streamDone = false
  private stopped = false
  private current: SpeechHandle | null = null

  constructor(
    private modality: string,
    private onActive?: (active: boolean) => void,
  ) {}

  // Feed the cumulative text-so-far; flushes any newly-complete sentences.
  feed(cumulative: string): void {
    if (this.stopped) return
    const speakable = speakablePrefix(cumulative)
    if (speakable.length <= this.flushedLen) return
    this.buf += speakable.slice(this.flushedLen)
    this.flushedLen = speakable.length
    const { sentences, rest } = takeSentences(this.buf)
    this.buf = rest
    for (const s of sentences) this.enqueue(s)
  }

  // No more text coming — speak whatever's left as a final sentence.
  finish(): void {
    if (this.stopped) return
    this.streamDone = true
    const tail = this.buf.trim()
    this.buf = ''
    if (tail) this.enqueue(tail)
    this.maybeDone()
  }

  stop(): void {
    this.stopped = true
    this.queue = []
    this.current?.stop()
    this.current = null
    this.onActive?.(false)
  }

  private enqueue(s: string): void {
    const clean = stripMarkers(s)
    if (!clean) return
    this.queue.push(clean)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    this.onActive?.(true)
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const sentence = this.queue.shift()!
        this.current = playClip(sentence, this.modality)
        await this.current.done
        this.current = null
      }
    } finally {
      this.draining = false
      this.maybeDone()
    }
  }

  // Signal "no longer speaking" only once the stream is done and nothing is left.
  private maybeDone(): void {
    if (this.stopped) return
    if (this.streamDone && !this.draining && this.queue.length === 0) {
      this.onActive?.(false)
    }
  }
}
