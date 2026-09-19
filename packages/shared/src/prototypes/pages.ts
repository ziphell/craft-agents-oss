/**
 * The pages of a prototype.
 *
 * A prototype is a flow, and this module is the one rule that says what its pages
 * are — read by the address (the host), the report (status), the deliverable
 * (export) and the agent (the prompt), so none of them can disagree about which
 * screens exist.
 *
 * Two facts are merged, and they never overlap (plan §19.2):
 *
 * - **the filesystem says what exists** — every top-level `*.html` is a page, and
 *   the page `cart` is the file `cart.html`;
 * - **the page table says the order, the entry, and whether the shared layout wraps
 *   one** (`config.json`). A row is also a page's *only* existence when it is an
 *   overlay, whose page is an address on someone else's site and cannot be
 *   discovered by walking anything.
 *
 * So a scratch page needs no declaration at all — write the file and it is a
 * page, in name order — and declaring one is how you place it in the flow, hand it
 * the entry, or say that it is a design of its own (`useLayout: false`), never how
 * you create it. Two documents are deliberately **not** pages: `_layout.html` and
 * anything else starting with `_`, and documents in subdirectories (assets — a page
 * lives at the root, the way it does on a site).
 *
 * @see docs/prototype-workbench-plan.md §19
 */

import { existsSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { readPrototypeConfig, writePrototypeConfig, type PrototypePageEntry } from './config.ts'
import { notice, rawNotice, type PrototypeNotice } from './notices.ts'
import { getPrototypeDirPath, getPrototypePagePatchesPath } from './storage.ts'
import { requireTargetUrl } from './target.ts'
import { prototypeOriginUrl } from './url.ts'
import { PROTOTYPE_LAYOUT_FILENAME, PROTOTYPE_LAYOUT_SLOT } from './types.ts'
import type { PageKind } from './types.ts'

/**
 * The layout a scratch page may share, and the one slot in it — declared in
 * `types.ts` (the module that imports nothing) and re-exported here, where the
 * page rule that keeps it out of the page list lives.
 */
export { PROTOTYPE_LAYOUT_FILENAME, PROTOTYPE_LAYOUT_SLOT }

/** The address the generated page index answers on, whatever `/` does (plan §19.3). */
export const PROTOTYPE_INDEX_PATH = '/_index'

/** The file a page name maps to. */
export function pageFileName(name: string): string {
  return `${name}.html`
}

/** The page name a file maps to (`orders.html` → `orders`). */
export function pageNameForFile(file: string): string {
  return basename(file, '.html')
}

export interface PrototypePage {
  /**
   * Short label — what commands take (`open --page cart`), what the
   * address answers to (`/cart`) and what a scratch page's file is called.
   */
  name: string
  kind: PageKind
  /** The document inside the prototype directory. Null for an overlay, or for a declared page whose file is gone. */
  file: string | null
  /** Where this page is opened. Null when nothing serves the prototype, or when its file is gone. */
  url: string | null
  /** Whether this is the page the address root opens. */
  entry: boolean
  /**
   * Whether the shared layout (`_layout.html`) wraps this page's document — false
   * when its row says so (`"useLayout": false`), and false for a live page, which
   * is someone else's document and not ours to wrap at all (plan §19.2).
   */
  useLayout: boolean
}

/** What the page table resolves to, plus the rows that could not be read. */
export interface PrototypePageTable {
  /** In flow order: declared rows first (table order), then undeclared documents by name. */
  pages: PrototypePage[]
  /** Problems worth saying out loud — a declared page with no document is a screen that is not there. */
  issues: PrototypeNotice[]
}

/**
 * Is this path a page of a prototype?
 *
 * Top-level only: pages live at the root of the prototype, the way they do at the
 * root of a site. A document in a subdirectory is an asset (a component demo, a
 * test fixture) and stays a plain file — the same tree the origin serves either
 * way. `_`-prefixed files are the host's own (`_layout.html`, `_index`), not
 * pages, which is what keeps "is this a page" answerable without a list.
 */
export function isPrototypePagePath(relativePath: string): boolean {
  const clean = relativePath.replace(/^\/+/, '')
  if (!clean || clean.includes('/') || clean.includes('\\')) return false
  if (clean.startsWith('_')) return false
  return clean.toLowerCase().endsWith('.html')
}

/** The page documents that exist in a prototype directory, by name. */
function listPageDocuments(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isPrototypePagePath(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    // A prototype directory that is not there (or not readable) has no pages.
    return []
  }
}

/**
 * Resolve a prototype's page table: what exists, in the order the flow gives.
 *
 * Declared rows come first and in table order (a flow's order is the order it was
 * written in, not alphabetical), then the documents nobody declared, by name. A
 * declared scratch page whose file is gone stays in the list with `file: null`
 * and an issue: a page that disappeared is worth knowing about, not worth
 * disappearing twice.
 */
export function describePrototypePages(workspaceRootPath: string, slug: string): PrototypePageTable {
  const config = readPrototypeConfig(workspaceRootPath, slug)
  const origin = prototypeOriginUrl(workspaceRootPath, slug)
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const documents = listPageDocuments(dir)
  // The config's own parse errors keep their wording (`rawNotice`): they name the
  // line, the key and the shape it was expected to have.
  const issues = (config.pageIssues ?? []).map(rawNotice)

  const addressOf = (file: string): string | null =>
    origin ? `${origin.replace(/\/+$/, '')}/${file}` : null

  const pages: PrototypePage[] = []
  const claimed = new Set<string>()

  for (const row of config.pages ?? []) {
    claimed.add(row.name)
    if (row.kind === 'overlay') {
      pages.push({
        name: row.name,
        kind: 'overlay',
        file: null,
        url: row.url ?? null,
        entry: row.entry === true,
        // Not ours to wrap: a live page is someone else's document.
        useLayout: false,
      })
      continue
    }

    const file = documents.find((candidate) => pageNameForFile(candidate) === row.name) ?? null
    if (!file) {
      issues.push(
        notice('page.documentMissing', { name: row.name, file: pageFileName(row.name) }),
      )
    }
    pages.push({
      name: row.name,
      kind: 'scratch',
      file,
      url: file ? addressOf(file) : null,
      entry: row.entry === true,
      useLayout: row.useLayout !== false,
    })
  }

  for (const file of documents) {
    const name = pageNameForFile(file)
    if (claimed.has(name)) continue
    pages.push({ name, kind: 'scratch', file, url: addressOf(file), entry: false, useLayout: true })
  }

  return { pages, issues }
}

/** Every page of a prototype, in flow order. */
export function listPrototypePages(workspaceRootPath: string, slug: string): PrototypePage[] {
  return describePrototypePages(workspaceRootPath, slug).pages
}

/** The page `/` opens: the one carrying the entry flag, or null when the prototype shows its index. */
export function findEntryPage(pages: PrototypePage[]): PrototypePage | null {
  return pages.find((page) => page.entry) ?? null
}

/**
 * Which page a URL is showing, by name — or null when it is not one of them.
 *
 * It answers "which screen is this window on", which is what the agent needs and
 * what the session binding records (plan §19.6), and a null says the window has
 * been taken somewhere the prototype does not describe at all.
 *
 * A path on the prototype's own host that matches no page is the **entry page**:
 * that is what the host serves for a history-API route, so the address is a route
 * *inside* the entry document rather than a different page. That fallback is
 * deliberately limited to a document we serve ourselves — an overlay's page is a
 * real site's, where `/login?next=…` is not the screen the prototype describes,
 * and saying it is would hide exactly the redirect worth noticing.
 */
export function matchPrototypePage(
  pages: PrototypePage[],
  url: string | null | undefined,
): string | null {
  if (!url) return null

  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }

  for (const page of pages) {
    if (!page.url) continue
    try {
      const candidate = new URL(page.url)
      if (candidate.host === target.host && candidate.pathname === target.pathname) return page.name
    } catch {
      continue
    }
  }

  const entry = findEntryPage(pages)
  if (entry?.file && entry.url) {
    try {
      if (new URL(entry.url).host === target.host) return entry.name
    } catch {
      return null
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// The page table (control plane only)
// ---------------------------------------------------------------------------

/**
 * A change to the page table. One operation at a time, so the caller can say what
 * it means and the runtime can name it back ("added", "removed", "renamed")
 * without guessing from a diff.
 */
export type PrototypePagesChange =
  | { op: 'add'; name: string; url?: string }
  | { op: 'remove'; name: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'entry'; name: string | null }
  /** Whether the shared layout wraps this page (`useLayout: false` = it stands on its own). */
  | { op: 'layout'; name: string; useLayout: boolean }

export interface PrototypePagesResult {
  slug: string
  /** The table as it now stands on disk. */
  pages: PrototypePageEntry[]
  /** What happened, in one sentence — the caller prints it rather than re-deriving it. */
  note: string
}

/** A page name becomes a file name and an address segment, so it has to be usable as both. */
function requirePageName(value: string): string {
  const name = value.trim()
  if (!name) {
    throw new Error('A page needs a name. Example: pages --add payment=https://app.example.com/pay')
  }
  if (/[\\/]/.test(name) || name === '.' || name === '..') {
    throw new Error(`"${value}" cannot be a page name: it becomes a file name and an address segment.`)
  }
  if (name.startsWith('_')) {
    throw new Error(
      `"${value}" cannot be a page name: a leading "_" is reserved for the host's own files (the shared layout, the page index).`,
    )
  }
  return name
}

/**
 * Add, remove, rename or re-point one page of a prototype.
 *
 * The rules it enforces are the table's own (usable, unique name; an overlay needs
 * an address a browser can open) plus the two facts the table does not own:
 * whether a document exists (the filesystem's answer) and whether deleting a page
 * means deleting its document. Everything else is the caller's call, including
 * whether a page is still worth having at all.
 *
 * @throws when the prototype does not exist, or when the change cannot be applied
 *   as asked — naming what does exist, so the caller is not left guessing.
 */
export function updatePrototypePages(
  workspaceRootPath: string,
  slug: string,
  change: PrototypePagesChange,
): PrototypePagesResult {
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
    throw new Error(`Prototype "${slug}" does not exist. See "list" for what exists.`)
  }

  const config = readPrototypeConfig(workspaceRootPath, slug)
  const rows = [...(config.pages ?? [])]
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const pages = listPrototypePages(workspaceRootPath, slug)
  const names = (): string => pages.map((page) => page.name).join(', ') || 'none'

  let note: string

  if (change.op === 'add') {
    const name = requirePageName(change.name)

    if (change.url) {
      if (pages.some((page) => page.name === name)) {
        throw new Error(`Prototype "${slug}" already has a page "${name}". Pages: ${names()}`)
      }
      const url = requireTargetUrl(change.url)
      if (rows.some((row) => row.url === url)) {
        throw new Error(`Prototype "${slug}" already has a page at "${url}". Pages: ${names()}`)
      }
      rows.push({ name, kind: 'overlay', url })
      note = `added overlay page "${name}" → ${url}`
    } else {
      // Declaring a page of ours is about order and entry, never creation (plan
      // §19.8): the document is what makes it a page, and an empty one would assert
      // a page that does not exist yet. So the only thing checked here is that the
      // document is there — and only a *declared* row counts as already declared,
      // because a document nobody declared is a page already, in name order.
      const file = pageFileName(name)
      if (!existsSync(join(dir, file))) {
        throw new Error(
          `A page of ours is a document, so ${file} has to exist before it can be placed in the flow. ` +
            `Write ${join(dir, file)} first — that alone makes it a page.`,
        )
      }
      if (rows.some((row) => row.name === name)) {
        throw new Error(`Prototype "${slug}" already declares the page "${name}".`)
      }
      rows.push({ name, kind: 'scratch' })
      note = `declared page "${name}" (${file}); it now sits in the flow order instead of after the declared pages`
    }
  } else if (change.op === 'remove') {
    const name = requirePageName(change.name)
    const page = pages.find((candidate) => candidate.name === name)
    if (!page) throw new Error(`Prototype "${slug}" has no page "${name}". Pages: ${names()}`)

    const at = rows.findIndex((row) => row.name === name)
    if (at !== -1) rows.splice(at, 1)

    if (page.file) {
      // A page of ours *is* its document, so removing the page removes it — the
      // table can only order a page, never keep one alive (plan §19.2).
      rmSync(join(dir, page.file), { force: true })
      rmSync(getPrototypePagePatchesPath(workspaceRootPath, slug, name), { recursive: true, force: true })
      note = `removed page "${name}" and its document ${page.file}`
    } else {
      note = `removed overlay page "${name}" from the flow`
    }
  } else if (change.op === 'rename') {
    const from = requirePageName(change.from)
    const to = requirePageName(change.to)
    if (from === to) throw new Error('A rename needs two different names.')

    const page = pages.find((candidate) => candidate.name === from)
    if (!page) throw new Error(`Prototype "${slug}" has no page "${from}". Pages: ${names()}`)
    if (pages.some((candidate) => candidate.name === to)) {
      throw new Error(`Prototype "${slug}" already has a page "${to}". Pages: ${names()}`)
    }

    const at = rows.findIndex((row) => row.name === from)

    if (page.file) {
      const toFile = pageFileName(to)
      if (existsSync(join(dir, toFile))) {
        throw new Error(`${toFile} already exists in ${dir}, so the page cannot take that name.`)
      }
      renameSync(join(dir, page.file), join(dir, toFile))

      // The page's own patches move with it, or they would silently stop applying
      // (the directory name is the ownership rule, plan §19.4).
      const fromPatches = getPrototypePagePatchesPath(workspaceRootPath, slug, from)
      const movedPatches = existsSync(fromPatches)
      if (movedPatches) renameSync(fromPatches, getPrototypePagePatchesPath(workspaceRootPath, slug, to))

      if (at !== -1) rows[at] = { ...rows[at]!, name: to }
      note =
        `renamed page "${from}" to "${to}" (${page.file} → ${toFile}` +
        `${movedPatches ? ', and its patches' : ''})`
    } else {
      // An overlay page exists only as a row, so there is nothing else to move.
      rows[at] = { ...rows[at]!, name: to }
      note = `renamed overlay page "${from}" to "${to}"`
    }
  } else if (change.op === 'layout') {
    const name = requirePageName(change.name)
    const page = pages.find((candidate) => candidate.name === name)
    if (!page) throw new Error(`Prototype "${slug}" has no page "${name}". Pages: ${names()}`)
    // A live page is someone else's document and the layout is ours, so neither
    // answer is ours to give — the same claim written into the file by hand is
    // reported rather than honoured (config.ts).
    if (page.kind === 'overlay') {
      throw new Error(
        `"${name}" is a live page — someone else's document — so the shared layout never wraps it. ` +
          `There is nothing to set.`,
      )
    }

    const at = rows.findIndex((row) => row.name === name)
    const declared = at !== -1
    // The flag lives on a row, so a document nobody declared becomes one now — the
    // same reason `entry` declares the page it points at.
    const next = at === -1 ? { name, kind: 'scratch' as const } : { ...rows[at]! }
    // `true` is the default and is never stored, so going back to it drops the key
    // rather than writing a second way of saying nothing (config.ts).
    if (change.useLayout) delete next.useLayout
    else next.useLayout = false
    if (at === -1) rows.push(next)
    else rows[at] = next

    const how = change.useLayout
      ? `"${name}" is wrapped by the shared layout again`
      : `"${name}" is served as written from now on — the shared layout does not wrap it`
    note = declared ? how : `${how} (declared, so it can carry the flag)`
  } else {
    // `entry` — the last op in the union, so the chain ends here.
    const name = change.name === null ? null : requirePageName(change.name)
    if (name !== null && !pages.some((page) => page.name === name)) {
      throw new Error(`Prototype "${slug}" has no page "${name}". Pages: ${names()}`)
    }

    for (const [index, row] of rows.entries()) {
      if (row.entry && row.name !== name) rows[index] = { ...row, entry: false }
    }

    if (name === null) {
      note = 'the address root shows the page index again'
    } else {
      const at = rows.findIndex((row) => row.name === name)
      if (at === -1) {
        // A document nobody declared becomes a row now, because the flag lives on
        // a row: that is the only way the entry can point at an existing page.
        rows.push({ name, kind: 'scratch', entry: true })
        note = `"${name}" is the entry page now (declared, so it can carry the flag)`
      } else {
        rows[at] = { ...rows[at]!, entry: true }
        note = `"${name}" is the entry page now`
      }
    }
  }

  writePrototypeConfig(workspaceRootPath, slug, { ...config, pages: rows })
  return { slug, pages: readPrototypeConfig(workspaceRootPath, slug).pages ?? [], note }
}
