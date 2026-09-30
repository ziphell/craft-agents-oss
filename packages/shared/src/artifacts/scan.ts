/**
 * The walk — the one impure half of the artifact library.
 *
 * Kept apart from `derive.ts` (`index.ts` stays free of `node:fs`, so the renderer
 * may import the types and the pure functions) and asked for nothing but the
 * files: which of them are artifacts is `deriveArtifactEntries`' decision, and a
 * refusal test here would be a second copy of it.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isIgnoredDirectoryName } from './derive.ts'
import type { ArtifactFileRef } from './types.ts'

/**
 * How deep to descend. A convention, not a limit anyone should meet: work lives a
 * few folders down, and a bound is what keeps a pathological tree from hanging
 * the caller that asked for the list.
 */
const MAX_DEPTH = 12

/**
 * Every file under `workspaceRootPath`, as the disk reports it — relative, POSIX.
 *
 * The caller filters (`deriveArtifactEntries`); this only walks. A directory whose
 * name is ignored is never descended into, and a symlink is never followed —
 * a loop in the tree would otherwise be walked until the depth bound, for nothing.
 */
export function scanArtifactFiles(workspaceRootPath: string): ArtifactFileRef[] {
  const files: ArtifactFileRef[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return

    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      // Unreadable or gone: nothing to list, and not this function's to report.
      return
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const absolute = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (isIgnoredDirectoryName(entry.name)) continue
        walk(absolute, depth + 1)
        continue
      }

      if (!entry.isFile()) continue
      try {
        files.push({
          path: relative(workspaceRootPath, absolute).split(sep).join('/'),
          mtimeMs: statSync(absolute).mtimeMs,
        })
      } catch {
        // Vanished between the listing and the stat.
      }
    }
  }

  walk(workspaceRootPath, 0)
  return files
}
