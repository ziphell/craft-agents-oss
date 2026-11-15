/**
 * Where the session index is remembered on this machine.
 *
 * The same rule as the posters and the versions, for the same reason: **nothing of ours goes in the
 * workspace.** The index is a cache of what the transcripts already say, so it lives under the app's
 * own data folder, one directory per workspace, keyed by the workspace's path.
 *
 * It exists for one number. Rebuilding the index from nothing costs a parse of every transcript in
 * the workspace — measured at 565 ms for 133 sessions / 140 MB — and that pause is what the first
 * open of the library in a session used to be. From here it is a warm scan, 75 ms.
 *
 * The store itself is `@craft-agent/shared/creations/cache-file`; this file only says where it is.
 */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function creationIndexDir(workspaceRootPath: string): string {
  const workspace = createHash('sha1').update(workspaceRootPath).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'creations-index', workspace)
}
