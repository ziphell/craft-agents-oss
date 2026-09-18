/**
 * Duplicating a prototype — a second prototype made from the first one's
 * material, with an identity of its own.
 *
 * This is the other way a prototype comes into existence besides
 * {@link createPrototype} (create.ts): you do not start from a name, you start
 * from work that already exists. The copy gets its own slug and its own
 * `config.json`, and from that moment the two are independent — editing either
 * one never reaches the other.
 *
 * ## Why the patches travel with the document, and only as a pair
 *
 * A patch's selectors are bound to the document it was written against.
 * Copying the page alone would produce a prototype whose patches match nothing;
 * copying patches alone would be worse. Because the document is copied
 * byte-for-byte and the patches are copies of the ones that were replayed
 * against it, the pair stays consistent — which is what makes a duplicate safe
 * to open the moment it exists.
 *
 * ## What is copied, and what is not
 *
 * - **Everything in the prototype's own directory, except `dist/`.**
 *   Deliverables are derived — `exportPrototype` rebuilds them from the page and
 *   the patches — so a copied `dist/` would be a second, stale source of truth.
 *   Contract fragments and fixtures under `services/` are part of the prototype
 *   and do come along.
 * - **`config.json` is written fresh rather than copied.** Its content is the page
 *   table, re-read from the source and normalised on the way in, so the copy's file
 *   goes through the same shape a created one does instead of inheriting whatever the
 *   source happened to have on disk.
 *
 * ## The one thing a copy can also do
 *
 * `{ fold: true }` collapses the copy's change layer on the way out
 * ({@link foldPrototype}, plan §21.3): the new prototype starts converged — one
 * document to read, one upper layer instead of a chain of patches — while the
 * source keeps every patch it had. It is an option here and nowhere else because
 * a fold is irreversible and only worth doing to work that has stopped moving, and
 * a copy is the one prototype nobody minds collapsing: you asked for another one.
 *
 * @see docs/prototype-workbench-plan.md §13.1 (where a base page comes from)
 */

import { cpSync, existsSync } from 'fs'
import { basename } from 'path'
import { prototypeSlugFromName } from './create.ts'
import { readPrototypeConfig, writePrototypeConfig } from './config.ts'
import { foldPrototype, type PrototypeFoldResult } from './fold.ts'
import { listPrototypePages } from './pages.ts'
import { getPrototypeDirPath, scanPrototypePatches } from './storage.ts'

const DIST_DIRNAME = 'dist'

/** How many `<slug>-copy-N` names to try before giving up. */
const MAX_COPY_ATTEMPTS = 1000

export interface DuplicatePrototypeOptions {
  /**
   * Name for the copy. Only used to derive its slug — the slug *is* the
   * prototype's name, exactly as in {@link createPrototype}. Omitted, the copy
   * is called `<slug> copy`.
   */
  name?: string
  /**
   * Fold the copy's change layer as part of duplicating it (plan §21.3).
   *
   * The **copy** is folded, never the source: the fold takes the patches it folds
   * (they stop existing as files) and rewrites a page of ours to link its own
   * assets, so doing it to the original would be a destructive side effect of
   * asking for a copy. Done to the copy it costs nothing — the new prototype starts
   * converged, and the one it came from is untouched.
   */
  fold?: boolean
}

export interface DuplicatedPrototype {
  slug: string
  /** The prototype the material came from. */
  sourceSlug: string
  /** Absolute path to the new prototype's directory. */
  dir: string
  /** Page names that came along, in flow order. */
  copiedPages: string[]
  /** Replayable patch file names that came along, in replay order. */
  copiedPatches: string[]
  /**
   * What folding the copy did, or null when it was not asked for. Carried so the
   * caller can say where the copied patches went: a fold deletes them as files.
   */
  folded: PrototypeFoldResult | null
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

  // The whole directory bar the derived deliverables. `config.json` comes along
  // here and is then replaced by the copy's own — written rather than copied so
  // the new slug is what the file describes.
  cpSync(getPrototypeDirPath(workspaceRootPath, source), dir, {
    recursive: true,
    filter: (from) => basename(from) !== DIST_DIRNAME,
  })

  const config = readPrototypeConfig(workspaceRootPath, source)
  writePrototypeConfig(workspaceRootPath, target, config)

  // After the copy is complete, so a fold that refuses something (a page of ours
  // whose document is missing) reports it rather than leaving half a copy.
  const folded = options.fold ? foldPrototype(workspaceRootPath, target) : null

  return {
    slug: target,
    sourceSlug: source,
    dir,
    copiedPages: listPrototypePages(workspaceRootPath, target).map((page) => page.name),
    copiedPatches: scanPrototypePatches(workspaceRootPath, target).map((patch) => patch.file),
    folded,
  }
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
