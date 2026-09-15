/**
 * Prototype workbench storage.
 *
 * The patch index is *derived* — {@link scanPrototypePatches} rebuilds it from
 * the `patches/` directory on every call. There is intentionally no
 * `manifest.json` to hand-write, which is what lets parallel lanes write their
 * own patch files without ever contending on a shared file.
 *
 * @see docs/prototype-workbench-plan.md §3.3 (constraint 2) and §6.2
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getWorkspacePrototypesPath } from '../workspaces/storage.ts'
import type { PrototypeArtifacts, PrototypePatch, PrototypePatchKind } from './types.ts'

const PATCHES_DIRNAME = 'patches'
const DIST_DIRNAME = 'dist'

/**
 * Patch files must be named `{lane}-{nnn}-{slug}.{css|js}`. Anything else in the
 * directory (READMEs, editor backups, notes) is ignored rather than replayed.
 */
const PATCH_NAME_RE = /^([A-Za-z])-(\d+)-.+\.(css|js)$/

/** Absolute path to a prototype project directory. */
export function getPrototypeProjectPath(workspaceRootPath: string, slug: string): string {
  return join(getWorkspacePrototypesPath(workspaceRootPath), slug)
}

/** Absolute path to a prototype project's patches directory. */
export function getPrototypePatchesPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeProjectPath(workspaceRootPath, slug), PATCHES_DIRNAME)
}

/** Absolute path to a prototype project's exported deliverables. */
export function getPrototypeDistPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeProjectPath(workspaceRootPath, slug), DIST_DIRNAME)
}

/** Init-script key for a patch — stable across re-scans so re-apply is idempotent. */
export function getPrototypePatchKey(slug: string, file: string): string {
  return `prototype:${slug}:${file}`
}

/**
 * Rebuild the ordered patch index by scanning the patches directory.
 *
 * Order is fully deterministic (lane → declared order → file name) so replay
 * never depends on directory listing order.
 */
export function scanPrototypePatches(workspaceRootPath: string, slug: string): PrototypePatch[] {
  const patchesDir = getPrototypePatchesPath(workspaceRootPath, slug)
  if (!existsSync(patchesDir)) return []

  const patches: PrototypePatch[] = []

  for (const file of readdirSync(patchesDir)) {
    const match = PATCH_NAME_RE.exec(file)
    if (!match) continue

    let source: string
    try {
      source = readFileSync(join(patchesDir, file), 'utf-8')
    } catch {
      // Unreadable patch (permissions, race) — skip rather than fail the replay.
      continue
    }

    patches.push({
      file,
      kind: match[3] as PrototypePatchKind,
      lane: match[1] ?? null,
      order: Number(match[2] ?? 0),
      source,
      key: getPrototypePatchKey(slug, file),
    })
  }

  patches.sort((a, b) => {
    const laneCompare = (a.lane ?? '').localeCompare(b.lane ?? '')
    if (laneCompare !== 0) return laneCompare
    if (a.order !== b.order) return a.order - b.order
    return a.file.localeCompare(b.file)
  })

  return patches
}

/** Load a prototype project's derived artifact index. */
export function loadPrototypeArtifacts(workspaceRootPath: string, slug: string): PrototypeArtifacts {
  return {
    slug,
    dir: getPrototypeProjectPath(workspaceRootPath, slug),
    patches: scanPrototypePatches(workspaceRootPath, slug),
  }
}
