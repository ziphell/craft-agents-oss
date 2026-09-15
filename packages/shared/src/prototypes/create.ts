/**
 * Prototype creation and base-page capture.
 *
 * A prototype project is just a directory with a `base.html` and a `patches/`
 * folder. `base.html` has two legitimate origins, and they are *not*
 * interchangeable:
 *
 * 1. **Starter page** — for building something from scratch.
 * 2. **Captured page** — the rendered DOM of a real page, read out of a live
 *    browser. This must come from the *rendered* document, not from fetching the
 *    URL: a client-rendered app returns an empty shell over HTTP, so a fetch
 *    would capture nothing usable (and would miss any authenticated state).
 *
 * @see docs/prototype-workbench-plan.md §7 (无中生有) and §5 (服务契约层)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypePatchesPath, getPrototypeProjectPath } from './storage.ts'

const BASE_FILENAME = 'base.html'

/** Slug characters that cannot escape the prototypes directory. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

export interface CreatePrototypeInput {
  name: string
}

export interface CreatedPrototype {
  slug: string
  /** Absolute project directory. */
  dir: string
  /** Absolute path to the seeded `base.html`. */
  baseHtmlPath: string
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

/** The page a from-scratch prototype starts from — real markup, not a stub. */
export function buildStarterBaseHtml(title: string): string {
  const safeTitle = title.replace(/[<>&]/g, '')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
  </head>
  <body>
    <main style="font-family: system-ui; padding: 2rem; max-width: 40rem">
      <h1>${safeTitle}</h1>
      <p>
        Starter page. Either build on this markup directly, or point the browser
        at the real product and use <strong>Capture base</strong> to replace this
        file with the rendered page.
      </p>
    </main>
  </body>
</html>
`
}

/**
 * Create a prototype project and seed its starter `base.html`.
 *
 * @throws when the name produces an empty slug, or when the project already
 *   exists — silently reusing a directory would mix two prototypes' patches.
 */
export function createPrototype(workspaceRootPath: string, input: CreatePrototypeInput): CreatedPrototype {
  const title = input.name.trim()
  const slug = prototypeSlugFromName(title)

  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Prototype name "${input.name}" does not produce a usable slug. Use letters or digits.`)
  }

  const dir = getPrototypeProjectPath(workspaceRootPath, slug)
  const baseHtmlPath = join(dir, BASE_FILENAME)

  if (existsSync(dir)) {
    throw new Error(`Prototype "${slug}" already exists.`)
  }

  // Seed base.html before anything else can observe a half-built project.
  mkdirSync(dir, { recursive: true })
  mkdirSync(getPrototypePatchesPath(workspaceRootPath, slug), { recursive: true })
  writeFileSync(baseHtmlPath, buildStarterBaseHtml(title || slug), 'utf-8')

  return { slug, dir, baseHtmlPath }
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
 * @throws when the project does not exist, or the markup is not a whole document.
 */
export function writePrototypeBase(workspaceRootPath: string, slug: string, html: string): CapturedBase {
  const dir = getPrototypeProjectPath(workspaceRootPath, slug)
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
  const baseHtmlPath = join(getPrototypeProjectPath(workspaceRootPath, slug), BASE_FILENAME)
  if (!existsSync(baseHtmlPath)) return null
  return readFileSync(baseHtmlPath, 'utf-8')
}
