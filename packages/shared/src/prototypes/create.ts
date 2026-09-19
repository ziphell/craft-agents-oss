/**
 * Prototype creation, and writing a page document.
 *
 * A prototype is a directory with a `patches/` folder and — later — its page
 * documents. Creation writes **no** page: the absence is a *true* statement,
 * "this prototype has no pages yet", and a seeded empty document would assert a
 * state that does not exist (it would make the page table list a screen that is
 * not there, hide the guidance that says how to write the first one, and hand
 * Export an empty document to write). The earlier worry — a brand-new prototype
 * with every action greyed out — is answered by the entry points instead of by a
 * fake file: Open is disabled until there is a page to show.
 *
 * Creation asks for a name and nothing else (plan §19.8). It used to ask for a
 * kind and, for an overlay, the address it changes; both of those are facts about
 * a **page**, so both moved to {@link updatePrototypePages} in pages.ts, where a
 * page is added. A prototype is a container either way.
 *
 * Pages arrive one of two ways: written with the file tools
 * ({@link writePrototypePage}), or copied from another prototype
 * ({@link duplicatePrototype} in duplicate.ts), which makes a second prototype
 * rather than filling this one in.
 *
 * Whether the product page is reached through a local dev server, a test
 * environment, or production is not a distinction this model cares about: an
 * overlay page's patches are an overlay on someone else's page either way, and
 * never flow back into that source. See docs/prototype-workbench-plan.md §1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeDirPath, getPrototypeLayoutPath, getPrototypePatchesPath } from './storage.ts'
import { pageFileName } from './pages.ts'

/** Slug characters that cannot escape the prototypes directory. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export interface CreatePrototypeInput {
  /** Display name; the slug is derived from it and is the prototype's name from then on. */
  name: string
}

export interface CreatedPrototype {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /** Absolute path to the (empty) patches directory. The shared patches live here. */
  patchesPath: string
}

/**
 * Derive a filesystem-safe slug from a display name.
 *
 * Everything outside `[a-z0-9]` collapses to a single `-`, which is what makes
 * the result inherently path-safe — there is no way for a name such as `../x`
 * to address something outside the prototypes directory.
 */
export function prototypeSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

/**
 * Create a prototype directory.
 *
 * Writes an empty `patches/` and nothing else — no page, no `config.json`, and no
 * `_layout.html` either: with no pages there is nothing to declare, and a layout now
 * appears the moment there is something to share (two pages that would repeat the
 * same shared markup), which is the rule the prompt states. Seeding one up front would be a
 * layout around screens that may not want it at all — a page can be a design of its
 * own (plan §19.2).
 *
 * @throws when the name produces an empty slug, or when the prototype already
 *   exists (silently reusing a directory would mix two prototypes' patches).
 */
export function createPrototype(workspaceRootPath: string, input: CreatePrototypeInput): CreatedPrototype {
  const title = input.name.trim()
  const slug = prototypeSlugFromName(title)

  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Prototype name "${input.name}" does not produce a usable slug. Use letters or digits.`)
  }

  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  if (existsSync(dir)) {
    throw new Error(`Prototype "${slug}" already exists.`)
  }

  mkdirSync(dir, { recursive: true })
  const patchesPath = getPrototypePatchesPath(workspaceRootPath, slug)
  mkdirSync(patchesPath, { recursive: true })

  return { slug, dir, patchesPath }
}

export interface WrittenPage {
  slug: string
  /** Page name, as the table and the address know it. */
  page: string
  /** Absolute path to the written document. */
  path: string
  /** Size of the written markup, in bytes. */
  bytes: number
}

/**
 * Write (or replace) one page of a prototype.
 *
 * This is the way a scratch page gets its document: written by hand or by the
 * agent's file tools. The write is unconditional — a caller that would discard
 * edits is responsible for asking first.
 *
 * @throws when the prototype does not exist, when the name cannot be a page, or
 *   when the markup is not a whole document.
 */
export function writePrototypePage(
  workspaceRootPath: string,
  slug: string,
  page: string,
  html: string,
): WrittenPage {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  if (!existsSync(dir)) {
    throw new Error(`Prototype "${slug}" does not exist. Create it first.`)
  }

  const name = page.trim()
  if (!name || /[\\/]/.test(name) || name.startsWith('_')) {
    throw new Error(`"${page}" cannot be a page name: it becomes a file name and an address segment.`)
  }

  const markup = html.trim()
  // A partial fragment would produce a page that patches cannot be applied to,
  // and the failure would only show up later at export time.
  if (!/^<html[\s>]/i.test(markup) && !/^<!doctype html/i.test(markup)) {
    throw new Error(
      `Page "${name}" is not a complete HTML document (expected <html> or <!doctype html>). ` +
        `Use ${pageFileName(name)} for the file name.`,
    )
  }

  const path = join(dir, pageFileName(name))
  writeFileSync(path, markup, 'utf-8')

  return { slug, page: name, path, bytes: Buffer.byteLength(markup, 'utf-8') }
}

/** Read one of a prototype's page documents, or null when it is not there. */
export function readPrototypePage(
  workspaceRootPath: string,
  slug: string,
  file: string,
): string | null {
  const path = join(getPrototypeDirPath(workspaceRootPath, slug), file)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}

/**
 * Read the optional layout a page of ours is rendered inside, or null when there is
 * none (plan §19.2).
 *
 * The layout is applied wherever a page is turned into a document — the host on
 * every request, and export when it writes the package — so the delivered page is
 * the page that was previewed, layout and all.
 */
export function readPrototypeLayout(workspaceRootPath: string, slug: string): string | null {
  const path = getPrototypeLayoutPath(workspaceRootPath, slug)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf-8')
}
