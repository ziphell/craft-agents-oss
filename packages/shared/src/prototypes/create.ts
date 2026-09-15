/**
 * Prototype creation and the base page.
 *
 * A prototype is a directory with a `patches/` folder and — for the
 * from-scratch kind — a `base.html` of our own. Creation writes **no**
 * `base.html`: the absence of the file is a *true* statement, "this prototype
 * has no page yet", and an empty seeded document would assert a state that does
 * not exist (it would make `baseHtmlPresent` true, hide the guidance that says
 * how to get a first page, and hand Export an empty document to write). The
 * earlier worry — a brand-new prototype with every action greyed out — is
 * answered by the panel instead of by a fake file: Open is disabled until there
 * is a page to show.
 *
 * Two kinds, and they get their page in different ways:
 *
 * - **overlay** — the page is the live address the prototype was created
 *   against. Nothing is written and nothing is captured: the page belongs to
 *   someone else, brings its own JavaScript and its own session, and the
 *   prototype is that page with patches replayed into it.
 * - **scratch** — the page is a document we own. It arrives one of two ways:
 *   written with the file tools ({@link writePrototypeBase}), or copied from
 *   another prototype ({@link importPrototype} in import.ts).
 *
 * Whether the product page is reached through a local dev server, a test
 * environment, or production is not a distinction this model cares about: the
 * patches are an overlay on someone else's page either way, and never flow back
 * into that source. See docs/prototype-workbench-plan.md §1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypePatchesPath, getPrototypeDirPath } from './storage.ts'
import { requireTargetUrl } from './target.ts'
import { DEFAULT_PROTOTYPE_KIND, writePrototypeConfig, type PrototypeKind } from './config.ts'

const BASE_FILENAME = 'base.html'

/** Slug characters that cannot escape the prototypes directory. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export interface CreatePrototypeInput {
  name: string
  /**
   * What kind of prototype to create. Defaults to {@link DEFAULT_PROTOTYPE_KIND}
   * (`scratch`) — the kind that owns its document, and so is never left with
   * nothing to do next.
   */
  kind?: PrototypeKind
  /** `overlay` only, and **required** for it: the page this prototype injects into. */
  targetUrl?: string
}

export interface CreatedPrototype {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /**
   * Absolute path to `base.html`. This is where the file will live — creation
   * never writes it, so it appears later: captured, hand-written, or imported.
   */
  baseHtmlPath: string
  /** The kind this prototype was created as (fixed for its lifetime). */
  kind: PrototypeKind
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
 * Writes `config.json` and an empty `patches/`, and nothing else: `base.html` is
 * authored later (hand-written, captured, or imported) and its absence is the
 * truth about the prototype's state. See the module note.
 *
 * The returned `baseHtmlPath` is where it *will* live.
 *
 * @throws when the name produces an empty slug, when the prototype already
 *   exists (silently reusing a directory would mix two prototypes' patches), or
 *   when an overlay is requested without the page it changes — see below.
 */
export function createPrototype(workspaceRootPath: string, input: CreatePrototypeInput): CreatedPrototype {
  const title = input.name.trim()
  const slug = prototypeSlugFromName(title)

  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Prototype name "${input.name}" does not produce a usable slug. Use letters or digits.`)
  }

  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const baseHtmlPath = join(dir, BASE_FILENAME)

  if (existsSync(dir)) {
    throw new Error(`Prototype "${slug}" already exists.`)
  }

  const kind = input.kind ?? DEFAULT_PROTOTYPE_KIND

  // An overlay's page *is* its address, and the kind is fixed for the
  // prototype's lifetime — so an overlay created without one has nothing to
  // open, nothing to export against, and no command that can fill it in later.
  // Refusing here is the only moment the address is still at hand; every later
  // failure would be a dead end with a working-looking prototype in front of it.
  //
  // The shape check is `requireTargetUrl`'s, shared with the later "change the
  // address" path (target.ts): one rule, two entry points, so neither can end up
  // stricter than the other.
  let targetUrl: string | undefined
  if (kind === 'overlay') {
    if (!input.targetUrl?.trim()) {
      throw new Error(
        `An overlay prototype changes a page that already exists, so it needs that page's address — ` +
          `"${title}" was created without one. Pass the address it changes, or create it as a ` +
          `from-scratch prototype, which owns its own document instead.`,
      )
    }
    targetUrl = requireTargetUrl(input.targetUrl)
  }

  mkdirSync(dir, { recursive: true })
  mkdirSync(getPrototypePatchesPath(workspaceRootPath, slug), { recursive: true })
  // Written before anything can observe the prototype: a prototype whose kind is
  // unknown would render the wrong guidance (patch someone's page vs. write ours).
  writePrototypeConfig(workspaceRootPath, slug, { kind, targetUrl })

  return { slug, dir, baseHtmlPath, kind }
}

export interface WrittenBase {
  slug: string
  baseHtmlPath: string
  /** Size of the written markup, in bytes. */
  bytes: number
}

/**
 * Replace a prototype's `base.html`.
 *
 * Used by both ways a from-scratch prototype gets its document: writing one by
 * hand, and importing another prototype's page. The write is unconditional — a
 * caller that would discard edits is responsible for asking first.
 *
 * @throws when the prototype does not exist, or the markup is not a whole document.
 */
export function writePrototypeBase(workspaceRootPath: string, slug: string, html: string): WrittenBase {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  if (!existsSync(dir)) {
    throw new Error(`Prototype "${slug}" does not exist. Create it first.`)
  }

  const markup = html.trim()
  // A partial fragment would produce a base that patches cannot be applied to,
  // and the failure would only show up later at export time.
  if (!/^<html[\s>]/i.test(markup) && !/^<!doctype html/i.test(markup)) {
    throw new Error('base.html is not a complete HTML document (expected <html> or <!doctype html>).')
  }

  const baseHtmlPath = join(dir, BASE_FILENAME)
  writeFileSync(baseHtmlPath, markup, 'utf-8')

  return { slug, baseHtmlPath, bytes: Buffer.byteLength(markup, 'utf-8') }
}

/** Read a prototype's base page, or null when it has none. */
export function readPrototypeBase(workspaceRootPath: string, slug: string): string | null {
  const baseHtmlPath = join(getPrototypeDirPath(workspaceRootPath, slug), BASE_FILENAME)
  if (!existsSync(baseHtmlPath)) return null
  return readFileSync(baseHtmlPath, 'utf-8')
}
