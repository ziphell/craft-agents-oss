/**
 * The drawio editor and viewer, answered by Electron at their own origin.
 *
 * drawio is a web application (HTML + a ~9 MB script + styles, images and stencil
 * data), so it needs what any served app needs before it will run: a real origin,
 * root-absolute references that resolve, and no `file://` opaque-origin surprises.
 * That is exactly what `local-origin.ts` hands out, and this module is the one
 * feature that uses it for something that is *not* a workspace directory — the files
 * come from the app's own bundle (`resources/drawio/`), never from a workspace.
 *
 * Three consequences follow from "the app's own bundle", and they are why this is a
 * host of its own:
 *
 * - **There is one editor per app, not one per workspace.** A directory served from a
 *   workspace keys a registry by label because two workspaces can hold the same slug;
 *   here a single slot is the honest shape, and its label is derived from the install path.
 * - **Nothing here is authored.** A directory served from a workspace is a person's work
 *   and is served live off the disk; these are a vendored dependency, fetched and pruned by
 *   `scripts/fetch-drawio-assets.ts`. So there is no write path and no watcher.
 * - **The origin is offline by construction.** A content-security policy on the shell
 *   document allows its own origin and nothing else, so the guarantee that a diagram
 *   never reaches the network is enforced rather than promised.
 *
 * What is served is decided in two places: the path naming a vendored file, and a
 * reserved path for the app's own shell document (see `drawio/types.ts` for the
 * bridge the shell and the renderer speak).
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import {
  contentTypeFor,
  isDocumentRequest,
  labelFromHost,
  LOCAL_ORIGIN_SCHEME,
  localHostLabel,
  localHostOrigin,
  resolveServedPath,
} from '@craft-agent/shared/local-origin'
import {
  DRAWIO_EMBED_PARAMS,
  DRAWIO_VIEWER_PATH,
} from '@craft-agent/shared/drawio/types'
import {
  DRAWIO_VIEWER_SCRIPT_PATH,
  drawioViewerBridgeScript,
  drawioViewerShellDocument,
} from '@craft-agent/shared/drawio/viewer-shell'
import {
  DRAWIO_ENGINE_PATH as SHARED_DRAWIO_ENGINE_PATH,
  DRAWIO_ENGINE_SCRIPT_PATH as SHARED_DRAWIO_ENGINE_SCRIPT_PATH,
  DRAWIO_ENGINE_SURFACE as SHARED_DRAWIO_ENGINE_SURFACE,
  DRAWIO_SHELL_CSP,
  drawioEngineBridgeScript,
  drawioEngineShellDocument,
} from '@craft-agent/shared/drawio/engine-shell'
import {
  DRAWIO_EDIT_BRIDGE_PATH,
  drawioEditBridgeScript,
  injectDrawioEditBridge,
} from '@craft-agent/shared/drawio/edit-bridge'
import { getBundledAssetsDir } from '@craft-agent/shared/utils/paths'
import { fileResponse, isFile, textResponse, type ProtocolHostSession } from './local-http'
import { mainLog } from './logger'

/**
 * The vendored directory this host serves, once an address has been handed out.
 *
 * One slot, not a map: the bundle is a single install-wide directory, so there is
 * nothing to disambiguate. Null until `drawioOriginUrl` runs, which is also the
 * security boundary — the host never walks the disk looking for things to serve, so
 * an address exists only for a run that has asked for one.
 */
let served: { label: string; dir: string } | null = null

/**
 * Hand out an address for a drawio directory, and answer it from then on.
 *
 * The primitive: `drawioOriginUrl` is the app's entry point that finds the directory,
 * this one is what actually registers it. Split because the registration and the
 * serving are the parts with rules in them — the label's derivation, what a path may
 * name, what the shell document is allowed to load — and they can be driven from any
 * directory, which is what makes them testable without shipping 68 MB of drawio.
 */
export function registerDrawioOrigin(dir: string): string {
  const label = localHostLabel('drawio', dir)
  served = { label, dir }
  return localHostOrigin(label)
}

/**
 * The origin the bundled editor is reachable at, or null when it is not installed.
 *
 * Null is a real answer, not a failure to handle: the assets are fetched rather than
 * committed (see the fetch script), so a checkout that has never run it has no
 * editor. The caller turns that into a sentence instead of an empty frame.
 */
export function drawioOriginUrl(): string | null {
  const dir = getBundledAssetsDir('drawio')
  return dir && existsSync(dir) ? registerDrawioOrigin(dir) : null
}

/** The directory a label names, if this run has handed its address out. */
function resolveServedDrawio(url: string): string | null {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  const label = labelFromHost(host)
  return served && label === served.label ? served.dir : null
}

/**
 * The vendored files are the one thing on these origins worth caching.
 *
 * `local-http.ts` answers `no-store` for everything, and that is right for workspace
 * content — its files are edited constantly and a cached document would show an earlier
 * state without saying so. This directory is the opposite: it is a fetched release that
 * changes only when the fetch script re-runs, and without a cache every open re-reads ~10 MB of
 * editor scripts from disk and re-compiles them, which is the difference between a frame
 * appearing and the app feeling broken.
 *
 * Ten minutes rather than a year, because the label is derived from the *path* and so
 * survives a refetch: a long one would pin the previous drawio release for as long as it
 * lasted. This is a bound on the staleness a refetch can be subject to, not an
 * optimisation. The synthesized shell document is deliberately not covered — it is app
 * code that changes with the app.
 */
const BUNDLE_CACHE = 'public, max-age=600'

/**
 * Answer a request for the drawio origin, or null when the label is not ours.
 *
 * Null is the answer for a label this run never handed out — an address nobody served.
 * The caller refuses it: nothing shares this scheme with us, so there is no
 * pass-through to fall back to.
 */
export async function serveDrawioRequest(request: Request): Promise<Response | null> {
  const dir = resolveServedDrawio(request.url)
  if (!dir) return null

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(405, '', { allow: 'GET, HEAD' })
    }

    const { pathname } = new URL(request.url)

    // Our own document and its script, synthesized rather than read: they are app code,
    // and the vendored directory they sit beside is disposable.
    if (pathname === DRAWIO_VIEWER_PATH) {
      return fileResponse(request, {
        body: Buffer.from(drawioViewerShellDocument('')),
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': SHELL_CSP },
      })
    }

    // The editor's bridge: it is what lets a running editor take a change in place instead of
    // being replaced by one (see `drawio/edit-bridge.ts`).
    if (pathname === DRAWIO_EDIT_BRIDGE_PATH) {
      return fileResponse(request, {
        body: Buffer.from(drawioEditBridgeScript('')),
        contentType: 'text/javascript; charset=utf-8',
      })
    }

    if (pathname === DRAWIO_VIEWER_SCRIPT_PATH) {
      return fileResponse(request, {
        body: Buffer.from(drawioViewerBridgeScript('')),
        contentType: 'text/javascript; charset=utf-8',
      })
    }

    // The headless side: `drawio_tool`'s conversion and its renderings. Same shape as the
    // viewer's two paths above, and reserved for the same reason — the vendored directory is
    // refetched and pruned, and would take our documents with it.
    if (pathname === DRAWIO_ENGINE_PATH) {
      return fileResponse(request, {
        body: Buffer.from(engineShellDocument()),
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': SHELL_CSP },
      })
    }

    if (pathname === ENGINE_SCRIPT_PATH) {
      return fileResponse(request, {
        body: Buffer.from(engineBridgeScript()),
        contentType: 'text/javascript; charset=utf-8',
      })
    }

    const requested = pathname.replace(/^\/+/, '')
    const accept = request.headers.get('accept') ?? undefined

    // A navigation with no file behind it is the editor document, so the origin has
    // one address a person can open. A path that names a file never falls back:
    // answering a missing script with HTML turns a clear 404 into a parse error.
    const target = isDocumentRequest(pathname, accept)
      ? resolveServedPath(dir, 'index.html')
      : resolveServedPath(dir, requested)
    if (!target) return textResponse(403, `Nothing of drawio is reachable at /${requested}.`)

    if (!(await isFile(target))) {
      return textResponse(404, `Nothing of drawio is at /${requested}.`)
    }

    const body = await readFile(target)
    // The editor is drawio's own document, with this app's bridge appended. Nothing else in the
    // bundle is touched — the directory is refetched, so an edit inside it would not survive.
    const edited = target === resolveServedPath(dir, 'index.html')
      ? injectDrawioEditBridge(body.toString('utf8'), '')
      : body

    return fileResponse(request, {
      body: typeof edited === 'string' ? Buffer.from(edited) : edited,
      contentType: contentTypeFor(target),
      headers: { 'cache-control': BUNDLE_CACHE },
    })
  } catch (error) {
    // Never hand the frame a network error because *we* failed: this branch is only
    // reachable for a host that is ours.
    mainLog.warn(`[drawio-host] failed to serve ${request.url}: ${String(error)}`)
    return textResponse(500, 'The diagram editor could not be served. See the app logs.')
  }
}

/**
 * Install the drawio host on a session — a handler for the app's own scheme, and no other.
 *
 * One call per session the diagram is rendered on. The app renders it on its own session
 * (the embedded viewer and the hidden engine window both live there), so that is the one
 * this is registered on.
 *
 * A scheme of our own is the whole point: the app installs **no** handler on `http` or
 * `https`, so a request for a real page never enters this process and every browsing
 * session stays Chromium's. The cost of the alternative was paid in full — a handler on
 * `http` comes down on every http request the session makes, and re-issuing those through
 * the host is what quietly broke real http pages.
 */
export function registerDrawioHandler(ses: ProtocolHostSession): void {
  ses.protocol.handle(LOCAL_ORIGIN_SCHEME, async (request) => {
    const response = await serveDrawioRequest(request)
    return response ?? textResponse(404, `No diagram is served at ${request.url}.`)
  })
}

/**
 * The shell document's policy: its own origin and inline styles, no network.
 *
 * `connect-src 'self'` rather than `'none'` because the viewer loads its own stencil
 * and image data by same-origin request; the clause that matters is the absence of
 * any other scheme, which is what makes "offline" a property of the document instead
 * of a promise about behaviour. Drawio's own scripts are served from this origin, so
 * `script-src 'self'` costs nothing and blocks anything that tries to arrive later.
 *
 * **There is no `'unsafe-inline'` and no nonce, so the shell may not carry an inline
 * script.** That is why the bridge below is a separate file: inlining it back would be
 * blocked silently, the page would never say `ready`, and the embedding card could only
 * read that as "still loading" — a blank progress line with nothing in the logs.
 */
const SHELL_CSP = DRAWIO_SHELL_CSP

// The viewer's shell document and bridge are shared with the web UI's same-origin host — see
// `@craft-agent/shared/drawio/viewer-shell`. This host serves them at the origin root (`''`).

// ── The headless engine: conversion and renderings, for `drawio_tool` ───────

/**
 * The page the headless side drives, and its script — shared with the hub's renderer.
 *
 * Same reason as the viewer's two paths: reserved paths rather than files under the vendored
 * directory, which is refetched and pruned and would take our documents with it. The document and
 * the bridge live in `@craft-agent/shared/drawio/engine-shell`, so the desktop and a hub cannot
 * drift into serving two different protocols to the same editor.
 */
export const DRAWIO_ENGINE_PATH = SHARED_DRAWIO_ENGINE_PATH
export const DRAWIO_ENGINE_SURFACE = SHARED_DRAWIO_ENGINE_SURFACE
const ENGINE_SCRIPT_PATH = SHARED_DRAWIO_ENGINE_SCRIPT_PATH

function engineShellDocument(): string {
  return drawioEngineShellDocument()
}

/** drawio's embed query string: it decides whether the editor may reach the network at all. */
function engineBridgeScript(): string {
  return drawioEngineBridgeScript(DRAWIO_EMBED_PARAMS)
}
