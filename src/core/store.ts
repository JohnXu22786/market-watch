/**
 * Local JSON persistence for the watchlist + alert rules.
 *
 * Durability model:
 * -   Writes go to a temp file in the same directory, then `rename` over the
 *     target. `rename` is atomic on POSIX and maps to `MoveFileEx(MOVEFILE_
 *     REPLACE_EXISTING)` on Windows, so readers never observe a truncated file
 *     and a crash mid-write leaves the previous contents intact.
 * -   All mutations run on a single promise chain so concurrent writers
 *     (poll loop + tool/CLI calls) serialize without lost updates.
 * -   A corrupt existing file is quarantined to `<name>.corrupt-<ts>` once and
 *     the store starts fresh, losing only that file rather than wedging the
 *     plugin.
 *
 * @module market-watch/core/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AlertRule, PersistedState, WatchItem } from './types.js'
import { STATE_VERSION } from './types.js'

export interface StoreLogger {
  /** Ordinary diagnostic line (stderr for CLI, logger.info for dsh). */
  info(message: string): void
  /** A recoverable problem occurred. */
  warn(message: string): void
}

/** No-op logger for embedders that don't care. */
const silentLogger: StoreLogger = {
  info: () => {},
  warn: () => {},
}

export class JsonStore {
  private state: PersistedState | null = null
  /** Promise chain tail; every mutation is appended so writes serialize. */
  private tail: Promise<unknown> = Promise.resolve()
  private initialized = false

  constructor(
    private readonly filePath: string,
    private readonly logger: StoreLogger = silentLogger,
  ) {}

  get path(): string {
    return this.filePath
  }

  /** Load (or bootstrap) the state document and enable read access. */
  async load(): Promise<PersistedState> {
    if (this.initialized) return this.state as PersistedState
    await mkdir(dirname(this.filePath), { recursive: true })
    let text: string | null = null
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`market-watch: cannot read ${this.filePath}, starting fresh: ${errorMessage(error)}`)
        await this.quarantine('unreadable')
        text = null
      }
    }
    if (text !== null) {
      try {
        this.state = normalizeState(JSON.parse(text) as unknown, this.filePath)
      } catch {
        this.logger.warn(`market-watch: ${this.filePath} is not valid JSON, starting fresh`)
        await this.quarantine('corrupt')
        this.state = freshState()
      }
    } else {
      this.state = freshState()
      await this.writeLocked()
    }
    this.initialized = true
    return this.state
  }

  /** Snapshot of the current in-memory state (must load() first). */
  current(): PersistedState {
    if (this.state === null) throw new Error('JsonStore.load() must be awaited before access')
    return this.state
  }

  /**
   * Run a mutation and persist afterwards. The updater may mutate the state
   * object in place or return a replacement; either way the write is serial
   * with respect to every other mutation. The mutation is applied to the
   * newest persisted state (a second process — e.g. the CLI — may have written
   * to the file since this store last read it), so a write never silently
   * reverts another writer's edits.
   */
  async mutate<T>(updater: (state: PersistedState) => T): Promise<T> {
    const run = this.tail.then(async () => {
      await this.load()
      // Strict re-read: if the file cannot be read now, abort the write rather
      // than commit a stale snapshot that would revert another writer's edits.
      await this.reapplyFromDisk(true)
      const state = this.state as PersistedState
      const result = updater(state)
      await this.writeLocked()
      return result
    })
    this.tail = run.catch(() => {})
    return run
  }

  /**
   * Re-read the state document from disk. The plugin and the CLI can share one
   * file: a second process's edits become visible on the next poll/quotation.
   * The returned state replaces the in-memory one; callers must not hold older
   * references across a reload.
   */
  async reload(): Promise<PersistedState> {
    const run = this.tail.then(async () => {
      await this.load()
      await this.reapplyFromDisk(false)
      return this.state as PersistedState
    })
    this.tail = run.catch(() => {})
    return run
  }

  /**
   * Refresh the in-memory state from disk.
   * - `strict` (write path): any non-ENOENT read failure throws so the
   *   mutation is aborted instead of committing possibly-stale data.
   * - non-strict (read path): a non-ENOENT failure keeps the last good state.
   */
  private async reapplyFromDisk(strict: boolean): Promise<void> {
    let text: string | null = null
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = freshState()
        return
      }
      if (strict) throw error
      this.logger.warn(`market-watch: cannot re-read ${this.filePath}: ${errorMessage(error)}`)
      return
    }
    try {
      this.state = normalizeState(JSON.parse(text) as unknown, this.filePath)
    } catch {
      if (strict) {
        // Write path: never commit a stale snapshot over a torn file — and
        // don't let the torn file wedge every later mutation. Quarantine it
        // (forensics copy) and continue from a fresh state.
        this.logger.warn(`market-watch: ${this.filePath} is not valid JSON; quarantining and starting fresh`)
        await this.quarantine('corrupt')
        this.state = freshState()
        return
      }
      // Read path: keep whatever we last had in memory rather than dropping
      // the user's watchlist on the floor.
      this.logger.warn(`market-watch: ${this.filePath} is not valid JSON while reloading, keeping last good state`)
    }
  }

  private async writeLocked(): Promise<void> {
    const state = this.current()
    const tmp = join(dirname(this.filePath), `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }

  /** Keep a broken file for forensics instead of silently deleting it. */
  private async quarantine(reason: string): Promise<void> {
    try {
      await rename(this.filePath, `${this.filePath}.${reason}-${Date.now()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`market-watch: failed to quarantine ${this.filePath}: ${errorMessage(error)}`)
      }
    }
  }
}

function freshState(): PersistedState {
  return { version: STATE_VERSION, items: [], rules: [] }
}

/** Tolerate missing fields / unknown versions rather than crashing the poll loop. */
function normalizeState(parsed: unknown, source: string): PersistedState {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${source}: state document is not an object`)
  }
  const record = parsed as { version?: unknown; items?: unknown; rules?: unknown }
  const items = Array.isArray(record.items) ? record.items.filter(isWatchItem) : []
  const rules = Array.isArray(record.rules) ? record.rules.filter(isAlertRule) : []
  return {
    version: typeof record.version === 'number' ? record.version : STATE_VERSION,
    items,
    rules,
  }
}

/** Structural sanity check: tolerates hand-edited files but never loads garbage. */
function isWatchItem(value: unknown): value is WatchItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as { code?: unknown; market?: unknown; kind?: unknown; addedAt?: unknown }
  return (
    typeof item.code === 'string' &&
    typeof item.market === 'string' &&
    typeof item.kind === 'string' &&
    typeof item.addedAt === 'number'
  )
}

function isAlertRule(value: unknown): value is AlertRule {
  if (typeof value !== 'object' || value === null) return false
  const rule = value as {
    id?: unknown
    code?: unknown
    field?: unknown
    op?: unknown
    value?: unknown
    cooldownSeconds?: unknown
    enabled?: unknown
    createdAt?: unknown
  }
  return (
    typeof rule.id === 'string' &&
    typeof (rule.code ?? '') === 'string' &&
    typeof rule.field === 'string' &&
    typeof rule.op === 'string' &&
    typeof rule.value === 'number' &&
    typeof rule.cooldownSeconds === 'number' &&
    typeof rule.enabled === 'boolean' &&
    typeof rule.createdAt === 'number'
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}