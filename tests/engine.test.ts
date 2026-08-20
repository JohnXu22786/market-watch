/**
 * Engine orchestration tests: watch/unwatch persistence, alert evaluation,
 * poll semantics, cooldown handling (all offline via mock fetch).
 * @module tests/engine
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { evalRules, formatAlertMessage, MarketWatch } from '../src/core/engine.js'
import { JsonStore } from '../src/core/store.js'
import type { AlertRule, Quote, WatchItem } from '../src/core/types.js'
import { FakeResponse, makeMockFetch, type RouteRule } from './helpers.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mw-engine-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const TEN_CENT_BODY =
  'v_sh600000="1~PUDONG~600000~9.04~9.10~9.09~571527~263130~308397~9.04~3447~9.03~3155~9.02~4282~9.01~2827~9.00~9170~9.05~170~9.06~1861~9.07~2158~9.08~2267~9.09~3131~~20260817161457~-0.06~-0.66~9.09~8.98~9.04/571527/516755919~571527~51676~0.17~5.88~~9.09~8.98~1.21~3010.85~3010.85~0.40~10.01~8.19~";'
const COIN_GECKO_BODY = JSON.stringify({
  bitcoin: { usd: 63_266, usd_24h_vol: 1e10, usd_24h_change: 0.525 },
})

function tencentRoutes(): RouteRule[] {
  return [
    {
      match: (url) => url.startsWith('https://qt.gtimg.cn/'),
      respond: () => new FakeResponse({ body: TEN_CENT_BODY }),
    },
    {
      match: (url) => url.includes('coins/list'),
      respond: () => new FakeResponse({ body: JSON.stringify([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }]) }),
    },
    {
      match: (url) => url.includes('/simple/price'),
      respond: () => new FakeResponse({ body: COIN_GECKO_BODY }),
    },
  ]
}

async function makeEngine(fetcher: RouteRule[], now?: () => number): Promise<{ engine: MarketWatch; store: JsonStore }> {
  const dir = await tempDir()
  const store = new JsonStore(join(dir, 'watchlist.json'))
  const { fetch } = makeMockFetch(fetcher)
  const engine = new MarketWatch({ store, fetcher: fetch, http: { maxRetries: 0 }, now })
  await engine.init()
  return { engine, store }
}

describe('watch / unwatch', () => {
  it('adds, dedupes, and persists watch items', async () => {
    const { engine, store } = await makeEngine(tencentRoutes())
    const first = await engine.watch({ codes: ['sh600000', 'bitcoin', '600000'] })
    expect(first.added).toHaveLength(2) // 600000 normalizes to sh600000 → duplicate
    expect(first.duplicates).toEqual(['sh600000'])
    const second = await engine.watch({ codes: ['600000.sh'] })
    expect(second.duplicates).toEqual(['sh600000'])

    // A fresh store on the same file sees the persisted state.
    const reloaded = new JsonStore(store.path)
    const state = await reloaded.load()
    expect(state.items.map((i) => i.code)).toEqual(['sh600000', 'bitcoin'])
    expect(state.items[0]?.kind).toBe('stock')
    expect(state.items[1]?.market).toBe('crypto')
  })

  it('rejects conflicting market hints', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    const outcome = await engine.watch({ codes: ['sh600000'], market: 'crypto' })
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.added).toHaveLength(0)
  })

  it('removes by normalized code', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    await engine.watch({ codes: ['600000.sh'] })
    const { removed } = await engine.unwatch('sh600000')
    expect(removed.map((i) => i.code)).toEqual(['sh600000'])
    await expect(engine.unwatch('sh600000')).rejects.toThrow(/not watched/)
  })
})

describe('alert rules', () => {
  it('adds and lists rules with normalization', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    const rule = await engine.addRule({ code: '600000', field: 'changePercent', op: 'lt', value: -5, cooldownSeconds: 60 })
    expect(rule.code).toBe('sh600000')
    const rules = await engine.rules()
    expect(rules).toHaveLength(1)
    expect(rules[0]?.id).toBe(rule.id)
  })

  it('removes rules by id and errors on unknown ids', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    const rule = await engine.addRule({ code: 'bitcoin', field: 'price', op: 'gte', value: 100, cooldownSeconds: 0 })
    await engine.removeRule(rule.id)
    expect(await engine.rules()).toHaveLength(0)
    await expect(engine.removeRule(rule.id)).rejects.toThrow(/no such alert rule/)
  })
})

describe('poll + evalRules', () => {
  it('fires alerts when a rule matches and respects the cooldown', async () => {
    const now = Date.UTC(2026, 7, 17, 8, 0)
    const alerts: string[] = []
    const { engine, store } = await makeEngine(tencentRoutes(), () => now)
    await engine.watch({ codes: ['sh600000'] })
    await engine.addRule({ code: 'sh600000', field: 'changePercent', op: 'lt', value: -0.5, cooldownSeconds: 3600, note: 'watch out' })
    engine.alertHandler = (alert) => alerts.push(alert.message)

    const first = await engine.poll()
    expect(first.alerts).toBe(1)
    expect(alerts).toHaveLength(1)

    // Second poll within the cooldown window must not re-fire.
    const second = await engine.poll()
    expect(second.alerts).toBe(0)
    expect(alerts).toHaveLength(1)

    // The last-triggered timestamp was persisted.
    const state = store.current()
    expect(state.rules[0]?.lastTriggeredAt).toBe(now)
  })

  it('persists the cooldown so a fresh engine never re-fires in-window', async () => {
    const now = Date.UTC(2026, 7, 17, 8, 0)
    const alerts: string[] = []
    const { engine, store } = await makeEngine(tencentRoutes(), () => now)
    await engine.watch({ codes: ['sh600000'] })
    await engine.addRule({ code: 'sh600000', field: 'changePercent', op: 'lt', value: -0.5, cooldownSeconds: 3600 })
    engine.alertHandler = (alert) => alerts.push(alert.message)
    await engine.poll()
    expect(alerts).toHaveLength(1)

    // The timestamp survived on disk.
    const freshStore = new JsonStore(store.path)
    expect((await freshStore.load()).rules[0]?.lastTriggeredAt).toBe(now)

    // A brand-new engine over the same file honors the cooldown: no refire.
    const { fetch } = makeMockFetch(tencentRoutes())
    const freshEngine = new MarketWatch({
      store: freshStore,
      fetcher: fetch,
      http: { maxRetries: 0 },
      now: () => now,
    })
    freshEngine.alertHandler = (alert) => alerts.push(alert.message)
    const outcome = await freshEngine.poll()
    expect(outcome.alerts).toBe(0)
    expect(alerts).toHaveLength(1)
  })

  it('persists lastTriggeredAt only when something fired', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    await engine.watch({ codes: ['sh600000'] })
    await engine.addRule({ code: 'sh600000', field: 'changePercent', op: 'lt', value: -99, cooldownSeconds: 0 })
    await engine.poll()
    expect((await engine.rules())[0]?.lastTriggeredAt).toBeUndefined()
  })

  it('evalRules is a pure function over quotes', () => {
    const rule: AlertRule = {
      id: 'r1',
      code: 'sh600000',
      field: 'price',
      op: 'gte',
      value: 9,
      cooldownSeconds: 0,
      enabled: true,
      createdAt: 0,
    }
    const quote: Quote = {
      code: 'sh600000', name: 'PUDONG', market: 'cn', kind: 'stock', price: 9.04, currency: 'CNY',
      change: -0.06, changePercent: -0.66, open: 9.09, high: 9.09, low: 8.98, prevClose: 9.1,
      volume: 1, amount: 1, ts: 1, source: 'tencent', delayNote: 'd',
    }
    const fired = evalRules([rule], new Map([['sh600000', quote]]), 100)
    expect(fired.alerts).toHaveLength(1)
    expect(fired.updated.get('r1')).toBe(100)

    // Price 0 (suspended) never fires.
    const suspended = evalRules([rule], new Map([['sh600000', { ...quote, price: 0 }]]), 100)
    expect(suspended.alerts).toHaveLength(0)

    // Disabled rule never fires.
    const disabled = evalRules([{ ...rule, enabled: false }], new Map([['sh600000', quote]]), 100)
    expect(disabled.alerts).toHaveLength(0)
  })

  it('formatAlertMessage includes the predicate and cooldown', () => {
    const rule: AlertRule = { id: 'r', code: 'sh600000', field: 'changePercent', op: 'lt', value: -5, cooldownSeconds: 300, enabled: true, createdAt: 0 }
    const quote: Quote = {
      code: 'sh600000', name: 'PUDONG', market: 'cn', kind: 'stock', price: 9.04, currency: 'CNY',
      change: -0.06, changePercent: -0.66, open: null, high: null, low: null, prevClose: 9.1,
      volume: 0, amount: null, ts: 0, source: 'tencent', delayNote: 'd',
    }
    const message = formatAlertMessage(rule, quote, 1000)
    expect(message).toContain('sh600000')
    expect(message).toContain('changePercent < -5')
    expect(message).toContain('300s')
  })

  it('poll reports ok/failed and survives failing providers', async () => {
    let now = 1_000_000
    const { engine } = await makeEngine(tencentRoutes(), () => now)
    await engine.watch({ codes: ['sh600000', 'bitcoin', 'gk-nonexistent'] })
    const outcome = await engine.poll()
    expect(outcome.ok).toBe(2)
    expect(outcome.failed).toBe(1)
    expect(outcome.alerts).toBe(0)

    // A hard network failure surfaces as failed quotes, not a crash.
    const broken = new MarketWatch({
      store: new JsonStore(join(await tempDir(), 'watchlist.json')),
      fetcher: async () => {
        throw new TypeError('offline')
      },
      http: { maxRetries: 0 },
      now: () => now,
    })
    await broken.init()
    await broken.watch({ codes: ['sh600000'] })
    const brokenOutcome = await broken.poll()
    expect(brokenOutcome.ok).toBe(0)
    expect(brokenOutcome.failed).toBe(1)
  })
})

describe('quote / history via engine', () => {
  it('fetchQuotes resolves watch names from the watchlist', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    await engine.watch({ codes: ['sh600000'], name: '浦发银行' })
    const results = await engine.quote(['sh600000'])
    const ok = results.find((r) => r.ok && r.quote.code === 'sh600000')
    expect(ok?.ok).toBe(true)
    if (ok?.ok) expect(ok.quote.name).toBe('浦发银行')
  })

  it('classes kinds from the watchlist for bare codes', async () => {
    const { engine } = await makeEngine(tencentRoutes())
    await engine.watch({ codes: ['600000.sh'], kind: 'stock' })
    const results = await engine.quote(['sh600000'])
    expect(results[0]?.ok).toBe(true)
  })
})