/**
 * Formatting / precision tests.
 * @module tests/format
 */

import { describe, expect, it } from 'vitest'
import type { Quote } from '../src/core/types.js'
import {
  formatMoney,
  formatPercent,
  formatSigned,
  formatQuoteOneLine,
  formatQuoteTable,
  formatDateLabel,
  newId,
  round,
} from '../src/core/format.js'

describe('round', () => {
  it('rounds to the requested decimals (Math.round semantics for exact halves)', () => {
    expect(round(0.125, 2)).toBe(0.13)
    expect(round(-0.125, 2)).toBe(-0.12) // Math.round rounds halves toward +infinity
    expect(round(2.5, 0)).toBe(3)
    expect(round(-2.5, 0)).toBe(-2)
  })

  it('normalizes negative zero', () => {
    expect(Object.is(round(-0.0001, 2), -0)).toBe(false)
    expect(round(-0.0001, 2)).toBe(0)
  })

  it('returns NaN for non-finite input', () => {
    expect(round(Number.NaN, 2)).toBeNaN()
  })

  it('is honest about IEEE binary floats', () => {
    // Deliberate documented behavior: we do NOT paper over binary float
    // representation with an epsilon; rounding is exact for the decimal value
    // actually stored. 1.005 is stored as 1.004999..., so it rounds to 1.
    expect(round(1.005, 2)).toBe(1)
    // 1.1 + 2.2 = 3.3000000000000003 — the classic float example rounds cleanly.
    expect(round(1.1 + 2.2, 1)).toBe(3.3)
  })
})

describe('money/percent formatting', () => {
  it('formats money with thousands and two decimals', () => {
    expect(formatMoney(1234567.891)).toBe('1,234,567.89')
    expect(formatMoney(-12.5)).toBe('-12.50')
    expect(formatMoney(Number.NaN)).toBe('-')
  })

  it('handles currency prefix', () => {
    expect(formatMoney(9.04, 'CNY')).toBe('CNY 9.04')
  })

  it('formats signed percentages', () => {
    expect(formatPercent(1.41)).toBe('+1.41%')
    expect(formatPercent(-0.66)).toBe('-0.66%')
    expect(formatPercent(0)).toBe('0.00%')
  })

  it('formats signed changes with optional currency', () => {
    expect(formatSigned(0.05, 2)).toBe('+0.05')
    expect(formatSigned(-1.2, 2, 'CNY')).toBe('CNY -1.20')
  })
})

describe('quote rendering', () => {
  const quote: Quote = {
    code: 'sh600000',
    name: 'Pudong Bank',
    market: 'cn',
    kind: 'stock',
    price: 9.04,
    currency: 'CNY',
    change: -0.06,
    changePercent: -0.66,
    open: 9.09,
    high: 9.09,
    low: 8.98,
    prevClose: 9.1,
    volume: 571527,
    amount: 516_750_000,
    ts: Date.UTC(2026, 7, 17, 8, 0),
    source: 'tencent',
    delayNote: 'delayed',
  }

  it('produces a one-line summary', () => {
    expect(formatQuoteOneLine(quote)).toBe('Pudong Bank(sh600000) CNY 9.04 (CNY -0.06, -0.66%)')
  })

  it('renders a header-aligned table', () => {
    const table = formatQuoteTable([quote])
    expect(table).toContain('代码')
    expect(table).toContain('sh600000')
    expect(table).toContain('Pudong Bank')
    expect(table).toContain('CNY 9.04')
    expect(table).toContain('-0.66%')
  })
})

describe('date labels', () => {
  it('formats UTC date labels', () => {
    expect(formatDateLabel(Date.UTC(2026, 7, 17))).toBe('08-17')
  })
})

describe('id generation', () => {
  it('emits prefixed unique ids', () => {
    const a = newId('alert')
    const b = newId('alert')
    expect(a.startsWith('alert-')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('edge values', () => {
  it('renders zero without a fake sign', () => {
    expect(formatMoney(0)).toBe('0.00')
    expect(formatSigned(0)).toBe('0.00')
    expect(formatPercent(0)).toBe('0.00%')
  })

  it('renders non-finite values as a dash', () => {
    expect(formatMoney(Number.NaN)).toBe('-')
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('-')
    expect(formatPercent(Number.NaN)).toBe('-')
    expect(formatSigned(Number.NaN)).toBe('-')
  })
})