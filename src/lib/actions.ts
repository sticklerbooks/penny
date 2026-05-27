// Parses action markers from Penny's responses and executes them.
// Markers are XML-like tags Penny embeds in her replies; the user never sees them.

import { prisma } from './db'

export type PennyAction =
  | { kind: 'create_task'; title: string; due?: string; priority?: number; category?: string; clientId?: string; description?: string }
  | { kind: 'update_task'; id: string; status?: string; priority?: number; due?: string; clientId?: string; pennyNotes?: string }
  | { kind: 'delete_task'; id: string }
  | { kind: 'create_memory'; category: string; content: string; importance?: number }
  | { kind: 'update_memory'; id: string; content?: string; category?: string; importance?: number; archived?: boolean }
  | { kind: 'delete_memory'; id: string }
  | { kind: 'next_session_note'; content: string }
  | { kind: 'resolve_note'; id: string }
  | { kind: 'delete_note'; id: string }
  | { kind: 'create_client'; name: string; contactName?: string; contactSecondary?: string; phone?: string; email?: string; businessStructure?: string; status?: string; services?: string; grossRevenue?: number; billingStatus?: string; notes?: string }
  | { kind: 'update_client'; id: string; name?: string; contactName?: string; contactSecondary?: string; phone?: string; email?: string; businessStructure?: string; status?: string; services?: string; grossRevenue?: number; billingStatus?: string; notes?: string }
  | { kind: 'delete_client'; id: string }

// Regex patterns for each marker type
const TASK_RE = /<task\s+([^/>]*)\/?>(?:([\s\S]*?)<\/task>)?/gi
const UPDATE_TASK_RE = /<update_task\s+([^/>]*)\/?>/gi
const DELETE_TASK_RE = /<delete_task\s+id=["']([^"']+)["']\s*\/?>/gi
const MEMORY_RE = /<memory\s+([^>]*)>([\s\S]*?)<\/memory>/gi
const UPDATE_MEMORY_RE = /<update_memory\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/update_memory>)/gi
const DELETE_MEMORY_RE = /<delete_memory\s+id=["']([^"']+)["']\s*\/?>/gi
const NEXT_SESSION_RE = /<next_session>([\s\S]*?)<\/next_session>/gi
const RESOLVE_NOTE_RE = /<resolve_note\s+id=["']([^"']+)["']\s*\/?>/gi
const DELETE_NOTE_RE = /<delete_note\s+id=["']([^"']+)["']\s*\/?>/gi
const CLIENT_RE = /<client\s+([^>]*)>(?:([\s\S]*?))<\/client>/gi
const UPDATE_CLIENT_RE = /<update_client\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/update_client>)/gi
const DELETE_CLIENT_RE = /<delete_client\s+id=["']([^"']+)["']\s*\/?>/gi

// Parse XML attributes from a string like: title="foo" due="2026-06-01" priority="9"
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)\s*=\s*["']([^"']*)["']/g
  let m
  while ((m = re.exec(s))) out[m[1]] = m[2]
  return out
}

export function parseActions(text: string): { actions: PennyAction[]; cleanText: string } {
  const actions: PennyAction[] = []

  // create_task
  for (const m of text.matchAll(TASK_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.title) continue
    actions.push({
      kind: 'create_task',
      title: attrs.title,
      due: attrs.due,
      priority: attrs.priority ? parseInt(attrs.priority) : undefined,
      category: attrs.category,
      clientId: attrs.client_id,
      description: (m[2] || attrs.description || '').trim() || undefined,
    })
  }

  // update_task
  for (const m of text.matchAll(UPDATE_TASK_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    actions.push({
      kind: 'update_task',
      id: attrs.id,
      status: attrs.status,
      priority: attrs.priority ? parseInt(attrs.priority) : undefined,
      due: attrs.due,
      clientId: attrs.client_id,
      pennyNotes: attrs.notes,
    })
  }

  // delete_task
  for (const m of text.matchAll(DELETE_TASK_RE)) {
    actions.push({ kind: 'delete_task', id: m[1] })
  }

  // create_memory
  for (const m of text.matchAll(MEMORY_RE)) {
    const attrs = parseAttrs(m[1])
    const content = m[2].trim()
    if (!content) continue
    actions.push({
      kind: 'create_memory',
      category: attrs.category || 'personal',
      content,
      importance: attrs.importance ? parseInt(attrs.importance) : 6,
    })
  }

  // update_memory
  for (const m of text.matchAll(UPDATE_MEMORY_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    const bodyContent = (m[2] || '').trim()
    actions.push({
      kind: 'update_memory',
      id: attrs.id,
      content: bodyContent || attrs.content,
      category: attrs.category,
      importance: attrs.importance ? parseInt(attrs.importance) : undefined,
      archived: attrs.archived !== undefined ? attrs.archived === 'true' : undefined,
    })
  }

  // delete_memory
  for (const m of text.matchAll(DELETE_MEMORY_RE)) {
    actions.push({ kind: 'delete_memory', id: m[1] })
  }

  // next_session
  for (const m of text.matchAll(NEXT_SESSION_RE)) {
    const content = m[1].trim()
    if (!content) continue
    actions.push({ kind: 'next_session_note', content })
  }

  // resolve_note
  for (const m of text.matchAll(RESOLVE_NOTE_RE)) {
    actions.push({ kind: 'resolve_note', id: m[1] })
  }

  // delete_note
  for (const m of text.matchAll(DELETE_NOTE_RE)) {
    actions.push({ kind: 'delete_note', id: m[1] })
  }

  // create_client
  for (const m of text.matchAll(CLIENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.name) continue
    actions.push({
      kind: 'create_client',
      name: attrs.name,
      contactName: attrs.contact_name,
      contactSecondary: attrs.contact_secondary,
      phone: attrs.phone,
      email: attrs.email,
      businessStructure: attrs.business_structure,
      status: attrs.status,
      services: attrs.services,
      grossRevenue: attrs.gross_revenue ? parseFloat(attrs.gross_revenue) : undefined,
      billingStatus: attrs.billing_status,
      notes: (m[2] || '').trim() || undefined,
    })
  }

  // update_client
  for (const m of text.matchAll(UPDATE_CLIENT_RE)) {
    const attrs = parseAttrs(m[1])
    if (!attrs.id) continue
    const bodyNotes = (m[2] || '').trim()
    actions.push({
      kind: 'update_client',
      id: attrs.id,
      name: attrs.name,
      contactName: attrs.contact_name,
      contactSecondary: attrs.contact_secondary,
      phone: attrs.phone,
      email: attrs.email,
      businessStructure: attrs.business_structure,
      status: attrs.status,
      services: attrs.services,
      grossRevenue: attrs.gross_revenue ? parseFloat(attrs.gross_revenue) : undefined,
      billingStatus: attrs.billing_status,
      notes: bodyNotes || undefined,
    })
  }

  // delete_client
  for (const m of text.matchAll(DELETE_CLIENT_RE)) {
    actions.push({ kind: 'delete_client', id: m[1] })
  }

  // Strip all marker tags from the displayed/saved text
  const cleanText = text
    .replace(TASK_RE, '')
    .replace(UPDATE_TASK_RE, '')
    .replace(DELETE_TASK_RE, '')
    .replace(MEMORY_RE, '')
    .replace(UPDATE_MEMORY_RE, '')
    .replace(DELETE_MEMORY_RE, '')
    .replace(NEXT_SESSION_RE, '')
    .replace(RESOLVE_NOTE_RE, '')
    .replace(DELETE_NOTE_RE, '')
    .replace(CLIENT_RE, '')
    .replace(UPDATE_CLIENT_RE, '')
    .replace(DELETE_CLIENT_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { actions, cleanText }
}

export async function executeActions(
  profileId: string,
  actions: PennyAction[]
): Promise<void> {
  for (const action of actions) {
    try {
      switch (action.kind) {
        case 'create_task':
          await prisma.task.create({
            data: {
              profileId,
              title: action.title,
              description: action.description ?? null,
              dueDate: action.due ? new Date(action.due) : null,
              priority: action.priority ?? 5,
              category: action.category ?? null,
              clientId: action.clientId ?? null,
            },
          })
          break

        case 'update_task': {
          const data: Record<string, unknown> = {}
          if (action.status) data.status = action.status
          if (action.priority !== undefined) data.priority = action.priority
          if (action.due) data.dueDate = new Date(action.due)
          if (action.clientId !== undefined) data.clientId = action.clientId || null
          if (action.pennyNotes) data.pennyNotes = action.pennyNotes
          if (Object.keys(data).length === 0) break
          await prisma.task.update({ where: { id: action.id }, data })
          break
        }

        case 'delete_task':
          await prisma.task.delete({ where: { id: action.id } })
          break

        case 'create_memory':
          await prisma.memory.create({
            data: {
              profileId,
              category: action.category,
              content: action.content,
              importance: action.importance ?? 6,
            },
          })
          break

        case 'update_memory': {
          const data: Record<string, unknown> = {}
          if (action.content) data.content = action.content
          if (action.category) data.category = action.category
          if (action.importance !== undefined) data.importance = action.importance
          if (action.archived !== undefined) data.archived = action.archived
          if (Object.keys(data).length === 0) break
          await prisma.memory.update({ where: { id: action.id }, data })
          break
        }

        case 'delete_memory':
          await prisma.memory.delete({ where: { id: action.id } })
          break

        case 'next_session_note':
          await prisma.nextSessionNote.create({
            data: { profileId, content: action.content },
          })
          break

        case 'resolve_note':
          await prisma.nextSessionNote.update({
            where: { id: action.id },
            data: { resolved: true },
          })
          break

        case 'delete_note':
          await prisma.nextSessionNote.delete({ where: { id: action.id } })
          break

        case 'create_client':
          await prisma.client.create({
            data: {
              profileId,
              name: action.name,
              contactName: action.contactName ?? null,
              contactSecondary: action.contactSecondary ?? null,
              phone: action.phone ?? null,
              email: action.email ?? null,
              businessStructure: action.businessStructure ?? null,
              status: action.status ?? 'prospect',
              services: action.services ?? null,
              grossRevenue: action.grossRevenue ?? null,
              billingStatus: action.billingStatus ?? null,
              notes: action.notes ?? null,
            },
          })
          break

        case 'update_client': {
          const data: Record<string, unknown> = {}
          if (action.name) data.name = action.name
          if (action.contactName !== undefined) data.contactName = action.contactName
          if (action.contactSecondary !== undefined) data.contactSecondary = action.contactSecondary
          if (action.phone !== undefined) data.phone = action.phone
          if (action.email !== undefined) data.email = action.email
          if (action.businessStructure !== undefined) data.businessStructure = action.businessStructure
          if (action.status) data.status = action.status
          if (action.services !== undefined) data.services = action.services
          if (action.grossRevenue !== undefined) data.grossRevenue = action.grossRevenue
          if (action.billingStatus !== undefined) data.billingStatus = action.billingStatus
          if (action.notes !== undefined) data.notes = action.notes
          if (Object.keys(data).length === 0) break
          await prisma.client.update({ where: { id: action.id }, data })
          break
        }

        case 'delete_client':
          await prisma.client.delete({ where: { id: action.id } })
          break
      }
    } catch (e) {
      // Log but don't crash — one bad action shouldn't kill the response
      console.error(`Failed to execute ${action.kind}:`, e)
    }
  }
}
