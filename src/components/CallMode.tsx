'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { getModality } from '@/lib/modalities'

// ─── Palette (matches ChatInterface) ────────────────────────────────────────
const C = {
  base:      '#0B0C10',
  panel:     '#1F2833',
  pink:      '#FF69B4',
  text:      'rgba(232,234,240,0.92)',
  textMuted: 'rgba(232,234,240,0.45)',
  border:    'rgba(255,105,180,0.18)',
}

type CallState = 'listening' | 'thinking' | 'speaking'

interface CallModeProps {
  conversationId: string | null
  onConversationId: (id: string) => void
  onClose: () => void
  onMessage: (role: 'user' | 'assistant', content: string) => void
  avatarImgError: boolean
  activeModality: string
  onModality?: (id: string) => void
}

// ─── Minimal Web Speech API types ────────────────────────────────────────────
interface SpeechResultAlt { transcript: string }
interface SpeechResult { isFinal: boolean; 0: SpeechResultAlt }
interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<SpeechResult>
}
interface SpeechErrorEvent { error: string }
interface SpeechRecognizer {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SpeechResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechErrorEvent) => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognizerCtor = new () => SpeechRecognizer

function getSpeechRecognizer(): SpeechRecognizerCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognizerCtor
    webkitSpeechRecognition?: SpeechRecognizerCtor
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition
}

// ─── Streaming-speech helpers ────────────────────────────────────────────────

// The text we're willing to speak from the raw stream so far. The chat endpoint
// streams RAW deltas (including the inline <artifact> block and a few legacy
// control tags), so we never feed those to TTS: hard-stop at an <artifact> tag
// and strip stray markers.
function speakablePrefix(raw: string): string {
  const a = raw.search(/<artifact\b/i)
  return a >= 0 ? raw.slice(0, a) : raw
}

// Defensive per-sentence cleanup — strips any marker that slipped through.
function stripMarkers(s: string): string {
  return s
    .replace(/<<INTAKE_COMPLETE>>/g, '')
    .replace(/<\/?(?:complete_session|shift_complete|switch_modality|run_subroutine|artifact)\b[^>]*>/gi, '')
    .trim()
}

// Pull complete sentences off the front of a buffer, leaving the trailing
// (still-incomplete) fragment. Splits on whitespace that follows . ! ? …
function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const parts = buf.split(/(?<=[.!?…])\s+/)
  const rest = parts.pop() ?? ''
  return { sentences: parts, rest }
}

// Append one chunk to a MediaSource SourceBuffer, resolving when it's accepted.
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

export default function CallMode({
  conversationId,
  onConversationId,
  onClose,
  onMessage,
  avatarImgError,
  activeModality,
  onModality,
}: CallModeProps) {
  const [callState, setCallState]   = useState<CallState>('listening')
  const [transcript, setTranscript] = useState('')
  const [pennyText, setPennyText]   = useState('')
  const [supported, setSupported]   = useState(true)
  const [avatarErr, setAvatarErr]   = useState(avatarImgError)

  const recognitionRef      = useRef<SpeechRecognizer | null>(null)
  const accumulated         = useRef('')            // finals from current recognition session
  const totalAccumRef       = useRef('')            // accumulated across breath-pause restarts
  const callStateRef        = useRef<CallState>('listening')
  const audioRef            = useRef<HTMLAudioElement | null>(null)
  const activeRef           = useRef(true)         // false when call ends
  const pendingSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interruptedRef      = useRef(false)         // cancellation signal for the speech player

  // ── Streaming-speech state ──
  // Penny's reply is spoken sentence-by-sentence as it streams, so audio starts
  // after the FIRST sentence instead of waiting for the whole response.
  const rawRef             = useRef('')             // full raw text received this turn
  const speakBufRef        = useRef('')             // speakable text awaiting a sentence boundary
  const flushedLenRef      = useRef(0)              // chars of speakable text already buffered
  const speechQueueRef     = useRef<string[]>([])   // sentences queued for TTS + playback
  const drainingRef        = useRef(false)          // is the playback loop running
  const streamDoneRef      = useRef(false)          // chat stream finished — no more sentences coming
  const artifactSeenRef    = useRef(false)          // hit an <artifact> block — stop speaking
  const chatAbortRef       = useRef<AbortController | null>(null)

  // Refs that keep the latest closures available inside long-lived callbacks.
  const conversationIdRef  = useRef(conversationId)
  const activeModalityRef  = useRef<string>(activeModality)
  const handleSendRef      = useRef<(text: string) => void>(() => {})
  const startListeningRef  = useRef<() => void>(() => {})

  useEffect(() => { callStateRef.current = callState }, [callState])
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  useEffect(() => { activeModalityRef.current = activeModality }, [activeModality])

  // ── Speech → text ──────────────────────────────────────────────────────────
  // continuous = false: one utterance per session. Chrome's VAD fires onend
  // when you pause (~1 s). We immediately restart and set a 2 s send timer.
  // New speech cancels the timer so natural breath pauses don't cut you off.
  const startListening = useCallback(() => {
    if (!activeRef.current) return
    const SR = getSpeechRecognizer()
    if (!SR) { setSupported(false); return }

    const r = new SR()
    r.continuous     = false
    r.interimResults = true
    r.lang           = 'en-US'
    recognitionRef.current = r
    accumulated.current = ''

    r.onresult = (event) => {
      if (!activeRef.current) return
      // New speech arriving — cancel any pending send
      if (pendingSendTimerRef.current) {
        clearTimeout(pendingSendTimerRef.current)
        pendingSendTimerRef.current = null
      }
      let sessionFinal = ''
      let interim      = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) sessionFinal += result[0].transcript + ' '
        else interim += result[0].transcript
      }
      accumulated.current = sessionFinal.trim()
      const displayBase = [totalAccumRef.current, accumulated.current].filter(Boolean).join(' ')
      setTranscript((displayBase + ' ' + interim).trim())
    }

    r.onend = () => {
      if (recognitionRef.current !== r) return
      if (!activeRef.current || callStateRef.current !== 'listening') return

      const sessionText = accumulated.current.trim()
      if (sessionText) {
        totalAccumRef.current = [totalAccumRef.current, sessionText].filter(Boolean).join(' ')
        accumulated.current = ''
        setTranscript(totalAccumRef.current)
        // Clear any leftover timer, then restart + arm a fresh 2 s send window
        if (pendingSendTimerRef.current) {
          clearTimeout(pendingSendTimerRef.current)
          pendingSendTimerRef.current = null
        }
        startListeningRef.current()
        pendingSendTimerRef.current = setTimeout(() => {
          const toSend = totalAccumRef.current.trim()
          totalAccumRef.current = ''
          setTranscript('')
          if (toSend && activeRef.current) handleSendRef.current(toSend)
        }, 2000)
      } else {
        // No speech this session — keep mic open
        startListeningRef.current()
      }
    }

    r.onerror = (e) => {
      if (e.error === 'not-allowed') setSupported(false)
      // 'no-speech' / 'aborted' fall through to onend → restarts
    }

    try { r.start() } catch { /* already started */ }
  }, [])

  const stopListening = useCallback(() => {
    const r = recognitionRef.current
    recognitionRef.current = null   // null first so onend won't restart
    r?.stop()
    if (pendingSendTimerRef.current) {
      clearTimeout(pendingSendTimerRef.current)
      pendingSendTimerRef.current = null
    }
    totalAccumRef.current = ''
  }, [])

  // ── Interrupt ──────────────────────────────────────────────────────────────
  // Tap the avatar or the Interrupt button to stop Penny mid-sentence: cancel the
  // in-flight reply, drop the queued sentences, stop the current clip, and listen.
  const handleInterrupt = useCallback(() => {
    if (callStateRef.current !== 'speaking') return
    interruptedRef.current = true
    speechQueueRef.current = []
    chatAbortRef.current?.abort()       // stop the chat stream — no more sentences
    audioRef.current?.pause()           // current clip resolves via its onpause
    if (activeRef.current) {
      setPennyText('')
      setCallState('listening')
      startListeningRef.current()
    }
  }, [])

  // ── Speech finish ────────────────────────────────────────────────────────────
  // Return to listening once the stream is done AND every queued sentence has
  // been spoken. Called both when the player drains and when the stream ends, so
  // whichever finishes last triggers it.
  const maybeFinish = useCallback(() => {
    if (!activeRef.current || interruptedRef.current) return
    if (drainingRef.current) return
    if (speechQueueRef.current.length > 0) return
    if (!streamDoneRef.current) return
    setPennyText('')
    setCallState('listening')
    startListeningRef.current()
  }, [])

  // ── Play one TTS clip, streaming audio as it arrives ──────────────────────────
  const playResponse = useCallback((res: Response): Promise<void> => {
    const canStream =
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('audio/mpeg') &&
      !!res.body

    // Fallback: buffer the whole (short) clip, then play.
    const playBlob = async () => {
      try {
        const blob = await res.blob()
        if (interruptedRef.current || !activeRef.current) return
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audioRef.current = audio
        await new Promise<void>((resolve) => {
          audio.onended = () => { URL.revokeObjectURL(url); resolve() }
          audio.onerror = () => { URL.revokeObjectURL(url); resolve() }
          audio.onpause = () => { if (interruptedRef.current) { URL.revokeObjectURL(url); resolve() } }
          audio.play().catch(() => resolve())
        })
      } catch { /* skip this clip */ }
    }

    if (!canStream) return playBlob()

    // Stream via MediaSource: start playing as the first bytes land.
    return new Promise<void>((resolve) => {
      const ms = new MediaSource()
      const audio = new Audio()
      audioRef.current = audio
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
      // Browsers fire pause transiently while buffering; only finish on a real interrupt.
      audio.onpause = () => { if (interruptedRef.current) finish() }

      ms.addEventListener('sourceopen', () => {
        let sb: SourceBuffer
        try { sb = ms.addSourceBuffer('audio/mpeg') } catch { finish(); return }
        const reader = res.body!.getReader()
        ;(async () => {
          try {
            while (true) {
              if (interruptedRef.current || !activeRef.current) break
              const { done, value } = await reader.read()
              if (done) break
              await appendChunk(sb, value)
              if (audio.paused && !interruptedRef.current) audio.play().catch(() => {})
            }
          } catch {
            /* append/codec error — fall through to endOfStream */
          } finally {
            try { if (ms.readyState === 'open') ms.endOfStream() } catch { /* noop */ }
            if (interruptedRef.current || !activeRef.current) finish()
            else if (audio.paused) audio.play().catch(() => finish())
          }
        })()
      })
    })
  }, [])

  // ── Fetch + play one sentence ─────────────────────────────────────────────────
  const playOne = useCallback(async (text: string): Promise<void> => {
    if (interruptedRef.current || !activeRef.current) return
    let res: Response
    try {
      res = await fetch('/api/speak', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, modality: activeModalityRef.current }),
      })
    } catch { return }
    if (!res.ok || interruptedRef.current || !activeRef.current) return
    await playResponse(res)
  }, [playResponse])

  // ── Playback loop: speak queued sentences one after another ───────────────────
  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return       // already running — new sentences just queue
    drainingRef.current = true
    try {
      while (speechQueueRef.current.length > 0) {
        if (interruptedRef.current || !activeRef.current) break
        const sentence = speechQueueRef.current.shift()!
        if (callStateRef.current !== 'speaking') setCallState('speaking')
        await playOne(sentence)
      }
    } finally {
      drainingRef.current = false
      maybeFinish()
    }
  }, [playOne, maybeFinish])

  const enqueueSentence = useCallback((s: string) => {
    const clean = stripMarkers(s)
    if (!clean) return
    speechQueueRef.current.push(clean)
    void drainQueue()
  }, [drainQueue])

  // ── Text → Penny response (streamed, spoken sentence-by-sentence) ─────────────
  const handleSend = useCallback(async (text: string) => {
    if (!activeRef.current) return
    stopListening()
    setCallState('thinking')
    onMessage('user', text)

    // Reset per-turn streaming-speech state
    interruptedRef.current  = false
    rawRef.current          = ''
    speakBufRef.current     = ''
    flushedLenRef.current   = 0
    speechQueueRef.current  = []
    drainingRef.current     = false
    streamDoneRef.current   = false
    artifactSeenRef.current = false

    // Feed a raw text delta: extend the buffer, flush any complete sentences to TTS.
    const feed = (delta: string) => {
      rawRef.current += delta
      if (artifactSeenRef.current) return
      if (/<artifact\b/i.test(rawRef.current)) artifactSeenRef.current = true
      const speakable = speakablePrefix(rawRef.current)
      if (speakable.length <= flushedLenRef.current) return
      speakBufRef.current += speakable.slice(flushedLenRef.current)
      flushedLenRef.current = speakable.length
      const { sentences, rest } = takeSentences(speakBufRef.current)
      speakBufRef.current = rest
      for (const s of sentences) enqueueSentence(s)
      setPennyText(speakablePrefix(rawRef.current).trim())
    }

    const ac = new AbortController()
    chatAbortRef.current = ac

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, conversationId: conversationIdRef.current, isVoice: true }),
        signal:  ac.signal,
      })
      if (!res.body) throw new Error('No response')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.text) { fullText += data.text; feed(data.text) }
            if (data.done) {
              if (data.conversationId) {
                conversationIdRef.current = data.conversationId
                onConversationId(data.conversationId)
              }
              if (data.activeModality) {
                activeModalityRef.current = data.activeModality
                onModality?.(data.activeModality)
              }
              if (data.contextCleared) {
                conversationIdRef.current = data.conversationId || null
              }
              const clean = data.cleanText ?? fullText
              onMessage('assistant', clean)
              setPennyText(clean)
              // Speak whatever speakable text is left as a final sentence.
              if (!interruptedRef.current) {
                const speakable = speakablePrefix(rawRef.current)
                if (speakable.length > flushedLenRef.current) {
                  speakBufRef.current += speakable.slice(flushedLenRef.current)
                  flushedLenRef.current = speakable.length
                }
                const tail = speakBufRef.current.trim()
                speakBufRef.current = ''
                if (tail) enqueueSentence(tail)
              }
              streamDoneRef.current = true
              maybeFinish()       // in case nothing was queued (drain already idle)
            }
            if (data.error) {
              console.error('[call] server error:', data.error)
              streamDoneRef.current = true
              if (activeRef.current && !interruptedRef.current) {
                setCallState('listening')
                startListeningRef.current()
              }
            }
          } catch { /* skip */ }
        }
      }

      // Safety net: stream closed without a done/error event — don't hang in
      // "thinking". Mark done so the player (or this) returns us to listening.
      if (!streamDoneRef.current && !interruptedRef.current) {
        streamDoneRef.current = true
        maybeFinish()
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return   // interrupted — already listening
      console.error('[call] chat error:', err)
      streamDoneRef.current = true
      if (activeRef.current && !interruptedRef.current) {
        setCallState('listening')
        startListeningRef.current()
      }
    }
  }, [stopListening, onConversationId, onMessage, onModality, enqueueSentence, maybeFinish])

  // Keep refs pointed at the latest function instances
  useEffect(() => {
    handleSendRef.current     = handleSend
    startListeningRef.current = startListening
  }, [handleSend, startListening])

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    activeRef.current = true
    startListening()
    return () => {
      activeRef.current = false
      interruptedRef.current = true
      speechQueueRef.current = []
      stopListening()
      chatAbortRef.current?.abort()
      audioRef.current?.pause()
    }
  }, [startListening, stopListening])

  const handleClose = () => {
    if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current)
    activeRef.current = false
    interruptedRef.current = true
    speechQueueRef.current = []
    stopListening()
    chatAbortRef.current?.abort()
    audioRef.current?.pause()
    onClose()
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const modality = getModality(activeModality)

  const stateLabel = {
    listening: 'Listening…',
    thinking:  'Thinking…',
    speaking:  'Speaking…',
  }[callState]

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between"
      style={{ background: C.base }}
    >
      {/* Background watermark */}
      <div className="absolute inset-0 pointer-events-none" aria-hidden>
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'url(/penny-bg.png)',
          backgroundSize: '80%',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          opacity: 0.05,
          filter: 'blur(8px)',
        }} />
      </div>

      {/* Top bar */}
      <div className="relative z-10 w-full flex items-center justify-between px-6 pt-12 pb-4">
        <span className="text-sm font-medium" style={{ color: C.textMuted }}>
          Call with {modality.displayName}
        </span>
        <button
          onClick={handleClose}
          className="text-xs px-3 py-1.5 rounded-full border"
          style={{ color: C.textMuted, borderColor: C.border }}
        >End</button>
      </div>

      {/* Center — avatar + state */}
      <div className="relative z-10 flex flex-col items-center gap-6 flex-1 justify-center w-full px-6">

        {/* Avatar — tappable to interrupt when speaking */}
        <div
          className="relative"
          onClick={callState === 'speaking' ? handleInterrupt : undefined}
          style={callState === 'speaking' ? { cursor: 'pointer' } : undefined}
          title={callState === 'speaking' ? 'Tap to interrupt' : undefined}
        >
          {/* Outer pulse ring */}
          {callState === 'listening' && (
            <div
              className="absolute inset-0 rounded-full animate-ping"
              style={{
                background: 'transparent',
                border: `2px solid ${modality.color}`,
                opacity: 0.35,
                transform: 'scale(1.2)',
              }}
            />
          )}
          {callState === 'speaking' && (
            <div
              className="absolute inset-0 rounded-full animate-pulse"
              style={{
                background: `${modality.color}22`,
                border: `2px solid ${modality.color}`,
                transform: 'scale(1.15)',
              }}
            />
          )}

          {avatarErr ? (
            <div
              className="w-32 h-32 rounded-full flex items-center justify-center text-white text-4xl font-semibold shadow-2xl"
              style={{ background: `linear-gradient(135deg, ${modality.color}, ${modality.color}bb)` }}
            >{modality.displayName[0]}</div>
          ) : (
            <img
              src={modality.avatarPath}
              className="w-32 h-32 rounded-full object-cover shadow-2xl"
              style={{ border: `3px solid ${callState === 'thinking' ? C.textMuted : modality.color}` }}
              alt={modality.displayName}
              onError={() => setAvatarErr(true)}
            />
          )}
        </div>

        {/* State label */}
        <div className="flex items-center gap-2">
          {callState === 'thinking' && (
            <span className="flex gap-1">
              {[0, 150, 300].map(d => (
                <span key={d} className="w-1.5 h-1.5 rounded-full animate-bounce"
                  style={{ background: modality.color, animationDelay: `${d}ms` }} />
              ))}
            </span>
          )}
          <span className="text-sm" style={{ color: callState === 'listening' ? modality.color : C.textMuted }}>
            {stateLabel}
          </span>
        </div>

        {/* Live transcript (what you're saying) */}
        {transcript && callState === 'listening' && (
          <p
            className="text-center text-sm max-w-xs px-6 leading-relaxed"
            style={{ color: C.text, fontFamily: 'var(--font-geist-sans)' }}
          >
            "{transcript}"
          </p>
        )}

        {/* Penny's response — scrollable, full text */}
        {pennyText && callState === 'speaking' && (
          <div
            className="max-w-xs w-full max-h-48 overflow-y-auto rounded-xl px-4 py-3"
            style={{ background: 'rgba(255,255,255,0.05)' }}
          >
            <p
              className="text-sm leading-relaxed text-center"
              style={{ color: C.text, fontFamily: 'var(--font-lora), Georgia, serif' }}
            >
              {pennyText}
            </p>
          </div>
        )}

        {/* Interrupt button (visible while speaking) */}
        {callState === 'speaking' && (
          <button
            onClick={handleInterrupt}
            className="text-xs px-5 py-2 rounded-full border transition-all hover:scale-105 active:scale-95"
            style={{
              color: modality.color,
              borderColor: modality.color + '60',
              background: modality.color + '18',
            }}
          >
            ✋ Interrupt
          </button>
        )}

        {!supported && (
          <p className="text-center text-sm px-6" style={{ color: C.pink }}>
            Microphone access is required for call mode.
          </p>
        )}
      </div>

      {/* Bottom hint */}
      <div className="relative z-10 pb-12">
        <p className="text-xs text-center" style={{ color: C.textMuted }}>
          {callState === 'speaking'
            ? 'Tap avatar or button above to interrupt'
            : 'Penny hears you. Stop talking for 2 seconds to send.'}
        </p>
      </div>
    </div>
  )
}
