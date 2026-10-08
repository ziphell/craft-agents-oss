/**
 * Shared usability gate for design action executors (mcp + api).
 *
 * Designs need a STABLE, machine-matchable error when a granted source has
 * lost authentication, so design JS can disable its buttons and point the
 * user at the host's reconnect banner instead of showing an opaque failure.
 * The prefix below is a documented part of the design authoring contract
 * (resources/docs/designs.md) — change it only with a migration note.
 */

import { isSourceUsable, type LoadedSource } from '@craft-agent/shared/sources'

export const DESIGN_SOURCE_AUTH_REQUIRED_PREFIX = 'source-auth-required'

/**
 * Throws when the source cannot serve design actions right now. Auth problems
 * get the stable `source-auth-required` prefix; a deliberately disabled
 * source stays a plain (non-retryable) error.
 */
export function assertDesignSourceUsable(source: LoadedSource): void {
  if (isSourceUsable(source)) return
  if (source.config.enabled === false) {
    throw new Error(`Source "${source.config.slug}" is disabled`)
  }
  throw new Error(
    `${DESIGN_SOURCE_AUTH_REQUIRED_PREFIX}: reconnect "${source.config.slug}" in the app`,
  )
}
