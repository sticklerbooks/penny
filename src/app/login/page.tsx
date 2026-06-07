'use client'

import { useState } from 'react'

export default function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        setError('Incorrect password')
        setLoading(false)
      }
    } catch {
      setError('Something went wrong — try again')
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1a1a1f',
        fontFamily: 'system-ui, sans-serif',
        padding: 24,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 340,
          background: '#26262e',
          borderRadius: 16,
          padding: 32,
          boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
          textAlign: 'center',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/penny-avatar.png"
          alt="Penny"
          width={72}
          height={72}
          style={{ borderRadius: '50%', marginBottom: 16, border: '2px solid #FF69B4' }}
        />
        <h1 style={{ color: '#fff', fontSize: 20, margin: '0 0 4px' }}>Welcome back</h1>
        <p style={{ color: '#9a9aa5', fontSize: 13, margin: '0 0 24px' }}>
          Enter your password to continue
        </p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          autoComplete="current-password"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '12px 14px',
            borderRadius: 10,
            border: error ? '1px solid #ef5350' : '1px solid #3a3a44',
            background: '#1a1a1f',
            color: '#fff',
            fontSize: 15,
            outline: 'none',
            marginBottom: 12,
          }}
        />

        {error && (
          <p style={{ color: '#ef5350', fontSize: 13, margin: '0 0 12px' }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            width: '100%',
            padding: '12px 14px',
            borderRadius: 10,
            border: 'none',
            background: loading || !password ? '#7a4660' : '#FF69B4',
            color: '#fff',
            fontSize: 15,
            fontWeight: 600,
            cursor: loading || !password ? 'default' : 'pointer',
          }}
        >
          {loading ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
