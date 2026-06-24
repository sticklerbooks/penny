// The review tool surface: Item CRUD (FSM-gated via item-store) plus two control
// tools (mark_discussed, finish_phase). The review loop uses THIS executor, not the
// legacy tool-executor — the new Item world stays decoupled from the old tables it
// replaces. Status writes are impossible to force illegally: set_item_status routes
// through decideStatusChange and returns the rejection reason to the model.

import type Anthropic from '@anthropic-ai/sdk'
import type { ToolContext } from '@/lib/tool-executor'
import { ITEM_TYPES } from './fsm'
import {
  createItem,
  setItemStatus,
  updateItemFields,
  searchItems,
  type ItemRow,
} from './item-store'
import { markDiscussed } from '@/lib/review/session'
import type { GuardViolation } from '@/lib/review/guards'

// ctx for the review loop — the legacy ToolContext plus the session, a mutable
// control flag the finish_phase tool sets (read by the runner after the loop), and
// the exit guard the engine evaluates before it will let the phase finish.
export interface ReviewToolContext extends ToolContext {
  reviewSessionId: string
  finishRequested?: boolean
  /** The phase's exit predicate, evaluated against the live DB. finish_phase calls
   *  it and refuses to finish while it returns any violations. */
  exitCheck?: () => Promise<GuardViolation[]>
}

type Tool = Anthropic.Tool

export const REVIEW_TOOL_SCHEMAS: Tool[] = [
  {
    name: 'search_items',
    description: 'List the items in scope (optionally filtered). Use to check what already exists before creating, and to see a self\'s load.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Filter to items aimed at this target (a modality id or "pa").' },
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[], description: 'Filter to one item type.' },
      },
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
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[], description: 'event | ongoing | memory | suggestion.' },
        target: { type: 'string', description: 'Who this is for: a modality id, or "pa" to send it to Penny.' },
        priority: { type: 'number', description: '0–5 (default 2).' },
        duration: { type: 'string', description: 'For events: "30 min", "1 hour".' },
        dayTime: { type: 'string', description: 'Timing/recurrence hint, if any.' },
        dueDate: { type: 'string', description: 'A specific due date, YYYY-MM-DD (one-offs only).' },
        projectId: { type: 'string', description: 'Link to a project, if any.' },
      },
      required: ['name', 'description', 'type', 'target'],
    },
  },
  {
    name: 'update_item',
    description: 'Edit an item\'s non-status fields (name, description, type, priority, duration, dayTime, projectId).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[] },
        priority: { type: 'number' },
        duration: { type: 'string' },
        dayTime: { type: 'string' },
        dueDate: { type: 'string', description: 'A specific due date, YYYY-MM-DD. Pass "" to clear it.' },
        projectId: { type: 'string' },
      },
      required: ['id'],
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
        to: { type: 'string', description: 'Target status, e.g. pending, continuing, schedule, completed, sent-to-PA, blocked, to-delete.' },
      },
      required: ['id', 'side', 'to'],
    },
  },
  {
    name: 'mark_discussed',
    description: 'Mark an item discussed in this review (so the phase knows it\'s been handled). Call after you and the user finish with it.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
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
  return `[${i.id}] "${i.name}" (${i.type}, ${status}, p${i.priority}${due}, →${i.target})`
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
        })
        return { content: items.length ? items.map(fmtItem).join('\n') : '(no items)' }
      }
      case 'create_item': {
        const item = await createItem(ctx.profileId, {
          name: String(args.name),
          description: String(args.description),
          type: String(args.type),
          target: String(args.target),
          createdBy: ctx.modalityId,
          priority: args.priority as number | undefined,
          duration: args.duration as string | undefined,
          dayTime: args.dayTime as string | undefined,
          dueDate: parseDueDate(args.dueDate),
          projectId: args.projectId as string | undefined,
        })
        return { content: `created ${fmtItem(item)}` }
      }
      case 'update_item': {
        const { id, dueDate, ...rest } = args as Record<string, unknown>
        const fields: Record<string, unknown> = { ...rest }
        if (dueDate !== undefined) fields.dueDate = parseDueDate(dueDate)
        const item = await updateItemFields(String(id), fields)
        return { content: `updated ${fmtItem(item)}` }
      }
      case 'set_item_status': {
        const res = await setItemStatus(String(args.id), args.side as 'pa' | 'modality', String(args.to))
        if (!res.ok) return { content: `REJECTED: ${res.reason}`, is_error: true }
        return { content: `status set → ${fmtItem(res.item!)}` }
      }
      case 'mark_discussed': {
        await markDiscussed(ctx.reviewSessionId, String(args.id))
        return { content: `marked discussed: ${args.id}` }
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
