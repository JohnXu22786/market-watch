/**
 * CoinGecko provider parsing tests (offline fixtures).
 * @module tests/providers.coingecko
 */

import { describe, expect, it } from 'vitest'
import { CoinGeckoProvider } from '../src/core/providers/coingecko.js'
import { FakeResponse } from './helpers.js'

const COIN_LIST = [
  { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
]

function provider(opts: { vsCurrency?: string } = {}): CoinGeckoProvider {
  return new CoinGeckoProvider({
    fetcher: () => new FakeResponse({ body: JSON.stringify(COIN_LIST) }),
    http: { maxRetries: 0 },
    vsCurrency: opts.vsCurrency,
    coinList: async () => COIN_LIST,
  })
}

describe('CoinGeckoProvider', () => {
  it('maps simple/price onto a quote', async () => {
    const provider = new CoinGeckoProvider({
      fetcher: (url) => {
        if (String(url).includes('/coins/list')) return new FakeResponse({ body: JSON.stringify(COIN_LIST) })
        const body = {
          bitcoin: { usd: 63_266, usd_24h_vol: 13_942_674_437.17, usd_24h_change: 0.525 },
        }
        return new FakeResponse({ body: JSON.stringify(body) })
      },
      http: { maxRetries: 0 },
      coinList: async () => COIN_LIST,
    })
    const results = await provider.quote(['bitcoin'], () => 'crypto')
    expect(results).toHaveLength(1)
    const quote = (results[0] as { ok: true; quote: import('../src/core/types.js').Quote }).quote
    expect(quote.name).toBe('Bitcoin')
    expect(quote.price).toBe(63_266)
    expect(quote.currency).toBe('USD')
    expect(quote.changePercent).toBeCloseTo(0.525)
    expect(quote.prevClose).toBeCloseTo(63_266 / 1.00525)
    expect(quote.change).toBeCloseTo(63_266 - 63_266 / 1.00525)
    expect(quote.kind).toBe('crypto')
    expect(quote.open).toBeNull()
  })

  it('flags unknown ids as failures', async () => {
    const p = provider()
    const results = await p.quote(['nometacoin'], () => 'crypto')
    expect(results[0]?.ok).toBe(false)
  })

  it('declines to serve non-crypto markets', () => {
    expect(provider().supports('crypto')).toBe(true)
    expect(provider().supports('cn')).toBe(false)
  })

  it('buckets market_chart points into daily bars', async () => {
    const p = new CoinGeckoProvider({
      fetcher: (url) => {
        if (String(url).includes('/coins/list')) return new FakeResponse({ body: JSON.stringify(COIN_LIST) })
        const dayA = Date.UTC(2026, 7, 17, 0, 0)
        const dayB = Date.UTC(2026, 7, 18, 0, 0)
        return new FakeResponse({
          body: JSON.stringify({
            prices: [
              [dayA, 63_000],
              [dayA + 3_600_000, 63_500],
              [dayA + 7_200_000, 63_200],
              [dayB, 63_900],
              [dayB + 7_200_000, 64_100],
            ],
            total_volumes: [
              [dayA, 1_000],
              [dayB, 2_000],
            ],
          }),
        })
      },
      http: { maxRetries: 0 },
      coinList: async () => COIN_LIST,
    })
    const points = await p.history('bitcoin', 'crypto', 5)
    expect(points).toHaveLength(2)
    expect(points[0]!.ts).toBe(Date.parse('2026-08-17T00:00:00Z'))
    expect(points[0]!.open).toBe(63_000)
    expect(points[0]!.close).toBe(63_200)
    expect(points[0]!.high).toBe(63_500)
    expect(points[0]!.low).toBe(63_000)
    expect(points[0]!.volume).toBe(1_000)
    expect(points[1]!.close).toBe(64_100)
    expect(points[1]!.volume).toBe(2_000)
  })

  it('throws on missing history payloads', async () => {
    const p = new CoinGeckoProvider({
      fetcher: (url) => {
        if (String(url).includes('/coins/list')) return new FakeResponse({ body: JSON.stringify(COIN_LIST) })
        return new FakeResponse({ body: JSON.stringify({ error: 'too many requests' }) })
      },
      http: { maxRetries: 0 },
      coinList: async () => COIN_LIST,
    })
    await expect(p.history('bitcoin', 'crypto', 5)).rejects.toThrow(/no history/)
  })

  it('degrades to zero volume when total_volumes is absent', async () => {
    const p = new CoinGeckoProvider({
      fetcher: (url) => {
        if (String(url).includes('/coins/list')) return new FakeResponse({ body: JSON.stringify(COIN_LIST) })
        const day = Date.UTC(2026, 7, 17, 0, 0)
        return new FakeResponse({
          body: JSON.stringify({
            prices: [
              [day, 63_000],
              [day + 3_600_000, 63_500],
            ],
          }),
        })
      },
      http: { maxRetries: 0 },
      coinList: async () => COIN_LIST,
    })
    const points = await p.history('bitcoin', 'crypto', 2)
    expect(points).toHaveLength(1)
    expect(points[0]!.volume).toBe(0)
    expect(points[0]!.open).toBe(63_000)
    expect(points[0]!.close).toBe(63_500)
  })

  it('handles a single-day series', async () => {
    const p = new CoinGeckoProvider({
      fetcher: (url) => {
        if (String(url).includes('/coins/list')) return new FakeResponse({ body: JSON.stringify(COIN_LIST) })
        const day = Date.UTC(2026, 7, 17, 0, 0)
        return new FakeResponse({ body: JSON.stringify({ prices: [[day, 42]] }) })
      },
      http: { maxRetries: 0 },
      coinList: async () => COIN_LIST,
    })
    const points = await p.history('bitcoin', 'crypto', 1)
    expect(points).toHaveLength(1)
    expect(points[0]!.close).toBe(42)
  })
})