/**
 * dsh integration-layer smoke tests: tool registration, lossless-JSON value
 * cleanliness, total render functions, and poller timer lifecycle. These run
 * against a fake `ctx` — no Cordis runtime is booted, so dsh-only code paths
 * stay testable offline.
 * @module tests/dsh
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { JsonStore } from '../src/core/store.js'
import { MarketWatch } from '../src/core/engine.js'
import { applyTools } from '../src/dsh/tools.js'
import { startPoller } from '../src/dsh/poller.js'
import { FakeResponse, makeMockFetch } from './helpers.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mw-dsh-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

interface FakeCtx {
  ctx: Context
  registered: ToolDefinition[]
  disposers: (() => void)[]
}

function makeFakeCtx(): FakeCtx {
  const registered: ToolDefinition[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        registered.push(definition)
        const disposer = (): void => {}
        disposers.push(disposer)
        return disposer
      },
    },
    on: () => () => {},
    emit: () => {},
    get: () => undefined,
  } as unknown as Context
  return { ctx, registered, disposers }
}

/** Mock fetch where every market request succeeds but returns no data. */
function emptyRoutes() {
  return [
    { match: (url: string) => url.startsWith('https://qt.gtimg.cn/'), respond: () => new FakeResponse({ body: '' }) },
    {
      match: (url: string) => url.includes('/coins/list'),
      respond: () => new FakeResponse({ body: JSON.stringify([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' }]) }),
    },
    { match: (url: string) => url.includes('/simple/price'), respond: () => new FakeResponse({ body: JSON.stringify({}) }) },
  ]
}

async function makeEngine(overrides: ReturnType<typeof emptyRoutes> = emptyRoutes()): Promise<MarketWatch> {
  const store = new JsonStore(join(await tempDir(), 'watchlist.json'))
  const { fetch } = makeMockFetch(overrides)
  const engine = new MarketWatch({ store, fetcher: fetch, http: { maxRetries: 0 } })
  await engine.init()
  return engine
}

const NO_OP_EXEC = {} as ToolRunContext

describe('tool registration', () => {
  it('registers the six contract tools', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    expect(registered.map((d) => d.name).sort()).toEqual(['alert', 'chart', 'list', 'quote', 'unwatch', 'watch'])
  })
})

describe('tools never produce broken output', () => {
  /** A value with any `undefined` own member is NOT lossless JSON. */
  const assertLossless = (value: unknown): void => {
    expect((Object.entries(value as Record<string, unknown>).filter(([, v]) => v === undefined)).length).toBe(0)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  }

  it('quote returns lossless JSON with no undefined members on total failure', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'quote') as ToolDefinition
    const value = (await (def.execute as (a: unknown, e: ToolRunContext) => Promise<unknown>)({ codes: ['zzz'] }, NO_OP_EXEC)) as Record<string, unknown>
    assertLossless(value)
    expect((value.details as unknown[]).length).toBe(1)
    // render is total over the failure payload.
    const blocks = def.output.render({ codes: ['zzz'] }, value)
    expect(blocks[0]?.type).toBe('text')
    expect((blocks[0] as { text: string }).text).toContain('zzz')
  })

  it('alert add without a note returns lossless JSON', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'alert') as ToolDefinition
    const value = (await (def.execute as (a: unknown, e: ToolRunContext) => Promise<unknown>)(
      { action: 'add', code: 'bitcoin', field: 'price', op: 'gte', value: 100 },
      NO_OP_EXEC,
    )) as Record<string, unknown>
    assertLossless(value)
    expect((value.rule as Record<string, unknown>).note).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(value.rule as object, 'note')).toBe(false)
  })

  it('watch without a name returns lossless JSON', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'watch') as ToolDefinition
    const value = (await (def.execute as (a: unknown, e: ToolRunContext) => Promise<unknown>)(
      { codes: ['bitcoin'] },
      NO_OP_EXEC,
    )) as Record<string, unknown>
    assertLossless(value)
    const added = (value.added as unknown[])[0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(added, 'name')).toBe(false)
  })

  it('list renders failure and empty shapes without throwing', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'list') as ToolDefinition
    const failure = def.output.render({}, { ok: false, error: 'disk error' })
    expect((failure[0] as { text: string }).text).toContain('disk error')
    const empty = def.output.render({}, { items: [] })
    expect((empty[0] as { text: string }).text).toContain('empty')
  })

  it('unwatch renders the not-found failure without throwing', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'unwatch') as ToolDefinition
    const blocks = def.output.render({ code: 'sh600000' }, { ok: false, code: 'sh600000', error: 'not watched: sh600000' })
    expect((blocks[0] as { text: string }).text).toContain('not watched')
  })

  it('watch reports an invalid market hint back to the model', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'watch') as ToolDefinition
    const value = (await (def.execute as (a: unknown, e: ToolRunContext) => Promise<unknown>)(
      { codes: ['sh600000'], market: 'bogus' },
      NO_OP_EXEC,
    )) as { errors: string[] }
    expect(value.errors?.[0]).toContain('unknown market')
    const blocks = def.output.render({ codes: ['sh600000'], market: 'bogus' }, value as never)
    expect((blocks[0] as { text: string }).text).toContain('unknown market')
    // The render must also be total over the I/O-failure shape.
    const failed = def.output.render({ codes: ['sh600000'] }, { ok: false, code: 'sh600000', error: 'EEXIST: disk full' })
    expect((failed[0] as { text: string }).text).toContain('disk full')
  })

  it('alert lists rules and renders a stable line', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'alert') as ToolDefinition
    const value = (await (def.execute as (a: unknown, e: ToolRunContext) => Promise<unknown>)(
      { action: 'list' },
      NO_OP_EXEC,
    )) as Record<string, unknown>
    expect(value.kind).toBe('rules')
    const blocks = def.output.render({ action: 'list' }, value)
    expect((blocks[0] as { text: string }).text).toContain('no alert rules')
  })

  it('chart renders a failure string without throwing', async () => {
    const engine = await makeEngine()
    const { ctx, registered } = makeFakeCtx()
    applyTools(ctx, engine)
    const def = registered.find((d) => d.name === 'chart') as ToolDefinition
    const value = (await (def.execute as (a: unknown, e: ToolRunContext) => Promise<unknown>)(
      { code: 'sh600000', days: 10 },
      NO_OP_EXEC,
    )) as { text: string }
    expect(value.text).toContain('chart failed')
    const blocks = def.output.render({ code: 'sh600000' }, value)
    expect((blocks[0] as { text: string }).text).toContain('chart failed')
  })
})

describe('poller lifecycle', () => {
  it('registers a timer effect and disposes it cleanly', async () => {
    const engine = await makeEngine()
    const effects: (() => void)[] = []
    const logger = { info: () => {}, warn: () => {}, error: () => {} }
    const ctx = {
      effect: (fn: () => (() => void) | void) => {
        const disposer = fn()
        if (typeof disposer === 'function') effects.push(disposer)
        return disposer
      },
      logger: () => logger,
    } as unknown as Context
    startPoller(ctx, engine, { intervalMs: 1000 }, logger as never)
    expect(effects).toHaveLength(1)
    effects[0]!() // unload — clears the interval
    await new Promise((resolve) => setTimeout(resolve, 10)) // give the tick a beat
  })
})