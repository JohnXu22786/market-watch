/**
 * Tiny shared error utilities (no dependencies besides the Error protocol).
 * @module market-watch/core/errors
 */

/** Human-readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}