/**
 * Prototype workbench storage.
 *
 * The paths inside a prototype's own directory, plus the two small readers that go
 * with them: the listing of the author's own files, and a content fingerprint.
 * Nothing here is an index — a prototype's derived facts are recomputed from disk
 * on every call, so nobody ever contends on a shared hand-written file.
 */

import { readdirSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import {
  PROTOTYPE_RESEARCH_DIRNAME,
  PROTOTYPE_REVIEWS_DIRNAME,
} from './types.ts'

/**
 * Paths inside a prototype's own directory.
 *
 * "Directory", never "project": this workspace also has real **projects**
 * (`{workspace}/projects/{slug}/` — the containers that group sessions, tasks
 * and shared assets), and they are unrelated to prototypes. A prototype is not
 * nested inside a project, and nothing records an ownership edge between them.
 */

/** Absolute path to a prototype's directory. */
export function getPrototypeDirPath(workspaceRootPath: string, slug: string): string {
  return join(getWorkspacePrototypesPath(workspaceRootPath), slug)
}

/**
 * Absolute path to a prototype's research directory.
 *
 * Sits with the other path builders because it is the same kind of fact — a
 * directory name that more than one module agrees on — and because the
 * distinction it draws is a rule, not a preference: `assets/` is a file the
 * prototype itself loads, while `research/` is how the author got to the
 * requirements and is therefore not packed.
 */
export function getPrototypeResearchPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_RESEARCH_DIRNAME)
}

/** Absolute path to a prototype's reviews — the arguments against the work. */
export function getPrototypeReviewsPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), PROTOTYPE_REVIEWS_DIRNAME)
}

/**
 * One file of a prototype's own directory: a name to show, and the absolute path to open.
 *
 * `name` is the file's path relative to the prototype's directory, with `/` separators
 * (`PRD.md`, `docs/features.md`) — the shape every other relative path here uses, and the
 * name a report can print on one line.
 */
export interface PrototypeFileEntry {
  name: string
  path: string
}

/**
 * Every file of a prototype's own directory, recursively, in **any format** and in path order.
 *
 * An author organizes their work the way they organize work: one document or several, flat or
 * nested in folders. The folder is theirs, so nothing here filters by extension or by anything
 * else — what the author put there is what is listed.
 *
 * Two directories are not the prototype's own files and have readers of their own, so they are
 * not walked: `research/` (findings) and `reviews/` (disputes). Hidden files and directories are
 * skipped — an editor's swap file is not something the author put there.
 *
 * No file is singled out: with requirements readable from any markdown file, there is no one
 * "brief" to separate (which files define requirements is a fact `requirements.ts` derives).
 */
export function listPrototypeFiles(workspaceRootPath: string, slug: string): PrototypeFileEntry[] {
  const dir = getPrototypeDirPath(workspaceRootPath, slug)
  const files: PrototypeFileEntry[] = []

  const walk = (current: string, prefix: string): void => {
    let items
    try {
      items = readdirSync(current, { withFileTypes: true })
    } catch {
      // A directory that cannot be read is not a file of the prototype. The top-level case is the
      // one that matters: a prototype that has not been created yet, or one whose directory was
      // removed behind us, is an empty folder.
      return
    }

    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const name = prefix ? `${prefix}/${item.name}` : item.name
      const path = join(current, item.name)

      if (item.isDirectory()) {
        if (item.name === PROTOTYPE_RESEARCH_DIRNAME || item.name === PROTOTYPE_REVIEWS_DIRNAME) continue
        walk(path, name)
      } else if (item.isFile()) {
        files.push({ name, path })
      }
    }
  }

  walk(dir, '')
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Whether a file is markdown — the kind whose text the workbench reads as a *document*: its headings
 * can state a requirement (`requirements.ts`) and its links point at other documents (`links.ts`).
 * `.mdx` reads as markdown too.
 *
 * Here rather than in either reader because both have to agree on it: a file one reads and the other
 * does not is a requirement nothing can link to, or a link nothing can define.
 */
export function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.mdx')
}

/**
 * A short content fingerprint of a source — the one thing a fingerprint is for here: telling
 * "this file changed" from "this file is as it was" without keeping a copy of it.
 *
 * Used by `reviews/`: a dispute records the fingerprint of what it disputes, and is reported as
 * **stale** if that thing no longer hashes to it.
 */
export function contentFingerprint(source: string): string {
  return createHash('sha256').update(source, 'utf-8').digest('hex').slice(0, 8)
}
