/**
 * Prototype creation and base-page capture.
 *
 * A prototype is a directory with an optional `base.html` and a
 * `patches/` folder. `base.html` has three ways in, and creation decides none of
 * them:
 *
 * 1. **Captured page** — the rendered DOM of a real page, read out of a live
 *    browser. This must come from the *rendered* document, not from fetching the
 *    URL: a client-rendered app returns an empty shell over HTTP, so a fetch
 *    would capture nothing usable (and would miss any authenticated state).
 * 2. **Hand-written page** — written directly with the file tools, by the agent
 *    or through the source editor.
 * 3. **Imported page** — another prototype's document and patches, copied in as a
 *    starting point ({@link importPrototype} in import.ts).
 *
 * So creation writes **no** `base.html`, for either kind, and the file's absence
 * is a *true* statement: "this prototype has no page yet." Seeding an empty
 * document would assert a state that does not exist — it would make
 * `baseHtmlPresent` true, hide the guidance that says how to get a first page,
 * and hand Export an empty document to write. The earlier worry (a brand-new
 * prototype with every action greyed out) is answered by the panel instead of by
 * a fake file: Open is disabled from `PrototypeStatus.pageAvailable`, while
 * "open a browser window" needs no page at all, so capturing one is always
 * reachable (§7 of docs/prototype-workbench-plan.md).
 *
 * "Is there a page?" is never inferred from the kind or from disk by guessing:
 * `PrototypeStatus.pageAvailable` answers that, and it counts an export as a page.
 *
 * Whether the product page is reached through a local dev server, a test
 * environment, or production is not a distinction this model cares about: the
 * patches are an overlay on someone else's page either way, and never flow back
 * into that source. See docs/prototype-workbench-plan.md §1.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypePatchesPath, getPrototypeDirPath } from './storage.ts'
import { DEFAULT_PROTOTYPE_KIND, writePrototypeConfig, type PrototypeKind } from './config.ts'

const BASE_FILENAME = 'base.html'

/** Slug characters that cannot escape the prototypes directory. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export interface CreatePrototypeInput {
  name: string
  /**
   * What kind of prototype to create. Defaults to `overlay` — injecting into a
   * real page is the main path, and it is what every prototype predating kinds
   * was built around.
   */
  kind?: PrototypeKind
  /** `overlay` only: the page this prototype injects into. */
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
 * @throws when the name produces an empty slug, or when the prototype already
 *   exists — silently reusing a directory would mix two prototypes' patches.
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

  mkdirSync(dir, { recursive: true })
  mkdirSync(getPrototypePatchesPath(workspaceRootPath, slug), { recursive: true })
  // Written before anything can observe the prototype: a prototype whose kind is
  // unknown would render the wrong guidance (capture vs. write-your-own).
  writePrototypeConfig(workspaceRootPath, slug, { kind, targetUrl: input.targetUrl })

  return { slug, dir, baseHtmlPath, kind }
}

export interface CapturedBase {
  slug: string
  baseHtmlPath: string
  /** Size of the captured markup, in bytes. */
  bytes: number
}

/**
 * Replace a prototype's `base.html` with markup captured from a live page.
 *
 * The caller supplies the markup because only it can read the rendered document
 * (via CDP) — see the module note on why fetching the URL is not equivalent.
 *
 * @throws when the prototype does not exist, or the markup is not a whole document.
 */
export function writePrototypeBase(workspaceRootPath: string, slug: string, html: string): CapturedBase {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  if (!existsSync(dir)) {
    throw new Error(`Prototype "${slug}" does not exist. Create it first.`)
  }

  const markup = html.trim()
  // A partial fragment would produce a base that patches cannot be applied to,
  // and the failure would only show up later at export time.
  if (!/^<html[\s>]/i.test(markup) && !/^<!doctype html/i.test(markup)) {
    throw new Error('Captured markup is not a complete HTML document (expected <html> or <!doctype html>).')
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
