'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import CallMode from './CallMode'
import { MODALITIES, getModality } from '@/lib/modalities'
import { SentenceSpeaker } from '@/lib/speak-client'

// ─── Base palette (non-modality colours) ─────────────────────────────────────
const C = {
  base:        '#0B0C10',
  panel:       '#1F2833',
  panelLight:  '#263040',
  blue:        '#4B9CD3',   // User's color (always blue)
  blueDark:    '#3a7dab',
  text:        'rgba(232,234,240,0.92)',
  textMuted:   'rgba(232,234,240,0.45)',
  borderBlue:  'rgba(75,156,211,0.18)',
}

// Derive per-modality accent colours at render time from current.color
function modalityBorder(color: string) {
  return color + '30'  // ~19% opacity hex
}

// ─── Streaming marker cleanup ────────────────────────────────────────────────
const BLOCK_TAGS = [
  'update_user_profile','update_self_notes',
  'update_private_user_profile','update_private_self_notes',
  'update_alt_about_user','update_alt_about_self',
  'memory','update_memory',
  'client','update_client','schedule_sms','next_session',
  'artifact',
  'schedule_task',
]

function stripStreamingMarkers(text: string): string {
  let result = text
  for (const tag of BLOCK_TAGS) {
    result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
    result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*$`, 'gi'), '')
  }
  result = result.replace(
    /<(task|update_task|delete_task|delete_memory|update_memory|resolve_note|delete_note|delete_client|cancel_sms|run_subroutine|complete_session|search_email|search_calendar)[^>]*\/?>/gi,
    ''
  )
  return result.replace(/\n{3,}/g, '\n\n').trim()
}

// ─── Web Speech API types (for dictate mode) ─────────────────────────────────
interface DictSpeechResultAlt { transcript: string }
interface DictSpeechResult { isFinal: boolean; 0: DictSpeechResultAlt }
interface DictSpeechResultEvent { resultIndex: number; results: ArrayLike<DictSpeechResult> }
interface DictSpeechErrorEvent { error: string }
interface DictSpeechRecognizer {
  continuous: boolean; interimResults: boolean; lang: string
  onresult: ((e: DictSpeechResultEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: DictSpeechErrorEvent) => void) | null
  start: () => void; stop: () => void
}
type DictSpeechRecognizerCtor = new () => DictSpeechRecognizer

function getDictSpeechRecognizer(): DictSpeechRecognizerCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: DictSpeechRecognizerCtor
    webkitSpeechRecognition?: DictSpeechRecognizerCtor
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition
}

// ─── Types ───────────────────────────────────────────────────────────────────
interface Message {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  artifact?: { filename: string; content: string } | null
}

interface ChatInterfaceProps {
  type: 'intake' | 'chat'
  onIntakeComplete?: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function ChatInterface({ type, onIntakeComplete }: ChatInterfaceProps) {
  const [messages, setMessages]               = useState<Message[]>([])
  const [input, setInput]                     = useState('')
  const [isLoading, setIsLoading]             = useState(false)
  const [conversationId, setConversationId]   = useState<string | null>(null)
  const [inCall, setInCall]                   = useState(false)
  const [avatarImgError, setAvatarImgError]   = useState(false)
  const [thinkingImgError, setThinkingImgError] = useState(false)
  const [activeModality, setActiveModality]   = useState('pa')
  const [isAltMode, setIsAltMode]             = useState(false)
  const [showSwitcher, setShowSwitcher]       = useState(false)
  const [isDictating, setIsDictating]         = useState(false)
  const [isMobile, setIsMobile]               = useState(false)
  // Text-mode TTS: when speakReplies is on, each completed assistant reply (incl.
  // the first greeting after a switch) is spoken aloud. playingIdx tracks which
  // bubble is currently being read so its 🔊 button can show a stop state.
  const [speakReplies, setSpeakReplies]       = useState(false)
  const [playingIdx, setPlayingIdx]           = useState<number | null>(null)

  const messagesEndRef     = useRef<HTMLDivElement>(null)
  const textareaRef        = useRef<HTMLTextAreaElement>(null)
  const hasInitialized     = useRef(false)

  // Speech playback refs
  const speechRef          = useRef<SentenceSpeaker | null>(null)
  const speakRepliesRef    = useRef(false)
  const activeModalityRef  = useRef('pa')

  // Dictate mode refs
  const dictateRecogRef    = useRef<DictSpeechRecognizer | null>(null)
  const dictateAccumRef    = useRef('')
  const isDictatingRef     = useRef(false)
  const startDictatingRef  = useRef<() => void>(() => {})

  // ── Mobile detection ────────────────────────────────────────────────────────
  useEffect(() => {
    setIsMobile(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  // ── Speak-replies preference (persisted) ─────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem('penny-speak-replies') === '1'
    setSpeakReplies(saved)
    speakRepliesRef.current = saved
  }, [])
  useEffect(() => { speakRepliesRef.current = speakReplies }, [speakReplies])
  useEffect(() => { activeModalityRef.current = activeModality }, [activeModality])

  // ── Speech playback ──────────────────────────────────────────────────────────
  // One SentenceSpeaker at a time (held in speechRef), used for both the streamed
  // auto-speak (fed live in sendMessage) and the per-message replay button.
  const stopSpeaking = useCallback(() => {
    speechRef.current?.stop()
    speechRef.current = null
    setPlayingIdx(null)
  }, [])

  // Per-message replay: speak one complete message, sentence by sentence.
  const speakMessage = useCallback((text: string, idx: number) => {
    speechRef.current?.stop()
    if (!text.trim()) { setPlayingIdx(null); return }
    setPlayingIdx(idx)
    const speaker = new SentenceSpeaker(activeModalityRef.current, (active) => {
      if (!active) setPlayingIdx((cur) => (cur === idx ? null : cur))
    })
    speechRef.current = speaker
    speaker.feed(text)
    speaker.finish()
  }, [])

  // Stop any playback on unmount.
  useEffect(() => () => { speechRef.current?.stop() }, [])

  // ── Prewarm: prime context + prompt cache so the first turn isn't cold ────────
  const prewarm = useCallback((modalityId: string) => {
    fetch('/api/prewarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modalityId }),
    }).catch(() => {})
  }, [])

  // ── Keep isDictatingRef in sync ─────────────────────────────────────────────
  useEffect(() => { isDictatingRef.current = isDictating }, [isDictating])

  // ── Cleanup dictation on unmount ────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const r = dictateRecogRef.current
      if (r) { dictateRecogRef.current = null; r.stop() }
    }
  }, [])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 128)}px`
    }
  }, [input])

  // ─── Dictate mode ──────────────────────────────────────────────────────────
  // Starts one recognition session (continuous=false). On pause, onend fires
  // and we restart as long as isDictatingRef is still true. Each final chunk
  // appends to dictateAccumRef so text survives across pauses.
  const startDictating = useCallback(() => {
    if (!isDictatingRef.current) return
    const SR = getDictSpeechRecognizer()
    if (!SR) { setIsDictating(false); isDictatingRef.current = false; return }

    const r = new SR()
    r.continuous     = false
    r.interimResults = true
    r.lang           = 'en-US'
    dictateRecogRef.current = r

    r.onresult = (event) => {
      let allFinal = ''
      let interim  = ''
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) allFinal += event.results[i][0].transcript + ' '
        else interim += event.results[i][0].transcript
      }
      if (allFinal.trim()) dictateAccumRef.current += allFinal
      setInput((dictateAccumRef.current + interim).trim())
    }

    r.onend = () => {
      if (dictateRecogRef.current !== r) return
      if (!isDictatingRef.current) return
      // Still dictating after a pause — restart for the next utterance
      startDictatingRef.current()
    }

    r.onerror = (e) => {
      if (e.error === 'not-allowed') {
        setIsDictating(false)
        isDictatingRef.current = false
      }
      // 'no-speech' / 'aborted' fall through to onend → restart
    }

    try { r.start() } catch { /* already started */ }
  }, [])

  const stopDictation = useCallback(() => {
    setIsDictating(false)
    isDictatingRef.current = false
    const r = dictateRecogRef.current
    dictateRecogRef.current = null
    r?.stop()
  }, [])

  const toggleDictation = useCallback(() => {
    if (isDictating) {
      stopDictation()
    } else {
      dictateAccumRef.current = ''
      setIsDictating(true)
      isDictatingRef.current = true
      // Defer by one tick so isDictatingRef is true when startDictating checks
      setTimeout(() => startDictatingRef.current(), 0)
    }
  }, [isDictating, stopDictation])

  // Keep startDictatingRef current
  useEffect(() => {
    startDictatingRef.current = startDictating
  }, [startDictating])

  // ─── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string, isAutoStart = false, switchTo?: string, activateAltMode?: boolean) => {
    // Stop dictation if active (user hit send while dictating)
    if (isDictatingRef.current) {
      setIsDictating(false)
      isDictatingRef.current = false
      const r = dictateRecogRef.current
      dictateRecogRef.current = null
      r?.stop()
    }

    const content = isAutoStart ? '' : text.trim()
    if (!isAutoStart && !switchTo && !content && activateAltMode === undefined) return
    if (isLoading) return

    // A new turn supersedes any reply currently being read aloud.
    speechRef.current?.stop()
    speechRef.current = null
    setPlayingIdx(null)

    // Show the user's message bubble (not for auto-start or silent switches)
    if (!isAutoStart && content) {
      setMessages(prev => [...prev, { role: 'user', content }])
      setInput('')
    }

    setIsLoading(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }])

    // Auto-speak: read the reply aloud sentence-by-sentence as it streams in.
    const speaker = speakRepliesRef.current
      ? new SentenceSpeaker(activeModalityRef.current)
      : null
    speechRef.current = speaker

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          conversationId,
          isAutoStart,
          switchTo,
          ...(activateAltMode !== undefined ? { activateAltMode } : {}),
        }),
      })
      if (!res.body) throw new Error('No response body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const lines = decoder.decode(value).split('\n')
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.text) {
              fullText += data.text
              speaker?.feed(fullText)
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last?.streaming) last.content = stripStreamingMarkers(fullText)
                return next
              })
            }
            if (data.done) {
              setConversationId(data.conversationId)
              if (data.activeModality) setActiveModality(data.activeModality)
              if (data.isAltMode !== undefined) setIsAltMode(data.isAltMode)
              if (data.intakeComplete && onIntakeComplete) setTimeout(onIntakeComplete, 2000)
              const finalText = data.cleanText ?? fullText
              setMessages(prev => {
                // contextCleared = we just switched modalities; messages were already
                // cleared client-side in switchModality() — keep only the greeting bubble
                const base = data.contextCleared ? [] : prev
                const next = [...base]
                const last = next[next.length - 1]
                if (last?.streaming) {
                  last.content = finalText
                  last.streaming = false
                  last.artifact = data.artifact ?? null
                } else {
                  next.push({ role: 'assistant', content: finalText, streaming: false, artifact: data.artifact ?? null })
                }
                return next
              })
              // No more text — flush the final sentence to TTS.
              speaker?.finish()
            }
            if (data.error) {
              speaker?.stop()
              if (data.conversationId) setConversationId(data.conversationId)
              if (data.isAltMode !== undefined) setIsAltMode(data.isAltMode)
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last?.streaming) {
                  last.content = fullText.trim() || 'Something hiccupped on my end — try again?'
                  last.streaming = false
                }
                return next
              })
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      console.error(err)
      speaker?.stop()
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.streaming) { last.content = "I'm having a little trouble right now. Try again in a moment?"; last.streaming = false }
        return next
      })
    }

    setIsLoading(false)
    textareaRef.current?.focus()
  }, [conversationId, isLoading, onIntakeComplete])

  // Initialize
  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    if (type === 'intake') {
      sendMessage('', true)
    } else {
      // "Talk to her" from the dashboard lands here as ?modality=<id>. The dashboard
      // already wrapped any abandoned session, so open a fresh conversation under the
      // requested self and let her greet — same path as an in-app switch. (Passing
      // switchTo is what tags the new conversation to her; without it the first turn
      // would be answered by the PA default.)
      const wantModality = new URLSearchParams(window.location.search).get('modality')
      if (wantModality && getModality(wantModality).id === wantModality) {
        setActiveModality(wantModality)
        activeModalityRef.current = wantModality   // greet in her voice
        sendMessage('', false, wantModality)
        return
      }
      fetch('/api/conversation')
        .then(r => r.json())
        .then(data => {
          if (data?.messages?.length) {
            setConversationId(data.id)
            if (data.activeModality) setActiveModality(data.activeModality)
            if (data.isAltMode !== undefined) setIsAltMode(data.isAltMode)
            setMessages(data.messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
              role: m.role, content: m.content,
            })))
          }
          // Warm context + this self's prompt cache for the first real turn.
          prewarm(data?.activeModality || 'pa')
        })
        .catch(() => {})
    }
  }, [type, sendMessage, prewarm])

  // ─── Keyboard handler ──────────────────────────────────────────────────────
  // On desktop (pointer: fine): Enter sends, Shift+Enter = new line.
  // On mobile  (pointer: coarse): Enter always inserts newline; only Send button sends.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  // ─── Penny avatar ──────────────────────────────────────────────────────────
  const PennyAvatar = ({ size = 'sm' }: { size?: 'sm' | 'lg' }) => {
    const dim = size === 'lg' ? 'w-10 h-10' : 'w-7 h-7'
    const txt = size === 'lg' ? 'text-base' : 'text-xs'
    const avatarSrc = current.avatarPath || '/penny-avatar.png'
    return avatarImgError ? (
      <div
        className={`${dim} rounded-full flex items-center justify-center text-white font-semibold ${txt} flex-shrink-0 shadow-md`}
        style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}
      >{current.displayName[0]}</div>
    ) : (
      <img
        src={avatarSrc}
        onError={() => setAvatarImgError(true)}
        className={`${dim} rounded-full object-cover flex-shrink-0 shadow-md`}
        alt={current.displayName}
        style={{ border: size === 'lg' ? `2px solid ${accentBorder}` : undefined }}
      />
    )
  }

  // ─── Thinking indicator ────────────────────────────────────────────────────
  const ThinkingIndicator = () =>
    thinkingImgError ? (
      <span className="flex gap-1.5 items-center h-5 px-1">
        {[0, 160, 320].map(delay => (
          <span key={delay} className="w-2 h-2 rounded-full animate-bounce"
            style={{ background: accent, animationDelay: `${delay}ms` }} />
        ))}
      </span>
    ) : (
      <img
        src="/penny-thinking.png"
        onError={() => setThinkingImgError(true)}
        className="w-10 h-10 object-contain animate-pulse"
        alt="Penny is thinking"
      />
    )

  // ─── Artifact download ─────────────────────────────────────────────────────
  const downloadArtifact = useCallback((filename: string, content: string) => {
    const ext = filename.split('.').pop()?.toLowerCase() ?? 'txt'
    const mimeMap: Record<string, string> = {
      txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', html: 'text/html',
    }
    const mime = mimeMap[ext] ?? 'text/plain'
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }, [])

  // ─── Call mode helpers ─────────────────────────────────────────────────────
  const addCallMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    setMessages(prev => [...prev, { role, content }])
  }, [])

  // ─── Modality switch (from the header dropdown) ────────────────────────────
  const switchModality = useCallback((id: string) => {
    setShowSwitcher(false)
    if (id === activeModality || isLoading) return
    // Clear messages immediately — fresh context for the new modality
    stopSpeaking()
    setMessages([])
    setActiveModality(id)
    activeModalityRef.current = id   // speak the greeting in the NEW self's voice
    sendMessage('', false, id)
  }, [activeModality, isLoading, sendMessage, stopSpeaking])

  const current = getModality(activeModality)
  // Per-modality accent (used for borders, rings, active highlights)
  const accent = current.color
  const accentBorder = modalityBorder(accent)

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative flex flex-col h-screen overflow-hidden" style={{ background: C.base }}>

      {/* Voice call overlay */}
      {inCall && (
        <CallMode
          conversationId={conversationId}
          onConversationId={setConversationId}
          onClose={() => setInCall(false)}
          onMessage={addCallMessage}
          avatarImgError={avatarImgError}
          activeModality={activeModality}
          onModality={setActiveModality}
        />
      )}

      {/* Faded background image */}
      <div className="absolute inset-0 z-0 pointer-events-none select-none" aria-hidden>
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url(${current.bgPath || current.avatarPath || '/penny-bg.png'})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center top',
          backgroundRepeat: 'no-repeat',
          opacity: 0.15,
          filter: 'blur(1px) saturate(0.6)',
        }} />
      </div>

      {/* Main layout */}
      <div className="relative z-10 flex flex-col h-full">

        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5 shadow-xl flex-shrink-0"
          style={{ background: C.panel, borderBottom: `1px solid ${accentBorder}` }}
        >
          <div className="flex items-center gap-3">
            <PennyAvatar size="lg" />
            <div>
              <h1 className="font-semibold leading-tight" style={{ color: C.text }}>
                {type === 'intake' ? 'Penny' : (isAltMode && current.altMode?.displayName) ? current.altMode.displayName : current.displayName}
              </h1>
              <p className="text-xs" style={{ color: C.textMuted }}>
                {type === 'intake' ? 'Getting to know you' : current.role}
              </p>
            </div>
          </div>

          {/* Speak-replies toggle — read each reply aloud (incl. the first greeting
              after a switch). For the phone-and-headphones, hands-free case. */}
          <button
            onClick={() => {
              setSpeakReplies(prev => {
                const next = !prev
                speakRepliesRef.current = next
                localStorage.setItem('penny-speak-replies', next ? '1' : '0')
                if (!next) stopSpeaking()
                // Turning it ON only affects future replies — it won't replay
                // whatever's already on screen.
                return next
              })
            }}
            title={speakReplies ? 'Stop reading replies aloud' : 'Read replies aloud'}
            className="text-sm px-3 py-1.5 rounded-full border transition-all hover:scale-105 active:scale-95"
            style={{
              background: speakReplies ? accent + '40' : accent + '12',
              borderColor: speakReplies ? accent : accentBorder,
              color: speakReplies ? accent : C.textMuted,
            }}
          >
            {speakReplies ? '🔊' : '🔇'}
          </button>

          {/* Alt-mode toggle — only shown when the active modality has an altMode */}
          {type !== 'intake' && current.altMode && (
            <button
              onClick={() => {
                stopSpeaking()
                setMessages([])
                sendMessage('', false, undefined, !isAltMode)
              }}
              disabled={isLoading}
              title={isAltMode ? 'Exit alt mode' : 'Enter alt mode'}
              className="text-sm px-3 py-1.5 rounded-full border transition-all hover:scale-105 active:scale-95 disabled:opacity-40"
              style={{
                background: isAltMode ? accent + '40' : accent + '12',
                borderColor: isAltMode ? accent : accentBorder,
                color: isAltMode ? accent : C.textMuted,
              }}
            >
              {isAltMode ? '◆' : '◇'}
            </button>
          )}

          {/* Modality switcher */}
          {type !== 'intake' && (
            <div className="relative">
              <button
                onClick={() => setShowSwitcher(s => !s)}
                disabled={isLoading}
                className="text-sm px-3 py-1.5 rounded-full border transition-all hover:scale-105 active:scale-95 disabled:opacity-40"
                style={{ background: accent + '20', borderColor: accentBorder, color: accent }}
                title="Switch modality"
              >
                {current.emoji} ▾
              </button>
              {showSwitcher && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSwitcher(false)} />
                  <div
                    className="absolute right-0 mt-2 z-50 rounded-xl overflow-y-auto shadow-2xl min-w-[200px]"
                    style={{ background: C.panelLight, border: `1px solid ${accentBorder}`, maxHeight: '70vh' }}
                  >
                    {MODALITIES.filter(m => !m.disabled).map(m => (
                      <button
                        key={m.id}
                        onClick={() => switchModality(m.id)}
                        className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 transition-colors hover:bg-white/5"
                        style={{
                          color: m.id === activeModality ? m.color : C.text,
                          background: m.id === activeModality ? m.color + '15' : 'transparent',
                        }}
                      >
                        <span>{m.emoji}</span>
                        <span className="flex flex-col leading-tight">
                          <span>{m.displayName}</span>
                          <span className="text-[10px]" style={{ color: C.textMuted }}>{m.role}</span>
                        </span>
                        {m.id === activeModality && <span className="ml-auto text-xs" style={{ color: m.color }}>●</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-5">
          {messages.map((msg, i) => {
            const isAssistant = msg.role === 'assistant'
            return (
              <div key={i} className={`flex items-end gap-2 ${isAssistant ? 'justify-start' : 'justify-end'}`}>
                {isAssistant && <div className="mb-0.5 flex-shrink-0"><PennyAvatar /></div>}

                <div
                  className="max-w-[80%] shadow-md"
                  style={isAssistant ? {
                    background: C.panel,
                    border: `1px solid ${accentBorder}`,
                    color: C.text,
                    borderRadius: '20px',
                    borderBottomLeftRadius: '5px',
                    padding: '14px 18px',
                    fontSize: '15px',
                    lineHeight: '1.7',
                    fontFamily: 'var(--font-lora), Georgia, serif',
                  } : {
                    background: `linear-gradient(135deg, ${C.blue}, ${C.blueDark})`,
                    color: 'white',
                    borderRadius: '20px',
                    borderBottomRightRadius: '5px',
                    padding: '11px 16px',
                    fontSize: '14px',
                    lineHeight: '1.55',
                  }}
                >
                  {msg.content ? (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                  ) : msg.streaming ? (
                    <ThinkingIndicator />
                  ) : null}
                  {msg.artifact && (
                    <button
                      onClick={() => downloadArtifact(msg.artifact!.filename, msg.artifact!.content)}
                      className="flex items-center gap-2 mt-3 px-3 py-1.5 rounded-lg text-xs transition-all hover:scale-105 active:scale-95"
                      style={{
                        background: accent + '20',
                        border: `1px solid ${accentBorder}`,
                        color: accent,
                      }}
                    >
                      <span>📎</span>
                      <span>{msg.artifact.filename}</span>
                      <span style={{ opacity: 0.6 }}>↓</span>
                    </button>
                  )}
                  {/* Per-message replay — hear this one aloud (or stop it). */}
                  {isAssistant && msg.content && !msg.streaming && (
                    <button
                      onClick={() => playingIdx === i ? stopSpeaking() : speakMessage(msg.content, i)}
                      title={playingIdx === i ? 'Stop' : 'Read aloud'}
                      className="mt-2 ml-0.5 text-xs transition-opacity hover:opacity-100"
                      style={{ color: accent, opacity: playingIdx === i ? 1 : 0.55 }}
                    >
                      {playingIdx === i ? '⏹ Stop' : '🔊 Listen'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div
          className="px-4 py-3 flex-shrink-0"
          style={{ background: C.panel, borderTop: `1px solid ${C.borderBlue}` }}
        >
          <div className="flex items-end gap-2 max-w-2xl mx-auto">

            {/* Call button */}
            <button
              onClick={() => {
                // Call mode speaks on its own — turn off text-mode auto-speak so
                // the reply isn't read aloud twice.
                stopSpeaking()
                setSpeakReplies(false)
                speakRepliesRef.current = false
                setInCall(true)
              }}
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 hover:scale-105 active:scale-95 shadow-md"
              style={{ background: accent + '20', border: `1px solid ${accentBorder}` }}
              title="Start a voice call with Penny"
            >📞</button>

            {/* Textarea */}
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isDictating ? 'Listening — speak now…' : isLoading ? 'Penny is thinking…' : 'Type or tap the mic…'}
                disabled={isLoading}
                rows={1}
                className="w-full resize-none rounded-xl px-4 py-2.5 text-sm transition-colors"
                style={{
                  background: C.base,
                  border: `1px solid ${isDictating ? accent : accentBorder}`,
                  color: C.text,
                  minHeight: '44px',
                  maxHeight: '128px',
                  outline: 'none',
                  caretColor: accent,
                }}
                onFocus={e => e.target.style.borderColor = accent}
                onBlur={e => e.target.style.borderColor = isDictating ? accent : accentBorder}
              />
            </div>

            {/* Dictate button — speaks directly into the textarea */}
            <button
              onClick={toggleDictation}
              disabled={isLoading}
              className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 hover:scale-105 active:scale-95 shadow-md disabled:opacity-25 ${isDictating ? 'animate-pulse' : ''}`}
              style={{
                background: isDictating ? accent + '40' : accent + '20',
                border: `1px solid ${isDictating ? accent : accentBorder}`,
              }}
              title={isDictating ? 'Stop dictating' : 'Dictate — speak to type, tap Send when done'}
            >
              🎤
            </button>

            {/* Send button */}
            <button
              onClick={() => sendMessage(input)}
              disabled={isLoading || !input.trim()}
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 disabled:opacity-25 hover:scale-105 active:scale-95 shadow-md"
              style={{ background: `linear-gradient(135deg, ${C.blue}, ${C.blueDark})` }}
            >
              <svg className="w-4 h-4 text-white rotate-90" fill="currentColor" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>

          {/* Hint text */}
          <p className="text-center text-xs mt-2" style={{ color: C.textMuted }}>
            {isDictating
              ? 'Listening… tap 🎤 again or Send when done'
              : isMobile
              ? 'Tap Send to send'
              : 'Enter to send · Shift+Enter for new line'}
          </p>
        </div>

      </div>
    </div>
  )
}
