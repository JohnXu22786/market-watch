/**
 * dsh-market-watch — financial market monitor bundle for DeepSeek Harness.
 *
 * Bundle entry point: exports `name`, `inject`, `Config`, and `apply` per the
 * Cordis contract used by every dsh plugin. Mounted as the `market-watch` row
 * from `cordis.patch.yml`; override its config there by id (a patch replaces
 * the whole config value).
 *
 * @module dsh-market-watch
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { JsonStore } from './core/store.js'
import { MarketWatch } from './core/engine.js'
import { resolveConfig } from './config.js'
import type { Config as PluginConfig } from './config.js'
import { applyTools } from './dsh/tools.js'
import { startPoller } from './dsh/poller.js'
import { buildNotifier } from './dsh/notify.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'market-watch'

/** Services required before this plugin loads. */
export const inject = ['tools']

export { MarketWatch } from './core/engine.js'
export type { EngineConfig, EngineOptions, PollOutcome, WatchOutcome } from './core/engine.js'
export { JsonStore } from './core/store.js'
export { evalRules, formatAlertMessage } from './core/engine.js'
export { renderChart, renderColumnChart, renderMermaidChart, sparkline } from './core/chart.js'
export { identifyCode, CodeError } from './core/symbols.js'
export type { StoreLogger } from './core/store.js'

export const Config: z<PluginConfig> = z.object({
  enabled: z.boolean().default(true),
  pollIntervalSeconds: z.natural().min(5).max(86_400).default(60),
  dataDir: z.string(),
  timeoutMs: z.natural().min(100).max(120_000).default(10_000),
  maxRetries: z.natural().max(5).default(2),
  retryBackoffBaseMs: z.natural().max(60_000).default(500),
  vsCurrency: z.string().default('usd'),
  coingeckoDelayMs: z.natural().max(60_000).default(1_200),
  agentNotify: z.boolean().default(true),
  agentWakeup: z.boolean().default(false),
})

/** Apply-time behavior (after schemastery filled the defaults). */
type Resolved = Required<PluginConfig>

export function apply(ctx: Context, config: PluginConfig): void {
  const resolvedConfig = resolveConfig(config)
  const resolved = config as Resolved
  if (resolved.enabled === false) return

  const logger = ctx.logger(name)
  const store = new JsonStore(resolvedConfig.watchFilePath, {
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
  })
  const engine = new MarketWatch({
    store,
    http: {
      timeoutMs: resolved.timeoutMs,
      maxRetries: resolved.maxRetries,
      backoffBaseMs: resolved.retryBackoffBaseMs,
    },
    config: {
      vsCurrency: resolved.vsCurrency,
      coingeckoDelayMs: resolved.coingeckoDelayMs,
    },
  })

  const notifier = buildNotifier(ctx, { agentNotify: resolved.agentNotify, agentWakeup: resolved.agentWakeup })
  engine.alertHandler = (alert) => notifier(alert)

  // Watchlist loads lazily on first use; surface early I/O failures loudly so
  // misconfiguration shows up at boot rather than at the first poll.
  void engine.init().catch((error) => {
    logger.error(`market-watch: cannot initialize data directory: ${error instanceof Error ? error.message : String(error)}`)
  })

  applyTools(ctx, engine)
  startPoller(ctx, engine, { intervalMs: resolvedConfig.pollIntervalMs }, logger)
}