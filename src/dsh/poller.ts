/**
 * Periodic polling loop backed by a plain timer wrapped in `ctx.effect`.
 *
 * dsh provides no scheduler API for fixed intervals on `ctx.jobs` (that seam
 * is for one-shot background tasks); the harness's own tutorial pattern for a
 * repeating timer is exactly this: acquire the interval inside `ctx.effect`
 * and return a disposer, so hot reload / unload clears the timer.
 *
 * Concurrency guard: overlapping ticks are dropped (the poll only re-enters
 * after the current pass settles), so a slow network cannot stack reads
 * against the free-tier endpoints.
 *
 * @module market-watch/dsh/poller
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Logger } from '@deepseek-ai/cordis'
import type { MarketWatch } from '../core/engine.js'

export interface PollerOptions {
  /** Milliseconds between ticks (clamped >= 5000 so the free sources survive). */
  readonly intervalMs: number
}

export function startPoller(ctx: Context, engine: MarketWatch, options: PollerOptions, logger: Logger): void {
  const intervalMs = Math.max(5_000, options.intervalMs)
  ctx.effect(() => {
    let running = false
    const tick = async (): Promise<void> => {
      if (running) return
      running = true
      try {
        const outcome = await engine.poll()
        if (outcome.failed > 0) {
          logger.warn(`poll: ${outcome.ok} ok, ${outcome.failed} failed, ${outcome.alerts} alert(s)`)
        } else if (outcome.alerts > 0) {
          logger.info(`poll: ${outcome.alerts} alert(s) fired`)
        }
      } catch (error) {
        logger.error(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => void tick(), intervalMs)
    void tick()
    return () => {
      clearInterval(timer)
    }
  })
}