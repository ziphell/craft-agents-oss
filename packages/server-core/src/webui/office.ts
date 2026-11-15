/**
 * The bundled GenOffice editors, served by the hub at the app's own origin.
 *
 * The Web UI has no Electron process to hand out a `craft-local://` address, so the document an
 * embedded frame loads has to come from the hub. It is served **same-origin** — `/office/…` —
 * for the same reasons drawio is (`./drawio.ts`): the assets sit behind the session cookie the
 * app already issued, and the frame needs no token of its own. A same-origin frame runs with
 * the app's privileges, which is accepted because the bundle is vendored, offline and
 * first-party; the CSP still refuses everything outside this origin and keeps the frame out of
 * the top window.
 *
 * What differs from drawio is the bridge. The editor knows nothing about this app — it expects
 * `window.desktop` from a preload it does not have here — so the served document carries the
 * shim (`shared/office/shim.ts`) and talks to its parent, which is where the app is. Bytes
 * travel in those messages; this route serves code, and only code.
 *
 *   /office/<app>/                  the editor (`index.html`, with the shim injected)
 *   /office/<app>/<file>            a vendored asset
 *   /office/__craft/office-shim.js  the preload stand-in
 */

import { contentTypeFor, resolveServedPath } from '@craft-agent/shared/local-origin'
import { OFFICE_APPS, OFFICE_SHIM_PATH, type OfficeApp } from '@craft-agent/shared/office/types'
import { officeShimScript } from '@craft-agent/shared/office/shim'
import { prepareEditorDocument } from '@craft-agent/shared/office/document'
import { join } from 'node:path'
import type { WebuiRuntime } from './runtime'

/** Where the editors live on the app's origin. */
export const OFFICE_ROUTE_BASE = '/office'

/**
 * The editor's policy: this origin only, and no network beyond it.
 *
 * `connect-src 'self' blob:` is load-bearing — the shim turns the bytes the host sent into a
 * blob URL and the editor fetches it. `frame-ancestors 'self'` keeps the editor embedded only
 * by this app. The vendored document's own `<meta>` policy is dropped on the way out
 * (`prepareEditorDocument`), because a meta policy and this header are both enforced and the
 * vendored one forbids `blob:`.
 */
const EDITOR_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ')

const BUNDLE_CACHE = 'public, max-age=600'

export interface OfficeRouteOptions {
  /** The vendored directory: `<dir>/<app>/index.html` per editor. */
  dir: string
  runtime: WebuiRuntime
}

/** `<app>` from a path under the base, when it is an editor this hub serves. */
function parseRoute(rest: string): { app: OfficeApp; relative: string } | null {
  const match = /^\/?([a-z]+)(\/.*)?$/.exec(rest)
  if (!match) return null
  const app = match[1] as OfficeApp
  if (!OFFICE_APPS.includes(app)) return null
  return { app, relative: (match[2] ?? '/').replace(/^\/+/, '') }
}

/**
 * Answer an `/office/…` request, or null when the path is not ours.
 *
 * Called **after** the session check in the web UI handler, exactly as the drawio route is: the
 * bundle is not a secret, but an anonymous visitor has no business using the hub as a static
 * host.
 */
export async function serveOfficeRoute(
  req: Request,
  pathname: string,
  options: OfficeRouteOptions,
): Promise<Response | null> {
  if (pathname !== OFFICE_ROUTE_BASE && !pathname.startsWith(`${OFFICE_ROUTE_BASE}/`)) return null

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  const rest = pathname.slice(OFFICE_ROUTE_BASE.length)

  // The shim is app code: synthesized, never read from the vendored directory.
  // `rest` is the path after `/office`: the shim lives at `/office/__craft/office-shim.js`,
  // which is exactly `${OFFICE_ROUTE_BASE}${OFFICE_SHIM_PATH}`.
  if (rest === OFFICE_SHIM_PATH) {
    return new Response(req.method === 'HEAD' ? null : officeShimScript(), {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    })
  }

  const parsed = parseRoute(rest)
  if (!parsed) {
    return new Response(`The office editors are served under ${OFFICE_APPS.map((a) => `${OFFICE_ROUTE_BASE}/${a}/`).join(' ')}.`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // `/office/docs` would resolve the editor's relative assets against `/office/`, so send the
  // one address that has a base.
  if (!rest.endsWith('/') && parsed.relative === '') {
    return new Response(null, { status: 302, headers: { Location: `${pathname}/` } })
  }

  const appDir = join(options.dir, parsed.app)

  if (parsed.relative === '') {
    const index = resolveServedPath(appDir, 'index.html')
    const file = index ? await options.runtime.openAsset(index) : null
    if (!file) {
      return new Response(`The ${parsed.app} editor is not installed on this hub.`, { status: 404 })
    }
    // The editor is served under `/office/<app>/`, so its shim is a path below that base — a
    // root-relative `/__craft/…` would land on the app's own router and come back as HTML.
    const html = prepareEditorDocument(
      await new Response(file).text(),
      `${OFFICE_ROUTE_BASE}${OFFICE_SHIM_PATH}`,
    )
    return new Response(req.method === 'HEAD' ? null : html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': EDITOR_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    })
  }

  const target = resolveServedPath(appDir, parsed.relative)
  if (!target) {
    return new Response(`Nothing of ${parsed.app} is reachable at ${pathname}.`, { status: 403 })
  }
  const file = await options.runtime.openAsset(target)
  if (!file) return new Response(`Nothing of ${parsed.app} is at ${pathname}.`, { status: 404 })

  return new Response(req.method === 'HEAD' ? null : file, {
    headers: {
      'Content-Type': contentTypeFor(target),
      'Cache-Control': BUNDLE_CACHE,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  })
}
