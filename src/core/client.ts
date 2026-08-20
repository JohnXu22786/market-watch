/**
 * Small fetch wrapper with the network hygiene the whole plugin relies on:
 * per-request timeouts, bounded retry with exponential backoff + jitter,
 * honor of `Retry-After` on 429, and an optional minimum spacing between
 * calls (rate-limit guard for the CoinGecko free tier).
 *
 * The fetcher is injectable so every network path in the plugin is testable
 * with a mock (see tests/client.test.ts).
 *
 * @module market-watch/core/client
 */

/** Minimal fetch signature — the global `fetch` conforms to it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface HttpRequestOptions {
  /** Milliseconds before the request aborts (default 10_000). */
  readonly timeoutMs?: number
  /** Extra attempt count AFTER the first try (default 2). */
  readonly maxRetries?: number
  /** Base backoff in ms; each retry sleeps `backoffBaseMs * 2^attempt` + jitter (default 500). */
  readonly backoffBaseMs?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly method?: string
  readonly body?: string
  /** Abort source from the caller (e.g. a tool execution signal). */
  readonly signal?: AbortSignal
  /** External clock for deterministic tests. */
  readonly now?: () => number
  /** Sleep implementation (defaults to global setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>
}

/** The last underlying error after retries were exhausted. */
export class HttpError extends Error {
  readonly status: number | undefined
  readonly attempts: number

  constructor(message: string, status: number | undefined, attempts: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HttpError'
    this.status = status
    this.attempts = attempts
  }
}

/** Body-over-bytes limiter: never buffer an unbounded response. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function sleepFallback(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowFn(): number {
  return Date.now()
}

function combineAbort(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal; clear: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let didTimeOut = false
  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const onExternalAbort = (): void => controller.abort(external?.reason)
  if (external?.aborted) {
    // Already-aborted caller signal: abort immediately so the fetch never starts.
    controller.abort(external.reason)
  } else {
    external?.addEventListener('abort', onExternalAbort, { once: true })
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    },
    timedOut: () => didTimeOut,
  }
}

/**
 * Serialize one sequence of requests (used for rate limiting): callers wake a
 * token after every completed request so a shared instance never fires two
 * requests closer than `minGapMs` apart. The first call is always admitted
 * (the release clock starts `minGapMs` in the past).
 */
export class RateLimiter {
  private lastRelease: number
  /** Promise-chain tail so concurrent acquirers serialize and never skip the gap. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly minGapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = sleepFallback,
  ) {
    this.lastRelease = -minGapMs
  }

  /** Wait until the configured gap has elapsed since the previous release. */
  acquire(): Promise<void> {
    const run = this.tail.then(async () => {
      const elapsed = this.now() - this.lastRelease
      const wait = this.minGapMs - elapsed
      if (wait > 0) await this.sleep(wait)
      this.lastRelease = this.now()
    })
    this.tail = run.catch(() => {})
    return run
  }
}

function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const seconds = Number.parseFloat(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  if (Number.isFinite(at)) return Math.max(0, at - now)
  return undefined
}

/**
 * Execute `fetchText` with timeouts/retries and return the raw body string.
 * Non-2xx responses throw {@link HttpError} (with retries for transient
 * statuses); network failures and timeouts also retry.
 * `encoding` selects the TextDecoder used for the response body (default
 * utf-8; `gbk` is required by the Sina/Tencent quote endpoints).
 */
export async function fetchText(
  input: string,
  fetcher: FetchLike,
  options: HttpRequestOptions = {},
  encoding = 'utf-8',
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const maxRetries = options.maxRetries ?? 2
  const backoffBaseMs = options.backoffBaseMs ?? 500
  const now = options.now ?? nowFn
  const sleep = options.sleep ?? sleepFallback

  let lastError: unknown
  const attempts = maxRetries + 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const timer = combineAbort(timeoutMs, options.signal)
    try {
      const response = await fetcher(input, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal: timer.signal,
      })
      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < maxRetries) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now())
          const sleepMs = retryAfter ?? backoffMs(backoffBaseMs, attempt)
          await abortableSleep(sleepMs, options.signal, sleep)
          continue
        }
        throw new HttpError(`HTTP ${response.status} for ${input}`, response.status, attempt + 1)
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_BODY_BYTES) {
        throw new HttpError(`response body exceeds ${MAX_BODY_BYTES} bytes for ${input}`, undefined, attempt + 1)
      }
      return new TextDecoder(encoding).decode(buffer)
    } catch (error) {
      lastError = error
      // Definitive outcomes (clear HTTP status, oversized body) never retry.
      if (error instanceof HttpError) throw error
      // Aborts are classified by the combined signal, not the error type:
      // undici rejects aborted fetches with a plain TypeError, so instanceof
      // checks cannot tell an abort apart from a connection drop.
      if (timer.signal.aborted) {
        if (timer.timedOut()) {
          // Internal timeout: transient by nature, retry when budget remains.
          if (attempt >= maxRetries) {
            throw new HttpError(`request to ${input} timed out after ${timeoutMs}ms`, undefined, attempt + 1, {
              cause: error,
            })
          }
          try {
            await abortableSleep(backoffMs(backoffBaseMs, attempt), options.signal, sleep)
          } catch (sleepError) {
            // Cancelled while pausing: settle as an abort, never retry.
            throw new HttpError(`aborted: ${errorMessage(sleepError)}`, undefined, attempt + 1, { cause: sleepError })
          }
          continue
        }
        // Externally aborted — retrying is pointless.
        throw new HttpError(`aborted: ${errorMessage(error)}`, undefined, attempt + 1, { cause: error })
      }
      // Network error: retry when budget remains.
      if (attempt >= maxRetries) {
        throw new HttpError(`request to ${input} failed: ${errorMessage(error)}`, undefined, attempt + 1, {
          cause: error,
        })
      }
      try {
        await abortableSleep(backoffMs(backoffBaseMs, attempt), options.signal, sleep)
      } catch (sleepError) {
        throw new HttpError(`aborted: ${errorMessage(sleepError)}`, undefined, attempt + 1, { cause: sleepError })
      }
    } finally {
      timer.clear()
    }
  }
  throw new HttpError(`request to ${input} failed: ${errorMessage(lastError)}`, undefined, attempts)
}

/**
 * Sleep like `sleep`, but resolve early (rejecting) if the EXTERNAL signal
 * aborts meanwhile — a Retry-After/backoff pause must not outlive a
 * cancellation. The per-attempt timeout signal is deliberately not observed
 * here: no request is in flight during the pause. Listeners are always removed.
 */
function abortableSleep(ms: number, external: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (external?.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
  if (external === undefined) return sleep(ms)
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'))
    external.addEventListener('abort', onAbort, { once: true })
    void sleep(ms).then(
      () => {
        external.removeEventListener('abort', onAbort)
        resolve()
      },
      (error) => {
        external.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function backoffMs(base: number, attempt: number): number {
  const exponential = base * 2 ** attempt
  const jitter = Math.random() * 0.5 + 0.75
  return Math.round(exponential * jitter)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}