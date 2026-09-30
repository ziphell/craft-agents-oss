/**
 * Prototype creation.
 *
 * A prototype is a **folder** — its specification (one `*.spec.md` file per spec) plus
 * whatever material the author keeps beside it. Creation makes the folder and writes a starter
 * `spec.md` into it, and nothing else: the entry is an **index**, and a new prototype therefore
 * starts with **no specs** — an honest empty state rather than a form to fill in.
 *
 * Creation asks for a name and nothing else. There is no kind, no address and no
 * layout to ask about any more — those were facts about a page, and a prototype no
 * longer has pages.
 *
 * Whether the work is studied through a local dev server, a test environment, or
 * production is not a distinction this model cares about.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { getPrototypeDirPath } from './storage.ts'
import { getPrototypeEntryPath } from './spec.ts'

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
  /** Absolute path to the starter `spec.md` written into it. */
  entryPath: string
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
 * The starter index.
 *
 * The entry is where the specification is read from, not a spec itself: a spec is its
 * own file, named `<name>.spec.md` (one spec per file, the file's name its identity), so the
 * template says where specs go rather than seeding an example a new author would have to
 * unlearn.
 */
function starterEntry(title: string): string {
  return [
    `# ${title}`,
    '',
    'The specification, read from the folder beside this file. Each spec is its own',
    'document, named `<name>.spec.md` — one spec per file, and the file\'s name is the',
    'spec\'s identity — with its first heading as the title and the rest of it as the prose.',
    '',
    'This entry is the index: point at a spec with an ordinary markdown link,',
    '`[the cart](cart-total.spec.md)`, and keep that subject\'s detail there rather than here.',
    '',
    'State the problem rather than a solution: say what a person cannot do today, and what changes',
    'for them once this exists. Keep it about the problem, not about a screen or a feature.',
    '',
  ].join('\n')
}

/**
 * Create a prototype directory and its starter index.
 *
 * @throws when the name produces an empty slug, or when the prototype already
 *   exists (silently reusing a directory would mix two prototypes' files).
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
  const entryPath = getPrototypeEntryPath(workspaceRootPath, slug)
  writeFileSync(entryPath, starterEntry(title), 'utf-8')

  return { slug, dir, entryPath }
}
