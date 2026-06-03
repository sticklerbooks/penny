'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import CallMode from './CallMode'
import { MODALITIES, getModality } from '@/lib/modalities'

// ─── Palette ────────────────────────────────────────────────────────────────
const C = {
  base:        '#0B0C10',
  panel:       '#1F2833',
  panelLight:  '#263040',
  pink:        '#FF69B4',   // Penny's color
  pinkDark:    '#d4539a',
  blue:        '#4B9CD3',   // User's color
  blueDark:    '#3a7dab',
  text:        'rgba(232,234,240,0.92)',
  textMuted:   'rgba(232,234,240,0.45)',
  border:      'rgba(255,105,180,0.18)',   // Pink-tinted border
  borderBlue:  'rgba(75,156,211,0.18)',
}

// ─── Streaming marker cleanup ────────────────────────────────────────────────
const BLOCK_TAGS = [
  'update_user_profile','update_self_notes','memory','update_memory',
  'client','update_client','schedule_sms','next_session',
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

// ─── Types ───────────────────────────────────────────────────────────────────
interface Message {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
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
  const [showSwitcher, setShowSwitcher]       = useState(false)

  const messagesEndRef  = useRef<HTMLDivElement>(null)
  const textareaRef     = useRef<HTMLTextAreaElement>(null)
  const hasInitialized  = useRef(false)


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


  const sendMessage = useCallback(async (text: string, isAutoStart = false, switchTo?: string) => {
    const content = isAutoStart ? '' : text.trim()
    if (!isAutoStart && !switchTo && !content) return
    if (isLoading) return

    // Show the user's message bubble (not for auto-start or silent switches)
    if (!isAutoStart && content) {
      setMessages(prev => [...prev, { role: 'user', content }])
      setInput('')
    }

    setIsLoading(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content, conversationId, isAutoStart, switchTo }),
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
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last?.streaming) last.content = stripStreamingMarkers(fullText)
                return next
              })
            }
            if (data.done) {
              setConversationId(data.conversationId)
              const finalText = data.cleanText ?? fullText
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last?.streaming) { last.content = finalText; last.streaming = false }
                return next
              })
              if (data.activeModality) setActiveModality(data.activeModality)
              if (data.intakeComplete && onIntakeComplete) setTimeout(onIntakeComplete, 2000)
              if (data.sessionComplete) {
                setConversationId(null)
                setActiveModality('pa') // fresh session starts as the Personal Assistant
                setMessages(prev => [...prev, { role: 'assistant', content: '— session closed —', streaming: false }])
              }
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      console.error(err)
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
      fetch('/api/conversation')
        .then(r => r.json())
        .then(data => {
          if (data?.messages?.length) {
            setConversationId(data.id)
            if (data.activeModality) setActiveModality(data.activeModality)
            setMessages(data.messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
              role: m.role, content: m.content,
            })))
          }
        })
        .catch(() => {})
    }
  }, [type, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
  }

  // ─── Penny avatar ──────────────────────────────────────────────────────────
  const PennyAvatar = ({ size = 'sm' }: { size?: 'sm' | 'lg' }) => {
    const dim = size === 'lg' ? 'w-10 h-10' : 'w-7 h-7'
    const txt = size === 'lg' ? 'text-base' : 'text-xs'
    return avatarImgError ? (
      <div
        className={`${dim} rounded-full flex items-center justify-center text-white font-semibold ${txt} flex-shrink-0 shadow-md`}
        style={{ background: `linear-gradient(135deg, ${C.pink}, ${C.pinkDark})` }}
      >P</div>
    ) : (
      <img
        src="/penny-avatar.png"
        onError={() => setAvatarImgError(true)}
        className={`${dim} rounded-full object-cover flex-shrink-0 shadow-md`}
        alt="Penny"
      />
    )
  }

  // ─── Thinking indicator ────────────────────────────────────────────────────
  const ThinkingIndicator = () =>
    thinkingImgError ? (
      <span className="flex gap-1.5 items-center h-5 px-1">
        {[0, 160, 320].map(delay => (
          <span key={delay} className="w-2 h-2 rounded-full animate-bounce"
            style={{ background: C.pink, animationDelay: `${delay}ms` }} />
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

  // ─── Call mode helpers ─────────────────────────────────────────────────────
  const addCallMessage = useCallback((role: 'user' | 'assistant', content: string) => {
    setMessages(prev => [...prev, { role, content }])
  }, [])

  // ─── Modality switch (from the header dropdown) ─────────────────────────────
  const switchModality = useCallback((id: string) => {
    setShowSwitcher(false)
    if (id === activeModality || isLoading) return
    setActiveModality(id)
    sendMessage('', false, id)
  }, [activeModality, isLoading, sendMessage])

  const current = getModality(activeModality)

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
        />
      )}

      {/* Faded background image — absolute (not fixed) so iOS Safari renders it correctly */}
      <div className="absolute inset-0 z-0 pointer-events-none select-none" aria-hidden>
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'url(/penny-bg.png)',
          backgroundSize: '65%',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          opacity: 0.07,
          filter: 'blur(4px) saturate(0.5)',
        }} />
      </div>

      {/* Main layout */}
      <div className="relative z-10 flex flex-col h-full">

        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5 shadow-xl flex-shrink-0"
          style={{ background: C.panel, borderBottom: `1px solid ${C.border}` }}
        >
          <div className="flex items-center gap-3">
            <PennyAvatar size="lg" />
            <div>
              <h1 className="font-semibold leading-tight" style={{ color: C.text }}>Penny</h1>
              <p className="text-xs" style={{ color: C.textMuted }}>
                {type === 'intake' ? 'Getting to know you' : `${current.emoji} ${current.displayName}`}
              </p>
            </div>
          </div>

          {/* Modality switcher */}
          {type !== 'intake' && (
            <div className="relative">
              <button
                onClick={() => setShowSwitcher(s => !s)}
                disabled={isLoading}
                className="text-sm px-3 py-1.5 rounded-full border transition-all hover:scale-105 active:scale-95 disabled:opacity-40"
                style={{ background: 'rgba(255,105,180,0.12)', borderColor: C.border, color: C.pink }}
                title="Switch modality"
              >
                {current.emoji} ▾
              </button>
              {showSwitcher && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSwitcher(false)} />
                  <div
                    className="absolute right-0 mt-2 z-50 rounded-xl overflow-hidden shadow-2xl min-w-[200px]"
                    style={{ background: C.panelLight, border: `1px solid ${C.border}` }}
                  >
                    {MODALITIES.map(m => (
                      <button
                        key={m.id}
                        onClick={() => switchModality(m.id)}
                        className="w-full text-left px-4 py-2.5 text-sm flex items-center gap-2 transition-colors hover:bg-white/5"
                        style={{
                          color: m.id === activeModality ? C.pink : C.text,
                          background: m.id === activeModality ? 'rgba(255,105,180,0.08)' : 'transparent',
                        }}
                      >
                        <span>{m.emoji}</span>
                        <span>{m.displayName}</span>
                        {m.id === activeModality && <span className="ml-auto text-xs">●</span>}
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
            // Session divider
            if (msg.content === '— session closed —') {
              return (
                <div key={i} className="flex items-center gap-3 py-2 px-2">
                  <div className="flex-1 h-px" style={{ background: C.border }} />
                  <span className="text-xs whitespace-nowrap" style={{ color: C.textMuted }}>session closed</span>
                  <div className="flex-1 h-px" style={{ background: C.border }} />
                </div>
              )
            }

            const isAssistant = msg.role === 'assistant'
            return (
              <div key={i} className={`flex items-end gap-2 ${isAssistant ? 'justify-start' : 'justify-end'}`}>
                {isAssistant && <div className="mb-0.5 flex-shrink-0"><PennyAvatar /></div>}

                <div
                  className="max-w-[80%] shadow-md"
                  style={isAssistant ? {
                    background: C.panel,
                    border: `1px solid ${C.border}`,
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
            {/* Call button — in the input bar so it's always thumb-reachable */}
            <button
              onClick={() => setInCall(true)}
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 hover:scale-105 active:scale-95 shadow-md"
              style={{ background: 'rgba(255,105,180,0.15)', border: `1px solid ${C.border}` }}
              title="Start a voice call with Penny"
            >📞</button>
            <div className="flex-1">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isLoading ? 'Penny is thinking…' : 'Type or tap the mic…'}
                disabled={isLoading}
                rows={1}
                className="w-full resize-none rounded-xl px-4 py-2.5 text-sm transition-colors"
                style={{
                  background: C.base,
                  border: `1px solid ${C.border}`,
                  color: C.text,
                  minHeight: '44px',
                  maxHeight: '128px',
                  outline: 'none',
                  caretColor: C.blue,
                }}
                onFocus={e => e.target.style.borderColor = C.blue}
                onBlur={e => e.target.style.borderColor = C.borderBlue}
              />
            </div>
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
          <p className="text-center text-xs mt-2" style={{ color: C.textMuted }}>
            Enter to send · Shift+Enter for new line
          </p>
        </div>

      </div>
    </div>
  )
}
