'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

// ─── Palette (matches ChatInterface) ────────────────────────────────────────
const C = {
  base:     '#0B0C10',
  panel:    '#1F2833',
  pink:     '#FF69B4',
  pinkDark: '#d4539a',
  blue:     '#4B9CD3',
  text:     'rgba(232,234,240,0.92)',
  textMuted:'rgba(232,234,240,0.45)',
  border:   'rgba(255,105,180,0.18)',
}

type CallState = 'listening' | 'thinking' | 'speaking'

interface CallModeProps {
  conversationId: string | null
  onConversationId: (id: string) => void
  onClose: () => void
  onMessage: (role: 'user' | 'assistant', content: string) => void
  avatarImgError: boolean
}

// ─── Speech recognition ───────────────────────────────────────────────────────

export default function CallMode({
  conversationId,
  onConversationId,
  onClose,
  onMessage,
  avatarImgError,
}: CallModeProps) {
  const [callState, setCallState]     = useState<CallState>('listening')
  const [transcript, setTranscript]   = useState('')
  const [pennyText, setPennyText]     = useState('')
  const [supported, setSupported]     = useState(true)

  const recognitionRef  = useRef<SpeechRecognition | null>(null)
  const silenceTimer    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const accumulated     = useRef('')
  const callStateRef    = useRef<CallState>('listening')
  const audioRef        = useRef<HTMLAudioElement | null>(null)
  const activeRef       = useRef(true) // false when call ends

  // Keep ref in sync with state (needed in callbacks)
  useEffect(() => { callStateRef.current = callState }, [callState])

  // ── Speech → text ──────────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!activeRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR: (new () => SpeechRecognition) | undefined = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) { setSupported(false); return }

    const r = new SR()
    r.continuous      = true
    r.interimResults  = true
    r.lang            = 'en-US'
    recognitionRef.current = r

    r.onresult = (event: SpeechRecognitionEvent & { resultIndex: number }) => {
      if (!activeRef.current) return
      clearTimeout(silenceTimer.current ?? undefined)

      let finalChunk = ''
      let interim    = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript
        if (event.results[i].isFinal) finalChunk += t
        else interim += t
      }
      accumulated.current += finalChunk
      setTranscript(accumulated.current + interim)

      // Auto-send after 1.5s of silence
      silenceTimer.current = setTimeout(() => {
        const text = (accumulated.current + interim).trim()
        if (text && callStateRef.current === 'listening') {
          accumulated.current = ''
          setTranscript('')
          handleSend(text)
        }
      }, 1500)
    }

    r.onend = () => {
      // Restart automatically if we're still in listening state
      if (activeRef.current && callStateRef.current === 'listening') {
        setTimeout(() => {
          if (activeRef.current && callStateRef.current === 'listening') {
            r.start()
          }
        }, 200)
      }
    }

    r.onerror = (e) => {
      if (e.error === 'not-allowed') setSupported(false)
    }

    r.start()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const stopListening = useCallback(() => {
    clearTimeout(silenceTimer.current ?? undefined)
    recognitionRef.current?.stop()
    recognitionRef.current = null
  }, [])

  // ── Text → Penny response ──────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string) => {
    if (!activeRef.current) return
    stopListening()
    setCallState('thinking')
    onMessage('user', text)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, conversationId }),
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
              if (data.conversationId) onConversationId(data.conversationId)
              const clean = data.cleanText ?? fullText
              onMessage('assistant', clean)
              setPennyText(clean)
              await speak(clean)
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.error('[call] chat error:', err)
      setCallState('listening')
      startListening()
    }
  }, [conversationId, stopListening, startListening, onConversationId, onMessage])

  // ── Response → audio ───────────────────────────────────────────────────────
  const speak = useCallback(async (text: string) => {
    if (!activeRef.current) return
    setCallState('speaking')

    try {
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error('TTS failed')

      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio

      await new Promise<void>((resolve) => {
        audio.onended = () => { URL.revokeObjectURL(url); resolve() }
        audio.onerror = () => { URL.revokeObjectURL(url); resolve() }
        audio.play().catch(() => resolve())
      })
    } catch (err) {
      console.error('[call] speak error:', err)
    }

    if (activeRef.current) {
      setPennyText('')
      setCallState('listening')
      startListening()
    }
  }, [startListening])

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
    activeRef.current = false
    stopListening()
    audioRef.current?.pause()
    onClose()
  }

  // ── State labels ───────────────────────────────────────────────────────────
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
          Call with Penny
        </span>
        <button
          onClick={handleClose}
          className="text-xs px-3 py-1.5 rounded-full border"
          style={{ color: C.textMuted, borderColor: C.border }}
        >End</button>
      </div>

      {/* Center — avatar + state */}
      <div className="relative z-10 flex flex-col items-center gap-6 flex-1 justify-center">

        {/* Avatar with animated ring */}
        <div className="relative">
          {/* Outer pulse ring */}
          {callState === 'listening' && (
            <div
              className="absolute inset-0 rounded-full animate-ping"
              style={{
                background: 'transparent',
                border: `2px solid ${C.pink}`,
                opacity: 0.35,
                transform: 'scale(1.2)',
              }}
            />
          )}
          {callState === 'speaking' && (
            <div
              className="absolute inset-0 rounded-full animate-pulse"
              style={{
                background: `${C.pink}22`,
                border: `2px solid ${C.pink}`,
                transform: 'scale(1.15)',
              }}
            />
          )}

          {avatarImgError ? (
            <div
              className="w-32 h-32 rounded-full flex items-center justify-center text-white text-4xl font-semibold shadow-2xl"
              style={{ background: `linear-gradient(135deg, ${C.pink}, ${C.pinkDark})` }}
            >P</div>
          ) : (
            <img
              src="/penny-avatar.png"
              className="w-32 h-32 rounded-full object-cover shadow-2xl"
              style={{ border: `3px solid ${callState === 'thinking' ? C.textMuted : C.pink}` }}
              alt="Penny"
            />
          )}
        </div>

        {/* State label */}
        <div className="flex items-center gap-2">
          {callState === 'thinking' && (
            <span className="flex gap-1">
              {[0,150,300].map(d => (
                <span key={d} className="w-1.5 h-1.5 rounded-full animate-bounce"
                  style={{ background: C.pink, animationDelay: `${d}ms` }} />
              ))}
            </span>
          )}
          <span className="text-sm" style={{ color: callState === 'listening' ? C.pink : C.textMuted }}>
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

        {/* Penny's response text (while speaking) */}
        {pennyText && callState === 'speaking' && (
          <p
            className="text-center text-sm max-w-xs px-6 leading-relaxed"
            style={{ color: C.text, fontFamily: 'var(--font-lora), Georgia, serif' }}
          >
            {pennyText.length > 180 ? pennyText.slice(0, 180) + '…' : pennyText}
          </p>
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
          Penny hears you. Pause for a moment to send.
        </p>
      </div>
    </div>
  )
}
