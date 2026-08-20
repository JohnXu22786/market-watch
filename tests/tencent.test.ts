/**
 * Tencent provider parsing tests (offline fixtures).
 * @module tests/providers.tencent
 */

import { describe, expect, it } from 'vitest'
import { TencentProvider, parseQuoteLines } from '../src/core/providers/tencent.js'
import { FakeResponse } from './helpers.js'

/** ASCII-bodied stand-in for the GBK wire format (numbers matter, names ASCII). */
const BODY =
  'v_sh600000="1~PUDONG~600000~9.04~9.10~9.09~571527~263130~308397~9.04~3447~9.03~3155~9.02~4282~9.01~2827~9.00~9170~9.05~170~9.06~1861~9.07~2158~9.08~2267~9.09~3131~~20260817161457~-0.06~-0.66~9.09~8.98~9.04/571527/516755919~571527~51676~0.17~5.88~~9.09~8.98~1.21~3010.85~3010.85~0.40~10.01~8.19~1.11~13294~9.04~4.86~6.02~~~0.05~51675.5919~6.0568~67~";\n' +
  'v_sh000001="1~INDEX~000001~3982.65~3927.18~3930.10~489834027~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20260817161402~55.47~1.41~3983.51~3924.47~3982.65/489834027/1112818620627~489834027~111281862~1.01~18.40~~3983.51~3924.47~1.50~622241.14~706558.12~0.00~-1~-1~0.93~0~3950.77~";'

describe('parseQuoteLines', () => {
  it('splits every v_<code> entry into fields', () => {
    const parsed = parseQuoteLines(BODY)
    expect(parsed.size).toBe(2)
    const fields = parsed.get('sh600000')
    expect(fields?.[1]).toBe('PUDONG')
    expect(fields?.[3]).toBe('9.04')
  })

  it('survives empty bodies', () => {
    expect(parseQuoteLines('').size).toBe(0)
  })
})

describe('TencentProvider.quote', () => {
  it('maps wire fields onto normalized quotes', async () => {
    const realFetch = () => new FakeResponse({ body: BODY })
    const provider = new TencentProvider({
      fetcher: realFetch,
      http: { maxRetries: 0 },
      now: () => Date.UTC(2026, 7, 17, 8, 14, 57),
    })
    const results = await provider.quote(['sh600000', 'sh000001'], (code) => (code === 'sh000001' ? 'index' : 'stock'))
    expect(results).toHaveLength(2)

    const stock = (results[0] as { ok: true; quote: import('../src/core/types.js').Quote }).quote
    expect(stock.code).toBe('sh600000')
    expect(stock.name).toBe('PUDONG')
    expect(stock.price).toBe(9.04)
    expect(stock.prevClose).toBe(9.1)
    expect(stock.change).toBe(-0.06)
    expect(stock.changePercent).toBe(-0.66)
    expect(stock.open).toBe(9.09)
    expect(stock.high).toBe(9.09)
    expect(stock.low).toBe(8.98)
    expect(stock.volume).toBe(571527)
    expect(stock.amount).toBe(516_760_000) // field 37 in 万 × 10 000
    expect(stock.currency).toBe('CNY')
    expect(stock.source).toBe('tencent')
    expect(stock.ts).toBe(Date.parse('2026-08-17T16:14:57+08:00'))

    const index = (results[1] as { ok: true; quote: import('../src/core/types.js').Quote }).quote
    expect(index.kind).toBe('index')
    expect(index.changePercent).toBe(1.41)
  })

  it('reports missing quotes as failures', async () => {
    const provider = new TencentProvider({ fetcher: () => new FakeResponse({ body: BODY }), http: { maxRetries: 0 } })
    const results = await provider.quote(['sz999999'], () => 'stock')
    expect(results[0]).toEqual({ ok: false, code: 'sz999999', error: 'no quote returned by tencent' })
  })
})

describe('TencentProvider.history', () => {
  const KLINE_FIXTURE = {
    code: 0,
    msg: '',
    data: {
      sh600000: {
        qfqday: [
          ['2026-08-10', '9.200', '9.290', '9.380', '9.160', '625425.000'],
          ['2026-08-11', '9.270', '9.210', '9.340', '9.180', '509424.000'],
          ['2026-08-17', '9.09', '9.04', '9.09', '8.98', '571527'],
        ],
      },
    },
  }

  it('parses qfqday rows into daily bars', async () => {
    const provider = new TencentProvider({
      fetcher: () => new FakeResponse({ body: JSON.stringify(KLINE_FIXTURE) }),
      http: { maxRetries: 0 },
    })
    const points = await provider.history('sh600000', 'stock', 30)
    expect(points).toHaveLength(3)
    expect(points[0]!.ts).toBe(Date.parse('2026-08-10T00:00:00Z'))
    expect(points[0]!.open).toBe(9.2)
    expect(points[0]!.close).toBe(9.29)
    expect(points[0]!.high).toBe(9.38)
    expect(points[0]!.low).toBe(9.16)
    expect(points[0]!.volume).toBe(625425)
  })

  it('throws when the series is absent', async () => {
    const provider = new TencentProvider({
      fetcher: () => new FakeResponse({ body: JSON.stringify({ code: 0, data: {} }) }),
      http: { maxRetries: 0 },
    })
    await expect(provider.history('sh600000', 'stock', 30)).rejects.toThrow(/no history/)
  })
})

describe('GBK decoding (env check)', () => {
  it('decodes Chinese names with TextDecoder("gbk")', () => {
    const bytes = new Uint8Array([0xc6, 0xd6, 0xb7, 0xa2, 0xd2, 0xf8, 0xd0, 0xd0])
    expect(new TextDecoder('gbk').decode(bytes)).toBe('浦发银行')
  })
})

describe('TencentProvider wire path', () => {
  it('decodes a real GBK name field through provider.quote', async () => {
    // The provider must decode with TextDecoder('gbk'), not utf-8: same ASCII
    // numbers would parse either way, so this guards the encoding argument.
    const head = new TextEncoder().encode('v_sh600000="1~')
    const gbk = new Uint8Array([0xc6, 0xd6, 0xb7, 0xa2, 0xd2, 0xf8, 0xd0, 0xd0]) // 浦发银行
    const tail = new TextEncoder().encode(
      '~600000~9.04~9.10~9.09~571527~263130~308397~9.04~3447~9.03~3155~9.02~4282~9.01~2827~9.00~9170~9.05~170~9.06~1861~9.07~2158~9.08~2267~9.09~3131~~20260817161457~-0.06~-0.66~9.09~8.98~9.04/571527/516755919~571527~51676~0.17~5.88~~9.09~8.98~1.21~3010.85~3010.85~0.40~10.01~8.19~";',
    )
    const body = new Uint8Array(head.length + gbk.length + tail.length)
    body.set(head, 0)
    body.set(gbk, head.length)
    body.set(tail, head.length + gbk.length)
    const provider = new TencentProvider({
      fetcher: () => new FakeResponse({ body }),
      http: { maxRetries: 0 },
    })
    const results = await provider.quote(['sh600000'], () => 'stock')
    const quote = (results[0] as { ok: true; quote: import('../src/core/types.js').Quote }).quote
    expect(quote.name).toBe('浦发银行')
  })

  it('appends qfq for indices too and parses their day bars', async () => {
    const called: string[] = []
    const provider = new TencentProvider({
      fetcher: (url) => {
        called.push(String(url))
        return new FakeResponse({
          body: JSON.stringify({
            code: 0,
            data: { sh000001: { day: [['2026-08-17', '3920.00', '3982.65', '3983.51', '3924.47', '489834027']] } },
          }),
        })
      },
      http: { maxRetries: 0 },
    })
    const points = await provider.history('sh000001', 'index', 30)
    // The endpoint 400s without the `,qfq` token even for indices; bars arrive
    // under the `day` key (the qfqday ?? day fallback).
    expect(called[0]).toContain(',qfq')
    expect(points[0]?.close).toBe(3982.65)
    expect(points[0]?.open).toBe(3920)
    expect(points[0]?.high).toBe(3983.51)
  })

  it('respects the requested trailing-window count', async () => {
    const provider = new TencentProvider({
      fetcher: () =>
        new FakeResponse({
          body: JSON.stringify({
            code: 0,
            data: {
              sh600000: {
                qfqday: [
                  ['2026-08-01', '1', '1', '1', '1', '1'],
                  ['2026-08-02', '2', '2', '2', '2', '2'],
                  ['2026-08-03', '3', '3', '3', '3', '3'],
                  ['2026-08-04', '4', '4', '4', '4', '4'],
                  ['2026-08-05', '5', '5', '5', '5', '5'],
                ],
              },
            },
          }),
        }),
      http: { maxRetries: 0 },
    })
    const points = await provider.history('sh600000', 'stock', 3)
    expect(points).toHaveLength(3)
    expect(points[0]!.close).toBe(3)
    expect(points[2]!.close).toBe(5)
  })
})