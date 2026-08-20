/**
 * Tencent (qt.gtimg.cn) provider for Shanghai / Shenzhen / Beijing securities
 * and broad indices.
 *
 * Wire format notes (verified against the live endpoint):
 * -   `qt.gtimg.cn/q=<code>,...` returns `v_<code>="<fields>";` lines encoded
 *     in GBK — decoded with `TextDecoder('gbk')`.
 * -   Fields are `~`-separated. Relevant indices:
 *     1 name, 2 code, 3 price, 4 prev close, 5 open, 6 volume(手),
 *     30 timestamp `YYYYMMDDHHMMSS`, 31 change, 32 change %, 33 high, 34 low,
 *     37 turnover(万).
 * -   Daily bars come from `web.ifzq.gtimg.cn/appstock/app/fqkline/get`:
 *     `data.<code>.qfqday` (or `.day`) holds `[date, open, close, high, low, volume]`.
 *
 * Free tier caveat documented alongside every quote: quotes may lag the tape
 * by seconds to minutes and are not tradeable-certainty data.
 *
 * @module market-watch/core/providers/tencent
 */

import { fetchText } from '../client.js'
import type { HistoryPoint, MarketArea, MarketKind, Quote, QuoteResult } from '../types.js'
import type { ProviderOptions, QuoteProvider } from './types.js'

const QUOTE_URL = 'https://qt.gtimg.cn/q='
const KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'

export const TEN_CENT_DELAY_NOTE =
  '数据来源：腾讯行情（免费接口），行情可能有数秒至数分钟延迟；非交易时段展示最近收盘值，不构成交易建议。'

function parsePrice(text: string | undefined): number | null {
  if (text === undefined || text === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

function parseTimeField(text: string | undefined, now: () => number): number {
  if (text === undefined || !/^\d{14}$/.test(text)) return now()
  const stamp = Date.parse(
    `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`,
  )
  return Number.isFinite(stamp) ? stamp : now()
}

/** Parse the whole `v_code="...";` response body into per-code field arrays. */
export function parseQuoteLines(body: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  const re = /v_([a-z0-9]+)="([^"]*)";/g
  for (let match = re.exec(body); match !== null; match = re.exec(body)) {
    const code = match[1] as string
    const fields = match[2] !== undefined ? match[2].split('~') : []
    result.set(code, fields)
  }
  return result
}
export class TencentProvider implements QuoteProvider {
  readonly id = 'tencent'
  readonly delayNote = TEN_CENT_DELAY_NOTE

  private readonly fetcher: ProviderOptions['fetcher']
  private readonly http: ProviderOptions['http']
  private readonly now: () => number

  constructor(options: ProviderOptions) {
    this.fetcher = options.fetcher
    this.http = options.http
    this.now = options.now ?? Date.now
  }

  supports(market: MarketArea): boolean {
    return market === 'cn'
  }

  private httpWith(signal: AbortSignal | undefined): ProviderOptions['http'] {
    return signal === undefined ? this.http : { ...this.http, signal }
  }

  async quote(
    codes: readonly string[],
    kindOf: (code: string) => MarketKind,
    signal?: AbortSignal,
  ): Promise<readonly QuoteResult[]> {
    if (codes.length === 0) return []
    const body = await fetchText(`${QUOTE_URL}${codes.join(',')}`, this.fetcher, this.httpWith(signal), 'gbk')
    const parsed = parseQuoteLines(body)
    const results: QuoteResult[] = []
    for (const code of codes) {
      const fields = parsed.get(code)
      if (fields === undefined || fields.length < 40) {
        results.push({ ok: false, code, error: 'no quote returned by tencent' })
        continue
      }
      const price = parsePrice(fields[3])
      const prevClose = parsePrice(fields[4])
      if (price === null || prevClose === null) {
        results.push({ ok: false, code, error: 'tencent returned an unparsable quote' })
        continue
      }
      const change = parsePrice(fields[31]) ?? price - prevClose
      const changePercent = parsePrice(fields[32]) ?? (prevClose === 0 ? 0 : ((price - prevClose) / prevClose) * 100)
      const quote: Quote = {
        code,
        name: fields[1] ?? code,
        market: 'cn',
        kind: kindOf(code),
        price,
        currency: 'CNY',
        change,
        changePercent,
        open: parsePrice(fields[5]),
        high: parsePrice(fields[33]),
        low: parsePrice(fields[34]),
        prevClose,
        volume: parsePrice(fields[6]) ?? 0,
        amount: (parsePrice(fields[37]) ?? 0) * 10_000,
        ts: parseTimeField(fields[30], this.now),
        source: this.id,
        delayNote: this.delayNote,
      }
      results.push({ ok: true, quote })
    }
    return results
  }

  async history(code: string, _kind: MarketKind, count: number, signal?: AbortSignal): Promise<readonly HistoryPoint[]> {
    const requested = Math.min(Math.max(count, 1), 640)
    // The endpoint requires the `,qfq` token for every market — indices return
    // their bars under the `day` key (no adjustment is applied), which the
    // `qfqday ?? day` fallback below handles. Omitting `,qfq` yields a 400.
    const url = `${KLINE_URL}?param=${encodeURIComponent(code)},day,,,${requested},qfq`
    const body = await fetchText(url, this.fetcher, this.httpWith(signal))
    const payload = JSON.parse(body) as Record<string, unknown>
    if (typeof payload.code !== 'undefined' && payload.code !== 0) {
      throw new Error(`tencent kline error for ${code}`)
    }
    const data = payload.data as Record<string, unknown> | undefined
    const series = data?.[code] as Record<string, unknown> | undefined
    const rows = (series?.qfqday ?? series?.day) as unknown
    if (!Array.isArray(rows)) {
      throw new Error(`tencent returned no history for ${code}`)
    }
    const points: HistoryPoint[] = []
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 5) continue
      const [date, open, close, high, low] = row
      const volume = Number(row[5] ?? 0)
      const ts = Date.parse(`${String(date)}T00:00:00Z`)
      if (Number.isFinite(ts)) {
        points.push({
          ts,
          open: Number(open),
          close: Number(close),
          high: Number(high),
          low: Number(low),
          volume: Number.isFinite(volume) ? volume : 0,
        })
      }
    }
    if (points.length === 0) throw new Error(`tencent returned invalid history bars for ${code}`)
    // The endpoint may return a rolling window wider than requested; honor the
    // caller's trailing-window intent (days were the requested semantics).
    return points.slice(-count)
  }
}