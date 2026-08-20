/**
 * Provider contract for market data backends.
 *
 * A provider owns the wire format of one backend (Tencent for A-share/HK,
 * CoinGecko for crypto) and normalizes results into the shared domain types.
 * Providers never mutate persisted state — the engine does that.
 *
 * @module market-watch/core/providers/types
 */

import type { FetchLike, HttpRequestOptions, RateLimiter } from '../client.js'
import type { HistoryPoint, MarketArea, MarketKind, QuoteResult } from '../types.js'
export interface ProviderOptions {
  /** Injectable fetch (tests substitute a mock). */
  readonly fetcher: FetchLike
  /** Shared request policy (timeouts/retries). */
  readonly http: HttpRequestOptions
  /** Shared rate limiter for calls to this backend. */
  readonly rateLimiter?: RateLimiter
  /** Injectable clock (tests). */
  readonly now?: () => number
}

export interface QuoteProvider {
  /** Stable provider id stored on every Quote (`source` field). */
  readonly id: string
  /** Data-delay disclaimer text attached to quotes. */
  readonly delayNote: string
  /** Whether this backend serves the given regional market. */
  supports(market: MarketArea): boolean
  /**
   * Fetch latest quotes.
   * @param codes - normalized codes (already classified via {@link kindOf})
   * @param kindOf - per-code instrument kind (crypto codes say `crypto`)
   * @param signal - caller cancellation (e.g. a tool execution signal)
   */
  quote(codes: readonly string[], kindOf: (code: string) => MarketKind, signal?: AbortSignal): Promise<readonly QuoteResult[]>
  /** Fetch the trailing `count` daily bars. */
  history(code: string, kind: MarketKind, count: number, signal?: AbortSignal): Promise<readonly HistoryPoint[]>
}