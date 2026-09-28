/**
 * Prototype creation.
 *
 * A prototype is a **folder** — its specification (markdown, one file or several) plus whatever
 * material the author keeps beside it. Creation makes the folder and writes a
 * starter brief into it, and nothing else: the spec *is* the deliverable now, so
 * starting from an empty document would leave the agent with a form to discover
 * rather than a document to fill in.
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
import { getPrototypePrdPath } from './requirements.ts'

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
  /** Absolute path to the starter `PRD.md` written into it. */
  prdPath: string
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
 * The starter brief.
 *
 * A requirement's shape is the one thing an author has to get right for anything else to work — the
 * id is what every file refers back to — so the template demonstrates it rather than describing it
 * from a distance.
 */
function starterPrd(title: string): string {
  return [
    `# ${title}`,
    '',
    'The specification. Every requirement is a heading whose id starts with `R-`, and that id is',
    'what the rest of this folder refers back to: any file declares what it serves with',
    '`@requirement R-001` in a comment.',
    '',
    'One file is enough to start. When a subject outgrows it, give that subject its own markdown',
    'file — every markdown file here is read the same way.',
    '',
    '## R-001 <what the requirement is>',
    '',
    'Say what a person cannot do today, and what changes for them once this exists. Keep it about',
    'the problem rather than about a screen or a feature.',
    '',
    'Add more the same way — `## R-002 …`.',
    '',
  ].join('\n')
}

/**
 * Create a prototype directory and its starter brief.
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
  const prdPath = getPrototypePrdPath(workspaceRootPath, slug)
  writeFileSync(prdPath, starterPrd(title), 'utf-8')

  return { slug, dir, prdPath }
}
