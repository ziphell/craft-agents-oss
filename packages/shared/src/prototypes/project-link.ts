/**
 * The edge between a prototype and the workspace project it was made for.
 *
 * §15 decided the two containers are unrelated — a prototype is not nested in a
 * project, and nothing of one lives inside the other — and that decision still
 * holds. What it left unanswered is the question a person asks second: *which
 * prototypes belong to this project?* With no link anywhere, the only answer was
 * "ask the agent, it may remember".
 *
 * So this is the smallest thing that answers it: one optional slug in the
 * prototype's config. Not a move, not a copy, not a second page table — an edge.
 * A session that has both the project and the prototype in front of it can then
 * be told, in words, which side a new file belongs on (`prompt.ts` says it).
 *
 * The edge can dangle — a project can be deleted while a prototype still names it
 * — and that is reported rather than hidden (`status.ts`), because a name that no
 * longer resolves is exactly the kind of thing that goes unnoticed otherwise.
 *
 * The same edge answers the question from the other side — *which prototype is
 * this project's?* — which is what lets a conversation inside the project reach
 * the prototype without being bound one at a time. That reading is derived
 * ({@link resolveProjectPrototype}) rather than stored, so the two directions can
 * never disagree.
 *
 * @see docs/prototype-workbench-plan.md §15.1
 */

import { existsSync, readdirSync } from 'fs'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import { projectExists } from '../projects/storage.ts'
import { readPrototypeConfig, writePrototypeConfig, type PrototypeConfig } from './config.ts'
import { getPrototypeDirPath } from './storage.ts'

/** The project a prototype belongs to, or null when it belongs to none. */
export function getPrototypeProject(workspaceRootPath: string, slug: string): string | null {
  return readPrototypeConfig(workspaceRootPath, slug).projectSlug ?? null
}

/**
 * Point a prototype at a project, or clear the edge by passing null.
 *
 * Idempotent, and both ends are checked: a prototype that does not exist has
 * nothing to write to, and a project that does not exist would record a
 * relationship that is not true. A failed command naming the wrong slug is better
 * than a config file that quietly means nothing — the rule `linkPrototypeReference`
 * already follows.
 */
export function setPrototypeProject(
  workspaceRootPath: string,
  slug: string,
  projectSlug: string | null,
): PrototypeConfig {
  if (!existsSync(getPrototypeDirPath(workspaceRootPath, slug))) {
    throw new Error(`Prototype "${slug}" does not exist. See "prototype-list" for what does.`)
  }

  const target = (projectSlug ?? '').trim()
  if (target.length > 0 && !projectExists(workspaceRootPath, target)) {
    throw new Error(`No project "${target}" in this workspace.`)
  }

  const config = readPrototypeConfig(workspaceRootPath, slug)
  writePrototypeConfig(workspaceRootPath, slug, {
    ...config,
    projectSlug: target.length > 0 ? target : undefined,
  })

  return readPrototypeConfig(workspaceRootPath, slug)
}

/**
 * The prototypes that belong to a project, by slug, in name order.
 *
 * Scanned rather than indexed: each prototype's config is the record, and a list
 * kept anywhere else would be a second thing to keep in sync — the same reasoning
 * that keeps the patch index out of a manifest (storage.ts).
 */
export function listPrototypesForProject(workspaceRootPath: string, projectSlug: string): string[] {
  let entries
  try {
    entries = readdirSync(getWorkspacePrototypesPath(workspaceRootPath), { withFileTypes: true })
  } catch {
    // The prototypes folder is created lazily, so a missing one means "none yet".
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((slug) => readPrototypeConfig(workspaceRootPath, slug).projectSlug === projectSlug)
    .sort()
}

/**
 * The prototype a project's conversations inherit — the answer to "which one is
 * *this project's* prototype?", so a session inside the project does not have to
 * be bound one at a time.
 *
 * Derived from the edge above, never stored. A `prototypeSlug` in the project's
 * config would be a second record of a fact the prototype already owns (its own
 * `projectSlug`), and two records of one fact disagree the first time someone
 * edits only one of them — the same reason `listPrototypesForProject` is a scan
 * rather than an index.
 *
 * **"Exactly one" is the entire rule.** With none there is nothing to inherit;
 * with several, the project does not name a single prototype, so sessions fall
 * back to the explicit binding they always had. Refusing to guess is deliberate:
 * taking the first would make the answer depend on directory order, and a session
 * quietly working on the wrong prototype is worse than a session that is bound to
 * none — `prompt.ts` feeds this into the agent's context, and `status.ts` reports
 * what it was given. Callers that want to *explain* the empty answer to a person
 * ask {@link listPrototypesForProject} whether it was "none" or "several".
 */
export function resolveProjectPrototype(
  workspaceRootPath: string,
  projectSlug: string | null | undefined,
): string | null {
  const target = (projectSlug ?? '').trim()
  if (!target) return null

  const candidates = listPrototypesForProject(workspaceRootPath, target)
  return candidates.length === 1 ? candidates[0]! : null
}
