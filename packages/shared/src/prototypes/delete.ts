/**
 * Deleting a prototype.
 *
 * The directory goes away whole — page, patches, contract fragments, fixtures,
 * deliverables. Nothing is archived and nothing is recoverable from here, which
 * is why the panel asks before calling this and why it is not on the agent's
 * command list: the agent may write and rewrite everything inside a prototype,
 * but the decision that a prototype stops existing is the user's.
 *
 * Another prototype's documents may name this one — a slug in someone's set, a
 * finding's `source:`. That is prose, not a relation stored anywhere, so there is
 * nothing here to repair or report: a stale mention reads as a prototype that is
 * not there, which is exactly what it is.
 *
 * @see docs/prototype-workbench-plan.md §13.1
 */

import { existsSync, rmSync } from 'fs'
import { getPrototypeDirPath } from './storage.ts'

export interface DeletedPrototype {
  slug: string
  /** The directory that was removed. */
  dir: string
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

  rmSync(dir, { recursive: true, force: true })

  return { slug: target, dir }
}
