// The table tool surface: two generic table operations (query_table, write_table)
// covering BOTH the Item and Project tables, plus two review-only control tools
// (mark_discussed, finish_phase) that aren't table cells at all — they're
// review-session bookkeeping. Used by BOTH the Review loop (which grants all 4)
// and normal chat (which grants the 2 table tools — see tools.ts's TABLE_TOOLS —
// and never sets reviewSessionId, so the mark_discussed bookkeeping below is
// simply skipped).
//
// Deliberately NOT a tool per verb (create_item/update_item/append_note/
// set_item_status/create_project/update_project, as this used to be): it's a
// table, the model reads and writes cells, and everything else is logic built
// on top of that — not a reason to mint a new tool name. The one thing that
// ISN'T a bare cell write is `stage`: that goes through the FSM
// (decideStatusChange) so an illegal jump is rejected and the derived
// timestamps (completedAt/scheduledAt/stageEnteredAt) get stamped automatically.

import type Anthropic from '@anthropic-ai/sdk'
import type { ToolContext } from '@/lib/tool-executor'
import { prisma } from '@/lib/db'
import { resolveModality } from '@/lib/modalities'
import { ITEM_TYPES, STAGES, ENTRY_STAGES } from './fsm'
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

// ctx for the table tools — the legacy ToolContext plus an OPTIONAL review session
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
    name: 'query_table',
    description: 'Read rows from the item table or the project table. Use to check what already exists before creating (search first, always), to see a self\'s load, and — with projectId — to see what\'s inside a project (its folder of items).',
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: ['item', 'project'], description: 'Which table to read.' },
        id: { type: 'string', description: 'Fetch a single row by id (either table).' },
        target: { type: 'string', description: '(item) Filter to items aimed at this target — a modality id, or "pa".' },
        type: { type: 'string', enum: ITEM_TYPES as unknown as string[], description: '(item) Filter to one item type.' },
        projectId: { type: 'string', description: '(item) Filter to the items inside this project.' },
        assignedModality: { type: 'string', description: '(project) Filter to projects owned by this modality.' },
      },
      required: ['table'],
    },
  },
  {
    name: 'write_table',
    description: `Create or update a row in the item table or the project table. Omit \`id\` to create a new row; include it to update an existing one.

\`fields\` sets cells directly:
  • item: name, description, type (${(ITEM_TYPES as unknown as string[]).join('|')}), target, priority (0–5), duration, dayTime, dueDate (YYYY-MM-DD), projectId, contingency, contingencyUntil (YYYY-MM-DD), stage (${(STAGES as unknown as string[]).join('|')} — VALIDATED: only legal moves are accepted, rejected with a reason otherwise. A new item without a stage defaults to "backlog"; pass one of ${(ENTRY_STAGES as unknown as string[]).join('|')} to start somewhere else.)
  • project: name, description, expectedDuration, assignedModality, kind ("goal"|"ongoing" — "goal" has a real end-state, its progress is computed automatically from its items; "ongoing" never hits 100% by design), progress (only meaningful for kind="ongoing"), termType (short|medium|long), contingencies, contingencyUntil (YYYY-MM-DD).

\`append\` adds a dated line to a text cell WITHOUT erasing what's already there, instead of overwriting it — currently supported: { notes: "..." } on the item table. This is the alternative to minting a duplicate row when you learn more about something already tracked.

SEARCH FIRST with query_table before creating — a near-duplicate row for something that already exists is the #1 mistake to avoid. A RECURRING commitment ("every morning", "every week") belongs in the project table, not as a repeated item.`,
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: ['item', 'project'] },
        id: { type: 'string', description: 'Omit to create a new row.' },
        fields: { type: 'object', description: 'Cells to set directly. See the tool description for the field list per table.' },
        append: { type: 'object', description: 'Text cells to append a dated line to. Currently: { notes: "..." } on the item table.' },
      },
      required: ['table'],
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
  const due = i.dueDate ? `, due ${new Date(i.dueDate).toISOString().slice(0, 10)}` : ''
  const notes = i.notes ? `\n    notes: ${i.notes.replace(/\n/g, ' / ')}` : ''
  const until = i.contingencyUntil ? ` (recheck ${new Date(i.contingencyUntil).toISOString().slice(0, 10)})` : ''
  const contingency = i.contingency ? `\n    contingent on: ${i.contingency}${until}` : ''
  return `[${i.id}] "${i.name}" (${i.type}, stage=${i.stage}, p${i.priority}${due}, →${i.target})${contingency}${notes}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmtProject(p: any): string {
  const progress = p.kind === 'ongoing' ? '(ongoing)' : `${p.progress}/10`
  return `[${p.id}] "${p.name}" (${p.kind}, ${progress}, →${p.assignedModality})`
}

export async function executeReviewTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReviewToolContext
): Promise<{ content: string; is_error?: boolean }> {
  try {
    switch (name) {
      case 'query_table': {
        const table = String(args.table)
        if (table === 'item') {
          // A submodality only ever sees her OWN domain — never the whole board.
          // PA sees everything (optionally filtered by the target arg).
          const target = ctx.modalityId === 'pa' ? (args.target as string | undefined) : ctx.modalityId
          const items = await searchItems(ctx.profileId, {
            id: args.id as string | undefined,
            target,
            type: args.type as string | undefined,
            projectId: args.projectId as string | undefined,
          })
          return { content: items.length ? items.map(fmtItem).join('\n') : '(no items)' }
        }
        if (table === 'project') {
          const where: Record<string, unknown> = { profileId: ctx.profileId }
          if (args.id) where.id = String(args.id)
          if (args.assignedModality) where.assignedModality = canonTarget(args.assignedModality, ctx.modalityId)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const projects = await (prisma as any).project.findMany({ where })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { content: projects.length ? projects.map((p: any) => fmtProject(p)).join('\n') : '(no projects)' }
        }
        return { content: `unknown table "${args.table}" — must be "item" or "project"`, is_error: true }
      }

      case 'write_table': {
        const table = String(args.table)
        const id = args.id ? String(args.id) : undefined
        const fields = (args.fields as Record<string, unknown>) ?? {}
        const append = (args.append as Record<string, unknown>) ?? {}

        if (table === 'item') {
          if (append.notes !== undefined) {
            if (!id) return { content: 'write_table: append requires an existing id', is_error: true }
            const item = await appendItemNote(id, String(append.notes))
            if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, id)
            return { content: `noted ${fmtItem(item)}` }
          }

          // stage is validated through the FSM, not a blind cell write.
          if (fields.stage !== undefined && id) {
            const res = await setItemStatus(id, String(fields.stage))
            if (!res.ok) return { content: `REJECTED: ${res.reason}`, is_error: true }
            if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, id)
            return { content: `stage set → ${fmtItem(res.item!)}` }
          }

          if (!id) {
            const item = await createItem(ctx.profileId, {
              name: String(fields.name),
              description: String(fields.description),
              type: String(fields.type),
              target: canonTarget(fields.target, ctx.modalityId),
              createdBy: ctx.modalityId,
              priority: fields.priority as number | undefined,
              duration: fields.duration as string | undefined,
              dayTime: fields.dayTime as string | undefined,
              dueDate: parseDueDate(fields.dueDate),
              projectId: fields.projectId as string | undefined,
              contingency: fields.contingency as string | undefined,
              contingencyUntil: parseDueDate(fields.contingencyUntil),
              stage: fields.stage as 'backlog' | 'planned' | 'blocked' | undefined,
            })
            if (ctx.reviewSessionId) {
              await markDiscussed(ctx.reviewSessionId, item.id)
              if (item.projectId) await markDiscussed(ctx.reviewSessionId, item.projectId)
            }
            return { content: `created ${fmtItem(item)}` }
          }

          const { dueDate, contingencyUntil, target, ...rest } = fields
          const upd: Record<string, unknown> = { ...rest }
          if (dueDate !== undefined) upd.dueDate = parseDueDate(dueDate)
          if (contingencyUntil !== undefined) upd.contingencyUntil = parseDueDate(contingencyUntil)
          if (target !== undefined) upd.target = canonTarget(target, ctx.modalityId)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const item = await updateItemFields(id, upd as any)
          if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, id)
          return { content: `updated ${fmtItem(item)}` }
        }

        if (table === 'project') {
          if (!id) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const project = await (prisma as any).project.create({
              data: {
                profileId: ctx.profileId,
                name: String(fields.name),
                description: String(fields.description),
                expectedDuration: String(fields.expectedDuration),
                assignedModality: canonTarget(fields.assignedModality, ctx.modalityId),
                kind: fields.kind !== undefined ? String(fields.kind) : 'goal',
                contingencies: fields.contingencies !== undefined ? String(fields.contingencies) || null : null,
                contingencyUntil: parseDueDate(fields.contingencyUntil) ?? null,
              },
            })
            if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, project.id)
            return { content: `created ${fmtProject(project)}` }
          }

          const data: Record<string, unknown> = {}
          if (fields.kind !== undefined) data.kind = String(fields.kind)
          // progress is only meaningful for kind='ongoing' — a goal-kind project's
          // displayed progress is computed live from its items (see the dashboard
          // route), so a manual write here is superseded there.
          if (fields.progress !== undefined) data.progress = Math.max(0, Math.min(10, Math.round(Number(fields.progress))))
          if (fields.name !== undefined) data.name = String(fields.name)
          if (fields.description !== undefined) data.description = String(fields.description)
          if (fields.expectedDuration !== undefined) data.expectedDuration = String(fields.expectedDuration)
          if (fields.assignedModality !== undefined) data.assignedModality = canonTarget(fields.assignedModality, ctx.modalityId)
          if (fields.termType !== undefined) data.termType = String(fields.termType)
          if (fields.contingencies !== undefined) data.contingencies = String(fields.contingencies) || null
          if (fields.contingencyUntil !== undefined) data.contingencyUntil = parseDueDate(fields.contingencyUntil)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = await (prisma as any).project.update({ where: { id }, data })
          if (ctx.reviewSessionId) await markDiscussed(ctx.reviewSessionId, id)
          return { content: `updated ${fmtProject(p)}` }
        }

        return { content: `unknown table "${args.table}" — must be "item" or "project"`, is_error: true }
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
              `\nResolve each (write_table and/or mark_discussed), then call finish_phase again.`,
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
