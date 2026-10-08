/**
 * Serving a design folder over the app's own scheme.
 *
 * A design is a folder (`index.html`, its assets, its `data/`), and serving it by
 * address is what lets it be authored as one: relative stylesheets and module
 * scripts resolve, the address keeps a fragment across a reload, and the same file
 * can be opened in the workspace browser by a person.
 *
 * **Which session this is installed on, and what it will not serve.** Protocol handlers
 * are per session, and this one is installed on the app's own session *and* on the one
 * the workspace browser uses — the second so a design can be opened in a tab and, with its
 * snapshot served, render the same numbers there as it does in the app.
 *
 * What makes that acceptable is that a design's address is a **capability**: the label
 * carries a hash of the design's directory, so it cannot be derived from the slug the app
 * shows and cannot be enumerated. Anyone holding a design's address can read what that
 * address serves — the design's document, its assets, and its `data/snapshot.json` — the
 * same bargain a share link makes.
 *
 * And the fence inside `data/` is the one the data model already draws: **`snapshot.json` is
 * the artifact a design (and every host) reads** — it is what `write_design_data` and a
 * refresh script regenerate — while `store.sqlite` is the script-private working store. Only
 * the snapshot is served; the store, its `-wal` and `-shm` are not there at all.
 *
 * (Measured, `spike/craft-local-probe.cjs`: with a handler present a *foreign* origin's fetch
 * is answered 200 whatever `corsEnabled` says, and a session without a handler cannot load a
 * design frame at all — so the session is not the door, and the two rules above are.)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getWorkspaces } from '@craft-agent/shared/config'
import { getWorkspaceDesignsPath, designDirForLabel } from '@craft-agent/shared/designs'
import { contentTypeFor, isDocumentRequest, labelFromHost, resolveServedPath } from '@craft-agent/shared/local-origin'
import { fileResponse, isFile, textResponse } from './local-http'
import { mainLog } from './logger'

/** Every design folder the app could serve, as label candidates. */
function designCandidates(): Array<{ slug: string; dir: string }> {
  const candidates: Array<{ slug: string; dir: string }> = []
  for (const workspace of getWorkspaces()) {
    const designsDir = getWorkspaceDesignsPath(workspace.rootPath)
    if (!existsSync(designsDir)) continue
    for (const entry of readdirSync(designsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      candidates.push({ slug: entry.name, dir: join(designsDir, entry.name) })
    }
  }
  return candidates
}

/**
 * Answer a request for a design, or `null` when the label is not one of ours
 * (the router then gives the next host its turn, and honestly 404s if none takes it).
 */
export async function serveDesignPreviewRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  const label = labelFromHost(url.hostname)
  if (!label) return null

  const designDir = designDirForLabel(label, designCandidates())
  if (!designDir) return null

  try {
    const target = await resolveDesignTarget(designDir, url.pathname, request)
    if (!target) return textResponse(404, `No design file at ${url.pathname}.`)
    return fileResponse(request, {
      body: readFileSync(target),
      contentType: contentTypeFor(target),
    })
  } catch (error) {
    // Never hand the frame a network error because *we* failed: this branch is only
    // reachable for a label that is ours.
    mainLog.warn(`[design-preview] failed to serve ${request.url}: ${String(error)}`)
    return textResponse(500, 'The design could not be served. See the app logs.')
  }
}

/**
 * The file a request names, or `null` when there is none.
 *
 * A path that names a file is never answered with the document (a missing script
 * must stay a missing script), while a path that names no file — a route the design
 * itself handles, or the folder root — is the document.
 */
export async function resolveDesignTarget(
  designDir: string,
  pathname: string,
  request: Request,
): Promise<string | null> {
  // `resolveServedPath` takes a *relative* path: a leading slash would be read as
  // an absolute one by `path.resolve` and the fence would (correctly) refuse it.
  const relative = pathname.replace(/^\/+/, '') || 'index.html'
  // Inside `data/`, one file is served and one only: the snapshot every design reads.
  // The store (and its -wal/-shm) is the script-private working file and is not on
  // this origin. Compared case-insensitively because the filesystem is.
  const segments = relative.toLowerCase().split(/[\\/]/)
  if (segments[0] === 'data' && !(segments.length === 2 && segments[1] === 'snapshot.json')) return null
  const file = resolveServedPath(designDir, relative)
  if (!file) return null
  if (await isFile(file)) return file
  if (!isDocumentRequest(pathname, request.headers.get('accept') ?? undefined)) return null

  const documentPath = resolveServedPath(designDir, 'index.html')
  if (!documentPath) return null
  return (await isFile(documentPath)) ? documentPath : null
}
