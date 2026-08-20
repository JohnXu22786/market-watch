/**
 * CoinGecko free-tier provider for cryptocurrencies.
 *
 * Endpoints used:
 * -   `GET /api/v3/simple/price?ids=<ids>&vs_currencies=<cur>&include_24hr_change=true&include_24hr_vol=true`
 * -   `GET /api/v3/coins/list` — one call, cached in memory, resolves display names
 * -   `GET /api/v3/coins/<id>/market_chart?vs_currency=<cur>&days=<n>` — history
 *
 * Free-tier caveats honored here:
 * -   Requests are spaced by a configurable delay (default 1.2 s) through the
 *     shared rate limiter; a 429 with `Retry-After` is honored by the HTTP
 *     layer's retry logic.
 * -   `market_chart` returns sub-daily granularity for short windows; this
 *     provider buckets points into UTC trading days and emits one bar per day.
 *
 * @module market-watch/core/providers/coingecko
 */

import { fetchText } from '../client.js'
import type { HistoryPoint, MarketArea, MarketKind, Quote, QuoteResult } from '../types.js'
import type { QuoteProvider } from './types.js'

export const COINGECKO_DELAY_NOTE =
  '数据来源：CoinGecko 免费 API；报价可能滞后，具有限流（调用间已按要求间隔）；非投资建议。'

const API_BASE = 'https://api.coingecko.com/api/v3'

interface CoinListItem {
  id: string
  symbol: string
  name: string
}

interface SimplePriceResponse {
  [id: string]: {
    [currency: string]: number | string | undefined
  }
}

export interface CoinGeckoProviderOptions {
  readonly fetcher: typeof fetch
  readonly http: import('../client.js').HttpRequestOptions
  readonly rateLimiter?: import('../client.js').RateLimiter
  readonly now?: () => number
  /** Quote currency per CoinGecko convention, e.g. `usd` (default). */
  readonly vsCurrency?: string
  /** Inject a name source (tests). Defaults to a lazy `/coins/list` fetch. */
  readonly coinList?: () => Promise<CoinListItem[]>
}

export class CoinGeckoProvider implements QuoteProvider {
  readonly id = 'coingecko'
  readonly delayNote = COINGECKO_DELAY_NOTE

  private readonly fetcher: CoinGeckoProviderOptions['fetcher']
  private readonly http: import('../client.js').HttpRequestOptions
  private readonly rateLimiter?: import('../client.js').RateLimiter
  private readonly now: () => number
  private readonly vsCurrency: string
  private readonly coinListSource: () => Promise<CoinListItem[]>
  private listCache: Map<string, string> | null = null

  constructor(options: CoinGeckoProviderOptions) {
    this.fetcher = options.fetcher
    this.http = options.http
    this.rateLimiter = options.rateLimiter
    this.now = options.now ?? Date.now
    this.vsCurrency = options.vsCurrency ?? 'usd'
    this.coinListSource = options.coinList ?? ((): Promise<CoinListItem[]> => this.fetchCoinList())
  }

  supports(market: MarketArea): boolean {
    return market === 'crypto'
  }

  /** Acquire the rate-limit slot, then issue one throttled request. */
  private async request(url: string, signal?: AbortSignal): Promise<string> {
    await this.rateLimiter?.acquire()
    return fetchText(url, this.fetcher, signal === undefined ? this.http : { ...this.http, signal })
  }

  private async fetchCoinList(): Promise<CoinListItem[]> {
    const body = await this.request(`${API_BASE}/coins/list`)
    return JSON.parse(body) as CoinListItem[]
  }

  /** id → display name, cached for the process lifetime. */
  private async names(): Promise<Map<string, string>> {
    if (this.listCache !== null) return this.listCache
    const list = await this.coinListSource()
    this.listCache = new Map(list.map((c) => [c.id, c.name]))
    return this.listCache
  }

  /** A name-table failure must never turn otherwise-good price data into errors. */
  private async safeNames(): Promise<Map<string, string>> {
    try {
      return await this.names()
    } catch {
      return new Map()
    }
  }

  async quote(codes: readonly string[], _kindOf: (code: string) => MarketKind, signal?: AbortSignal): Promise<readonly QuoteResult[]> {
    if (codes.length === 0) return []
    const url = `${API_BASE}/simple/price?ids=${codes.join(',')}&vs_currencies=${this.vsCurrency}&include_24hr_change=true&include_24hr_vol=true`
    const body = await this.request(url, signal)
    let payload: SimplePriceResponse
    try {
      payload = JSON.parse(body) as SimplePriceResponse
    } catch {
      return codes.map((code) => ({ ok: false, code, error: 'coingecko returned an unparsable response' }))
    }
    const names = await this.safeNames()
    const results: QuoteResult[] = []
    for (const code of codes) {
      const entry = payload[code]
      if (entry === undefined) {
        results.push({ ok: false, code, error: 'coingecko returned no price for this id' })
        continue
      }
      const price = entry[this.vsCurrency]
      if (typeof price !== 'number') {
        results.push({ ok: false, code, error: 'coingecko returned no price for this id' })
        continue
      }
      const changePercent = typeof entry[`${this.vsCurrency}_24h_change`] === 'number' ? (entry[`${this.vsCurrency}_24h_change`] as number) : 0
      const volume = typeof entry[`${this.vsCurrency}_24h_vol`] === 'number' ? (entry[`${this.vsCurrency}_24h_vol`] as number) : 0
      const prevClose = changePercent === 0 ? price : price / (1 + changePercent / 100)
      const quote: Quote = {
        code,
        name: names.get(code) ?? code,
        market: 'crypto',
        kind: 'crypto',
        price,
        currency: this.vsCurrency.toUpperCase(),
        change: price - prevClose,
        changePercent,
        open: null,
        high: null,
        low: null,
        prevClose,
        volume,
        amount: null,
        ts: this.now(),
        source: this.id,
        delayNote: this.delayNote,
      }
      results.push({ ok: true, quote })
    }
    return results
  }

  async history(code: string, _kind: MarketKind, days: number, signal?: AbortSignal): Promise<readonly HistoryPoint[]> {
    const clamped = Math.min(Math.max(days, 1), 365)
    const url = `${API_BASE}/coins/${encodeURIComponent(code)}/market_chart?vs_currency=${this.vsCurrency}&days=${clamped}`
    const body = await this.request(url, signal)
    const payload = JSON.parse(body) as { prices?: [number, number][] }
    if (payload?.prices === undefined) throw new Error(`coingecko returned no history for ${code}`)
    // Bucket sub-daily points into UTC days, keeping OHLCV per day.
    const buckets = new Map<string, { open: number; close: number; high: number; low: number; volume: number }>()
    for (const [ts, price] of payload.prices) {
      const day = new Date(ts).toISOString().slice(0, 10)
      const existing = buckets.get(day)
      if (existing === undefined) {
        buckets.set(day, { open: price, close: price, high: price, low: price, volume: 0 })
      } else {
        existing.close = price
        existing.high = Math.max(existing.high, price)
        existing.low = Math.min(existing.low, price)
      }
    }
    // Volumes arrive in a parallel array from the same endpoint; when the
    // format changes we still return OHLC rather than failing the chart.
    const volumePayload = payload as { total_volumes?: [number, number][] }
    const volumes = new Map<number, number>()
    for (const [ts, vol] of volumePayload.total_volumes ?? []) volumes.set(dayKey(ts), vol)
    const points: HistoryPoint[] = []
    for (const [day, bar] of buckets) {
      const dayTs = Date.parse(`${day}T00:00:00Z`)
      points.push({
        ts: dayTs,
        open: bar.open,
        close: bar.close,
        high: bar.high,
        low: bar.low,
        volume: volumes.get(dayTs) ?? 0,
      })
    }
    points.sort((a, b) => a.ts - b.ts)
    return points
  }
}

function dayKey(ts: number): number {
  return Date.parse(`${new Date(ts).toISOString().slice(0, 10)}T00:00:00Z`)
}