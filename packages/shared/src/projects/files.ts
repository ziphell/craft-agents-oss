/**
 * Folder file listing.
 *
 * The one small reader that goes with a project folder's own paths: the listing of the
 * author's own files. Nothing here is an index — a project's derived facts are
 * recomputed from disk on every call, so nobody ever contends on a shared
 * hand-written file.
 */

import { readdirSync } from 'fs'
import { join } from 'path'

/**
 * One file of a folder: a name to show, and the absolute path to open.
 *
 * `name` is the file's path relative to the folder, with `/` separators
 * (`spec.md`, `docs/features.md`) — the shape every other relative path here uses, and the
 * name a report can print on one line.
 */
export interface FolderFile {
  name: string
  path: string
}

/**
 * Every file of a folder, recursively, in **any format** and in path order.
 *
 * An author organizes their work the way they organize work: one document or several, flat or
 * nested in folders. The folder is theirs, so nothing here filters by extension or by anything
 * else — what the author put there is what is listed. Hidden files and directories are skipped —
 * an editor's swap file is not something the author put there.
 *
 * No file is singled out: a spec is one `*.spec.md` file among the author's files, so there
 * is no one "brief" to separate (which files are specs is a fact `spec-docs.ts` derives
 * by name).
 */
export function listFiles(dir: string): FolderFile[] {
  const files: FolderFile[] = []

  const walk = (current: string, prefix: string): void => {
    let items
    try {
      items = readdirSync(current, { withFileTypes: true })
    } catch {
      // A directory that cannot be read is not a file of the folder. The top-level case is the
      // one that matters: a folder that has not been created yet, or one whose directory was
      // removed behind us, is an empty folder.
      return
    }

    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const name = prefix ? `${prefix}/${item.name}` : item.name
      const path = join(current, item.name)

      if (item.isDirectory()) {
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
 * Whether a file is markdown — the kind whose text the workbench reads as a *document*: its links
 * point at other documents (`links.ts`). (A spec is a file too, but it is named `.spec.md`
 * and found by name — `isSpecFile` — rather than by being markdown.)
 *
 * Here, beside the listing, rather than in `links.ts`, because it is a fact about a file's name and
 * every caller has to read it the same way. `.mdx` counts too.
 */
export function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.mdx')
}
