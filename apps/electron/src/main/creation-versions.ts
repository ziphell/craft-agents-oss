/**
 * Where a work's versions live on this machine.
 *
 * The same rule as the posters, and for the same reason: **nothing of ours goes in the workspace.**
 * A version is a cache — a copy kept so the library can answer "what did this say before" — and a
 * cache that writes into a person's folder is a folder they did not ask for. So it sits under the
 * app's own data folder, one directory per workspace, keyed by the workspace's path.
 *
 * The store itself is `@craft-agent/shared/creations/versions`; this file only says where it is,
 * which is the one thing a hub cannot answer (`creationVersions` is absent there, and the library
 * then offers no versions rather than pretending).
 */

import { app } from 'electron'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function creationVersionDir(workspaceRootPath: string): string {
  const workspace = createHash('sha1').update(workspaceRootPath).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'creation-versions', workspace)
}
