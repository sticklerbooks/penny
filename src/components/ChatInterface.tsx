'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import VoiceControls from './VoiceControls'

interface Message {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
}

interface ChatInterfaceProps {
  type: 'intake' | 'chat'
  onIntakeComplete?: () => void
}

export default function ChatInterface({ type, onIntakeComplete }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [ttsEnabled, setTtsEnabled] = useState(true)
  const [voicesLoaded, setVoicesLoaded] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasInitialized = useRef(false)

  // Load voices (browsers load them async)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const loadVoices = () => setVoicesLoaded(true)
    window.speechSynthesis.onvoiceschanged = loadVoices
    if (window.speechSynthesis.getVoices().length > 0) setVoicesLoaded(true)
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

  const speak = useCallback(
    (text: string) => {
      if (!ttsEnabled || typeof window === 'undefined') return
      window.speechSynthesis.cancel()

      // Break long responses into chunks (browsers cut off long utterances)
      const sentences = text.match(/[^.!?]+[.!?]+/g) || [text]
      const chunks: string[] = []
      let current = ''
      for (const s of sentences) {
        if ((current + s).length > 200) {
          if (current) chunks.push(current.trim())
          current = s
        } else {
          current += s
        }
      }
      if (current.trim()) chunks.push(current.trim())

      const voices = window.speechSynthesis.getVoices()
      const preferredVoice =
        voices.find((v) => v.name === 'Samantha') ||
        voices.find((v) => v.name.includes('Karen')) ||
        voices.find((v) => v.name.includes('Moira')) ||
        voices.find((v) => v.lang === 'en-US' && v.localService) ||
        voices.find((v) => v.lang.startsWith('en'))

      chunks.forEach((chunk, i) => {
        const utterance = new SpeechSynthesisUtterance(chunk)
        utterance.rate = 0.92
        utterance.pitch = 1.05
        if (preferredVoice) utterance.voice = preferredVoice
        // Small gap between chunks
        if (i > 0) utterance.rate = 0.92
        window.speechSynthesis.speak(utterance)
      })
    },
    [ttsEnabled, voicesLoaded] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const sendMessage = useCallback(
    async (text: string, isAutoStart = false) => {
      const content = isAutoStart ? '' : text.trim()
      if (!isAutoStart && !content) return
      if (isLoading) return

      if (!isAutoStart) {
        setMessages((prev) => [...prev, { role: 'user', content }])
        setInput('')
      }

      setIsLoading(true)
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '', streaming: true },
      ])

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            conversationId,
            isAutoStart,
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
                setMessages((prev) => {
                  const next = [...prev]
                  const last = next[next.length - 1]
                  if (last?.streaming) last.content = fullText
                  return next
                })
              }

              if (data.done) {
                setConversationId(data.conversationId)
                setMessages((prev) => {
                  const next = [...prev]
                  const last = next[next.length - 1]
                  if (last?.streaming) last.streaming = false
                  return next
                })
                speak(fullText)
                if (data.intakeComplete && onIntakeComplete) {
                  setTimeout(onIntakeComplete, 2000)
                }
              }
            } catch {
              // Skip malformed chunks
            }
          }
        }
      } catch (err) {
        console.error(err)
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (last?.streaming) {
            last.content = "I'm having a little trouble right now. Try again in a moment?"
            last.streaming = false
          }
          return next
        })
      }

      setIsLoading(false)
      textareaRef.current?.focus()
    },
    [conversationId, isLoading, speak, onIntakeComplete]
  )

  // Initialize: auto-start intake or load last chat
  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    if (type === 'intake') {
      sendMessage('', true)
    } else {
      // Load most recent conversation
      fetch('/api/conversation')
        .then((r) => r.json())
        .then((data) => {
          if (data?.messages?.length) {
            setConversationId(data.id)
            setMessages(
              data.messages.map((m: { role: 'user' | 'assistant'; content: string }) => ({
                role: m.role,
                content: m.content,
              }))
            )
          }
        })
        .catch(() => {})
    }
  }, [type, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const stopSpeaking = () => {
    if (typeof window !== 'undefined') {
      window.speechSynthesis.cancel()
    }
  }

  return (
    <div className="flex flex-col h-screen" style={{ background: '#FAF8F5' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 bg-white border-b border-stone-100 shadow-sm">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm shadow-sm"
            style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)' }}
          >
            P
          </div>
          <div>
            <h1 className="font-semibold text-stone-800 leading-tight">Penny</h1>
            <p className="text-xs text-stone-400">
              {type === 'intake' ? 'Getting to know you' : 'Your personal assistant'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={stopSpeaking}
            className="text-xs px-2.5 py-1.5 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
            title="Stop speaking"
          >
            ◼
          </button>
          <button
            onClick={() => setTtsEnabled(!ttsEnabled)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              ttsEnabled
                ? 'bg-amber-50 border-amber-200 text-amber-700'
                : 'bg-stone-100 border-stone-200 text-stone-400'
            }`}
          >
            {ttsEnabled ? '🔊 Voice on' : '🔇 Voice off'}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold flex-shrink-0 mb-0.5 shadow-sm"
                style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)' }}
              >
                P
              </div>
            )}

            <div
              className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                msg.role === 'assistant'
                  ? 'bg-white border border-stone-200 text-stone-700 rounded-bl-sm shadow-sm'
                  : 'text-white rounded-br-sm shadow-sm'
              }`}
              style={
                msg.role === 'user'
                  ? { background: 'linear-gradient(135deg, #F59E0B, #D97706)' }
                  : {}
              }
            >
              {msg.content ? (
                <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
              ) : msg.streaming ? (
                <span className="flex gap-1 items-center h-4 px-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-bounce"
                    style={{ animationDelay: '160ms' }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-bounce"
                    style={{ animationDelay: '320ms' }}
                  />
                </span>
              ) : null}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="bg-white border-t border-stone-100 px-4 py-3">
        <div className="flex items-end gap-2 max-w-2xl mx-auto">
          <VoiceControls
            onTranscript={(text) => setInput((prev) => (prev ? prev + ' ' + text : text))}
            disabled={isLoading}
          />
          <div className="flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isLoading ? 'Penny is thinking...' : 'Type or tap the mic...'}
              disabled={isLoading}
              rows={1}
              className="w-full resize-none rounded-xl border border-stone-200 px-4 py-2.5 text-sm text-stone-700 placeholder-stone-400 focus:outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-100 disabled:bg-stone-50 disabled:text-stone-400 transition-colors"
              style={{ minHeight: '44px', maxHeight: '128px' }}
            />
          </div>
          <button
            onClick={() => sendMessage(input)}
            disabled={isLoading || !input.trim()}
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 disabled:opacity-30 hover:scale-105 active:scale-95 shadow-sm"
            style={{ background: 'linear-gradient(135deg, #F59E0B, #D97706)' }}
          >
            <svg className="w-4 h-4 text-white rotate-90" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
        <p className="text-center text-xs text-stone-300 mt-2">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  )
}
