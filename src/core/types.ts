/**
 * Shared domain vocabulary for dsh-market-watch.
 *
 * These types are UI-agnostic: both the dsh plugin surface and the standalone
 * CLI consume them, so no dsh/Cordis import may appear in this module.
 * @module market-watch/core/types
 */

/** Security kind of a quoteable instrument. */
export type MarketKind = 'stock' | 'index' | 'crypto'

/** Regional market a code belongs to. `cn` covers Shanghai/Shenzhen/Beijing exchanges. */
export type MarketArea = 'cn' | 'crypto'

/** A locally persisted watch item (code/name/market/type). */
export interface WatchItem {
  /** Normalized code, e.g. `sh600000`, `sz000858`, `sh000001`, or a CoinGecko id like `bitcoin`. */
  readonly code: string
  /** Optional user-supplied display name; when absent the name is resolved from the data source. */
  readonly name?: string
  readonly market: MarketArea
  readonly kind: MarketKind
  /** Unix epoch milliseconds when the item was added. */
  readonly addedAt: number
}

/** One normalized latest quote. Field meaning is documented per source in the providers. */
export interface Quote {
  readonly code: string
  readonly name: string
  readonly market: MarketArea
  readonly kind: MarketKind
  /** Latest traded price. */
  readonly price: number
  readonly currency: string
  /** Absolute change against `prevClose`. */
  readonly change: number
  /** Relative change in percent (e.g. `-0.66` means -0.66%). */
  readonly changePercent: number
  /** Session open; `null` when the source does not expose it. */
  readonly open: number | null
  readonly high: number | null
  readonly low: number | null
  readonly prevClose: number
  /** Traded volume in the source's native unit (shares/lots for CN, coins for crypto). */
  readonly volume: number
  /** Turnover in `currency` when exposed by the source. */
  readonly amount: number | null
  /** Unix epoch milliseconds the quote describes (source timestamp). */
  readonly ts: number
  /** Provider id (`tencent` or `coingecko`). */
  readonly source: string
  /** Human-readable data-delay disclaimer of the source. */
  readonly delayNote: string
}

/** One daily history point. For CN daily bars the timestamp is midnight UTC of the trading day. */
export interface HistoryPoint {
  readonly ts: number
  readonly open: number
  readonly close: number
  readonly high: number
  readonly low: number
  readonly volume: number
}

/** Quote lookup outcome — successful quotes + per-code failures side by side. */
export type QuoteResult =
  | { readonly ok: true; readonly quote: Quote }
  | { readonly ok: false; readonly code: string; readonly error: string }

/** Field an alert rule watches. */
export type AlertField = 'changePercent' | 'price'

/** Comparison operator against a numeric threshold. */
export type AlertOp = 'gt' | 'gte' | 'lt' | 'lte'

/** One persisted alert rule, owned by the watchlist file (not per-session). */
export interface AlertRule {
  readonly id: string
  /** Normalized instrument code the rule watches. */
  readonly code: string
  readonly field: AlertField
  readonly op: AlertOp
  readonly value: number
  /** Minimum seconds between two triggers of this rule (dedupe window). */
  readonly cooldownSeconds: number
  readonly enabled: boolean
  /** Free-form note rendered alongside the rule in listings. */
  readonly note?: string
  readonly createdAt: number
  /** Unix epoch milliseconds of the last trigger; drives the cooldown window. */
  readonly lastTriggeredAt?: number
}

/** A rule that fired, scheduled for delivery. */
export interface AlertEvent {
  readonly rule: AlertRule
  readonly quote: Quote
  /** One-line human-readable alert text. */
  readonly message: string
  readonly triggeredAt: number
}

/** The whole local persistence document (watchlist + rules). */
export interface PersistedState {
  readonly version: number
  readonly items: WatchItem[]
  readonly rules: AlertRule[]
}

/** Current file format version written by this plugin. */
export const STATE_VERSION = 1