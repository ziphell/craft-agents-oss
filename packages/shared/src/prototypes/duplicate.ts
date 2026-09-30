/**
 * Duplicating a prototype — a second prototype made from the first one's
 * material, with an identity of its own.
 *
 * This is the other way a prototype comes into existence besides
 * {@link createPrototype} (create.ts): you do not start from a name, you start
 * from work that already exists. The copy gets its own slug and its own
 * directory, and from that moment the two are independent — editing either one
 * never reaches the other.
 *
 * ## What is copied
 *
 * **The prototype's own directory, whole.** The specification and the material beside it all come
 * along, because they are the prototype.
 */

import { cpSync, existsSync } from 'fs'
import { prototypeSlugFromName } from './create.ts'
import { getPrototypeDirPath } from './storage.ts'

/** How many `<slug>-copy-N` names to try before giving up. */
const MAX_COPY_ATTEMPTS = 1000

export interface DuplicatePrototypeOptions {
  /**
   * Name for the copy. Only used to derive its slug — the slug *is* the
   * prototype's name, exactly as in {@link createPrototype}. Omitted, the copy
   * is called `<slug> copy`.
   */
  name?: string
}

export interface DuplicatedPrototype {
  slug: string
  /** The prototype the material came from. */
  sourceSlug: string
  /** Absolute path to the new prototype's directory. */
  dir: string
}

/**
 * Copy an existing prototype into a new one.
 *
 * @throws when the source does not exist, when a requested name produces an
 *   unusable or taken slug, or when every `<slug>-copy-N` name is taken.
 */
export function duplicatePrototype(
  workspaceRootPath: string,
  slug: string,
  options: DuplicatePrototypeOptions = {},
): DuplicatedPrototype {
  const source = slug.trim()
  if (!source) throw new Error('A duplicate needs a prototype to copy.')
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, source))) {
    throw new Error(`Prototype "${source}" does not exist, so there is nothing to copy.`)
  }

  const target = resolveCopySlug(workspaceRootPath, source, options.name)
  const dir = getPrototypeDirPath(workspaceRootPath, target)

  // The whole directory.
  cpSync(getPrototypeDirPath(workspaceRootPath, source), dir, { recursive: true })

  return { slug: target, sourceSlug: source, dir }
}

/**
 * Pick the new prototype's slug.
 *
 * Without a requested name: `-copy`, then `-copy-2`, `-copy-3`… — the first free
 * name, so copying twice in a row does not collide and never needs the caller to
 * invent a name.
 */
function resolveCopySlug(workspaceRootPath: string, sourceSlug: string, name?: string): string {
  const requested = name?.trim()
  if (requested) {
    const slug = prototypeSlugFromName(requested)
    if (!slug) {
      throw new Error(`Name "${requested}" does not produce a usable slug. Use letters or digits.`)
    }
    if (existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
      throw new Error(`Prototype "${slug}" already exists.`)
    }
    return slug
  }

  for (let index = 1; index <= MAX_COPY_ATTEMPTS; index += 1) {
    const candidate = index === 1 ? `${sourceSlug}-copy` : `${sourceSlug}-copy-${index}`
    if (!existsSync(getPrototypeDirPath(workspaceRootPath, candidate))) return candidate
  }

  throw new Error(`Too many copies of "${sourceSlug}" already exist.`)
}
