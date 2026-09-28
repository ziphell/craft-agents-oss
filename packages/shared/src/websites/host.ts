/**
 * What a website's own origin serves.
 *
 * A website is a **directory** addressed at its own origin
 * (`http://<slug>-<hash>.localhost/`, see `../local-origin.ts`), which is the point
 * of it: the site can load its own files by root-absolute path, keep state in
 * `localStorage`, and `fetch` its own endpoints — none of which an opaque
 * `srcdoc` document can do.
 *
 * What is decided here, and what is left to the caller: this module decides *which
 * file* a request names, and nothing about IO or responses. Existence is the
 * caller's question (only it can stat), so the two answers that need a file to be
 * there — the root and a history-API route — come back as a candidate path, and a
 * missing one is a 404 the caller words.
 *
 * Two rules are worth stating because they are the ones a reader will ask about:
 *
 * - **A path with no file extension is the site's own document.** A website is one
 *   document with as many screens as its JS switches between, so a history-API
 *   route (`/orders`) is a real request on reload and has no file behind it. It
 *   falls back to `index.html` — but only for a navigation (the check is
 *   `isDocumentRequest`, `../local-origin.ts`), so `fetch('/api/orders')`
 *   gets a 404 rather than an HTML document it would try to parse as JSON.
 * - **What the app keeps about the site is not the site** — with one exception, which is
 *   the site's own. `website.json`, `thumbnail.jpg` and the SQLite store under `data/` are
 *   the host's bookkeeping (the config, the cached poster, the script-private working file)
 *   and none of them is served on the site's origin. {@link WEBSITE_DATA_PATH} is the one
 *   path in there that belongs to the site rather than to the app. This is a *name* rule,
 *   not an enumeration of what a site may contain: everything else in the directory is the
 *   author's, and is served as written.
 * - **A site reads its own data by fetching it.** The store is SQLite under the Bun runtime
 *   (`./data-store.ts`) and this host is Node, so no request can reach the store itself:
 *   what the site's own scripts fetch at {@link WEBSITE_DATA_PATH} is the snapshot that
 *   store publishes (`./storage.ts`), which is the same file the app's own UI reads. One
 *   shape, one file, no second copy to keep in step.
 */

import { extname } from 'path'
import { isDocumentRequest, resolveServedPath } from '../local-origin.ts'
import { WEBSITE_CONFIG_FILENAME, WEBSITE_SNAPSHOT_FILENAME, WEBSITE_THUMBNAIL_FILENAME } from './storage.ts'

/** A website, as its own origin sees it. */
export interface ServedWebsite {
  workspaceRootPath: string
  slug: string
  /** Absolute website directory — this host's root. */
  dir: string
}

/** The one document a website's address root opens, and what a route falls back to. */
export const WEBSITE_INDEX_FILE = 'index.html'

/** The host's own files, never served: these name what the app keeps, not the site. */
const HOST_FILES = new Set([WEBSITE_CONFIG_FILENAME, WEBSITE_THUMBNAIL_FILENAME])

/** The app's own directory inside a website, holding its data (`getWebsiteDataPath`). */
const DATA_DIRNAME = 'data'

/** The host's own directory, never served — `getWebsiteDataPath` in `./storage.ts`. */
const HOST_DIRS = new Set([DATA_DIRNAME])

/**
 * Where a website's own JavaScript reads its data: `fetch('/data/snapshot.json')`.
 *
 * The one path under `data/` that is the site's rather than the app's. It is the snapshot
 * the store publishes — the only artifact of the store any other process may read — so a
 * site's scripts, which run in a browser that cannot open SQLite, get the data with an
 * ordinary `fetch`. A website has a real origin precisely so that its own scripts can
 * fetch something; without this path a site's data would exist and be unreachable from the
 * page it is about.
 *
 * The whole snapshot comes back in one response (every kv entry and the last
 * `DEFAULT_SNAPSHOT_MAX_POINTS_PER_SERIES` points of every series), which is small enough
 * to be one request and one shape to learn. When no refresh or write has run yet the file
 * is not there and the answer is a 404 — "nothing yet" rather than an empty dataset that
 * would read as "the data is empty".
 */
export const WEBSITE_DATA_PATH = `${DATA_DIRNAME}/${WEBSITE_SNAPSHOT_FILENAME}`

/** What a request on a website's origin names. */
export type WebsiteResolution =
  /** Serve this absolute path from disk. */
  | { kind: 'file'; path: string }
  /** Nothing of the site is at that path; `reason` is for the 404 body. */
  | { kind: 'missing'; reason: string }
  /** The path is one the host does not answer for at all. */
  | { kind: 'refused'; reason: string }

/**
 * Is this path (relative, `/`-separated) one the host keeps for itself?
 *
 * Exported because it is asked in two places that must agree: what a website's origin
 * refuses to serve, and what an export leaves behind (`./export.ts`). A file served in the
 * app is a file in the copy and the other way round, so both questions have to have one
 * answer.
 *
 * {@link WEBSITE_DATA_PATH} is **not** the host's: the directory is the app's, the
 * published snapshot inside it is the site's data, and that is why a site can fetch it and
 * a copy of the site carries it.
 */
export function isWebsiteHostOwned(relativePath: string): boolean {
  if (relativePath === WEBSITE_DATA_PATH) return false

  const [first] = relativePath.split('/')
  return first !== undefined && (HOST_FILES.has(first) || HOST_DIRS.has(first))
}

/**
 * Decide what `requested` names inside `website.dir`.
 *
 * `requested` is the pathname with its leading slashes stripped — `''` is the
 * address root, which is the site's document.
 */
export function resolveWebsiteRequest(
  website: ServedWebsite,
  requested: string,
  accept: string | undefined,
): WebsiteResolution {
  if (isWebsiteHostOwned(requested)) {
    return {
      kind: 'refused',
      reason: `/${requested} is what the app keeps about this website, not part of it.`,
    }
  }

  const path = resolveServedPath(website.dir, requested)
  const index = resolveServedPath(website.dir, WEBSITE_INDEX_FILE)
  if (!path || !index) return { kind: 'refused', reason: 'Path escapes the website directory.' }

  // The root opens the site's document; a path that names a file is that file.
  const namesAFile = requested !== '' && extname(requested) !== ''
  if (namesAFile) return { kind: 'file', path }

  // A history-API route inside that same document — a navigation only, so a
  // `fetch` for a path that does not exist stays a 404.
  if (requested !== '' && !isDocumentRequest(`/${requested}`, accept)) {
    return { kind: 'missing', reason: `Nothing of this website is at /${requested}.` }
  }

  return { kind: 'file', path: index }
}
