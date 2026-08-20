/**
 * Instrument code normalization and validation.
 *
 * Accepted input forms:
 * -   A-share with exchange prefix: `sh600000`, `sz000858`, `bj920002`
 * -   A-share with suffix: `600000.sh`, `600000.ss`, `000858.sz`
 * -   Bare 5/6-digit A-share code (prefix inferred from the leading digit,
 *     optionally guided by a `kind` hint when the code is ambiguous)
 * -   Anything else is treated as a crypto id in the CoinGecko vocabulary
 *     (e.g. `bitcoin`, `ethereum`)
 *
 * @module market-watch/core/symbols
 */

import type { MarketArea, MarketKind } from './types.js'

/** Thrown when an input cannot be interpreted as a known instrument reference. */
export class CodeError extends Error {
  readonly input: string

  constructor(input: string, message: string) {
    super(message)
    this.name = 'CodeError'
    this.input = input
  }
}

export interface IdentifiedCode {
  readonly code: string
  readonly market: MarketArea
  readonly kind: MarketKind
}

/**
 * Infer the exchange from the leading digit(s) of a bare A-share code.
 * Shanghai: 5 (funds), 6 (A shares), 9 (B shares). Shenzhen: 0, 2, 3.
 * Beijing: 4, 8 and the 92 new-segment codes (920xxx).
 */
function exchangeFromDigit(digits: string): 'sh' | 'sz' | 'bj' {
  switch (digits[0]) {
    case '6':
    case '5':
      return 'sh'
    case '9':
      return digits.startsWith('92') ? 'bj' : 'sh'
    case '0':
    case '2':
    case '3':
      return 'sz'
    case '4':
    case '8':
      return 'bj'
    default:
      // Never reached for validated inputs, but keeps the function total.
      throw new CodeError(digits, `cannot infer exchange for "${digits}"`)
  }
}

/**
 * Index codes are prefixed by convention: Shanghai indices start `000`
 * (`sh000001`), Shenzhen indices start `399` (`sz399001`).
 */
function inferIndexExchange(code: string): 'sh' | 'sz' {
  return code.startsWith('399') ? 'sz' : 'sh'
}

/**
 * Resolve a bare numeric A-share code to an exchange prefix.
 * @param digits - validated 5 or 6 digit numeric string
 * @param kind - how the caller classified the code
 */
function prefixBare(digits: string, kind: MarketKind): string {
  if (kind === 'index') return `${inferIndexExchange(digits)}${digits}`
  return `${exchangeFromDigit(digits)}${digits}`
}

/** Lowercase + trim + strip separators (`.`, `-`, `/`, whitespace). */
function clean(input: string): string {
  return input.trim().toLowerCase().replace(/[\s.\-/]+/g, '')
}

const CN_CODE_RE = /^(sh|sz|bj)(\d{5,6})$/
const CN_SUFFIX_RE = /^(\d{5,6})(sh|ss|sz|bj)$/
const CN_BARE_RE = /^(\d{5,6})$/

/**
 * Interpret a user-supplied instrument reference.
 * @param input - raw code, e.g. `sh600000`, `600000.sh`, `000001`, `bitcoin`
 * @param hint - optional guidance from the caller (watch market means `watch --market`, etc.)
 * @returns the canonical code plus its market and kind classification
 * @throws CodeError when the input is empty / malformed
 */
export function identifyCode(input: string, hint?: { market?: MarketArea; kind?: MarketKind }): IdentifiedCode {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new CodeError(String(input), 'instrument code must be a non-empty string')
  }
  const raw = clean(input)
  if (raw.length > 32) {
    throw new CodeError(input, `instrument code "${input}" is too long`)
  }

  const prefixed = CN_CODE_RE.exec(raw)
  if (prefixed !== null) {
    const prefix = prefixed[1] as 'sh' | 'sz' | 'bj'
    const digits = prefixed[2] as string
    const kind = resolveKind(digits, prefix, hint?.kind)
    return { code: `${prefix}${digits}`, market: 'cn', kind }
  }

  const suffixed = CN_SUFFIX_RE.exec(raw)
  if (suffixed !== null) {
    const digits = suffixed[1] as string
    const ex = suffixed[2] as 'sh' | 'ss' | 'sz' | 'bj'
    const prefix = ex === 'ss' ? 'sh' : ex
    const kind = resolveKind(digits, prefix, hint?.kind)
    return { code: `${prefix}${digits}`, market: 'cn', kind }
  }

  const bare = CN_BARE_RE.exec(raw)
  if (bare !== null) {
    const digits = bare[1] as string
    const kind = hint?.kind ?? inferBareKind(digits)
    return { code: prefixBare(digits, kind), market: 'cn', kind }
  }

  // Fall through to crypto: any reasonable token is a CoinGecko id.
  return { code: raw, market: 'crypto', kind: 'crypto' }
}

/** Guess the kind of a bare numeric CN code from its first digits. */
function inferBareKind(digits: string): MarketKind {
  return digits.startsWith('399') ? 'index' : 'stock'
}

/**
 * Decide the instrument kind. An explicit hint wins; canonical index prefixes
 * are recognized otherwise: `sh000xxx` (Shanghai indices) and `sz399xxx`
 * (Shenzhen indices). `000858` is a Shenzhen stock, NOT an index, so the
 * exchange matters — only Shanghai `000` codes classify as indices here.
 */
function resolveKind(digits: string, prefix: 'sh' | 'sz' | 'bj', hint: MarketKind | undefined): MarketKind {
  if (hint !== undefined) return hint
  if (prefix === 'sh' && digits.startsWith('000')) return 'index'
  if (prefix === 'sz' && digits.startsWith('399')) return 'index'
  return 'stock'
}