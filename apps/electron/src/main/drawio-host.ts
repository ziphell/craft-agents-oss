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
  DRAWIO_BRIDGE_PROTOCOL,
  DRAWIO_EMBED_PARAMS,
  DRAWIO_VIEWER_PATH,
} from '@craft-agent/shared/drawio/types'
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
        body: Buffer.from(viewerShellDocument()),
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': SHELL_CSP },
      })
    }

    if (pathname === VIEWER_SCRIPT_PATH) {
      return fileResponse(request, {
        body: Buffer.from(viewerBridgeScript()),
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

    return fileResponse(request, {
      body: await readFile(target),
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
const SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * Where the shell's bridge is served.
 *
 * Under the same reserved prefix as the shell, and *not* a path under the vendored
 * directory: that directory is fetched and pruned, and would take our file with it.
 * Not in `drawio/types.ts` either — this is not part of what the renderer and the frame
 * agree on; it is how one document loads its own script.
 */
const VIEWER_SCRIPT_PATH = '/__craft/viewer.js'

/**
 * The page the renderer embeds, and the frame half of the bridge in `drawio/types.ts`.
 *
 * It is generated here rather than kept as a file because it is app code with one
 * variable in it — the protocol string, injected from the same constant the renderer
 * imports, so the two ends cannot disagree about it.
 *
 * The failure paths are the interesting half: the viewer is a script this app does
 * not control, so "it did not load" and "it threw" are both reported to the renderer
 * as `rendered { ok: false }` rather than left as an empty frame. An empty frame
 * looks the same as a diagram with no shapes in it, which is the one reading a
 * reviewer must not be given.
 */
function viewerShellDocument(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Diagram</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; }
  #host { width: 100%; height: 100%; }
  #failed { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #52525B; padding: 16px; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="host"></div>
<script src="${VIEWER_SCRIPT_PATH}"><\/script>
<script src="/js/viewer-static.min.js"><\/script>
</body>
</html>
`
}

/**
 * The bridge, as its own file — see the note on `SHELL_CSP` for why it cannot be inline.
 *
 * Generated rather than kept as a file for the same reason the shell is: it is app code
 * with one variable in it, the protocol string, taken from the constant the renderer
 * imports so the two ends cannot disagree about it.
 *
 * The failure paths are the interesting half. The viewer is a script this app does not
 * control, so "it did not load" and "it threw" are both reported back as
 * `rendered { ok: false }` rather than left as an empty frame — an empty frame looks the
 * same as a diagram with no shapes in it, which is the one reading a reviewer must not
 * be given.
 */
function viewerBridgeScript(): string {
  const protocol = JSON.stringify(DRAWIO_BRIDGE_PROTOCOL)

  return `(function () {
  var PROTOCOL = ${protocol}
  var host = document.getElementById('host')

  // The viewer ships *absolute* defaults pointing at viewer.diagrams.net — STENCIL_PATH,
  // SHAPES_PATH, STYLE_PATH, IMAGE_PATH, GRAPH_IMAGE_PATH, DRAW_MATH_URL, mxBasePath — because
  // a static viewer is normally embedded from somewhere else entirely. Ours is served from
  // this origin, so every one of them is claimed here, and before the viewer script runs,
  // which is why this file is loaded first. Left alone, a diagram would fetch its styles,
  // images and stencils over the network: the document's own policy blocks that, so shapes
  // would come out unstyled — and "offline" would be a claim rather than a fact.
  window.STENCIL_PATH = '/stencils'
  window.SHAPES_PATH = '/shapes'
  window.STYLE_PATH = '/styles'
  window.IMAGE_PATH = '/images'
  window.GRAPH_IMAGE_PATH = '/img'
  window.DRAW_MATH_URL = '/math4/es5'
  window.mxImageBasePath = '/mxgraph/images'
  window.mxBasePath = '/mxgraph'

  function post(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, '*')
  }

  function fail(reason) {
    if (host) {
      host.textContent = ''
      var line = document.createElement('p')
      line.id = 'failed'
      line.textContent = String(reason)
      host.appendChild(line)
    }
    post({ protocol: PROTOCOL, type: 'rendered', ok: false, error: String(reason).slice(0, 500) })
  }

  /**
   * The attributes the viewer is configured with — plus a page, when the renderer named one.
   *
   * pageId, and not page: the viewer reads its page attribute as a 0-based index and clamps it into
   * range, so an index that names nothing draws the *last* page and says nothing about it. pageId is
   * exact, and it is what the renderer resolves a page name into — a name that matches nothing is
   * reported there instead of drawn wrong here.
   */
  function pageAttributes(attributes, pageId) {
    if (pageId) attributes.pageId = pageId
    return attributes
  }

  function render(xml, dark, pageId) {
    try {
      var stage = document.createElement('div')
      stage.className = 'mxgraph'
      // Set as an attribute rather than in markup: the diagram is a JSON string, and a DOM
      // write needs no escaping.
      //
      // 'allow-zoom-out': false is the load-bearing one, and it is not about a toolbar this
      // viewer does not have. **The viewer shrinks a diagram that does not fit the box it is
      // drawing in** — with allowZoomOut at its default, a document wider than its container is
      // fitted to it — and what then comes back is the shrunken drawing: the SVG itself, and the
      // min-width/min-height it states, which the viewer works out *at that same scale*. The box
      // here is this frame's own 1024x768, an engine kept out of sight: it has nothing to do with
      // how big the drawing is wanted. Measured on a 2218x1304 document, 1030x611 stated and
      // scale(0.46,0.46) on the drawing group, against 2218x1304 and scale(1,1) with this flag —
      // which is why a large diagram used to be unreadable in the app while the same file opened
      // at its own size in drawio. How big a drawing is *shown* is the displayer's decision; the
      // app has its own zoom for that.
      stage.setAttribute('data-mxgraph', JSON.stringify(pageAttributes({
        xml: xml,
        nav: true,
        darkMode: !!dark,
        'allow-zoom-out': false
      }, pageId)))
      host.textContent = ''
      host.appendChild(stage)
      GraphViewer.processElements()

      var svg = host.querySelector('svg')
      if (!svg) {
        fail('The viewer produced no drawing for this document.')
        return
      }
      // Addressed here, because the app is about to show this markup in its own document:
      // everything it points at has to be an absolute address here or it will be looked for
      // relative to the app instead. Its *size* is not decided here: this viewer hands back an
      // SVG with no viewBox and no size attributes (measured against the vendored bundle), and
      // the app measures what it was given — one place, and the place that also has to scale it.
      declareColorScheme(svg, dark)
      absolutizeImages(svg)
      post({ protocol: PROTOCOL, type: 'rendered', ok: true, svg: svg.outerHTML })
    } catch (error) {
      fail(error && error.message ? error.message : error)
    }
  }

  function absolutizeImages(svg) {
    var images = svg.querySelectorAll('image')
    for (var i = 0; i < images.length; i++) {
      var href = images[i].getAttribute('xlink:href') || images[i].getAttribute('href')
      if (!href || /^(data:|https?:|blob:)/.test(href)) continue
      var absolute = new URL(href, window.location.href).href
      images[i].setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', absolute)
      images[i].setAttribute('href', absolute)
    }
  }

  /**
   * Say on the drawing itself which scheme it was drawn for.
   *
   * The viewer states the scheme on its own container — \`GraphViewer.darkModeChanged\` writes
   * color-scheme there, not on the drawing — and the app takes only the drawing: \`svg.outerHTML\`
   * leaves that container behind. What travels is markup full of \`light-dark(...)\` with nothing
   * to resolve it, and \`light-dark()\` with no color-scheme stated is always the *light* value, so
   * the diagram ignored the app's dark mode while an exported SVG — which states color-scheme on
   * its root, because drawio's own export writes it there — followed it. Written here for the same
   * reason the images are addressed here: this is the last place that knows, and the markup has to
   * speak for itself once it is inlined into the app's document.
   */
  function declareColorScheme(svg, dark) {
    var style = svg.getAttribute('style') || ''
    svg.setAttribute('style', style + ' color-scheme: ' + (dark ? 'dark' : 'light') + ';')
  }

  // Nothing clicks in here any more: this document is an engine, kept out of sight, and the
  // drawing it produces is what the app shows. window.open is still neutralised because it
  // is a path a viewer can take without anyone clicking — and a frame that leaves has left
  // the app and reached the network, which is the one thing this shell exists to prevent.
  window.open = function () { return null }

  window.addEventListener('message', function (event) {
    // The embedder is the only window allowed to talk to us. Its origin is not pinned: it
    // differs between the dev server, an app packaged as file:// and the webui, so the
    // identity that actually holds is the window, not the origin. The renderer enforces
    // the strict half of this (origin *and* frame window).
    if (event.source !== window.parent) return
    var data = event.data
    if (!data || data.protocol !== PROTOCOL) return
    if (data.type === 'render' && typeof data.xml === 'string') render(data.xml, data.dark, data.pageId)
  })

  function announceReady() {
    // The viewer is a classic script, so once the document has loaded it has either run or
    // never will. The bundle ships it; a 404 here means the assets were pruned or never
    // fetched.
    if (typeof GraphViewer === 'undefined') {
      fail('The diagram viewer did not load from this origin. Run: bun scripts/fetch-drawio-assets.ts')
      return
    }
    post({ protocol: PROTOCOL, type: 'ready' })
  }

  // Waiting for the load event rather than announcing at the end of this script, because the
  // viewer is loaded *after* us now — see the paths above.
  if (document.readyState === 'complete') announceReady()
  else window.addEventListener('load', announceReady)
})()
`
}

// ── The headless engine: conversion and renderings, for `drawio_tool` ───────

/**
 * The page the headless side drives, and its script.
 *
 * Same reason as the viewer's two paths: reserved paths rather than files under the vendored
 * directory, which is refetched and pruned and would take our documents with it.
 */
export const DRAWIO_ENGINE_PATH = '/__craft/engine.html'
const ENGINE_SCRIPT_PATH = '/__craft/engine.js'

/**
 * The surface the engine offers, by name — the one place both ends of the call agree.
 *
 * `drawio-render.ts` calls into it and the bridge below defines it, and a rename on one side
 * alone would be silent: the hidden window would reject with "undefined is not a function" and
 * read as a broken engine rather than as a mismatched pair.
 */
export const DRAWIO_ENGINE_SURFACE = 'window.__craftDiagram'

/**
 * The engine document: nothing on screen, two on-demand residents.
 *
 * It is a page of its own rather than something the renderer embeds because **the person is not
 * involved**: `drawio_tool` converts and renders whether or not a window is open, which is what
 * a tool at this level has to do. The hidden window that loads it lives in `drawio-render.ts`.
 */
function engineShellDocument(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Diagram engine</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  #editor { position: fixed; left: -20000px; top: 0; width: 1280px; height: 900px; border: 0; }
</style>
</head>
<body>
<script src="${ENGINE_SCRIPT_PATH}"><\/script>
</body>
</html>
`
}

/**
 * The engine's script, as its own file — the shell's CSP has no `'unsafe-inline'`, so an inline
 * script would be blocked silently (see `SHELL_CSP`).
 *
 * One resident: **the editor**, in drawio's own embed mode, off-screen and loaded on the first
 * request. Everything a document can be turned into — SVG, PNG, HTML — is drawio's code running in
 * drawio's application; nothing here reimplements an exporter. PNG in particular is
 * `Editor.exportToCanvas`, which is local: the remote export service is off because the document is
 * offline by construction.
 *
 * The failure paths are the point, as they are for the viewer: every one of them comes back as a
 * rejection with a sentence, because a blank document and a diagram with no shapes in it look the
 * same.
 */
function engineBridgeScript(): string {
  const editorUrl = JSON.stringify(`/?${DRAWIO_EMBED_PARAMS}`)
  const surface = DRAWIO_ENGINE_SURFACE

  return `(function () {
  var EDITOR_URL = ${editorUrl}

  var frame = null
  var pending = null

  function fail(reason) {
    var waiting = pending
    if (!waiting) return
    pending = null
    waiting.reject(new Error(String(reason)))
  }

  /** Settle the one outstanding request, if this is the reply it was waiting for. */
  function settle(kind, value) {
    var waiting = pending
    if (!waiting || waiting.kind !== kind) return
    pending = null
    waiting.resolve(value)
  }

  function post(message) {
    frame.contentWindow.postMessage(JSON.stringify(message), '*')
  }

  /**
   * One request at a time, with a ceiling.
   *
   * drawio's embed protocol has **no request id** — a reply cannot be matched to a request — so
   * ordering is this module's own state: exactly one request is outstanding, and the event name
   * says which. A request that is never answered has to fail rather than hang, because the caller
   * is a tool call that has to return something.
   *
   * \`action\` is the message this request posts, and it is absent for the one step that has nothing
   * to post: the editor announces \`init\` by itself once it is ready, so waiting for it *is* that
   * step. It was a callback here once, and calling it whether or not it was given made the missing
   * one a thrown TypeError rather than a wait — every conversion and every rendering failed on it.
   */
  function request(kind, timeoutMs, action) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (pending && pending.kind === kind) fail('The diagram editor did not answer in time.')
      }, timeoutMs)
      pending = {
        kind: kind,
        resolve: function (value) { clearTimeout(timer); resolve(value) },
        reject: function (error) { clearTimeout(timer); reject(error) }
      }
      if (!action) return
      try { post(action) } catch (error) { fail(error && error.message ? error.message : error) }
    })
  }

  function ensureEditor() {
    if (frame) return
    frame = document.createElement('iframe')
    frame.id = 'editor'
    frame.setAttribute('src', EDITOR_URL)
    document.body.appendChild(frame)
  }

  window.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow) return
    if (typeof event.data !== 'string') return
    var message
    try { message = JSON.parse(event.data) } catch (error) { return }
    if (!message || typeof message.event !== 'string') return

    if (message.event === 'init') settle('init', true)
    else if (message.event === 'load') settle('load', message)
    else if (message.event === 'export') settle('export', message)
    else if (message.event === 'error') fail(message.message || 'The diagram editor refused the document.')
  })

  // ── A .drawio document → SVG / PNG / HTML ──────────────────────────────────

  async function render(options) {
    ensureEditor()
    // No action: the editor announces itself, and there is nothing to ask it for.
    await request('init', 60000)
    // One axis, and this is the half of it a *picture* needs: dark mode on the editor is what a
    // canvas resolves its light-dark() colors by, so a PNG comes out drawn for the scheme named
    // (\`auto\` leaves the editor as it is, which is light). An SVG never looks at this — the export
    // below states the scheme in the file instead.
    await request('load', 60000, { action: 'load', xml: options.xml, dark: options.theme === 'dark' })

    var reply = await request('export', 60000, {
      action: 'export',
      format: options.format,
      scale: options.scale,
      // The scheme the *file* states, which only an SVG has somewhere to put: drawio writes it onto
      // the SVG's root, where it decides whether the drawing follows whoever shows it (\`auto\`) or is
      // pinned. Every other format ignores it — \`exportDrawio\` is where the two are one axis.
      theme: options.theme,
      // SVG comes back as markup rather than as a data URI: what is written to disk is the
      // drawing itself, and a caller that wants \`xmlsvg\` (an SVG that reopens in drawio) asks
      // for that format instead.
      asText: options.format === 'svg'
    })

    // The document itself is not a rendering, and the editor files it differently: a picture arrives
    // in \`data\`, the document in \`xml\` (the same shape \`json\` uses). One thing comes back to the
    // caller either way — the text or the bytes to write — so the difference ends here.
    //
    // What the editor hands over for \`xml\` is the document with its pages **uncompressed**
    // (\`getFileData\`, whose uncompressed flag defaults on): this is the one call that reads a page
    // body rather than carrying it, which is why it is also how a file saved compressed is written
    // out plain.
    if (options.format === 'xml') {
      if (!reply.xml) {
        throw new Error('The editor produced no document for this file.')
      }
      return reply.xml
    }

    if (!reply.data) {
      throw new Error('The editor produced no ' + options.format + ' for this document.')
    }
    return reply.data
  }

  ${surface} = { render: render }
})()
`
}
