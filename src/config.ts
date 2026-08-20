/**
 * Runtime configuration: plugin defaults and the shared data directory
 * resolution used by both the dsh entry and the CLI.
 *
 * The CLI deliberately shares the plugin's home — `$DSH_HOME/market-watch`
 * (defaulting to `~/.dsh/market-watch`) — so `dsh-market-watch` and the
 * plugin operate on the same watchlist file.
 *
 * @module market-watch/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The dsh plugin row config shape. All fields optional; defaults applied here. */
export interface Config {
  /** Master switch for the plugin (row-level `disabled` also works). Default true. */
  readonly enabled?: boolean
  /** Poll period in seconds. Default 60; clamped by the schema to [5, 86 400]. */
  readonly pollIntervalSeconds?: number
  /** Directory holding `watchlist.json`. Defaults to `$DSH_HOME/market-watch`. */
  readonly dataDir?: string
  /** Per-request network timeout in ms. Default 10 000. */
  readonly timeoutMs?: number
  /** Extra attempts after the first try. Default 2. */
  readonly maxRetries?: number
  /** Exponential backoff base in ms between retries. Default 500. */
  readonly retryBackoffBaseMs?: number
  /** Quote currency for crypto quotes (CoinGecko id). Default `usd`. */
  readonly vsCurrency?: string
  /** Minimum ms between consecutive CoinGecko calls. Default 1200. */
  readonly coingeckoDelayMs?: number
  /** Deliver alerts into live dsh agent sessions via `agent.inject`. Default true. */
  readonly agentNotify?: boolean
  /** Wake an idle agent on alert (`agent.followup` instead of `inject`). Default false. */
  readonly agentWakeup?: boolean
}

export interface ResolvedConfig {
  readonly dataDir: string
  readonly watchFilePath: string
  readonly pollIntervalMs: number
  readonly timeoutMs: number
  readonly maxRetries: number
  readonly retryBackoffBaseMs: number
  readonly vsCurrency: string
  readonly coingeckoDelayMs: number
  readonly agentNotify: boolean
  readonly agentWakeup: boolean
}

/** The harness home the dsh CLI composes profiles under. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Where watch data lives by default: `$DSH_HOME/market-watch`. */
export function defaultDataDir(): string {
  return join(dshHome(), 'market-watch')
}

/** Fill every default. `storeFile` lets the CLI reuse the same layout. */
export function resolveConfig(raw: Config | undefined, overrides: { dataDir?: string; pollIntervalSeconds?: number } = {}): ResolvedConfig {
  const dataDir = overrides.dataDir ?? raw?.dataDir ?? defaultDataDir()
  return {
    dataDir,
    watchFilePath: join(dataDir, 'watchlist.json'),
    pollIntervalMs: ((overrides.pollIntervalSeconds ?? raw?.pollIntervalSeconds ?? 60) as number) * 1000,
    timeoutMs: raw?.timeoutMs ?? 10_000,
    maxRetries: raw?.maxRetries ?? 2,
    retryBackoffBaseMs: raw?.retryBackoffBaseMs ?? 500,
    vsCurrency: raw?.vsCurrency ?? 'usd',
    coingeckoDelayMs: raw?.coingeckoDelayMs ?? 1_200,
    agentNotify: raw?.agentNotify ?? true,
    agentWakeup: raw?.agentWakeup ?? false,
  }
}