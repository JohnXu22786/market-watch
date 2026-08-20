/**
 * JsonStore durability tests (all offline).
 * @module tests/store
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../src/core/store.js'
import { STATE_VERSION } from '../src/core/types.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mw-store-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('JsonStore', () => {
  it('bootstraps a fresh file', async () => {
    const dir = await tempDir()
    const store = new JsonStore(join(dir, 'watchlist.json'))
    const state = await store.load()
    expect(state.version).toBe(STATE_VERSION)
    expect(state.items).toEqual([])
    await expect(readFile(join(dir, 'watchlist.json'), 'utf8')).resolves.toContain('"version"')
  })

  it('round-trips mutations and leaves no temp file behind', async () => {
    const dir = await tempDir()
    const store = new JsonStore(join(dir, 'watchlist.json'))
    await store.load()
    await store.mutate((state) => {
      state.items.push({ code: 'sh600000', market: 'cn', kind: 'stock', addedAt: 1 })
      return state
    })
    await store.mutate((state) => {
      state.rules.push({ id: 'r1', code: 'sh600000', field: 'changePercent', op: 'lt', value: -5, cooldownSeconds: 60, enabled: true, createdAt: 1 })
      return state
    })
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])

    const reloaded = new JsonStore(join(dir, 'watchlist.json'))
    const state = await reloaded.load()
    expect(state.items).toHaveLength(1)
    expect(state.rules).toHaveLength(1)
    expect(state.rules[0]?.id).toBe('r1')
  })

  it('serializes concurrent mutations without lost updates', async () => {
    const dir = await tempDir()
    const store = new JsonStore(join(dir, 'watchlist.json'))
    await store.load()
    const ops = Array.from({ length: 20 }, (_, i) =>
      store.mutate((state) => {
        state.items.push({ code: `sh60${String(i).padStart(4, '0')}`, market: 'cn', kind: 'stock', addedAt: i })
        return state
      }),
    )
    await Promise.all(ops)
    const state = await store.load()
    expect(state.items).toHaveLength(20)
  })

  it('quarantines a corrupt file and starts fresh', async () => {
    const dir = await tempDir()
    const file = join(dir, 'watchlist.json')
    await writeFile(file, '{ not json', 'utf8')
    const store = new JsonStore(file)
    const state = await store.load()
    expect(state.items).toEqual([])
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('watchlist.json.corrupt-'))).toBe(true)
    // The store recovered and is usable.
    const after = await store.mutate((s) => s.items.length)
    expect(after).toBe(0)
  })

  it('drops structurally invalid records instead of loading garbage', async () => {
    const dir = await tempDir()
    const file = join(dir, 'watchlist.json')
    await writeFile(
      file,
      JSON.stringify({ version: 1, items: [{ code: 'sh600000' }, null, 'garbage'], rules: [{ id: 'x' }] }),
      'utf8',
    )
    const store = new JsonStore(file)
    const state = await store.load()
    expect(state.items).toEqual([])
    expect(state.rules).toEqual([])
  })

  it('reload picks up edits written by another store instance', async () => {
    const dir = await tempDir()
    const file = join(dir, 'watchlist.json')
    const store = new JsonStore(file)
    await store.load()
    expect(store.current().items).toEqual([])

    // A second writer (e.g. the CLI) mutates the same file.
    const other = new JsonStore(file)
    await other.load()
    await other.mutate((s) => {
      s.items.push({ code: 'sh600000', market: 'cn', kind: 'stock', addedAt: 1 })
      return s
    })

    const state = await store.reload()
    expect(state.items.map((i) => i.code)).toEqual(['sh600000'])
  })

  it('reload keeps the last good state when the file is corrupt', async () => {
    const dir = await tempDir()
    const file = join(dir, 'watchlist.json')
    const store = new JsonStore(file)
    await store.load()
    await store.mutate((s) => {
      s.items.push({ code: 'sh600000', market: 'cn', kind: 'stock', addedAt: 1 })
      return s
    })
    // Another process clobbers the file.
    await writeFile(file, 'not json at all', 'utf8')
    const state = await store.reload()
    expect(state.items.map((i) => i.code)).toEqual(['sh600000'])
  })

  it('mutate quarantines a corrupt file instead of committing stale state', async () => {
    const dir = await tempDir()
    const file = join(dir, 'watchlist.json')
    const store = new JsonStore(file)
    await store.load()
    await store.mutate((s) => {
      s.items.push({ code: 'sh600000', market: 'cn', kind: 'stock', addedAt: 1 })
      return s
    })
    // Another process clobbers the file with garbage.
    await writeFile(file, 'garbage{{{', 'utf8')
    // The mutation must NOT rebuild the snapshot from the stale in-memory copy:
    // the torn file is quarantined, the state starts fresh, the update applies.
    await store.mutate((s) => {
      s.items.push({ code: 'bitcoin', market: 'crypto', kind: 'crypto', addedAt: 2 })
      return s
    })
    expect(store.current().items.map((i) => i.code)).toEqual(['bitcoin'])
    const files = await readdir(dir)
    expect(files.some((f) => f.startsWith('watchlist.json.corrupt-'))).toBe(true)
  })

  it('supports load-after-load and reject reads before load', async () => {
    const dir = await tempDir()
    const store = new JsonStore(join(dir, 'watchlist.json'))
    expect(() => store.current()).toThrow(/load/)
    await store.load()
    expect(store.current().items).toEqual([])
  })
})