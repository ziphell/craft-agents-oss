/**
 * Importing another prototype's material — its page, and its patches.
 *
 * This is the second way a `base.html` comes into existence (see the module note
 * in create.ts): a *copy* of another prototype's document, taken as a starting
 * point so a new flow does not begin on an empty page. What arrives is material,
 * not identity: the target keeps its own kind, its own `config.json`, its own
 * target page, and its own references. Only two things move — the document and
 * the replayable patches that were written against it.
 *
 * ## Why the patches travel with the document, and only as a pair
 *
 * A patch's selectors are bound to the document it was written against. Importing
 * the page alone would produce a prototype whose patches (had it any) match
 * nothing; importing patches alone would be worse. Because the document is copied
 * byte-for-byte and the patches are copies of the ones that were replayed against
 * it, the pair stays consistent — which is exactly what makes this different from
 * studying a prototype via `references`, where the patches must stay behind
 * (references.ts, plan §14.2).
 *
 * ## What is deliberately not copied
 *
 * - **Files already present here.** A same-named patch on the target is left
 *   untouched and reported, rather than overwritten: a silent replacement of this
 *   prototype's own work is the one failure nobody would notice. Nothing is ever
 *   deleted.
 * - **Non-replayable files.** Only patches that match the naming convention are
 *   imported, because only those are part of the prototype: the injector ignores
 *   the rest, `prototype-export` does not inline them, and `prototype-status`
 *   reports them as ownership violations. Copying them would move another
 *   prototype's junk into a clean one.
 * - **`dist/`.** Deliverables are derived (export.ts rebuilds them from base +
 *   patches); an imported copy would be a second, stale source of truth.
 *
 * @see docs/prototype-workbench-plan.md §13.1 (where a base page comes from)
 */

import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { readPrototypeBase, writePrototypeBase } from './create.ts'
import { readPrototypeConfig } from './config.ts'
import { getPrototypeDirPath, getPrototypePatchesPath, scanPrototypePatches } from './storage.ts'

const BASE_FILENAME = 'base.html'

export interface ImportedPrototype {
  slug: string
  /** The prototype the material came from. */
  sourceSlug: string
  /** Absolute path to the imported `base.html`. */
  baseHtmlPath: string
  /** Size of the imported document, in bytes. */
  bytes: number
  /** Patch file names copied in, in replay order. */
  copiedPatches: string[]
  /**
   * Patch file names the target already had, left as they were. Non-empty means
   * the two patch sets were not merged — say so instead of reporting success.
   */
  skippedPatches: string[]
}

/**
 * Copy `sourceSlug`'s page and patches into `slug`.
 *
 * @throws when either prototype is missing, when the source has no `base.html`
 *   (an export is not a substitute: it already has the patches inlined), when the
 *   source and target are the same, or when the target is an `overlay` — an
 *   overlay has no document of its own to replace, only a live page to point at.
 */
export function importPrototype(
  workspaceRootPath: string,
  slug: string,
  sourceSlug: string,
): ImportedPrototype {
  const source = sourceSlug.trim()
  if (!source) throw new Error('An import needs a source prototype slug.')

  if (source === slug) {
    throw new Error(`Prototype "${slug}" cannot import from itself.`)
  }
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
    throw new Error(`Prototype "${slug}" does not exist. Create it first.`)
  }
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, source))) {
    throw new Error(`No prototype "${source}" to import from. See "prototype-list" for what exists.`)
  }

  const kind = readPrototypeConfig(workspaceRootPath, slug).kind
  if (kind !== 'scratch') {
    throw new Error(
      `Prototype "${slug}" is an overlay: its page is the live address it was created against, not a document, ` +
        `so there is nothing here to replace with an import. Create a from-scratch prototype to import into.`,
    )
  }

  const sourceBase = readPrototypeBase(workspaceRootPath, source)
  if (sourceBase === null) {
    throw new Error(
      `Prototype "${source}" has no ${BASE_FILENAME} to import. Give it one first — write it, ` +
        `or import from a prototype that already has a page.`,
    )
  }

  // Written through the same path as a hand-written document rather than copied
  // blindly, so the target can only ever hold a whole document: a half-imported
  // file would fail much later, at export time.
  const imported = writePrototypeBase(workspaceRootPath, slug, sourceBase)

  const sourcePatchesDir = getPrototypePatchesPath(workspaceRootPath, source)
  const targetPatchesDir = getPrototypePatchesPath(workspaceRootPath, slug)
  mkdirSync(targetPatchesDir, { recursive: true })

  const copiedPatches: string[] = []
  const skippedPatches: string[] = []
  for (const patch of scanPrototypePatches(workspaceRootPath, source)) {
    const destination = join(targetPatchesDir, patch.file)
    if (existsSync(destination)) {
      skippedPatches.push(patch.file)
      continue
    }
    copyFileSync(join(sourcePatchesDir, patch.file), destination)
    copiedPatches.push(patch.file)
  }

  return {
    slug,
    sourceSlug: source,
    baseHtmlPath: imported.baseHtmlPath,
    bytes: imported.bytes,
    copiedPatches,
    skippedPatches,
  }
}
