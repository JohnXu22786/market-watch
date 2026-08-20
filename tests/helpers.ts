/**
 * Test helpers: a structural Response fake and a scriptable mock fetcher.
 * The production client only consumes `ok/status/headers/arrayBuffer`, so the
 * fake never needs to be a real `Response`.
 *
 * @module tests/helpers
 */

import type { FetchLike } from '../src/core/client.js'

export interface FakeResponseInit {
  readonly status?: number
  readonly body?: string | Uint8Array
  readonly retryAfter?: string
  readonly headers?: Readonly<Record<string, string>>
}

export class FakeResponse {
  readonly ok: boolean
  readonly status: number
  private readonly bodyBytes: Uint8Array
  private readonly headerMap: Readonly<Record<string, string>>

  constructor(init: FakeResponseInit = {}) {
    this.status = init.status ?? 200
    this.ok = this.status >= 200 && this.status < 300
    this.bodyBytes = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : (init.body ?? new Uint8Array())
    this.headerMap = init.headers ?? {}
    if (init.retryAfter !== undefined) this.headerMap = { ...this.headerMap, 'retry-after': init.retryAfter }
  }

  headers = {
    get: (name: string): string | null => this.headerMap[name.toLowerCase()] ?? null,
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bodyBytes.buffer.slice(this.bodyBytes.byteOffset, this.bodyBytes.byteOffset + this.bodyBytes.byteLength) as ArrayBuffer
  }
}

export interface RouteRule {
  /** Predicate over the requested URL. */
  readonly match: (url: string) => boolean
  /** Produce a response, or throw to simulate a network failure. */
  readonly respond: () => FakeResponse | Error | Promise<FakeResponse | Error>
}

/** Deterministic fetcher driven by route rules; records every call. */
export function makeMockFetch(routes: readonly RouteRule[]): { fetch: FetchLike; calls: { url: string; init?: RequestInit }[]; responses: number } {
  const calls: { url: string; init?: RequestInit }[] = []
  let responses = 0
  const fetch: FetchLike = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    for (const rule of routes) {
      if (rule.match(url)) {
        responses += 1
        const result = await rule.respond()
        if (result instanceof Error) throw result
        return result as unknown as Response
      }
    }
    responses += 1
    throw new TypeError(`no route for ${url}`)
  }
  return { fetch, calls, responses }
}