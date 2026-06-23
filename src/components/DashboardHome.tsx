'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { MODALITIES } from '@/lib/modalities'

const C = {
  base: '#0B0C10',
  text: 'rgba(232,234,240,0.92)',
  textMuted: 'rgba(232,234,240,0.45)',
}

export default function DashboardHome() {
  // Opening the dashboard wraps any session Adam abandoned mid-stream. Fire and
  // forget — never block the grid on it.
  useEffect(() => {
    fetch('/api/wrap-abandoned', { method: 'POST' }).catch(() => {})
  }, [])

  const selves = MODALITIES.filter((m) => !m.disabled)

  return (
    <div style={{ minHeight: '100dvh', background: C.base, color: C.text, padding: '2rem 1.25rem 4rem' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <header style={{ marginBottom: '1.75rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>Your team</h1>
          <p style={{ color: C.textMuted, margin: '0.35rem 0 0', fontSize: '0.9rem' }}>
            Tap a self to see everything she&apos;s holding — and tell her what&apos;s done, moved, or stale.
          </p>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: '0.9rem',
          }}
        >
          {selves.map((m) => (
            <Link
              key={m.id}
              href={`/dashboard/${m.id}`}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                aspectRatio: '3 / 4',
                borderRadius: 16,
                overflow: 'hidden',
                textDecoration: 'none',
                color: C.text,
                border: `1px solid ${m.color}55`,
                boxShadow: `0 1px 0 ${m.color}22`,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundImage: `url(${m.bgPath || m.avatarPath})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center top',
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: `linear-gradient(to top, ${C.base} 6%, rgba(11,12,16,0.15) 55%, rgba(11,12,16,0.05) 100%)`,
                }}
              />
              <div style={{ position: 'relative', padding: '0.7rem 0.8rem' }}>
                <div style={{ fontWeight: 600, fontSize: '1rem', color: m.color }}>
                  {m.emoji} {m.displayName}
                </div>
                <div style={{ fontSize: '0.72rem', color: C.textMuted, marginTop: 2 }}>{m.role}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
