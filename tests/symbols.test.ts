/**
 * Code normalization / validation tests.
 * @module tests/symbols
 */

import { describe, expect, it } from 'vitest'
import { CodeError, identifyCode } from '../src/core/symbols.js'

describe('identifyCode', () => {
  it('keeps explicit exchange prefixes', () => {
    expect(identifyCode('sh600000')).toEqual({ code: 'sh600000', market: 'cn', kind: 'stock' })
    expect(identifyCode('sz000858')).toEqual({ code: 'sz000858', market: 'cn', kind: 'stock' })
    expect(identifyCode('000001', { kind: 'index' })).toEqual({ code: 'sh000001', market: 'cn', kind: 'index' })
  })

  it('normalizes suffixes and case', () => {
    expect(identifyCode('600000.SH')).toEqual({ code: 'sh600000', market: 'cn', kind: 'stock' })
    expect(identifyCode('000858.sz ')).toEqual({ code: 'sz000858', market: 'cn', kind: 'stock' })
    expect(identifyCode('600000.ss')).toEqual({ code: 'sh600000', market: 'cn', kind: 'stock' })
  })

  it('infers exchange from bare digits', () => {
    expect(identifyCode('600000')).toEqual({ code: 'sh600000', market: 'cn', kind: 'stock' })
    expect(identifyCode('300750')).toEqual({ code: 'sz300750', market: 'cn', kind: 'stock' })
    expect(identifyCode('920002')).toEqual({ code: 'bj920002', market: 'cn', kind: 'stock' })
    expect(identifyCode('510300')).toEqual({ code: 'sh510300', market: 'cn', kind: 'stock' }) // funds → sh
    expect(identifyCode('900901')).toEqual({ code: 'sh900901', market: 'cn', kind: 'stock' }) // B shares → sh
    expect(identifyCode('430047')).toEqual({ code: 'bj430047', market: 'cn', kind: 'stock' }) // BSE → bj
    expect(identifyCode('920002.bj')).toEqual({ code: 'bj920002', market: 'cn', kind: 'stock' })
  })

  it('infers the index kind from a bare 399 prefix without a hint', () => {
    expect(identifyCode('399001')).toEqual({ code: 'sz399001', market: 'cn', kind: 'index' })
  })

  it('treats bare index prefixes as indices with an explicit hint', () => {
    expect(identifyCode('000001', { kind: 'index' })).toEqual({ code: 'sh000001', market: 'cn', kind: 'index' })
    expect(identifyCode('399001', { kind: 'index' })).toEqual({ code: 'sz399001', market: 'cn', kind: 'index' })
  })

  it('classifies everything else as crypto', () => {
    expect(identifyCode('bitcoin')).toEqual({ code: 'bitcoin', market: 'crypto', kind: 'crypto' })
    expect(identifyCode('ethereum ')).toEqual({ code: 'ethereum', market: 'crypto', kind: 'crypto' })
  })

  it('rejects empty and overlong input', () => {
    expect(() => identifyCode('')).toThrow(CodeError)
    expect(() => identifyCode('   ')).toThrow(CodeError)
    expect(() => identifyCode('a'.repeat(33))).toThrow(CodeError)
  })

  it('normalizes whitespace and case for crypto codes', () => {
    expect(identifyCode(' BTC ')).toEqual({ code: 'btc', market: 'crypto', kind: 'crypto' })
    expect(identifyCode('BitCoin')).toEqual({ code: 'bitcoin', market: 'crypto', kind: 'crypto' })
    expect(identifyCode('  ethereum  ')).toEqual({ code: 'ethereum', market: 'crypto', kind: 'crypto' })
  })
})