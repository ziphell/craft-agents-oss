/**
 * A project's layers — the report over the project's own folder.
 *
 * A project's thinking is written down in three layers, each a file in **the project folder**: the
 * goal (`goal.md`), the specifications (`*.spec.md`) and the plans (`*.plan.md`). The rule the
 * workbench applies to a folder is the rule here, unchanged — one file per layer, its path
 * relative to that folder is its identity, links between documents are ordinary markdown. Nothing
 * about a layer is stored anywhere else, and nothing is read from anywhere else.
 *
 * `spec.md` at the root is the conventional index; every other `*.spec.md` — at the root or in a
 * subfolder — is one spec, named by its first heading, and a spec and a plan that share a stem are
 * the two layers of one piece of work.
 *
 * This is the "one project's work" surface: the parsing layer (`spec-docs.ts`) and the report
 * (`layers.ts`) are gathered here, beside the project-level entry point
 * (`buildProjectLayers`), so a reader of a project's layers has one place to look.
 *
 * ## What the report leaves out
 *
 * A project folder also holds the app's own plumbing: `config.json`, `MEMORY.md`, and the
 * `assets/` folder the Assets tab already lists. None of them is something the author put there
 * to be read, and the assets are named once already — the workbench's own rule is that nothing
 * is listed twice. So the material list drops them.
 *
 * This is not the "never filter what the author puts in the folder" rule being broken: that rule
 * is about not constraining what **the author** may put there, and none of these three names is
 * the author's.
 *
 * ## What it does not do
 *
 * It never leaves the project folder. A layer shared with another project is read by following the
 * link that points at it (`links.ts`) — a link is navigation, and a project that no longer exists
 * turns up as a link that points at nothing, which is a fact this report already states.
 */

import { getProjectPath, MEMORY_FILENAME } from './storage.ts'
import { buildWorkLayers, type LayerDocument, type WorkLayers } from './layers.ts'

export {
  parseSpecDocument,
  readSpecDocuments,
  specEntryPath,
} from './spec-docs.ts'
export type { SpecDocument, SpecDocuments } from './spec-docs.ts'
export { buildWorkLayers }
export type { LayerDocument, WorkLayers }

/**
 * Names inside a project folder that belong to the app rather than to the author.
 *
 * Compared against the first path segment, so `assets/` and everything under it is dropped
 * whether it is empty or holds fifty uploads.
 */
const APP_OWNED = new Set(['config.json', MEMORY_FILENAME, 'assets'])

/**
 * The layers of one project, read from its folder.
 *
 * Never throws: a project folder that is not there reads as a folder with nothing in it, which
 * is the honest state of a project nothing has been written into yet.
 */
export function buildProjectLayers(
  workspaceRootPath: string,
  projectSlug: string,
): WorkLayers {
  const report = buildWorkLayers(getProjectPath(workspaceRootPath, projectSlug), projectSlug)

  return {
    ...report,
    files: report.files.filter((file) => !APP_OWNED.has(file.name.split('/')[0] ?? file.name)),
  }
}
