// The Item-world tool surface: Item CRUD (FSM-gated via item-store) plus two
// review-only control tools (mark_discussed, finish_phase). Used by BOTH the
// Review loop (which grants all 7) and normal chat (which grants the 5 CRUD
// tools — see tools.ts's ITEM_TOOLS — and never sets reviewSessionId, so the
// mark_discussed bookkeeping below is simply skipped). Status writes are
// impossible to force illegally: set_item_status routes through
// decideStatusChange and returns the rejection reason to the model.

import type Anthropic from '@anthropic-ai/sdk'
import type { ToolContext } from '@/lib/tool-executor'
import { prisma } from '@/lib/db'
import { resolveModality } from '@/lib/modalities'
import { ITEM_TYPES } from './fsm'
import {
  createItem,
  setItemStatus,
  updateItemFields,
  appendItemNote,
  searchItems,
  type ItemRow,
} from './item-store'
import { markDiscussed } from '@/lib/review/session'
import type { GuardViolation } from '@/lib/review/guards'

// ctx for the Item tools — the legacy ToolContext plus an OPTIONAL review session
// (only set inside an active Review; normal chat omits it), a mutable control flag
// the finish_phase tool sets (read by the runner after the loop), and the exit
// guard the engine evaluates before it will let a phase finish.
export interface ReviewToolContext extends ToolContext {
  reviewSessionId?: string
  finishRequested?: boolean
  /** The phase's exit predicate, evaluated against the live DB. finish_phase calls
   *  it and refuses to finish while it returns any violations. */
  exitCheck?: () => Promise<GuardViolation[]>
}

// Canonicalize a target (modality id, display name, or 'pa') to its stable id —
// the model often passes a display name ("Margot") instead of the id
// ("bookkeeping"); resolveModality maps either. Falls back to the creating
// modality, then 'pa'. See CLAUDE.md's modality id-vs-display-name convention.
function canonTarget(raw: unknown, fallback: string): string {
  const resolved = typeof raw === 'string' && raw.trim() ? resolveModality(raw)?.id : undefined
  return resolved ?? (resolveModality(fallback)?.id ?? fallback)
}

type Tool = Anthropic.Tool

export const REVIEW_TOOL_SCHEMAS: Tool[] = [
  {
    name: 'search_items',
    description: 'List the items in scope (optionally filtered). Use to check what already exists before creating, to see a self\'s load, and — with projectId — to see what\'s inside a project (its folder of items).',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Filter to items aimed at this target (a modality id or "pa").' },
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[], description: 'Filter to one item type.' },
        projectId: { type: 'string', description: 'Filter to the items inside this project (its folder contents).' },
      },
    },
  },
  {
    name: 'update_project',
    description: 'Update a project (the folder itself): its progress (0–10), description, term, or contingency. Use in the projects phase to nudge a project forward.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        progress: { type: 'number', description: '0–10 (10 = complete).' },
        description: { type: 'string' },
        termType: { type: 'string', enum: ['short', 'medium', 'long'] },
        contingencies: { type: 'string', description: 'Why this can\'t move right now, e.g. "needs Jessica home". Pass "" to clear.' },
        contingencyUntil: { type: 'string', description: 'A real recheck date, YYYY-MM-DD. While in the future, this project is skipped entirely in review. Pass "" to clear.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project — the folder for a multi-session goal or a recurring commitment. In the projects phase, this is how you upgrade an item that turned out to be recurring (rather than a one-off) into something that can hold its own instances.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        description: { type: 'string', description: 'What this project is and what it accomplishes.' },
        expectedDuration: { type: 'string', description: '"next few weeks", "sometime this year", "ongoing", etc.' },
        assignedModality: { type: 'string', description: 'Modality responsible for this project.' },
        progress: { type: 'integer', description: '0–10. 0 = not started, 10 = complete. Defaults to 0.' },
        contingencies: { type: 'string', description: 'Why this can\'t move right now: "only workable in summer", "needs Jessica home", etc.' },
        contingencyUntil: { type: 'string', description: 'A real recheck date, YYYY-MM-DD, if known. While in the future, this project is skipped entirely in review.' },
      },
      required: ['name', 'description', 'expectedDuration', 'assignedModality'],
    },
  },
  {
    name: 'create_item',
    description: 'Create a work item. Search first — update an existing one rather than duplicating.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short label.' },
        description: { type: 'string', description: 'What it is / what needs doing.' },
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[], description: 'task | event | memory | suggestion. A RECURRING commitment ("every morning", "every week") is a Project, not an item of any type — see the projects protocol.' },
        target: { type: 'string', description: 'Who this is for: a modality id, or "pa" to send it to Penny.' },
        priority: { type: 'number', description: '0–5 (default 2).' },
        duration: { type: 'string', description: 'For events: "30 min", "1 hour".' },
        dayTime: { type: 'string', description: 'Timing/recurrence hint, if any.' },
        dueDate: { type: 'string', description: 'A specific due date, YYYY-MM-DD (one-offs only).' },
        projectId: { type: 'string', description: 'Link to a project, if any.' },
        contingency: { type: 'string', description: 'Why this can\'t move right now, e.g. "waiting to hear back from the IRS" — only if known at creation; usually set later via update_item once something genuinely blocks it.' },
        contingencyUntil: { type: 'string', description: 'A real recheck date, YYYY-MM-DD, if known. While in the future, this item is skipped entirely in review — not just deprioritized.' },
      },
      required: ['name', 'description', 'type', 'target'],
    },
  },
  {
    name: 'update_item',
    description: 'Edit an item\'s non-status fields (name, description, type, priority, duration, dayTime, projectId, contingency). `notes` here OVERWRITES the whole notes log — for adding a line without erasing history, use append_note instead.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        notes: { type: 'string', description: 'Overwrites the entire notes field. Usually you want append_note instead.' },
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[] },
        priority: { type: 'number' },
        duration: { type: 'string' },
        dayTime: { type: 'string' },
        dueDate: { type: 'string', description: 'A specific due date, YYYY-MM-DD. Pass "" to clear it.' },
        projectId: { type: 'string' },
        target: { type: 'string', description: 'Reassign who this is for: a modality id, or "pa". Use when an item was filed under the wrong domain.' },
        contingency: { type: 'string', description: 'Why this can\'t move right now, e.g. "waiting to hear back from the IRS". Pair with set_item_status(..., to=\'contingent\'). Pass "" to clear once resolved.' },
        contingencyUntil: { type: 'string', description: 'A real recheck date, YYYY-MM-DD. While in the future, this item is skipped entirely in review. Pass "" to clear.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'append_note',
    description: 'Add a line to an item\'s running notes WITHOUT erasing what\'s already there. Use this — not create_item — every time you learn more about something already tracked that ISN\'T a contingency (for "waiting on X", use update_item\'s contingency field + set_item_status to \'contingent\' instead — that\'s what stops the same question getting asked every time). Creating a new Item for an update to an existing one is the #1 thing to avoid.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string', description: 'The line to add.' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'set_item_status',
    description: 'Move an item to a new lifecycle status. Only legal transitions are allowed; an illegal move is rejected with the reason and the allowed options.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        side: { type: 'string', enum: ['pa', 'modality'], description: 'Which lifecycle to move: Penny\'s (pa) or this self\'s (modality).' },
        to: { type: 'string', description: 'Target status, e.g. pending, schedule, completed, sent-to-PA, contingent, to-delete.' },
      },
      required: ['id', 'side', 'to'],
    },
  },
  {
    name: 'mark_discussed',
    description: 'Mark ANY reviewable thing — an item OR a project — as reviewed this session, by its id, so the phase can close. You usually don\'t need this: changing or creating something already marks it reviewed automatically. Use it for the one case that has no change to make: a thing you looked at with the user and deliberately left exactly as-is (e.g. a project you decided not to touch this week).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The item or project id.' } },
      required: ['id'],
    },
  },
  {
    name: 'finish_phase',
    description: 'Signal that this phase\'s work is genuinely complete so the review advances. Do not call early.',
    input_schema: { type: 'object', properties: {} },
  },
]

/** Schemas for just the named tools (the runner grants only what the phase allows). */
export function reviewToolSchemas(names: string[]): Tool[] {
  const set = new Set(names)
  return REVIEW_TOOL_SCHEMAS.filter((t) => set.has(t.name))
}

// Tool names executeReviewTool actually handles. The runner uses this to decide
// whether a phase-granted tool (e.g. a calendar tool) belongs to THIS executor
// or should fall through to the main tool-executor instead.
export const REVIEW_OWN_TOOL_NAMES = new Set(REVIEW_TOOL_SCHEMAS.map((t) => t.name))

// undefined = leave unchanged; null = clear; Date = set. Empty/invalid string clears.
function parseDueDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function fmtItem(i: ItemRow): string {
  const status = i.target === 'pa' ? `pa=${i.paStatus}` : `mod=${i.modalityStatus}`
  const due = i.dueDate ? `, due ${new Date(i.dueDate).toISOString().slice(0, 10)}` : ''
  const notes = i.notes ? `\n    notes: ${i.notes.replace(/\n/g, ' / ')}` : ''
  const until = i.contingencyUntil ? ` (recheck ${new Date(i.contingencyUntil).toISOString().slice(0, 10)})` : ''
  const contingency = i.contingency ? `\n    contingent on: ${i.contingency}${until}` : ''
  return `[${i.id}] "${i.name}" (${i.type}, ${status}, p${i.priority}${due}, →${i.target})${contingency}${notes}`
}

export async function executeReviewTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReviewToolContext
): Promise<{ content: string; is_error?: boolean }> {
  try {
    switch (name) {
      case 'search_items': {
        // A submodality only ever sees her OWN domain — never the whole board.
        // PA sees everything (optionally filtered by the target arg).
        const target = ctx.modalityId === 'pa' ? (args.target as string | undefined) : ctx.modalityId
        const items = await searchItems(ctx.profileId, {
          target,
          type: args.type as string | undefined,
          projectId: args.projectId as string | undefined,
        })
        return { content: items.length ? items.map(fmtItem).join('\n') : '(no items)' }
      }
      case 'update_project': {
        const data: Record<string, unknown> = {}
        if (args.progress !== undefined) data.progress = Math.max(0, Math.min(10, Math.round(Number(args.progress))))
        if (args.description !== undefined) data.description = String(args.description)
        if (args.termType !== undefined) data.termType = String(args.termType)
        if (args.contingencies !== undefined) data.contingencies = String(args.contingencies) || null
        if (args.contingencyUntil !== undefined) data.contingencyUntil = parseDueDate(args.contingencyUntil)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = await (prisma as any).project.update({ where: { id: String(args.id) }, data })
        if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, String(args.id)) // acting on it = reviewed
        return { content: `project updated: "${p.name}" — ${p.progress}/10` }
      }
      case 'create_project': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const project = await (prisma as any).project.create({
          data: {
            profileId: ctx.profileId,
            name: String(args.name),
            description: String(args.description),
            expectedDuration: String(args.expectedDuration),
            assignedModality: canonTarget(args.assignedModality, ctx.modalityId),
            progress: args.progress !== undefined ? Math.max(0, Math.min(10, Math.round(Number(args.progress)))) : 0,
            contingencies: args.contingencies !== undefined ? String(args.contingencies) || null : null,
            contingencyUntil: parseDueDate(args.contingencyUntil) ?? null,
          },
        })
        if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, project.id)
        return { content: `project created: "${project.name}" (id=${project.id})` }
      }
      case 'create_item': {
        const item = await createItem(ctx.profileId, {
          name: String(args.name),
          description: String(args.description),
          type: String(args.type),
          target: canonTarget(args.target, ctx.modalityId),
          createdBy: ctx.modalityId,
          priority: args.priority as number | undefined,
          duration: args.duration as string | undefined,
          dayTime: args.dayTime as string | undefined,
          dueDate: parseDueDate(args.dueDate),
          projectId: args.projectId as string | undefined,
          contingency: args.contingency as string | undefined,
          contingencyUntil: parseDueDate(args.contingencyUntil),
        })
        if (ctx.reviewSessionId) {
          await markDiscussed(ctx.reviewSessionId, item.id)
          if (item.projectId) await markDiscussed(ctx.reviewSessionId, item.projectId) // worked into a project = reviewed it
        }
        return { content: `created ${fmtItem(item)}` }
      }
      case 'update_item': {
        const { id, dueDate, contingencyUntil, target, ...rest } = args as Record<string, unknown>
        const fields: Record<string, unknown> = { ...rest }
        if (dueDate !== undefined) fields.dueDate = parseDueDate(dueDate)
        if (contingencyUntil !== undefined) fields.contingencyUntil = parseDueDate(contingencyUntil)
        if (target !== undefined) fields.target = canonTarget(target, ctx.modalityId)
        const item = await updateItemFields(String(id), fields)
        if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, String(id))
        return { content: `updated ${fmtItem(item)}` }
      }
      case 'append_note': {
        const item = await appendItemNote(String(args.id), String(args.text))
        if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, String(args.id))
        return { content: `noted ${fmtItem(item)}` }
      }
      case 'set_item_status': {
        const res = await setItemStatus(String(args.id), args.side as 'pa' | 'modality', String(args.to))
        if (!res.ok) return { content: `REJECTED: ${res.reason}`, is_error: true }
        if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, String(args.id))
        return { content: `status set → ${fmtItem(res.item!)}` }
      }
      case 'mark_discussed': {
        if (!ctx.reviewSessionId) return { content: 'mark_discussed is only available during a Review.', is_error: true }
        await markDiscussed(ctx.reviewSessionId, String(args.id))
        return { content: `marked reviewed: ${args.id}` }
      }
      case 'finish_phase': {
        const violations = ctx.exitCheck ? await ctx.exitCheck() : []
        if (violations.length > 0) {
          ctx.finishRequested = false
          return {
            content:
              `CANNOT FINISH — ${violations.length} item(s) still block this phase:\n` +
              violations.map((v) => `  • "${v.name}" [${v.id}]: ${v.reason}`).join('\n') +
              `\nResolve each (set_item_status and/or mark_discussed), then call finish_phase again.`,
            is_error: true,
          }
        }
        ctx.finishRequested = true
        return { content: 'phase complete — the review will advance.' }
      }
      default:
        return { content: `unknown review tool: ${name}`, is_error: true }
    }
  } catch (e) {
    return { content: `error in ${name}: ${e instanceof Error ? e.message : String(e)}`, is_error: true }
  }
}
