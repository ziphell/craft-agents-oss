/**
 * The bundled drawio editor, served by the hub at the app's own origin.
 *
 * The web UI has no Electron process to hand out a `craft-local://` address, so the editor an
 * embedded frame loads has to come from the hub. It is served **same-origin** — `/drawio/…` —
 * which is the arrangement the person asked for: the assets are behind the same session cookie
 * as the app, and the frame's `postMessage` bridge needs no token of its own.
 *
 * What that costs is stated where the CSP is: a same-origin frame runs with the app's
 * privileges. The bundle is vendored, offline and first-party, so that is accepted; the policy
 * still refuses everything outside this origin and keeps the frame out of the top window.
 *
 * Paths mirror the desktop host (`apps/electron/src/main/drawio-host.ts`):
 *   /drawio/                     the vendored editor (`index.html`)
 *   /drawio/__craft/viewer.html  the viewer shell
 *   /drawio/__craft/viewer.js    its bridge
 *   /drawio/<file>               a vendored asset
 */

import {
  contentTypeFor,
  resolveServedPath,
} from '@craft-agent/shared/local-origin'
import { DRAWIO_VIEWER_PATH } from '@craft-agent/shared/drawio/types'
import {
  DRAWIO_VIEWER_SCRIPT_PATH,
  drawioViewerBridgeScript,
  drawioViewerShellDocument,
} from '@craft-agent/shared/drawio/viewer-shell'
import type { WebuiRuntime } from './runtime'

/** Where the editor's assets live on the app's origin. */
export const DRAWIO_ROUTE_BASE = '/drawio'

/**
 * The viewer shell's policy: this origin only, and no network beyond it.
 *
 * `connect-src 'self'` is not optional: the viewer loads its own stencils and images from this
 * origin. `frame-ancestors 'self'` keeps the editor from being embedded anywhere but the app.
 */
const VIEWER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ')

/**
 * The editor document's policy — looser by exactly what drawio needs to boot.
 *
 * The vendored `index.html` is drawio's own application, not a document this repo writes, and
 * it carries inline bootstrap code. `unsafe-inline`/`unsafe-eval` are confined to *this*
 * origin's editor; the network is still closed (`connect-src 'self'`), which is what keeps the
 * editor offline and stops it reaching viewer.diagrams.net.
 */
const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ')

const BUNDLE_CACHE = 'public, max-age=600'

function html(body: string, csp: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    },
  })
}

export interface DrawioRouteOptions {
  dir: string
  runtime: WebuiRuntime
}

/**
 * Answer a `/drawio/…` request, or null when the path is not ours.
 *
 * Called **after** the session check in the web UI handler: the editor is not a secret, but it
 * is part of the app and there is no reason for an anonymous visitor to use the hub as a static
 * host. `<base>` inside the shell is `/drawio/`, so every relative resource drawio asks for
 * lands under this prefix.
 */
export async function serveDrawioRoute(
  req: Request,
  pathname: string,
  options: DrawioRouteOptions,
): Promise<Response | null> {
  if (pathname !== DRAWIO_ROUTE_BASE && !pathname.startsWith(`${DRAWIO_ROUTE_BASE}/`)) {
    return null
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  // `/drawio` without the slash would resolve drawio's relative resources against the app root,
  // so send the one address that has a base.
  if (pathname === DRAWIO_ROUTE_BASE) {
    return new Response(null, { status: 302, headers: { Location: `${DRAWIO_ROUTE_BASE}/` } })
  }

  const rest = pathname.slice(DRAWIO_ROUTE_BASE.length)

  if (rest === '/') {
    const index = resolveServedPath(options.dir, 'index.html')
    const file = index ? await options.runtime.openAsset(index) : null
    if (!file) {
      return new Response('The bundled drawio editor is not installed.', { status: 404 })
    }
    return new Response(file, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': EDITOR_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-store',
      },
    })
  }

  if (rest === DRAWIO_VIEWER_PATH) {
    return html(drawioViewerShellDocument(DRAWIO_ROUTE_BASE), VIEWER_CSP)
  }

  if (rest === DRAWIO_VIEWER_SCRIPT_PATH) {
    return new Response(drawioViewerBridgeScript(DRAWIO_ROUTE_BASE), {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  }

  const relative = rest.replace(/^\/+/, '')
  const target = resolveServedPath(options.dir, relative)
  if (!target) {
    return new Response(`Nothing of drawio is reachable at ${pathname}.`, { status: 403 })
  }
  const file = await options.runtime.openAsset(target)
  if (!file) {
    return new Response(`Nothing of drawio is at ${pathname}.`, { status: 404 })
  }

  return new Response(file, {
    headers: {
      'Content-Type': contentTypeFor(target),
      'Cache-Control': BUNDLE_CACHE,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  })
}
