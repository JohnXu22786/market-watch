/**
 * Decimal, money, and table formatting shared by the tool renderers and the CLI.
 *
 * All money math in this plugin works on plain numbers; rounding is deferred to
 * display time so alert comparisons never see rounded inputs. Floating point is
 * the one hazard: we round to a sensible decimal count rather than printing raw
 * binary expansions such as 0.30000000000000004.
 *
 * @module market-watch/core/format
 */

import type { Quote, QuoteResult } from './types.js'

/** Round to `digits` decimals, guarding against `-0` outputs. */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return NaN
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  // Normalize negative zero: -0.00 renders confusingly.
  return rounded === 0 ? 0 : rounded
}

/** Fixed-width decimal string with thousands separators. `-` for non-finite. */
export function formatMoney(value: number, currency?: string, digits = 2): string {
  if (!Number.isFinite(value)) return '-'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  const cur = currency ? `${currency} ` : ''
  return `${cur}${sign}${body}`
}

/** Signed percentage with one sign digit, e.g. `+1.41%` / `-0.66%`. */
export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '-'
  const rounded = round(value, digits)
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded.toFixed(digits)}%`
}

/** Signed absolute change, e.g. `+0.05` / `-1.20`. */
export function formatSigned(value: number, digits = 2, currency?: string): string {
  if (!Number.isFinite(value)) return '-'
  const rounded = round(value, digits)
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${formatMoney(rounded, currency, digits)}`
}

/** For a single quote: `name(code) price (change, percent)` line. */
export function formatQuoteOneLine(quote: Quote): string {
  const name = quote.name || quote.code
  return `${name}(${quote.code}) ${formatMoney(quote.price, quote.currency)} (${formatSigned(
    quote.change,
    2,
    quote.currency,
  )}, ${formatPercent(quote.changePercent)})`
}

function padEnd(text: string, width: number): string {
  // CJK glyphs are double-width; approximate display width for clean tables.
  const widthOf = (s: string): number => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xff ? 2 : 1), 0)
  const diff = width - widthOf(text)
  // At least one space separates columns, even when a cell overflows its width.
  return text + ' '.repeat(Math.max(1, diff))
}

/** Multi-row quote table used by the `quote` tool and CLI. */
export function formatQuoteTable(quotes: readonly Quote[], delayNote?: string): string {
  if (quotes.length === 0) return 'no quotes'
  const header = ['代码', '名称', '现价', '涨跌', '涨跌幅', '今开', '最高', '最低']
  const cols = [12, 10, 15, 15, 10, 14, 14, 14]
  const rows: string[][] = quotes.map((q) => [
    q.code,
    q.name || q.code,
    formatMoney(q.price, q.currency),
    formatSigned(q.change, 2, q.currency),
    formatPercent(q.changePercent),
    q.open === null ? '-' : formatMoney(q.open),
    q.high === null ? '-' : formatMoney(q.high),
    q.low === null ? '-' : formatMoney(q.low),
  ])
  const lines = [
    header.map((h, i) => padEnd(h, cols[i] ?? 12)).join(''),
    ...rows.map((r) => r.map((cell, i) => padEnd(cell, cols[i] ?? 12)).join('')),
  ]
  if (delayNote) lines.push(`\n${delayNote}`)
  return lines.join('\n')
}

/** One line per result (ok or failure), for compact tool/CLI output. */
export function formatQuoteResults(results: readonly QuoteResult[], delayNote?: string): string {
  const ok = results.filter((r): r is Extract<QuoteResult, { ok: true }> => r.ok)
  const failed = results.filter((r): r is Extract<QuoteResult, { ok: false }> => !r.ok)
  const blocks: string[] = []
  if (ok.length > 0) blocks.push(formatQuoteTable(ok.map((r) => r.quote), delayNote))
  for (const f of failed) blocks.push(`${f.code}: ${f.error}`)
  return blocks.join('\n')
}

/** Render a short human timestamp for alert lines (local time). */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** YYYY-MM-DD label for chart x-axes. */
export function formatDateLabel(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

/** Stable id generator (crypto-random enough for local rule ids). */

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  const time = Date.now().toString(36).slice(-6)
  return `${prefix}-${time}${rand}`
}