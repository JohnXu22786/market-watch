/**
 * In-chat visualizations: an ASCII sparkline, a monospaced column chart, and a
 * mermaid `xychart-beta` snippet. All renderers are pure functions over the
 * close-price series so tests can assert exact output.
 *
 * @module market-watch/core/chart
 */

import { formatDateLabel, round } from './format.js'
import type { HistoryPoint } from './types.js'

export interface ChartOptions {
  /** Column width of the plot area (default 60). */
  readonly width?: number
  /** Row height of the plot area (default 10). */
  readonly height?: number
  /** Series label rendered above the chart (default empty). */
  readonly title?: string
}

const SPARK_CHARS = '▁▂▃▄▅▆▇█'

/** Tiny single-line trend glyph from `values` mapped onto 8 levels. */
export function sparkline(values: readonly number[], width = 40): string {
  if (values.length === 0) return ''
  if (values.length === 1) {
    return SPARK_CHARS[Math.min(7, Math.max(0, Math.round(values[0]! * 7)))]!
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  return pickEvenly(values, Math.max(2, width))
    .map((value) => levelChar(value, min, span))
    .join('')
}

/** Pick `n` evenly spaced samples (first and last always included). */
function pickEvenly<T>(values: readonly T[], n: number): T[] {
  if (n <= 1) return [values[0] as T]
  if (n >= values.length) return [...values]
  const picked: T[] = []
  for (let i = 0; i < n; i += 1) {
    const index = Math.round((i * (values.length - 1)) / (n - 1))
    picked.push(values[index]!)
  }
  return picked
}

function levelChar(value: number, min: number, span: number): string {
  if (!Number.isFinite(value)) return SPARK_CHARS[0]!
  const ratio = span === 0 ? 0 : (value - min) / span
  const level = Math.min(7, Math.max(0, Math.round(ratio * 7)))
  return SPARK_CHARS[level]!
}

/** Compact y-axis tick label (`1.2k`, `3.4m`, plain decimals otherwise). */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${round(value / 1e9, 1)}b`
  if (abs >= 1e6) return `${round(value / 1e6, 1)}m`
  if (abs >= 1e3) return `${round(value / 1e3, 1)}k`
  return round(value, 2).toFixed(2)
}

const AXIS_WIDTH = 8

interface ColumnSpec {
  readonly height: number
  readonly value: number
}

/**
 * Render a monospaced column chart of daily closes:
 *
 * ```
 * 浦发银行 最近14日
 * 2026-07-28 → 2026-08-17
 *   10.4 ┤███·████████████████
 *    9.9 ┤██████████████████████
 *    9.4 ┤██████████████████████
 *    8.9 ┤████████████████████████
 *    8.4 ┤███████████████████████┐
 *         └──────┬─────────┬─────┘
 *         07-28      08-10      08-17
 * ```
 *
 * Deterministic: same points + options always render identical output, which
 * is what the snapshot tests rely on.
 */
export function renderColumnChart(points: readonly HistoryPoint[], options: ChartOptions = {}): string {
  const width = Math.max(4, options.width ?? 60)
  const height = Math.max(3, options.height ?? 10)
  const title = options.title ?? ''
  if (points.length === 0) return title === '' ? '(no data)' : `${title}\n(no data)`

  const closes = points.map((p) => p.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min
  const pad = span === 0 ? Math.max(Math.abs(max) * 0.05, 0.5) : span * 0.08
  const top = max + pad
  const bottom = Math.max(0, min - pad)
  const plotSpan = top - bottom

  const columns: ColumnSpec[] = pickEvenly(points, Math.max(2, Math.min(width, points.length))).map((p) => ({
    height: Math.round(((p.close - bottom) / plotSpan) * (height - 1)),
    value: p.close,
  }))

  const rows: string[] = []
  for (let row = 0; row < height; row += 1) {
    const level = height - 1 - row
    const valueAt = bottom + (level / (height - 1)) * plotSpan
    const label = compactNumber(valueAt).padStart(AXIS_WIDTH - 2)
    const bars = columns.map((c) => (c.height >= level ? '█' : ' ')).join('')
    rows.push(`${label} ┤${bars}`)
  }

  const edge = '─'.repeat(Math.max(0, columns.length - 1))
  const xAxisLine = `${' '.repeat(AXIS_WIDTH)}└${edge}┘`
  const labels = axisLegend(points, columns.length)
  const header: string[] = []
  if (title !== '') header.push(title)
  header.push(`${formatDateLabel(points[0]!.ts)} → ${formatDateLabel(points[points.length - 1]!.ts)}`)
  return [...header, ...rows, xAxisLine, labels].join('\n')
}

/** Up to three spaced date labels under the axis (start / middle / end). */
function axisLegend(points: readonly HistoryPoint[], columns: number): string {
  const count = Math.min(3, points.length)
  const indices = Array.from({ length: count }, (_, i) =>
    Math.round((i * (points.length - 1)) / Math.max(1, count - 1)),
  )
  const positions = indices.map((index) => Math.round((index / Math.max(1, points.length - 1)) * columns))
  let line = ''
  let cursor = 0
  for (let i = 0; i < indices.length; i += 1) {
    const start = Math.max(positions[i]!, cursor)
    const label = formatDateLabel(points[indices[i]!]!.ts)
    line += `${' '.repeat(Math.max(0, start - line.length))}${label}`
    cursor = line.length + 1 // keep a one-character gutter between labels
  }
  return `${' '.repeat(AXIS_WIDTH)}${line}`
}

/**
 * Render a mermaid `xychart-beta` block for chat UIs that support mermaid.
 */
export function renderMermaidChart(points: readonly HistoryPoint[], options: ChartOptions = {}): string {
  const width = Math.max(4, options.width ?? 40)
  const title = options.title ?? 'price'
  if (points.length === 0) return '```mermaid\n(none)\n```'
  const picked = pickEvenly(points, Math.max(1, Math.min(width, points.length)))
  const labels = picked.map((p) => formatDateLabel(p.ts)).join(', ')
  const values = picked.map((p) => `${round(p.close, 2)}`).join(', ')
  const closes = picked.map((p) => p.close)
  const minimum = Math.min(...closes)
  const maximum = Math.max(...closes)
  return [
    '```mermaid',
    'xychart-beta',
    `  title "${title}"`,
    `  x-axis [${labels}]`,
    `  y-axis "price" ${Math.floor(minimum)} --> ${Math.ceil(maximum)}`,
    `  line [${values}]`,
    '```',
  ].join('\n')
}

export interface ChartRender {
  readonly text: string
  readonly points: number
}

/** Entry point used by both the tool and the CLI. */
export function renderChart(
  points: readonly HistoryPoint[],
  format: 'ascii' | 'mermaid',
  options: ChartOptions = {},
): ChartRender {
  const text = format === 'mermaid' ? renderMermaidChart(points, options) : renderColumnChart(points, options)
  return { text, points: points.length }
}