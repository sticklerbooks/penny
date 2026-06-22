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
