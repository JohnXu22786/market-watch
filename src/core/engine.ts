/**
 * MarketWatch engine: the dependency-light core shared by the dsh plugin
 * surface and the standalone CLI.
 *
 * The engine owns orchestration only:
 * -   routing codes to the right provider,
 * -   mutating the persisted watchlist / rules through {@link JsonStore},
 * -   evaluating alert rules on polled quotes (cooldown-aware) and firing
 *     {@link EngineOptions.onAlert},
 * -   producing the data the renderers (chart/format modules) consume.
 *
 * Network access goes through an injected {@link FetchLike} and a {@link
 * RateLimiter} per provider, so tests run fully offline.
 *
 * @module market-watch/core/engine
 */

import type { FetchLike, HttpRequestOptions } from './client.js'
import { RateLimiter } from './client.js'
import { identifyCode } from './symbols.js'
import { errorMessage } from './errors.js'
import type { JsonStore } from './store.js'
import type {
  AlertEvent,
  AlertField,
  AlertOp,
  AlertRule,
  HistoryPoint,
  MarketKind,
  PersistedState,
  Quote,
  QuoteResult,
  WatchItem,
} from './types.js'
import { formatPercent, newId } from './format.js'
import type { QuoteProvider } from './providers/types.js'
import { CoinGeckoProvider } from './providers/coingecko.js'
import { TencentProvider } from './providers/tencent.js'
import { MARKET_AREAS, isMarketArea, isMarketKind } from './kinds.js'

export interface EngineConfig {
  /** Quote currency for crypto quotes, e.g. `usd` (default). */
  readonly vsCurrency?: string
  /** Minimum ms between consecutive CoinGecko calls (free-tier spacing, default 1200). */
  readonly coingeckoDelayMs?: number
}

export interface EngineOptions {
  readonly store: JsonStore
  /** Fetcher — injectable for tests; defaults to global fetch. */
  readonly fetcher?: FetchLike
  /** Shared HTTP policy overrides (timeouts/retries). */
  readonly http?: HttpRequestOptions
  readonly config?: EngineConfig
  /** Fired for every rule that triggers (poll loop and CLI both hook in here). */
  readonly onAlert?: (alert: AlertEvent) => void
  /** Injectable clock for deterministic cooldown tests. */
  readonly now?: () => number
}

export interface WatchOutcome {
  readonly added: WatchItem[]
  readonly duplicates: string[]
  readonly errors: string[]
}

export interface PollOutcome {
  readonly ok: number
  readonly failed: number
  readonly alerts: number
}

export class MarketWatch {
  private readonly store: JsonStore
  private readonly fetcher: FetchLike
  private readonly http: HttpRequestOptions
  private readonly now: () => number
  private readonly providers: Readonly<Record<string, QuoteProvider>>

  /** Delivery hook; dsh sets this once after wiring its event/agent notifiers. */
  alertHandler: ((alert: AlertEvent) => void) | undefined

  constructor(options: EngineOptions) {
    this.store = options.store
    this.fetcher = options.fetcher ?? fetch
    this.http = options.http ?? {}
    this.now = options.now ?? Date.now
    this.alertHandler = options.onAlert
    const config = options.config ?? {}
    const tencent = new TencentProvider({ fetcher: this.fetcher, http: this.http, now: this.now })
    const coingecko = new CoinGeckoProvider({
      fetcher: this.fetcher,
      http: this.http,
      rateLimiter: new RateLimiter(config.coingeckoDelayMs ?? 1_200, this.now),
      now: this.now,
      vsCurrency: config.vsCurrency ?? 'usd',
    })
    this.providers = { tencent, coingecko }
  }

  /** Load persisted state (idempotent). */
  async init(): Promise<PersistedState> {
    return this.store.load()
  }

  private providerFor(market: string): QuoteProvider {
    const provider = this.providers[market === 'crypto' ? 'coingecko' : market === 'cn' ? 'tencent' : '']
    if (provider === undefined) throw new Error(`no market-data provider for market "${market}"`)
    return provider
  }

  /** Group watch items by market, keeping per-code kind hints. */
  private static groupByMarket(items: readonly WatchItem[]): Map<string, { codes: string[]; kindOf: ReadonlyMap<string, string> }> {
    const groups = new Map<string, { codes: string[]; kindOf: ReadonlyMap<string, string> }>()
    for (const item of items) {
      let entry = groups.get(item.market)
      if (entry === undefined) {
        entry = { codes: [], kindOf: new Map() }
        groups.set(item.market, entry)
      }
      entry.codes.push(item.code)
      ;(entry.kindOf as Map<string, string>).set(item.code, item.kind)
    }
    return groups
  }

  // ---------- watchlist ----------

  async watchlist(): Promise<readonly WatchItem[]> {
    const state = await this.store.reload()
    return [...state.items]
  }

  /** Add instrument(s). Valid codes are added, invalid ones reported; nothing is written when everything fails. */
  async watch(input: {
    codes: readonly string[]
    market?: string
    kind?: string
    name?: string
  }): Promise<WatchOutcome> {
    if (input.codes.length === 0) return { added: [], duplicates: [], errors: ['no codes given'] }
    const market = input.market === undefined ? undefined : isMarketArea(input.market) ? input.market : null
    if (input.market !== undefined && market === null) {
      return {
        added: [],
        duplicates: [],
        errors: [`unknown market "${input.market}" (expected one of: ${MARKET_AREAS.join(', ')})`],
      }
    }
    const kind = input.kind === undefined ? undefined : isMarketKind(input.kind) ? input.kind : null
    if (input.kind !== undefined && kind === null) {
      return { added: [], duplicates: [], errors: [`unknown kind "${input.kind}"`] }
    }

    const candidates: WatchItem[] = []
    const duplicates: string[] = []
    const errors: string[] = []
    const state = await this.store.reload()
    const seen = new Set(state.items.map((item) => `${item.market}\u0000${item.code}`))
    for (const raw of input.codes) {
      try {
        const identified = identifyCode(raw, { market: market ?? undefined, kind: kind ?? undefined })
        if (market !== undefined && market !== identified.market) {
          errors.push(`${raw}: conflicts with market "${market}"`)
          continue
        }
        const key = `${identified.market}\u0000${identified.code}`
        if (seen.has(key)) {
          duplicates.push(identified.code)
          continue
        }
        seen.add(key)
        const base: WatchItem = {
          code: identified.code,
          market: identified.market,
          kind: identified.kind,
          addedAt: this.now(),
        }
        // Omit `name` when absent: an undefined own property would violate the
        // lossless-JSON contract of the values tools return.
        candidates.push(input.name === undefined ? base : { ...base, name: input.name })
      } catch (error) {
        errors.push(`${raw}: ${errorMessage(error)}`)
      }
    }
    if (candidates.length > 0) {
      await this.store.mutate((latest) => {
        for (const candidate of candidates) {
          if (!latest.items.some((item) => item.code === candidate.code && item.market === candidate.market)) {
            latest.items.push(candidate)
          }
        }
        return latest
      })
    }
    return { added: candidates, duplicates, errors }
  }

  async unwatch(raw: string): Promise<{ removed: WatchItem[] }> {
    const identified = identifyCode(raw)
    const removed: WatchItem[] = []
    await this.store.mutate((state) => {
      // In-place splice: `items` is a readonly property, so filter-and-reassign
      // is not allowed; backwards iteration keeps indices stable.
      for (let i = state.items.length - 1; i >= 0; i -= 1) {
        const item = state.items[i]
        if (item?.code === identified.code && item.market === identified.market) {
          state.items.splice(i, 1)
          removed.push(item)
        }
      }
      if (removed.length === 0) throw new Error(`not watched: ${identified.code}`)
      return removed
    })
    return { removed }
  }

  // ---------- alert rules ----------

  async rules(): Promise<readonly AlertRule[]> {
    const state = await this.store.reload()
    return [...state.rules]
  }

  async addRule(input: {
    code: string
    field: AlertField
    op: AlertOp
    value: number
    cooldownSeconds: number
    note?: string
  }): Promise<AlertRule> {
    if (!Number.isFinite(input.value)) throw new Error('rule value must be a finite number')
    if (input.cooldownSeconds < 0) throw new Error('cooldown must be >= 0 seconds')
    const identified = identifyCode(input.code)
    const hasNote = input.note !== undefined && input.note !== ''
    const rule: AlertRule = {
      id: newId('alert'),
      code: identified.code,
      field: input.field,
      op: input.op,
      value: input.value,
      cooldownSeconds: Math.round(input.cooldownSeconds),
      enabled: true,
      createdAt: this.now(),
      // Omit `note` when absent: an undefined own property would violate the
      // lossless-JSON contract of the values tools return.
      ...(hasNote ? { note: input.note } : {}),
    }
    await this.store.mutate((state) => {
      state.rules.push(rule)
      return state
    })
    return rule
  }

  async removeRule(id: string): Promise<{ removed: AlertRule }> {
    const removed = await this.store.mutate<AlertRule>((state) => {
      const index = state.rules.findIndex((rule) => rule.id === id)
      if (index === -1) throw new Error(`no such alert rule: ${id}`)
      const found = state.rules[index]
      state.rules.splice(index, 1)
      return found as AlertRule
    })
    return { removed }
  }

  // ---------- quoting ----------

  /** Fetch latest quotes for raw codes, with kind hints from the watchlist. */
  async quote(rawCodes: readonly string[], signal?: AbortSignal): Promise<readonly QuoteResult[]> {
    const items = await this.watchlist()
    const hintOf = new Map(items.map((item) => [`${item.market}\u0000${item.code}`, item.kind]))
    const results: QuoteResult[] = []
    const groups = new Map<string, { codes: string[]; kindOf: Map<string, string> }>()
    for (const raw of rawCodes) {
      try {
        const identified = identifyCode(raw)
        const kind = hintOf.get(`${identified.market}\u0000${identified.code}`) ?? identified.kind
        let group = groups.get(identified.market)
        if (group === undefined) {
          group = { codes: [], kindOf: new Map<string, string>() }
          groups.set(identified.market, group)
        }
        group.codes.push(identified.code)
        group.kindOf.set(identified.code, kind)
      } catch (error) {
        results.push({ ok: false, code: raw, error: errorMessage(error) })
      }
    }
    for (const [market, group] of groups) {
      const provider = this.providerFor(market)
      let fetched: readonly QuoteResult[]
      try {
        fetched = await provider.quote(group.codes, (code) => (group.kindOf.get(code) as MarketKind) ?? 'stock', signal)
      } catch (error) {
        // A failing provider must surface as failed quotes, not crash the poll.
        fetched = group.codes.map((code) => ({ ok: false as const, code, error: errorMessage(error) }))
      }
      results.push(...this.applyWatchNames(fetched, items))
    }
    return results
  }

  /** A user-supplied watch name always wins over the source-resolved one. */
  private applyWatchNames(fetched: readonly QuoteResult[], items: readonly WatchItem[]): QuoteResult[] {
    return fetched.map((result) => {
      if (!result.ok) return result
      const item = items.find((i) => i.code === result.quote.code && i.market === result.quote.market)
      if (item?.name !== undefined) {
        return { ok: true as const, quote: { ...result.quote, name: item.name } }
      }
      return result
    })
  }

  /** Fetch daily history for one code, using the watchlist kind when known. */
  async history(raw: string, count: number, signal?: AbortSignal): Promise<readonly HistoryPoint[]> {
    const items = await this.watchlist()
    const hint = identifyCode(raw)
    const known = items.find((item) => item.code === hint.code && item.market === hint.market)
    const kind = known?.kind ?? hint.kind
    const provider = this.providerFor(hint.market)
    return provider.history(hint.code, kind, clampCount(count), signal)
  }

  // ---------- poll / alerts ----------

  /** Fetch every watched quote and evaluate alert rules once. */
  async poll(): Promise<PollOutcome> {
    const state = await this.store.reload()
    const quotes = await this.fetchQuotes(state.items)
    const quotesByCode = new Map<string, Quote>()
    for (const result of quotes) {
      if (result.ok) quotesByCode.set(result.quote.code, result.quote)
    }
    const fired = evalRules(state.rules, quotesByCode, this.now())
    if (this.alertHandler !== undefined) {
      for (const alert of fired.alerts) {
        try {
          this.alertHandler(alert)
        } catch {
          // Alert delivery must never break the poll loop.
        }
      }
    }
    if (fired.updated.size > 0) {
      await this.store.mutate((latest) => {
        for (const [id, at] of fired.updated) {
          const index = latest.rules.findIndex((r) => r.id === id)
          if (index !== -1) {
            const rule = latest.rules[index] as AlertRule
            latest.rules[index] = { ...rule, lastTriggeredAt: at }
          }
        }
        return latest
      })
    }
    return {
      ok: quotes.filter((r) => r.ok).length,
      failed: quotes.filter((r) => !r.ok).length,
      alerts: fired.alerts.length,
    }
  }

  private async fetchQuotes(items: readonly WatchItem[]): Promise<readonly QuoteResult[]> {
    const results: QuoteResult[] = []
    for (const [market, group] of MarketWatch.groupByMarket(items)) {
      const provider = this.providerFor(market)
      let fetched: readonly QuoteResult[]
      try {
        fetched = await provider.quote(group.codes, (code) => (group.kindOf.get(code) as MarketKind) ?? 'stock')
      } catch (error) {
        fetched = group.codes.map((code) => ({ ok: false as const, code, error: errorMessage(error) }))
      }
      results.push(...this.applyWatchNames(fetched, items))
    }
    return results
  }
}

function clampCount(count: number): number {
  return Math.min(Math.max(Number.isFinite(count) ? count : 30, 1), 640)
}

// ---------- pure alert evaluation ----------

/** Alert evaluation is a pure function of rules + quotes + now — isolated for tests. */
export function evalRules(
  rules: readonly AlertRule[],
  quotes: ReadonlyMap<string, Quote>,
  now: number,
): { alerts: AlertEvent[]; updated: Map<string, number> } {
  const alerts: AlertEvent[] = []
  const updated = new Map<string, number>()
  for (const rule of rules) {
    if (rule.enabled === false) continue
    const quote = quotes.get(rule.code)
    if (quote === undefined) continue
    if (!Number.isFinite(quote.price) || quote.price === 0) continue
    const value = rule.field === 'changePercent' ? quote.changePercent : quote.price
    if (!compare(rule.op, value, rule.value)) continue
    if (rule.lastTriggeredAt !== undefined && now - rule.lastTriggeredAt < rule.cooldownSeconds * 1000) continue
    alerts.push({ rule, quote, message: formatAlertMessage(rule, quote, now), triggeredAt: now })
    updated.set(rule.id, now)
  }
  return { alerts, updated }
}

/** One-line human-readable alert text. */
export function formatAlertMessage(rule: AlertRule, quote: Quote, now: number): string {
  return (
    `[market-watch] ${quote.name || quote.code}(${quote.code}) 提醒触发：${quote.price.toFixed(2)} ${quote.currency}，` +
    `涨跌幅 ${formatPercent(quote.changePercent)}，规则 ${rule.field} ${opSymbol(rule.op)} ${rule.value}` +
    `（冷却 ${rule.cooldownSeconds}s）@ ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`
  )
}

function opSymbol(op: AlertOp): string {
  switch (op) {
    case 'gt':
      return '>'
    case 'gte':
      return '>='
    case 'lt':
      return '<'
    case 'lte':
      return '<='
  }
}

function compare(op: AlertOp, value: number, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
  }
}