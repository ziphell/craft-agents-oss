/**
 * `/tmp` on Windows.
 *
 * Windows has no `/tmp`. A path that starts with a separator is rooted at the **current drive**, so
 * anything that writes `/tmp/shots/a.png` silently lands in `C:\tmp\shots\a.png` (or `D:\tmp\…`
 * when the working directory sits on another drive). The app's own file reads are bounded to the
 * home directory, the real temp directory and the workspace, so the file writes fine and then
 * cannot be read back.
 *
 * Rewriting paths in the places we control is not enough: a script file, a PowerShell one-liner or
 * an external program resolves `/tmp` itself, and then writer and reader disagree about where the
 * folder is. One junction makes every one of them agree: `C:\tmp` → the real temp directory, so the
 * native meaning of `/tmp` and the allowed temp directory are the same files.
 *
 * Best-effort and idempotent. It never throws and never moves or deletes a real directory that may
 * hold someone's files — a `C:\tmp` that is already a plain folder is reported, not replaced.
 */

import { lstatSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

export type TmpAliasStatus =
  | 'linked'
  | 'already-linked'
  | 'skipped'
  | 'unsupported'
  | 'failed'

export interface TmpAliasResult {
  status: TmpAliasStatus
  /** The drive-root spelling the OS itself gives `/tmp`, e.g. `C:\tmp`. */
  linkPath: string
  /** Where it points: the real temp directory. */
  target: string
  /** Why nothing was created, for `skipped` / `failed`. */
  reason?: string
}

function defaultLinkPath(): string {
  const systemDrive = process.env.SystemDrive
  const drive = systemDrive && /^[A-Za-z]:$/.test(systemDrive) ? systemDrive : 'C:'
  return `${drive}\\tmp`
}

function comparable(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Ensure `<system drive>:\tmp` is a junction to the real temp directory.
 *
 * Only Windows is touched; every other platform returns `unsupported` before looking at the disk.
 */
export function ensureWindowsTmpAlias(
  linkPath: string = defaultLinkPath(),
  target: string = tmpdir(),
  platform: NodeJS.Platform = process.platform,
): TmpAliasResult {
  if (platform !== 'win32') {
    return { status: 'unsupported', linkPath, target }
  }

  let stats
  try {
    stats = lstatSync(linkPath)
  } catch {
    try {
      symlinkSync(target, linkPath, 'junction')
      return { status: 'linked', linkPath, target }
    } catch (error) {
      return {
        status: 'failed',
        linkPath,
        target,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  if (!stats.isSymbolicLink()) {
    return {
      status: 'skipped',
      linkPath,
      target,
      reason: 'a real directory already exists there; it is left untouched',
    }
  }

  // A junction is a symbolic link to Windows, so `realpath` is what says where it actually points.
  const pointsTo = comparable(linkPath)
  const wanted = comparable(target)
  if (pointsTo.toLowerCase() === wanted.toLowerCase()) {
    return { status: 'already-linked', linkPath, target }
  }

  return {
    status: 'skipped',
    linkPath,
    target,
    reason: `already linked to ${pointsTo}; it is left untouched`,
  }
}
