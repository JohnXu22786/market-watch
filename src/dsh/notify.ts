/**
 * dsh delivery seam for fired alerts.
 *
 * Two channels, both optional and silenced on failure:
 * 1.   A typed harness event `market-watch/alert` (always emitted) so any
 *      extension (UI layer, messenger plugins, logging) can observe alerts.
 * 2.   Direct session delivery: when `ctx.agents` is mounted, each live agent
 *      receives the alert as a plugin-sourced `user/message` in its next
 *      pre-step (`agent.inject`), or as a full follow-up turn when
 *      `agentWakeup` is enabled.
 *
 * @module market-watch/dsh/notify
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AlertEvent } from '../core/types.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'market-watch/alert'(alert: AlertEvent): void
  }
}

/** The plugin id stamped onto plugin-sourced messages. */
export const SOURCE_PLUGIN = 'market-watch'

export interface NotifyOptions {
  /** Push alerts into every live agent session (default true). */
  readonly agentNotify: boolean
  /** Wake idle agents with a follow-up turn instead of quiet context injection. */
  readonly agentWakeup: boolean
}

/** Build the alert delivery callback wired into the engine. */
export function buildNotifier(ctx: Context, options: NotifyOptions): (alert: AlertEvent) => void {
  return (alert) => {
    ctx.emit('market-watch/alert', alert)
    if (!options.agentNotify) return
    try {
      deliverToAgents(ctx, alert, options.agentWakeup)
    } catch {
      // Agent delivery is best-effort; never break the poll loop over it.
    }
  }
}

function deliverToAgents(ctx: Context, alert: AlertEvent, wakeup: boolean): void {
  const registry = ctx.get('agents') as AgentRegistry | undefined
  if (registry === undefined) return
  const message = createUserMessage({
    content: [{ type: 'text', text: alert.message }],
    source: { kind: 'plugin', plugin: SOURCE_PLUGIN, form: 'relay' },
  })
  for (const agent of registry.list()) {
    try {
      if (wakeup) {
        agent.followup(message)
      } else {
        agent.inject(message)
      }
    } catch {
      // One unhealthy agent must not block delivery to the rest.
    }
  }
}