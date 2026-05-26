'use client'

import { useState, useRef, useCallback } from 'react'

interface VoiceControlsProps {
  onTranscript: (text: string) => void
  disabled?: boolean
}

export default function VoiceControls({ onTranscript, disabled }: VoiceControlsProps) {
  const [isListening, setIsListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const startListening = useCallback(() => {
    if (typeof window === 'undefined') return

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognition) {
      alert('Voice input is not supported in this browser. Please use Chrome.')
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript
      onTranscript(transcript)
    }

    recognition.onend = () => setIsListening(false)
    recognition.onerror = () => setIsListening(false)

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
  }, [onTranscript])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setIsListening(false)
  }, [])

  const toggle = () => {
    if (isListening) stopListening()
    else startListening()
  }

  return (
    <button
      onClick={toggle}
      disabled={disabled}
      title={isListening ? 'Tap to stop' : 'Tap to speak'}
      className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-all duration-200 ${
        isListening
          ? 'bg-red-500 text-white shadow-lg shadow-red-200 scale-110'
          : 'bg-stone-100 text-stone-500 hover:bg-stone-200'
      } disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {isListening ? (
        // Waveform icon when active
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 9h2v6H9zm4-2h2v10h-2zm-8 4h2v4H5zm12 0h2v4h-2z"/>
        </svg>
      ) : (
        // Mic icon when idle
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
        </svg>
      )}
    </button>
  )
}
