#!/usr/bin/env node
/**
 * dsh-market-watch — standalone CLI twin of the dsh plugin.
 *
 * Shares the same data directory (`$DSH_HOME/market-watch`, i.e. the plugin's
 * own `dataDir` default), so commands issued here act on the exact state the
 * plugin polls.
 *
 * Usage:
 *   dsh-market-watch quote [--days n] <code...>
 *   dsh-market-watch watch [--market cn|crypto] [--kind stock|index|crypto] [--name n] <code...>
 *   dsh-market-watch unwatch <code...>
 *   dsh-market-watch list
 *   dsh-market-watch alert list | alert add <code> --field f --op o --value v [--cooldown s] [--note t] | alert remove <id>
 *   dsh-market-watch chart <code> [--days n] [--format ascii|mermaid] [--width w] [--height h]
 *   dsh-market-watch poll [--once] [--interval s]
 *
 * Global flags: --data-dir <path> (or env MARKET_WATCH_DATA_DIR), -h/--help, --version.
 *
 * @module market-watch/cli
 */

import { JsonStore } from '../core/store.js'
import { MarketWatch } from '../core/engine.js'
import { resolveConfig } from '../config.js'
import type { QuoteResult } from '../core/types.js'
import { formatQuoteResults, formatDateLabel, formatClock } from '../core/format.js'
import { renderChart, sparkline } from '../core/chart.js'
import { errorMessage } from '../core/errors.js'
import { MARKET_AREAS, MARKET_KINDS, isMarketArea, isMarketKind } from '../core/kinds.js'
import type { AlertField, AlertOp } from '../core/types.js'

const VERSION = '0.1.0'

function parseFlags(args: readonly string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1))
      } else {
        const key = arg.slice(2)
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next)
          i += 1
        } else {
          flags.set(key, '')
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(arg.slice(1), next)
        i += 1
      } else {
        flags.set(arg.slice(1), '')
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function usage(): string {
  return `dsh-market-watch ${VERSION}

Usage: dsh-market-watch <command> [options] [args...]

Commands:
  quote <code...>          latest quotes (--days n adds a sparkline)
  list                     show the local watchlist
  watch <code...>          add instruments (--market cn|crypto, --kind stock|index|crypto, --name NAME)
  unwatch <code...>        remove instruments
  alert list | add | remove   manage threshold alert rules
  chart <code>             trailing-days chart (--days n, --format ascii|mermaid, --width w, --height h)
  poll                     poll watchlist + evaluate alerts continuously (--once runs a single pass)

Global:
  --data-dir <path>        data directory (default $DSH_HOME/market-watch, env MARKET_WATCH_DATA_DIR also honored)
  -h, --help               show this help
  -v, --version            print version
`
}

async function main(argv: readonly string[]): Promise<number> {
  const { flags, positional } = parseFlags(argv)
  if (flags.has('help') || flags.has('h')) {
    process.stdout.write(usage())
    return 0
  }
  if (flags.has('version') || flags.has('v')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const command = positional[0]
  if (command === undefined) {
    process.stderr.write(usage())
    return 2
  }
  const args = positional.slice(1)
  const dataDir = flags.get('data-dir') ?? process.env.MARKET_WATCH_DATA_DIR

  const config = resolveConfig(undefined, {
    dataDir,
    pollIntervalSeconds: flags.has('interval') ? Number(flags.get('interval')) : undefined,
  })
  const store = new JsonStore(config.watchFilePath, {
    info: (message) => process.stderr.write(`${message}\n`),
    warn: (message) => process.stderr.write(`${message}\n`),
  })
  const engine = new MarketWatch({
    store,
    http: { timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, backoffBaseMs: config.retryBackoffBaseMs },
    config: { vsCurrency: config.vsCurrency, coingeckoDelayMs: config.coingeckoDelayMs },
  })
  await engine.init()

  const codeArgs = flags.get('code') ? [flags.get('code')!] : args
  switch (command) {
    case 'quote':
      return cmdQuote(engine, codeArgs, flags)
    case 'list':
      return cmdList(engine)
    case 'watch':
      return cmdWatch(engine, codeArgs, flags)
    case 'unwatch':
      return cmdUnwatch(engine, codeArgs)
    case 'alert':
      return cmdAlert(engine, flags, args)
    case 'chart':
      return cmdChart(engine, codeArgs, flags)
    case 'poll':
      return cmdPoll(engine, flags)
    default:
      process.stderr.write(`unknown command "${command}"\n\n${usage()}`)
      return 2
  }
}

async function cmdQuote(engine: MarketWatch, codes: readonly string[], flags: Map<string, string>): Promise<number> {
  if (codes.length === 0) {
    process.stderr.write('quote requires at least one code\n')
    return 2
  }
  try {
    const results = (await engine.quote(codes)) as QuoteResult[]
    const note = results.find((r) => r.ok)?.quote.delayNote
    process.stdout.write(formatQuoteResults(results, note))
    const days = flags.has('days') ? Number(flags.get('days')) : NaN
    if (Number.isInteger(days) && days >= 1) {
      process.stdout.write('\n')
      for (const result of results) {
        if (!result.ok) continue
        try {
          const points = await engine.history(result.quote.code, Math.min(days, 90))
          process.stdout.write(`${result.quote.code} ${formatDateLabel(points[0]?.ts ?? 0)} → ${formatDateLabel(points[points.length - 1]?.ts ?? 0)} ${sparkline(points.map((p) => p.close), Math.min(days, 60))}\n`)
        } catch {
          process.stdout.write(`${result.quote.code} (history unavailable)\n`)
        }
      }
    }
    return 0
  } catch (error) {
    process.stderr.write(`quote failed: ${errorMessage(error)}\n`)
    return 1
  }
}

async function cmdList(engine: MarketWatch): Promise<number> {
  const items = await engine.watchlist()
  if (items.length === 0) {
    process.stdout.write('watchlist is empty — use `watch` to add instruments\n')
    return 0
  }
  for (const item of items) {
    process.stdout.write(
      `${item.code}\t${item.name ?? ''}\t${item.market}/${item.kind}\t${new Date(item.addedAt).toISOString()}\n`,
    )
  }
  return 0
}

async function cmdWatch(engine: MarketWatch, codes: readonly string[], flags: Map<string, string>): Promise<number> {
  if (codes.length === 0) {
    process.stderr.write('watch requires at least one code\n')
    return 2
  }
  const market = flags.get('market')
  const kind = flags.get('kind')
  if (market !== undefined && !isMarketArea(market)) {
    process.stderr.write(`unknown market "${market}" (one of: ${MARKET_AREAS.join(', ')})\n`)
    return 2
  }
  if (kind !== undefined && !isMarketKind(kind)) {
    process.stderr.write(`unknown kind "${kind}" (one of: ${MARKET_KINDS.join(', ')})\n`)
    return 2
  }
  const outcome = await engine.watch({ codes, market, kind, name: flags.get('name') })
  for (const item of outcome.added) process.stdout.write(`+ watched ${item.code} (${item.market}/${item.kind})\n`)
  for (const dup of outcome.duplicates) process.stdout.write(`= already watched ${dup}\n`)
  for (const err of outcome.errors) process.stderr.write(`x ${err}\n`)
  return outcome.errors.length > 0 ? 1 : 0
}

async function cmdUnwatch(engine: MarketWatch, codes: readonly string[]): Promise<number> {
  if (codes.length === 0) {
    process.stderr.write('unwatch requires at least one code\n')
    return 2
  }
  let failed = false
  for (const code of codes) {
    try {
      const { removed } = await engine.unwatch(code)
      for (const item of removed) process.stdout.write(`- unwatched ${item.code}\n`)
    } catch (error) {
      failed = true
      process.stderr.write(`x ${code}: ${errorMessage(error)}\n`)
    }
  }
  return failed ? 1 : 0
}

async function cmdAlert(engine: MarketWatch, flags: Map<string, string>, args: readonly string[]): Promise<number> {
  const action = args[0]
  try {
    switch (action) {
      case 'list': {
        const rules = await engine.rules()
        if (rules.length === 0) {
          process.stdout.write('no alert rules\n')
          return 0
        }
        for (const rule of rules) {
          process.stdout.write(
            `${rule.id}\t${rule.code}\t${rule.field} ${rule.op} ${rule.value}\tcooldown ${rule.cooldownSeconds}s\t${rule.enabled ? 'enabled' : 'disabled'}\tlast ${rule.lastTriggeredAt === undefined ? 'never' : formatClock(rule.lastTriggeredAt)}\t${rule.note ?? ''}\n`,
          )
        }
        return 0
      }
      case 'add': {
        const code = flags.get('code') ?? args[1]
        if (code === undefined) {
          process.stderr.write('alert add requires a code (alert add <code> --field f --op o --value v)\n')
          return 2
        }
        const field = flags.get('field')
        const op = flags.get('op')
        const value = Number(flags.get('value'))
        if (!isField(field) || !isOp(op) || !Number.isFinite(value)) {
          process.stderr.write('alert add requires --field changePercent|price, --op gt|gte|lt|lte and --value <number>\n')
          return 2
        }
        const cooldown = flags.has('cooldown') ? Number(flags.get('cooldown')) : 300
        if (!Number.isInteger(cooldown) || cooldown < 0) {
          process.stderr.write('--cooldown must be a non-negative integer (seconds)\n')
          return 2
        }
        const rule = await engine.addRule({
          code,
          field,
          op,
          value,
          cooldownSeconds: cooldown,
          note: flags.get('note'),
        })
        process.stdout.write(`+ rule ${rule.id}: ${rule.code} ${rule.field} ${rule.op} ${rule.value} (cooldown ${rule.cooldownSeconds}s)\n`)
        return 0
      }
      case 'remove': {
        const id = flags.get('id') ?? args[1]
        if (id === undefined) {
          process.stderr.write('alert remove requires --id <rule id> (see `alert list`)\n')
          return 2
        }
        const { removed } = await engine.removeRule(id)
        process.stdout.write(`- removed rule ${removed.id}\n`)
        return 0
      }
      default:
        process.stderr.write('alert expects list | add | remove\n')
        return 2
    }
  } catch (error) {
    process.stderr.write(`alert failed: ${errorMessage(error)}\n`)
    return 1
  }
}

async function cmdChart(engine: MarketWatch, codes: readonly string[], flags: Map<string, string>): Promise<number> {
  const code = codes[0]
  if (code === undefined) {
    process.stderr.write('chart requires exactly one code\n')
    return 2
  }
  const days = flags.has('days') ? Number(flags.get('days')) : 30
  const width = flags.has('width') ? Number(flags.get('width')) : 60
  const height = flags.has('height') ? Number(flags.get('height')) : 10
  if (!Number.isFinite(days) || days < 1 || !Number.isFinite(width) || !Number.isFinite(height)) {
    process.stderr.write('chart bounds are invalid\n')
    return 2
  }
  try {
    const points = await engine.history(code, Math.min(Math.max(days, 1), 365))
    const format = flags.get('format') === 'mermaid' ? 'mermaid' : 'ascii'
    const rendered = renderChart(points, format, { width, height, title: code })
    process.stdout.write(`${rendered.text}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`chart failed: ${errorMessage(error)}\n`)
    return 1
  }
}

async function cmdPoll(engine: MarketWatch, flags: Map<string, string>): Promise<number> {
  const once = flags.has('once')
  let lastPassOk = true
  const runPass = async (): Promise<void> => {
    try {
      const outcome = await engine.poll()
      lastPassOk = true
      process.stderr.write(`poll pass: ${outcome.ok} ok, ${outcome.failed} failed, ${outcome.alerts} alert(s)\n`)
    } catch (error) {
      lastPassOk = false
      process.stderr.write(`poll failed: ${errorMessage(error)}\n`)
    }
  }
  if (once) {
    await runPass()
    return lastPassOk ? 0 : 1
  }
  await runPass()
  const intervalMs = Number(flags.get('interval')) > 0 ? Number(flags.get('interval')) * 1000 : undefined
  const timer = setInterval(async () => void runPass(), intervalMs ?? 60_000)
  const shutdown = (): void => {
    clearInterval(timer)
    // exitCode (not process.exit): lets in-flight fetches settle so libuv
    // sockets close cleanly on Windows.
    process.exitCode = 0
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return 0
}

function isField(value: string | undefined): value is AlertField {
  return value === 'changePercent' || value === 'price'
}

function isOp(value: string | undefined): value is AlertOp {
  return value === 'gt' || value === 'gte' || value === 'lt' || value === 'lte'
}

main(process.argv.slice(2))
  .then((code) => {
    // exitCode (not process.exit): lets pending fetch sockets close cleanly.
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`fatal: ${errorMessage(error)}\n`)
    process.exitCode = 1
  })