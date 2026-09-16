/**
 * Deleting a prototype.
 *
 * The directory goes away whole — page, patches, contract fragments, fixtures,
 * deliverables. Nothing is archived and nothing is recoverable from here, which
 * is why the panel asks before calling this and why it is not on the agent's
 * command list: the agent may write and rewrite everything inside a prototype,
 * but the decision that a prototype stops existing is the user's.
 *
 * ## Dangling references are reported, not repaired
 *
 * A reference lives in the *referring* prototype's `config.json`, so deleting a
 * prototype can leave others pointing at a slug that no longer exists. Repairing
 * that here would mean rewriting other prototypes on a request that named one,
 * and guessing, for each reader, whether it meant "study something else" or "stop
 * studying this". The relation is already allowed to dangle — `unlinkReference`
 * is the supported way to drop it, and `prototype-status` shows the reader that
 * its reference is gone — so this reports the readers and leaves them alone.
 *
 * @see docs/prototype-workbench-plan.md §13.1
 */

import { existsSync, readdirSync, rmSync } from 'fs'
import { readPrototypeConfig } from './config.ts'
import { getPrototypeDirPath } from './storage.ts'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'

export interface DeletedPrototype {
  slug: string
  /** The directory that was removed. */
  dir: string
  /**
   * Prototypes whose `references` still name the deleted one. Non-empty means
   * they are now dangling — say so, rather than leaving a surprise for whoever
   * opens one next.
   */
  referencedBy: string[]
}

/**
 * Remove a prototype and everything in it.
 *
 * @throws when the prototype does not exist — a delete that silently does
 *   nothing would report success for a slug that was never there.
 */
export function deletePrototype(workspaceRootPath: string, slug: string): DeletedPrototype {
  const target = slug.trim()
  if (!target) throw new Error('A delete needs a prototype to remove.')

  const dir = getPrototypeDirPath(workspaceRootPath, target)
  if (!existsSync(dir)) {
    throw new Error(`Prototype "${target}" does not exist, so there is nothing to delete.`)
  }

  // Read before removing: the readers' own configs are what name this prototype.
  const referencedBy = listReaders(workspaceRootPath, target)
  rmSync(dir, { recursive: true, force: true })

  return { slug: target, dir, referencedBy }
}

/** Slugs of prototypes that still list `slug` as a reference. */
function listReaders(workspaceRootPath: string, slug: string): string[] {
  let entries
  try {
    entries = readdirSync(getWorkspacePrototypesPath(workspaceRootPath), { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== slug && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((other) => (readPrototypeConfig(workspaceRootPath, other).references ?? []).includes(slug))
    .sort()
}
