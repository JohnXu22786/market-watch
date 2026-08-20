/**
 * Enum vocabularies shared by CLI validation and tool schemas.
 * @module market-watch/core/kinds
 */

import type { MarketArea, MarketKind } from './types.js'

/** Every supported instrument kind. */
export const MARKET_KINDS: readonly MarketKind[] = ['stock', 'index', 'crypto']

/** Every supported regional market. */
export const MARKET_AREAS: readonly MarketArea[] = ['cn', 'crypto']

/** Is the string a known market kind? */
export function isMarketKind(value: string): value is MarketKind {
  return (MARKET_KINDS as readonly string[]).includes(value)
}

/** Is the string a known market area? */
export function isMarketArea(value: string): value is MarketArea {
  return (MARKET_AREAS as readonly string[]).includes(value)
}