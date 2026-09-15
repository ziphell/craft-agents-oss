/**
 * Prototype configuration — what kind of prototype this is, and what it is
 * studied from.
 *
 * There are two kinds, and they are different in substance rather than in
 * labelling (see docs/prototype-workbench-plan.md §1):
 *
 * - **`overlay`** — we inject patches into *someone else's* page. The page keeps
 *   existing on its own; our patches are an overlay that never flows back into
 *   that source. It therefore needs a `targetUrl` so the page can be reopened and
 *   re-captured later.
 * - **`scratch`** — `base.html` is ours. It may be written from scratch or seeded
 *   by capturing a page we studied (plan §14); either way the whole document is
 *   editable and there is nothing to keep in sync afterwards.
 *
 * Stored in `config.json`, written **only** by the control plane. This does not
 * conflict with the "no shared index file" rule (see storage.ts): that rule
 * exists because `patches/` is written by many lanes, whereas this file has a
 * single writer and no derived data to drift.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeDirPath } from './storage.ts'

export type PrototypeKind = 'overlay' | 'scratch'

export interface PrototypeConfig {
  kind: PrototypeKind
  /** `overlay` only: the page this prototype injects into. */
  targetUrl?: string
  /**
   * Slugs of other prototypes this one is studied from.
   *
   * A reference is a *relation*, not a third kind: what the reader is building
   * is unchanged by the fact that it looked at something (plan §14). Both kinds
   * may have references — an overlay can be told "look at how that page does it,
   * then patch ours this way".
   */
  references?: string[]
}

export const PROTOTYPE_CONFIG_FILENAME = 'config.json'

/**
 * What a prototype is assumed to be when it has no config (or an unreadable one).
 *
 * `overlay` is the honest default: every prototype created before kinds existed
 * was built around capturing a real page.
 */
export const DEFAULT_PROTOTYPE_KIND: PrototypeKind = 'overlay'

/** Absolute path to a prototype's `config.json`. */
export function getPrototypeConfigPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_CONFIG_FILENAME)
}

/** Narrow an unknown value to a known kind, falling back to the default. */
export function isPrototypeKind(value: unknown): value is PrototypeKind {
  return value === 'overlay' || value === 'scratch'
}

/**
 * Normalise a `references` value read off disk or given by a caller.
 *
 * Returns `undefined` (rather than `[]`) for "nothing to store", so the key is
 * omitted from the file instead of being written as an empty list.
 *
 * A prototype referencing itself is dropped: the relation says "study something
 * else", so pointing at yourself is contradictory rather than merely useless.
 */
export function normalizePrototypeReferences(
  value: unknown,
  selfSlug: string,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const slug = entry.trim()
    if (!slug || slug === selfSlug) continue
    seen.add(slug)
  }

  return seen.size > 0 ? [...seen] : undefined
}

/**
 * Read a prototype's config.
 *
 * Never throws and never returns a partial result: a missing file, invalid JSON,
 * or an unknown `kind` all resolve to {@link DEFAULT_PROTOTYPE_KIND}. An
 * unreadable config must not make the prototype unusable, and — because the file
 * can be edited by hand or by another process — a malformed one is expected
 * rather than exceptional.
 */
export function readPrototypeConfig(workspaceRootPath: string, slug: string): PrototypeConfig {
  const path = getPrototypeConfigPath(workspaceRootPath, slug)
  if (!existsSync(path)) return { kind: DEFAULT_PROTOTYPE_KIND }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (!isPrototypeKind(parsed.kind)) return { kind: DEFAULT_PROTOTYPE_KIND }

    const targetUrl = typeof parsed.targetUrl === 'string' && parsed.targetUrl.trim()
      ? parsed.targetUrl.trim()
      : undefined
    const references = normalizePrototypeReferences(parsed.references, slug)

    return {
      kind: parsed.kind,
      ...(targetUrl ? { targetUrl } : {}),
      ...(references ? { references } : {}),
    }
  } catch {
    return { kind: DEFAULT_PROTOTYPE_KIND }
  }
}

/** Write a prototype's config. Only `overlay` keeps a `targetUrl`. */
export function writePrototypeConfig(
  workspaceRootPath: string,
  slug: string,
  config: PrototypeConfig,
): void {
  const targetUrl = config.kind === 'overlay' && config.targetUrl?.trim()
    ? config.targetUrl.trim()
    : undefined
  const references = normalizePrototypeReferences(config.references, slug)

  const payload: PrototypeConfig = {
    kind: config.kind,
    ...(targetUrl ? { targetUrl } : {}),
    ...(references ? { references } : {}),
  }

  writeFileSync(getPrototypeConfigPath(workspaceRootPath, slug), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}
