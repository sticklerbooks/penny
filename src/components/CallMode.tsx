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
  const interruptedRef      = useRef(false)         // cancellation signal for speak()

  // Refs that keep the latest closures available inside long-lived callbacks.
  const conversationIdRef  = useRef(conversationId)
  const activeModalityRef  = useRef<string>(activeModality)
  const handleSendRef      = useRef<(text: string) => void>(() => {})
  const startListeningRef  = useRef<() => void>(() => {})
  const speakRef           = useRef<(text: string) => Promise<void>>(async () => {})

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
  // Tap the avatar or the Interrupt button to stop Penny mid-sentence.
  // speak() has an onpause handler that resolves its promise naturally.
  const handleInterrupt = useCallback(() => {
    if (callStateRef.current !== 'speaking') return
    interruptedRef.current = true
    audioRef.current?.pause()   // → onpause fires → speak()'s promise resolves
    // If still fetching TTS (audioRef null), interruptedRef guards the flow
  }, [])

  // ── Response → audio ───────────────────────────────────────────────────────
  const speak = useCallback(async (text: string) => {
    if (!activeRef.current) return
    interruptedRef.current = false
    setCallState('speaking')

    try {
      const res = await fetch('/api/speak', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, modality: activeModalityRef.current }),
      })
      if (!res.ok) throw new Error('TTS failed')

      // Guard: was interrupt() called while we were fetching?
      if (interruptedRef.current) throw new Error('interrupted')

      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      // Guard again after setting audioRef (tiny race window)
      if (interruptedRef.current) {
        URL.revokeObjectURL(url)
        throw new Error('interrupted')
      }

      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve() }
        audio.onerror = () => { URL.revokeObjectURL(url); resolve() }
        // Only resolve on pause if it was a deliberate interrupt — browsers can fire
        // pause transiently during buffering/media-session suspension, which would
        // otherwise prematurely end speech and snap back to listening.
        audio.onpause = () => { if (interruptedRef.current) { URL.revokeObjectURL(url); resolve() } }
        audio.play().catch(() => resolve())
      })
    } catch (err) {
      if ((err as Error).message !== 'interrupted') {
        console.error('[call] speak error:', err)
      }
    }

    // Whether we finished naturally or were interrupted, restart listening
    if (activeRef.current) {
      setPennyText('')
      setCallState('listening')
      startListeningRef.current()
    }
  }, [])

  // ── Text → Penny response ──────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string) => {
    if (!activeRef.current) return
    stopListening()
    setCallState('thinking')
    onMessage('user', text)

    try {
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, conversationId: conversationIdRef.current, isVoice: true }),
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
            if (data.text) fullText += data.text
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
              await speakRef.current(clean)
            }
            if (data.error) {
              console.error('[call] server error:', data.error)
              if (activeRef.current) {
                setCallState('listening')
                startListeningRef.current()
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.error('[call] chat error:', err)
      setCallState('listening')
      startListeningRef.current()
    }
  }, [stopListening, onConversationId, onMessage, onModality])

  // Keep refs pointed at the latest function instances
  useEffect(() => {
    handleSendRef.current     = handleSend
    startListeningRef.current = startListening
    speakRef.current          = speak
  }, [handleSend, startListening, speak])

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    activeRef.current = true
    startListening()
    return () => {
      activeRef.current = false
      stopListening()
      audioRef.current?.pause()
    }
  }, [startListening, stopListening])

  const handleClose = () => {
    if (pendingSendTimerRef.current) clearTimeout(pendingSendTimerRef.current)
    activeRef.current = false
    stopListening()
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
