/**
 * HTTP client behavior: timeout, retry, backoff, rate limiting, 429 handling.
 * @module tests/client
 */

import { describe, expect, it, vi } from 'vitest'
import { HttpError, RateLimiter, fetchText, type FetchLike } from '../src/core/client.js'
import { FakeResponse } from './helpers.js'

const noSleep = async (): Promise<void> => {}

describe('fetchText retries', () => {
  it('returns the body on the first success', async () => {
    const fetcher: FetchLike = async () => new FakeResponse({ body: 'hello' })
    await expect(fetchText('http://x', fetcher, { sleep: noSleep })).resolves.toBe('hello')
  })

  it('retries a 500 then succeeds', async () => {
    const calls = vi.fn()
    const fetcher: FetchLike = async () => {
      calls()
      return calls.mock.calls.length >= 2 ? new FakeResponse({ body: 'ok' }) : new FakeResponse({ status: 500 })
    }
    await expect(fetchText('http://x', fetcher, { maxRetries: 1, sleep: noSleep })).resolves.toBe('ok')
    expect(calls).toHaveBeenCalledTimes(2)
  })

  it('throws without retrying a 404', async () => {
    const calls = vi.fn()
    const fetcher: FetchLike = async () => {
      calls()
      return new FakeResponse({ status: 404 })
    }
    const error = await fetchText('http://x', fetcher, { maxRetries: 3, sleep: noSleep }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(404)
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After on 429', async () => {
    const sleeps: number[] = []
    const fetcher: FetchLike = async () =>
      new FakeResponse({ status: 429, body: 'slow down', retryAfter: '2' })
    // Always failing: each attempt sees 429 and retries until budget runs out.
    await fetchText('http://x', fetcher, {
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    }).catch(() => {})
    expect(sleeps[0]).toBe(2_000)
  })

  it('retries network failures with exponential backoff', async () => {
    const attempts = vi.fn()
    const fetcher: FetchLike = async () => {
      attempts()
      if (attempts.mock.calls.length === 2) return new FakeResponse({ body: 'recovered' })
      throw new TypeError('fetch failed')
    }
    await expect(fetchText('http://x', fetcher, { maxRetries: 1, backoffBaseMs: 100, sleep: noSleep })).resolves.toBe(
      'recovered',
    )
    expect(attempts).toHaveBeenCalledTimes(2)
  })

  it('wraps exhausting failures in HttpError with attempt count', async () => {
    const fetcher: FetchLike = async () => {
      throw new TypeError('ECONNREFUSED')
    }
    const error = await fetchText('http://x', fetcher, { maxRetries: 1, backoffBaseMs: 1, sleep: noSleep }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).attempts).toBe(2)
    expect((error as HttpError).message).toContain('ECONNREFUSED')
  })

  it('does not retry an externally aborted request', async () => {
    const calls = vi.fn()
    const controller = new AbortController()
    const fetcher: FetchLike = async (_input, init) => {
      calls()
      return new Promise((_resolve, reject) => {
        // Mimic undici: an aborted in-flight fetch rejects with a plain
        // TypeError, NOT a DOMException — the client must classify by signal.
        init?.signal?.addEventListener('abort', () => {
          reject(new TypeError('fetch failed'))
        })
      })
    }
    const pending = fetchText('http://x', fetcher, { maxRetries: 3, sleep: noSleep, signal: controller.signal })
    controller.abort(new Error('user cancelled'))
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).message).toContain('aborted')
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('retries a request that times out when the budget allows', async () => {
    const calls = vi.fn()
    const fetcher: FetchLike = async (_input, init) => {
      calls()
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }
    // 3 attempts: every one times out (internal timer), each is retried up to maxRetries.
    await fetchText('http://x', fetcher, { timeoutMs: 15, maxRetries: 2, sleep: noSleep }).catch(() => {})
    expect(calls).toHaveBeenCalledTimes(3)
  })

  it('times out requests that never settle', async () => {
    const fetcher: FetchLike = async (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }
    const error = await fetchText('http://x', fetcher, { timeoutMs: 15, maxRetries: 0, sleep: noSleep }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(HttpError)
  })

  it('rejects oversized bodies', async () => {
    const fetcher: FetchLike = async () => new FakeResponse({ body: 'x'.repeat(9 * 1024 * 1024) })
    const error = await fetchText('http://x', fetcher, { maxRetries: 0, sleep: noSleep }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
  })
})

describe('RateLimiter', () => {
  it('admits the first call immediately and spaces the second', async () => {
    let clock = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter(
      100,
      () => clock,
      async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    )
    await limiter.acquire() // first: always admitted
    expect(sleeps).toHaveLength(0)
    await limiter.acquire() // no time passed since release → full gap
    expect(sleeps).toEqual([100])
  })

  it('waits only for the remaining gap', async () => {
    let clock = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter(
      100,
      () => clock,
      async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    )
    await limiter.acquire()
    clock += 40 // 40ms since release
    await limiter.acquire()
    expect(sleeps[0]).toBe(60)
  })

  it('serializes concurrent acquisitions so the gap is never skipped', async () => {
    let clock = 0
    const sleeps: number[] = []
    const limiter = new RateLimiter(
      100,
      () => clock,
      async (ms) => {
        sleeps.push(ms)
        clock += ms
      },
    )
    await Promise.all([limiter.acquire(), limiter.acquire()])
    // First is admitted; the second must still wait the full gap after it.
    expect(sleeps).toEqual([100])
  })
})