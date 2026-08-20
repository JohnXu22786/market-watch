/**
 * Chart renderer determinism tests.
 * @module tests/chart
 */

import { describe, expect, it } from 'vitest'
import { compactNumber, renderChart, renderColumnChart, renderMermaidChart, sparkline } from '../src/core/chart.js'
import type { HistoryPoint } from '../src/core/types.js'

const day = (offset: number, close: number): HistoryPoint => ({
  ts: Date.UTC(2026, 7, 17 - offset, 0, 0),
  open: close - 1,
  close,
  high: close + 1,
  low: close - 2,
  volume: 1000,
})

describe('sparkline', () => {
  it('renders an empty glyph for empty input', () => {
    expect(sparkline([])).toBe('')
  })

  it('maps flat series to the lowest level', () => {
    expect(sparkline([10, 10, 10, 10])).toBe('▁▁▁▁')
  })

  it('maps a rising ramp to rising characters', () => {
    expect(sparkline([0, 10])).toBe('▁█')
    expect(sparkline([0, 2.5, 5, 7.5, 10])).toBe('▁▃▅▆█')
  })

  it('honors an explicit width', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toHaveLength(5)
  })
})

describe('compactNumber', () => {
  it('compacts units', () => {
    expect(compactNumber(0)).toBe('0.00')
    expect(compactNumber(1500)).toBe('1.5k')
    expect(compactNumber(3_400_000)).toBe('3.4m')
    expect(compactNumber(12e9)).toBe('12b')
    expect(compactNumber(9.04)).toBe('9.04')
  })

  it('handles negatives, extremes, and non-finite input', () => {
    expect(compactNumber(-1500)).toBe('-1.5k')
    expect(compactNumber(-0.5)).toBe('-0.50')
    expect(compactNumber(1234567)).toBe('1.2m')
    expect(compactNumber(Number.NaN)).toBe('-')
    expect(compactNumber(Number.POSITIVE_INFINITY)).toBe('-')
  })
})

describe('renderColumnChart', () => {
  it('renders a deterministic shape for sample data', () => {
    const points = [day(4, 10), day(3, 12), day(2, 9), day(1, 11), day(0, 13)]
    const text = renderColumnChart(points, { width: 12, height: 4, title: 'demo' })
    const lines = text.split('\n')
    expect(lines[0]).toBe('demo')
    expect(lines[1]).toBe('08-13 → 08-17')
    expect(lines[2]).toContain('┤')
    expect(lines[lines.length - 2]).toContain('└')
    expect(lines[lines.length - 1]).toMatch(/08-\d\d\s+08-\d\d/)
  })

  it('handles a single point', () => {
    const text = renderColumnChart([day(0, 5)], { width: 10, height: 4 })
    expect(text).toContain('┤█')
  })

  it('handles flat series without dividing by zero', () => {
    const text = renderColumnChart([day(0, 5), day(1, 5)], { width: 8, height: 4 })
    expect(text).toContain('┤')
    expect(text).not.toContain('NaN')
  })

  it('reports empty input', () => {
    expect(renderColumnChart([], {})).toBe('(no data)')
  })
})

describe('renderMermaidChart / renderChart', () => {
  it('emits a valid xychart-beta block', () => {
    const text = renderMermaidChart([day(2, 10), day(1, 11), day(0, 13)] as HistoryPoint[], { title: 'btc' })
    expect(text).toContain('```mermaid')
    expect(text).toContain('xychart-beta')
    expect(text).toContain('title "btc"')
    expect(text).toContain('line [10, 11, 13]')
    expect(text).toContain('y-axis "price" 10 --> 13')
  })

  it('dispatches ascii/mermaid via renderChart', () => {
    const points = [day(1, 10), day(0, 11)]
    expect(renderChart(points, 'mermaid').text).toContain('xychart-beta')
    expect(renderChart(points, 'ascii').text).toContain('┤')
    expect(renderChart(points, 'ascii').points).toBe(2)
  })
})