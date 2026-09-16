/**
 * Prototype configuration — the page table, and what the prototype is studied from.
 *
 * A prototype is a **flow**, and a flow is a list of pages. Each row says what
 * that page *is* (plan §19):
 *
 * - **`overlay`** — someone else's live page. We inject patches into it and never
 *   copy it, so the row carries the `url` it lives at.
 * - **`scratch`** — a document of ours: `name.html` in the prototype directory.
 *   The row carries nothing else — a file name would be a second name for the
 *   same fact, and files cannot drift from themselves.
 *
 * The file is therefore the **order** and the **entry** of the flow, and nothing
 * else; what *exists* is the filesystem (`pages.ts` merges the two). That split is
 * why writing `cart.html` is enough to have a page: declaring it is how you place
 * it in the flow, or hand it the entry — never how you create it.
 *
 * Stored in `config.json`, written **only** by the control plane. This does not
 * conflict with the "no shared index file" rule (see storage.ts): that rule
 * exists because `patches/` is written by many lanes, whereas this file has a
 * single writer and no derived data to drift.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  LEGACY_BASE_PAGE_NAME,
  LEGACY_ENTRY_PAGE_NAME,
  type PageKind,
} from './types.ts'
import { getPrototypeDirPath } from './storage.ts'

/** One page of a prototype: a name, what kind it is, and where it lives. */
export interface PrototypePageEntry {
  /**
   * Short name — what commands take (`prototype-open --page cart`), what the
   * address answers to (`/cart`), and what a scratch page's file is called
   * (`cart.html`). Unique within the prototype.
   */
  name: string
  kind: PageKind
  /** `overlay` only: the live address. Absent on a scratch page, where it would be a claim nothing honours. */
  url?: string
  /**
   * True for the page `/` opens. At most one row carries it, and it is a flag on
   * a row rather than a name kept elsewhere — an entry can therefore never point
   * at a page that is not there.
   *
   * No row carries it when the prototype wants the **page index** at `/` instead
   * (plan §19.3), which is the default: no page of a flow is naturally the first
   * one.
   */
  entry?: boolean
}

export interface PrototypeConfig {
  /**
   * The pages of the flow, in flow order.
   *
   * Absent means "no pages yet" — an honest state, and the one every prototype is
   * created in (plan §13.2). It does not mean the prototype is broken.
   */
  pages?: PrototypePageEntry[]
  /**
   * Read-only diagnostic: rows of `pages` that could not be read as written
   * (no name, no kind, a name or an address used twice, an overlay with no url…).
   *
   * They are dropped from {@link pages} rather than guessed at, and reported here
   * because a dropped page is exactly the kind of thing that would otherwise
   * disappear silently — the flow would simply be missing a screen. Never written
   * back to disk: {@link writePrototypeConfig} ignores it.
   */
  pageIssues?: string[]
  /**
   * Slugs of other prototypes this one is studied from.
   *
   * A reference is a *relation*, not a third kind: what the reader is building
   * is unchanged by the fact that it looked at something (plan §14). All kinds of
   * page may come out of a reference.
   */
  references?: string[]
}

export const PROTOTYPE_CONFIG_FILENAME = 'config.json'

/** Absolute path to a prototype's `config.json`. */
export function getPrototypeConfigPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_CONFIG_FILENAME)
}

/** Narrow an unknown value to a known page kind. */
export function isPageKind(value: unknown): value is PageKind {
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
 * Normalise a `pages` value read off disk or given by a caller.
 *
 * Returns `undefined` (rather than `[]`) for "nothing to store", so the key is
 * omitted from the file instead of being written as an empty list.
 *
 * Every row it refuses is described in `issues`, because the alternative —
 * quietly dropping one — means a flow is missing a screen and nothing anywhere
 * says so. Order is preserved: a flow's page order is the order it was declared
 * in (plan §18 ⑤, §19.1).
 *
 * Two rows cannot share a **name** (that is what the address and the commands
 * resolve) or an **address** (two names for one screen would make "which page am
 * I looking at" ambiguous rather than merely redundant). A scratch page carrying
 * a `url` loses the url and keeps its row: the page is real, the claim is the
 * part that cannot be honoured (plan §13.4).
 */
export function normalizePrototypePages(
  value: unknown,
): { pages: PrototypePageEntry[] | undefined; issues: string[] } {
  const issues: string[] = []
  if (value === undefined) return { pages: undefined, issues }

  if (!Array.isArray(value)) {
    return { pages: undefined, issues: ['pages is not a list of { name, kind } entries.'] }
  }

  const pages: PrototypePageEntry[] = []
  const names = new Set<string>()
  const urls = new Set<string>()

  value.forEach((candidate, index) => {
    const at = `pages[${index}]`
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      issues.push(`${at}: expected { name, kind }.`)
      return
    }

    const raw = candidate as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) {
      issues.push(`${at}: needs a name — it is what the address and "prototype-open --page" take.`)
      return
    }
    if (names.has(name)) {
      issues.push(`${at} ("${name}"): the name is already used by an earlier page.`)
      return
    }
    if (!isPageKind(raw.kind)) {
      issues.push(
        `${at} ("${name}"): needs a kind — "overlay" (a live address) or "scratch" (a document of ours).`,
      )
      return
    }

    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    if (raw.kind === 'overlay') {
      if (!url) {
        issues.push(`${at} ("${name}"): an overlay page needs a url — that address *is* the page.`)
        return
      }
      if (urls.has(url)) {
        issues.push(`${at} ("${name}"): "${url}" is already another page's address; one screen, one name.`)
        return
      }
    } else if (url) {
      issues.push(
        `${at} ("${name}"): a scratch page is a document of ours, so a url on it is a claim nothing will honour.`,
      )
    }

    const wantsEntry = raw.entry === true
    const entry = wantsEntry && !pages.some((page) => page.entry)
    if (wantsEntry && !entry) {
      issues.push(`${at} ("${name}"): only one page can be the entry; the earlier one keeps it.`)
    }

    names.add(name)
    if (raw.kind === 'overlay') urls.add(url)
    pages.push({
      name,
      kind: raw.kind,
      ...(raw.kind === 'overlay' ? { url } : {}),
      ...(entry ? { entry: true } : {}),
    })
  })

  return { pages: pages.length > 0 ? pages : undefined, issues }
}

/**
 * Read a config written **before** the page table existed as rows for the table
 * (plan §19.7). Read-time promotion, so no prototype needs migrating: the file on
 * disk is left alone until the next control-plane write turns it into the new
 * shape.
 *
 * - a legacy `scratch` had one page — `base.html`, which the table names `base`;
 *   whether that file is still there is the filesystem's answer, not this
 *   function's (pages.ts reports it), so the row is emitted unconditionally.
 * - a legacy `overlay` had one `targetUrl`, which the table names `entry`, plus
 *   any `pages` it had declared — all of them overlay pages, since a legacy
 *   prototype was one kind.
 *
 * The rows go through {@link normalizePrototypePages} like any others, so a
 * legacy config gets the same rule for duplicate names and addresses as a
 * hand-written one.
 */
export function legacyPageRows(parsed: Record<string, unknown>): unknown[] {
  if (parsed.kind === 'scratch') {
    return [{ name: LEGACY_BASE_PAGE_NAME, kind: 'scratch', entry: true }]
  }

  const targetUrl = typeof parsed.targetUrl === 'string' ? parsed.targetUrl.trim() : ''
  const rows: unknown[] = targetUrl
    ? [{ name: LEGACY_ENTRY_PAGE_NAME, kind: 'overlay', url: targetUrl, entry: true }]
    : []
  if (Array.isArray(parsed.pages)) {
    for (const page of parsed.pages) {
      if (typeof page !== 'object' || page === null) continue
      rows.push({ ...(page as Record<string, unknown>), kind: 'overlay' })
    }
  }
  return rows
}

/**
 * Read a prototype's config.
 *
 * Never throws: a missing file, invalid JSON, or a config that is malformed in
 * other ways all resolve to "no pages yet". An unreadable config must not make
 * the prototype unusable, and — because the file can be edited by hand or by
 * another process — a malformed one is expected rather than exceptional.
 *
 * The same tolerance applies inside the file: an unreadable row is dropped and
 * described in {@link PrototypeConfig.pageIssues}, so one bad line cannot take
 * the whole flow down — and cannot vanish without a word either.
 */
export function readPrototypeConfig(workspaceRootPath: string, slug: string): PrototypeConfig {
  const path = getPrototypeConfigPath(workspaceRootPath, slug)
  if (!existsSync(path)) return {}

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    const references = normalizePrototypeReferences(parsed.references, slug)
    // A `kind` at the top level is what a pre-page-table config looked like.
    const { pages, issues } = normalizePrototypePages(
      isPageKind(parsed.kind) ? legacyPageRows(parsed) : parsed.pages,
    )

    return {
      ...(pages ? { pages } : {}),
      ...(issues.length > 0 ? { pageIssues: issues } : {}),
      ...(references ? { references } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Write a prototype's config.
 *
 * Writes the page table and nothing else: there is no `kind` or `targetUrl` at
 * this level any more, so a write is also what retires the old shape (a config
 * with no `kind` is read as the new one, `readPrototypeConfig`).
 */
export function writePrototypeConfig(
  workspaceRootPath: string,
  slug: string,
  config: PrototypeConfig,
): void {
  const references = normalizePrototypeReferences(config.references, slug)
  const { pages } = normalizePrototypePages(config.pages)

  const payload: PrototypeConfig = {
    ...(pages ? { pages } : {}),
    ...(references ? { references } : {}),
  }

  writeFileSync(getPrototypeConfigPath(workspaceRootPath, slug), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
}
