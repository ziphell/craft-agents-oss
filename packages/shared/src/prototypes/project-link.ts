/**
 * The prototypes a **project** is worked on with (§15.1.3).
 *
 * §15 kept the two containers unrelated — a prototype is not nested in a project, and
 * nothing of one lives inside the other — and §15.1.2 settled that a project does not
 * name a prototype *for* its conversations. What is left is the one direction that is
 * true: a project may record which prototypes its work touches.
 *
 * **Background information, like a connected source.** A conversation in that project is
 * told the fact (`<project_prototypes>`), and nothing else follows: it is not bound by
 * it, no prototype context or guide is injected because of it, and `prototype_tool`
 * commands still take their default slug from the page and the conversation's own
 * binding. The record is written from the app — a person ticking them in the project's
 * Prototypes tab — so there is no agent command for it.
 *
 * **A set, not a "current" one.** A project works on several prototypes at once, and
 * nothing here ranks them: the list says what the work touches, never which one is in
 * front. So the API reads and writes a whole list, and there is no "the" prototype.
 *
 * **A prototype belongs to no project.** There used to be an edge the other way (a
 * prototype naming the project it was made for) and the membership question answered off
 * it — *which prototypes does this project have?* — and both were withdrawn: the same
 * prototype is worked on from conversations of different projects, so "belongs to a
 * project" was never true, and the list it produced answered a question nothing should
 * ask (§15.1.4). Nothing on the prototype side records a project now.
 *
 * @see docs/prototype-workbench-plan.md §15.1, §15.1.2, §15.1.3, §15.1.4
 */

import { existsSync } from 'fs'
import { loadProjectConfig, updateProject } from '../projects/storage.ts'
import type { ProjectConfig } from '../projects/types.ts'
import { getPrototypeDirPath } from './storage.ts'

/**
 * Keep only the slugs that name a prototype that is there, in the order given, once each.
 *
 * Filtering is what both ends use, so they agree: a name that no longer resolves is not
 * worth an error (it is background information, and an error would only put a failed
 * write in front of somebody who ticked a prototype deleted a moment ago) and not worth
 * mentioning in a prompt (nobody can open it). "Not there" is answered as "not in the
 * set" on the way out and "not in the set" on the way in.
 */
function existingPrototypeSlugs(workspaceRootPath: string, slugs: string[]): string[] {
  const kept: string[] = []
  for (const raw of slugs) {
    const slug = raw.trim()
    if (!slug || kept.includes(slug)) continue
    if (existsSync(getPrototypeDirPath(workspaceRootPath, slug))) kept.push(slug)
  }
  return kept
}

/**
 * The prototypes a project is worked on with — empty when it names none, and empty when
 * the ones it names are gone.
 */
export function getProjectPrototypes(workspaceRootPath: string, projectSlug: string): string[] {
  const slugs = loadProjectConfig(workspaceRootPath, projectSlug)?.prototypeSlugs ?? []
  return existingPrototypeSlugs(workspaceRootPath, slugs)
}

/**
 * Record the prototypes a project is worked on with, replacing the set.
 *
 * An empty list (or a list where nothing survives {@link existingPrototypeSlugs}) leaves
 * no key at all — the same "absent means none" rule the page table follows.
 *
 * The project has to exist, and only the storage layer says so (`updateProject`) — it is
 * the one that would have to write the record, and nothing here creates a project. A
 * conversation never has to care: a project that is gone is not in its context at all.
 *
 * There is no ownership to check either: a prototype belongs to no project (§15.1.4), so
 * any prototype of the workspace can be in the set.
 */
export function setProjectPrototypes(
  workspaceRootPath: string,
  projectSlug: string,
  prototypeSlugs: string[],
): ProjectConfig {
  const kept = existingPrototypeSlugs(workspaceRootPath, prototypeSlugs)

  return updateProject(workspaceRootPath, projectSlug, {
    prototypeSlugs: kept.length > 0 ? kept : undefined,
  })
}
