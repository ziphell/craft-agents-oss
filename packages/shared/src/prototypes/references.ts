/**
 * Prototype references — "this prototype is studied from those ones".
 *
 * A reference is a **relation between two prototypes**, not a third kind
 * (docs/prototype-workbench-plan.md §14): reverse-engineering someone's page and
 * then building your own does not change what your artifact *is*, only where you
 * looked. Keeping it a relation is also what lets one page be a reference for
 * prototype A while being the delivery target of prototype B.
 *
 * The relation is deliberately **one-way**. A reference does not know it is being
 * referenced, because the role lives on the edge: two readers can look at the
 * same page for opposite reasons, and neither reading is a property of that page.
 *
 * ## Why this is not just a convenience
 *
 * `exportPrototype` inlines **every** patch under the prototype's own `patches/`
 * (see export.ts). If a reference's patches were stored alongside the reader's,
 * they would be baked into the reader's deliverable silently — selectors aimed at
 * someone else's DOM, applied to a page where none of them match. Keeping each
 * prototype's patches in its own directory is what makes that impossible rather
 * than merely unlikely; this module is the only way the two are connected.
 */

import { existsSync } from 'fs'
import { readPrototypeConfig, writePrototypeConfig, type PrototypeConfig } from './config.ts'
import { getPrototypeDirPath } from './storage.ts'

/** The references a prototype currently declares, in declaration order. */
export function getPrototypeReferences(workspaceRootPath: string, slug: string): string[] {
  return readPrototypeConfig(workspaceRootPath, slug).references ?? []
}

/**
 * Declare that `slug` is studied from `referenceSlug`.
 *
 * Idempotent: linking an already-linked reference is a no-op rather than an
 * error, because "make sure this is linked" is the operation callers actually
 * want and there is no harm in the duplicate.
 *
 * @throws when the reader does not exist, when the reference does not exist, or
 *   when they are the same prototype — all three would leave a relation that
 *   cannot be honoured, and a reference the agent cannot read is worse than a
 *   failed command that says why.
 */
export function linkPrototypeReference(
  workspaceRootPath: string,
  slug: string,
  referenceSlug: string,
): PrototypeConfig {
  const target = referenceSlug.trim()
  if (!target) throw new Error('A reference needs a prototype slug.')

  if (target === slug) {
    throw new Error(`Prototype "${slug}" cannot reference itself.`)
  }
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
    throw new Error(`Prototype "${slug}" does not exist.`)
  }
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, target))) {
    throw new Error(`No prototype "${target}" to reference. See "prototype-list" for what exists.`)
  }

  const config = readPrototypeConfig(workspaceRootPath, slug)
  writePrototypeConfig(workspaceRootPath, slug, {
    ...config,
    references: [...(config.references ?? []), target],
  })

  return readPrototypeConfig(workspaceRootPath, slug)
}

/**
 * Drop a reference.
 *
 * Idempotent, and never throws on a missing prototype: removing a reference to
 * something that is already gone is exactly how a dangling reference gets
 * cleaned up, so refusing would strand the caller.
 */
export function unlinkPrototypeReference(
  workspaceRootPath: string,
  slug: string,
  referenceSlug: string,
): PrototypeConfig {
  const target = referenceSlug.trim()
  const config = readPrototypeConfig(workspaceRootPath, slug)
  const remaining = (config.references ?? []).filter((entry) => entry !== target)

  writePrototypeConfig(workspaceRootPath, slug, { ...config, references: remaining })

  return readPrototypeConfig(workspaceRootPath, slug)
}
