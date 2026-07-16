'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { BUCKET_ORDER, BUCKET_LABEL, type Bucket } from '@/lib/dashboard'

const C = {
  base: '#0B0C10',
  panel: '#1F2833',
  panelLight: '#263040',
  text: 'rgba(232,234,240,0.92)',
  textMuted: 'rgba(232,234,240,0.45)',
  overdue: '#EF5350',
  amber: '#FB8C00',
}

interface NoteLite {
  id: string
  kind: string
  body: string | null
  createdAt: string
  acknowledged: boolean
}
interface AgendaItem {
  id: string
  type: 'task' | 'event'
  title: string
  description: string
  date: string | null
  dateRaw: string | null
  dueTime: string | null
  bucket: Bucket
  overdue: boolean
  status: string | null
  priority: number | null
  projectId: string | null
  notes: NoteLite[]
  unacked: number
}
interface ProjectItem {
  id: string
  type: 'project'
  title: string
  description: string
  progress: number
  expectedDuration: string
  contingencies: string | null
  notes: NoteLite[]
  unacked: number
}
interface DashData {
  modality: { id: string; name: string; role: string; color: string; bgPath?: string }
  today: string
  agenda: AgendaItem[]
  projects: ProjectItem[]
}

type ActionKind = 'done' | 'moved' | 'stale' | 'contingent' | 'note'
type Selected = (AgendaItem | ProjectItem) & { type: 'task' | 'event' | 'project' }

const TYPE_GLYPH: Record<string, string> = { task: '✓', event: '📅', project: '📁' }

function fmtDate(d: string | null, raw: string | null): string {
  if (raw && !/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw // free-text like "morning"
  if (!d) return 'no date'
  const dt = new Date(d + 'T12:00:00')
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function ModalityAgenda({ modalityId }: { modalityId: string }) {
  const [data, setData] = useState<DashData | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await fetch(`/api/dashboard?modality=${modalityId}`)
    setData(await r.json())
  }, [modalityId])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const accent = data?.modality.color ?? '#FF69B4'

  // Group agenda items into the fixed bucket order; undated naturally sinks last.
  const grouped: Record<Bucket, AgendaItem[]> = {
    overdue: [], today: [], week: [], future: [], undated: [],
  }
  data?.agenda.forEach((it) => grouped[it.bucket].push(it))

  return (
    <div style={{ minHeight: '100dvh', background: C.base, color: C.text }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '1.1rem 1rem 6rem' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.25rem' }}>
          <Link href="/dashboard" style={{ color: C.textMuted, textDecoration: 'none', fontSize: '1.4rem' }}>‹</Link>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: '1.3rem', fontWeight: 600, color: accent }}>
              {data?.modality.name ?? '…'}
            </h1>
            <div style={{ fontSize: '0.75rem', color: C.textMuted }}>{data?.modality.role}</div>
          </div>
          <Link
            href={`/chat?modality=${modalityId}`}
            style={{
              fontSize: '0.8rem', textDecoration: 'none', color: C.text,
              border: `1px solid ${accent}66`, borderRadius: 999, padding: '0.4rem 0.85rem',
              background: `${accent}1A`,
            }}
          >
            Talk to her →
          </Link>
        </div>

        {!data && <div style={{ color: C.textMuted }}>Loading…</div>}

        {/* Projects band */}
        {data && data.projects.length > 0 && (
          <section style={{ marginBottom: '1.5rem' }}>
            <SectionLabel>Active projects</SectionLabel>
            {data.projects.map((p) => (
              <Row key={p.id} accent={accent} unacked={p.unacked} onClick={() => setSelected({ ...p, type: 'project' })}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{TYPE_GLYPH.project}</span>
                  <span style={{ flex: 1 }}>{p.title}</span>
                  <span style={{ fontSize: '0.7rem', color: C.textMuted }}>{p.expectedDuration}</span>
                </div>
                <div style={{ marginTop: 6, height: 5, background: C.panelLight, borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${p.progress * 10}%`, height: '100%', background: accent }} />
                </div>
              </Row>
            ))}
          </section>
        )}

        {/* Agenda buckets */}
        {data && BUCKET_ORDER.map((b) => {
          const items = grouped[b]
          if (items.length === 0) return null
          const isOverdue = b === 'overdue'
          return (
            <section key={b} style={{ marginBottom: '1.25rem' }}>
              <SectionLabel color={isOverdue ? C.overdue : undefined}>{BUCKET_LABEL[b]}</SectionLabel>
              {items.map((it) => (
                <Row key={it.id} accent={accent} unacked={it.unacked} onClick={() => setSelected({ ...it })}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: it.type === 'event' ? C.amber : accent }}>{TYPE_GLYPH[it.type]}</span>
                    <span style={{ flex: 1 }}>{it.title}</span>
                    {it.priority != null && it.priority >= 3 && (
                      <span style={{ fontSize: '0.62rem', color: C.amber }}>p{it.priority}</span>
                    )}
                    <span style={{ fontSize: '0.7rem', color: isOverdue ? C.overdue : C.textMuted }}>
                      {it.overdue ? '⚠ ' : ''}{fmtDate(it.date, it.dateRaw)}{it.dueTime ? ` · ${it.dueTime}` : ''}
                    </span>
                  </div>
                </Row>
              ))}
            </section>
          )
        })}

        {data && data.agenda.length === 0 && data.projects.length === 0 && (
          <div style={{ color: C.textMuted, marginTop: '2rem', textAlign: 'center' }}>
            Nothing on her plate right now.
          </div>
        )}
      </div>

      {selected && (
        <ItemDrawer
          item={selected}
          accent={accent}
          busy={busy}
          onClose={() => setSelected(null)}
          onAction={async (kind, body, newDueDate) => {
            setBusy(true)
            try {
              const res = await fetch('/api/dashboard/action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ itemType: selected.type, itemId: selected.id, kind, body, newDueDate }),
              })
              if (!res.ok) {
                const e = await res.json().catch(() => ({}))
                alert(e.error || 'Something went wrong.')
                return
              }
              setSelected(null)
              await load()
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </div>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{
      fontSize: '0.7rem', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: color ?? C.textMuted, marginBottom: 6, fontWeight: 600,
    }}>
      {children}
    </div>
  )
}

function Row({
  children, accent, unacked, onClick,
}: { children: React.ReactNode; accent: string; unacked: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        background: C.panel, border: 'none', borderLeft: `3px solid ${accent}`,
        borderRadius: 8, padding: '0.6rem 0.75rem', marginBottom: 6, color: C.text,
        position: 'relative',
      }}
    >
      {children}
      {unacked > 0 && (
        <span style={{
          position: 'absolute', top: 6, right: 6, fontSize: '0.6rem',
          background: C.amber, color: '#000', borderRadius: 999, padding: '0 5px', fontWeight: 700,
        }}>
          ⚑{unacked}
        </span>
      )}
    </button>
  )
}

function ItemDrawer({
  item, accent, busy, onClose, onAction,
}: {
  item: Selected
  accent: string
  busy: boolean
  onClose: () => void
  onAction: (kind: ActionKind, body?: string, newDueDate?: string) => void
}) {
  const [mode, setMode] = useState<ActionKind | null>(null)
  const [body, setBody] = useState('')
  const [date, setDate] = useState('')

  const isProject = item.type === 'project'
  const needsBody = mode === 'contingent' || mode === 'note'
  const canSubmit =
    mode === 'done' ? true :
    mode === 'moved' ? !!date :
    mode === 'stale' ? true :
    needsBody ? !!body.trim() : false

  const submit = () => {
    if (!mode) return
    onAction(mode, body.trim() || undefined, mode === 'moved' ? date : undefined)
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 760, margin: '0 auto', background: C.panel,
          borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '1.1rem 1.1rem 1.6rem',
          maxHeight: '85dvh', overflowY: 'auto', borderTop: `2px solid ${accent}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>{item.title}</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: '1.2rem', cursor: 'pointer' }}>✕</button>
        </div>
        {item.description && (
          <p style={{ color: C.textMuted, fontSize: '0.85rem', margin: '0.4rem 0 0' }}>{item.description}</p>
        )}

        {/* History of Adam's notes on this item */}
        {item.notes.length > 0 && (
          <div style={{ marginTop: '0.9rem' }}>
            <SectionLabel>Your notes on this</SectionLabel>
            {item.notes.map((n) => (
              <div key={n.id} style={{ fontSize: '0.8rem', marginBottom: 5, color: C.text }}>
                <span style={{ color: accent, fontWeight: 600 }}>{n.kind}</span>
                {n.body ? ` — ${n.body}` : ''}
                {!n.acknowledged && <span style={{ color: C.amber }}> (awaiting her)</span>}
                <span style={{ color: C.textMuted }}> · {new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
              </div>
            ))}
          </div>
        )}

        {/* Action picker */}
        <div style={{ marginTop: '1.1rem' }}>
          <SectionLabel>Tell her</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <ActionChip label="✓ Done" active={mode === 'done'} onClick={() => setMode('done')} accent={accent} />
            {!isProject && <ActionChip label="→ Move" active={mode === 'moved'} onClick={() => setMode('moved')} accent={accent} />}
            <ActionChip label="⚑ Stale" active={mode === 'stale'} onClick={() => setMode('stale')} accent={accent} />
            {!isProject && <ActionChip label="⛔ Contingent" active={mode === 'contingent'} onClick={() => setMode('contingent')} accent={accent} />}
            <ActionChip label="✎ Note" active={mode === 'note'} onClick={() => setMode('note')} accent={accent} />
          </div>
        </div>

        {/* Mode-specific input */}
        {mode === 'moved' && (
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={inputStyle} />
        )}
        {(mode === 'stale' || mode === 'contingent' || mode === 'note') && (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              mode === 'contingent' ? 'What is it contingent on? (required)' :
              mode === 'note' ? 'Your note to her (required)' :
              'Why is it stale? (optional)'
            }
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        )}
        {mode === 'done' && (
          <p style={{ fontSize: '0.78rem', color: C.textMuted, marginTop: 10 }}>
            Marks it complete now. It drops off her plate immediately and she&apos;ll credit it in the weekly review.
          </p>
        )}

        {mode && (
          <button
            onClick={submit}
            disabled={!canSubmit || busy}
            style={{
              marginTop: 12, width: '100%', padding: '0.7rem', borderRadius: 10, border: 'none',
              background: canSubmit && !busy ? accent : C.panelLight,
              color: canSubmit && !busy ? '#000' : C.textMuted, fontWeight: 600, cursor: canSubmit && !busy ? 'pointer' : 'default',
            }}
          >
            {busy ? 'Sending…' : 'Send to her'}
          </button>
        )}
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  marginTop: 10, width: '100%', boxSizing: 'border-box', background: C.base,
  border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '0.6rem',
  color: C.text, fontSize: '0.9rem',
}

function ActionChip({
  label, active, onClick, accent,
}: { label: string; active: boolean; onClick: () => void; accent: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: '0.8rem', padding: '0.4rem 0.7rem', borderRadius: 999, cursor: 'pointer',
        border: `1px solid ${active ? accent : 'rgba(255,255,255,0.15)'}`,
        background: active ? `${accent}26` : 'transparent',
        color: active ? accent : C.text,
      }}
    >
      {label}
    </button>
  )
}
