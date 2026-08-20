/**
 * The six model-facing tools: quote, list, watch, unwatch, alert, chart.
 *
 * Names follow the plugin contract (short, grep-able, no collision with the
 * shipped tool set). Every tool:
 * -   returns a canonical lossless-JSON value (machine-readable)
 * -   renders terse human text for the model
 * -   never throws for expected failures (invalid codes, offline provider) —
 *     those return `{ ok: false, error }` entries the model can act on.
 *
 * @module market-watch/dsh/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { MarketWatch } from '../core/engine.js'
import type { AlertField, AlertOp, QuoteResult } from '../core/types.js'
import { formatQuoteResults } from '../core/format.js'
import { renderChart, sparkline } from '../core/chart.js'
import { errorMessage } from '../core/errors.js'
import { MARKET_AREAS, MARKET_KINDS, isMarketArea, isMarketKind } from '../core/kinds.js'

const TEXT: (text: string) => ContentBlock[] = (text) => [{ type: 'text', text }]

function errorValue(code: unknown, error: unknown): JsonValue {
  return { ok: false, code, error: errorMessage(error) } as unknown as JsonValue
}

/** Structurally rich values must cross the JsonValue boundary explicitly. */
function json(value: unknown): JsonValue {
  return value as unknown as JsonValue
}

export function applyTools(ctx: Context, engine: MarketWatch): void {
  registerQuote(ctx, engine)
  registerList(ctx, engine)
  registerWatch(ctx, engine)
  registerUnwatch(ctx, engine)
  registerAlert(ctx, engine)
  registerChart(ctx, engine)
}

function registerQuote(ctx: Context, engine: MarketWatch): void {
  ctx.tools.register(
    defineTool({
      name: 'quote',
      description:
        'Fetch live quotes for stocks/indices/crypto (free sources: Tencent for A-share — Shanghai/Shenzhen/Beijing; CoinGecko for crypto; quotes may be delayed). When `days` is set, appends a compact ASCII trend sparkline per instrument using trailing daily closes.',
      parameters: {
        codes: {
          type: 'array',
          items: { type: 'string', description: 'instrument code, e.g. sh600000, 000858, 600000.sh, 000001 (index), bitcoin, ethereum' },
          required: true,
          description: 'one or more instrument codes',
        },
        days: {
          type: 'integer',
          description: 'fetch this many trailing daily closes to draw a sparkline (1-90; costs one history request per instrument)',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const valueObj = value as Record<string, unknown>
          if (valueObj.ok === false) return TEXT(`quote failed: ${valueObj.error as string}`)
          return TEXT(formatQuoteResults(valueObj.details as QuoteResult[]) + (valueObj.note ? `\n${valueObj.note as string}` : ''))
        },
      },
      async execute(args, exec) {
        try {
          const results = (await engine.quote(args.codes, exec.signal)) as QuoteResult[]
          // `note` must stay absent when undefined: undefined own properties
          // violate the lossless-JSON contract of tool values.
          const body: Record<string, unknown> = { details: results }
          const firstOk = results.find((r) => r.ok)
          if (firstOk !== undefined) body.note = firstOk.quote.delayNote
          if (args.days !== undefined && args.days >= 1) {
            const days = Math.min(args.days, 90)
            const trends: Record<string, string> = {}
            for (const result of results) {
              if (!result.ok) continue
              try {
                const points = await engine.history(result.quote.code, days, exec.signal)
                trends[result.quote.code] = sparkline(points.map((p) => p.close), Math.min(days, 60))
              } catch {
                trends[result.quote.code] = '(history unavailable)'
              }
            }
            body.trends = trends
          }
          return json(body)
        } catch (error) {
          return json({ ok: false, error: errorMessage(error) })
        }
      },
    }),
  )
}

function registerList(ctx: Context, engine: MarketWatch): void {
  ctx.tools.register(
    defineTool({
      name: 'list',
      description: 'List every watched instrument (local watchlist: code, name hint, market, kind, added time).',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const out = value as { ok?: boolean; error?: string; items?: unknown[] }
          if (out.ok === false) return TEXT(`list failed: ${out.error ?? 'unknown error'}`)
          const items = out.items ?? []
          if (items.length === 0) return TEXT('watchlist is empty — use watch to add instruments')
          const rows = items.map(
            (item) =>
              `- ${(item as { code: string }).code}  ${(item as { name?: string }).name ?? ''} [${(item as { market: string }).market}/${(item as { kind: string }).kind}]`,
          )
          return TEXT(rows.join('\n'))
        },
      },
      async execute() {
        try {
          const items = await engine.watchlist()
          return json({ items })
        } catch (error) {
          return json({ ok: false, error: errorMessage(error) })
        }
      },
    }),
  )
}

function registerWatch(ctx: Context, engine: MarketWatch): void {
  ctx.tools.register(
    defineTool({
      name: 'watch',
      description: `Add instruments to the local watchlist. Market: ${MARKET_AREAS.join(' or ')}; kind: ${MARKET_KINDS.join('/')}.`,
      parameters: {
        codes: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'instrument codes to add, e.g. ["sh600000", "bitcoin"]',
        },
        market: {
          type: 'string',
          description: 'force the regional market when the code is ambiguous (cn/crypto)',
        },
        kind: {
          type: 'string',
          description: 'force the instrument kind when the code is ambiguous (stock/index/crypto)',
        },
        name: {
          type: 'string',
          description: 'optional display name (overrides the source name when shown)',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const out = value as { ok?: boolean; error?: string; added?: unknown[]; duplicates?: string[]; errors?: string[] }
          if (out.ok === false) return TEXT(`watch failed: ${out.error ?? 'unknown error'}`)
          const lines = [
            (out.added ?? []).length > 0 ? `added: ${(out.added ?? []).map((a) => (a as { code: string }).code).join(', ')}` : '',
            (out.duplicates ?? []).length > 0 ? `already watched: ${(out.duplicates ?? []).join(', ')}` : '',
            ...(out.errors ?? []).map((e) => `error: ${e}`),
          ].filter((l) => l !== '')
          return TEXT(lines.join('\n') || 'nothing changed')
        },
      },
      async execute(args) {
        if (args.market !== undefined && !isMarketArea(args.market)) {
          return json({ added: [], duplicates: [], errors: [`unknown market "${args.market}" (expected one of: ${MARKET_AREAS.join(', ')})`] })
        }
        if (args.kind !== undefined && !isMarketKind(args.kind)) {
          return json({ added: [], duplicates: [], errors: [`unknown kind "${args.kind}" (expected one of: ${MARKET_KINDS.join(', ')})`] })
        }
        try {
          return json(await engine.watch({ codes: args.codes, market: args.market, kind: args.kind, name: args.name }))
        } catch (error) {
          return errorValue(args.codes.join(','), error)
        }
      },
    }),
  )
}

function registerUnwatch(ctx: Context, engine: MarketWatch): void {
  ctx.tools.register(
    defineTool({
      name: 'unwatch',
      description: 'Remove an instrument from the local watchlist (accepts the same code forms as watch/quote).',
      parameters: {
        code: {
          type: 'string',
          required: true,
          description: 'instrument code to remove',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const out = value as { ok?: boolean; error?: string; removed?: unknown[] }
          if (out.ok === false) return TEXT(`unwatch failed: ${out.error ?? 'unknown error'}`)
          const removed = out.removed ?? []
          return TEXT(removed.length > 0 ? `unwatched ${(removed[0] as { code: string }).code}` : 'nothing removed')
        },
      },
      async execute(args) {
        try {
          return json(await engine.unwatch(args.code))
        } catch (error) {
          return errorValue(args.code, error)
        }
      },
    }),
  )
}

function registerAlert(ctx: Context, engine: MarketWatch): void {
  ctx.tools.register(
    defineTool({
      name: 'alert',
      description:
        'Manage threshold alerts. `list` shows rules; `add` creates one (field=changePercent|price, op=gt|gte|lt|lte, cooldownSeconds is the minimum gap between two triggers); `remove` deletes by rule id. Alerts fire on every poll.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'list, add or remove',
        },
        code: { type: 'string', description: 'instrument code when adding a rule' },
        field: { type: 'string', description: 'changePercent or price' },
        op: { type: 'string', description: 'comparison: gt, gte, lt or lte' },
        value: { type: 'number', description: 'threshold value' },
        cooldownSeconds: { type: 'integer', description: 'minimum seconds between triggers (default 300)' },
        note: { type: 'string', description: 'optional annotation' },
        id: { type: 'string', description: 'rule id when removing' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const out = value as { kind: string }
          switch (out.kind) {
            case 'added':
              return TEXT(literalRule((value as { rule: unknown }).rule))
            case 'removed':
              return TEXT(`removed rule ${(value as { removed: unknown }).removed as string}`)
            case 'error':
              return TEXT(`alert failed: ${(value as { error: string }).error}`)
            default:
              return TEXT(renderRuleList((value as { rules: unknown[] }).rules))
          }
        },
      },
      async execute(args) {
        try {
          switch (args.action) {
            case 'list':
              return json({ kind: 'rules', rules: await engine.rules() })
            case 'add': {
              if (args.code === undefined || !isField(args.field) || !isOp(args.op) || args.value === undefined) {
                throw new Error('add requires code, field, op and value')
              }
              const rule = await engine.addRule({
                code: args.code,
                field: args.field,
                op: args.op,
                value: args.value,
                cooldownSeconds: args.cooldownSeconds ?? 300,
                note: args.note,
              })
              return json({ kind: 'added', rule })
            }
            case 'remove': {
              if (args.id === undefined) throw new Error('remove requires a rule id (see alert with action=list)')
              return json({ kind: 'removed', removed: (await engine.removeRule(args.id)).removed.id })
            }
            default:
              throw new Error(`unknown action "${args.action}" (list|add|remove)`)
          }
        } catch (error) {
          return json({ kind: 'error', error: errorMessage(error) })
        }
      },
    }),
  )
}

function isField(value: string | undefined): value is AlertField {
  return value === 'changePercent' || value === 'price'
}

function isOp(value: string | undefined): value is AlertOp {
  return value === 'gt' || value === 'gte' || value === 'lt' || value === 'lte'
}

function literalRule(rule: unknown): string {
  const r = rule as { id: string; code: string; field: string; op: string; value: number; cooldownSeconds: number }
  return `added rule ${r.id}: ${r.code} ${r.field} ${r.op} ${r.value} (cooldown ${r.cooldownSeconds}s)`
}

function renderRuleList(rules: unknown[]): string {
  if (rules.length === 0) return 'no alert rules'
  return rules
    .map((rule) => {
      const r = rule as { id: string; code: string; field: string; op: string; value: number; cooldownSeconds: number; enabled: boolean; lastTriggeredAt?: number; note?: string }
      const state = r.enabled ? 'enabled' : 'disabled'
      const last = r.lastTriggeredAt === undefined ? 'never' : new Date(r.lastTriggeredAt).toISOString()
      return `- ${r.id}  ${r.code} ${r.field} ${r.op} ${r.value} [${state}] cooldown ${r.cooldownSeconds}s last ${last}${r.note ? ` # ${r.note}` : ''}`
    })
    .join('\n')
}

function registerChart(ctx: Context, engine: MarketWatch): void {
  ctx.tools.register(
    defineTool({
      name: 'chart',
      description: 'Render an ASCII or mermaid chart of trailing daily closes for one instrument.',
      parameters: {
        code: { type: 'string', required: true, description: 'instrument code' },
        days: { type: 'integer', description: 'trailing trading days to plot (default 30)' },
        format: { type: 'string', description: 'ascii (default) or mermaid' },
        width: { type: 'integer', description: 'plot width in characters (default 60)' },
        height: { type: 'integer', description: 'plot height in lines, ascii only (default 10)' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => TEXT((value as { text: string }).text),
      },
      async execute(args, exec) {
        try {
          const days = Math.min(Math.max(args.days ?? 30, 1), 365)
          const points = await engine.history(args.code, days, exec.signal)
          const rendered = renderChart(points, args.format === 'mermaid' ? 'mermaid' : 'ascii', {
            width: args.width,
            height: args.height,
            title: args.code,
          })
          return json({ text: rendered.text, points: rendered.points })
        } catch (error) {
          return json({ text: `chart failed: ${errorMessage(error)}`, points: 0 })
        }
      },
    }),
  )
}