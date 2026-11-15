/**
 * The document that renders a drawio diagram, and its bridge — served by whoever hosts the
 * bundled editor.
 *
 * Two hosts serve this: the desktop app, at its own `craft-local://drawio-…` origin, and the
 * hub's web UI, at `/drawio` on the app's origin. The only difference between them is the
 * **base path** every asset is addressed under, so it is a parameter rather than two copies.
 *
 * Both documents are generated rather than kept as files because they are app code with one
 * variable in them — the bridge protocol string, taken from the constant the renderer imports,
 * so the two ends cannot disagree about it.
 *
 * `DRAWIO_VIEWER_PATH` lives in `./types` because the renderer builds the address too; the
 * script's path is ours alone and lives here.
 */

import { DRAWIO_BRIDGE_PROTOCOL } from './types'

/** Where the bridge is served, relative to the editor's base path. */
export const DRAWIO_VIEWER_SCRIPT_PATH = '/__craft/viewer.js'

/**
 * The page the renderer embeds, and the frame half of the bridge in `drawio/types.ts`.
 *
 * The failure paths are the interesting half: the viewer is a script this app does not
 * control, so "it did not load" and "it threw" are both reported to the renderer as
 * `rendered { ok: false }` rather than left as an empty frame. An empty frame looks the same as
 * a diagram with no shapes in it, which is the one reading a reviewer must not be given.
 *
 * `basePath` is `''` on the desktop's own origin and `'/drawio'` on the web UI's. It is stated
 * as a `<base>` as well as on the script tags, so drawio's own relative resources land under
 * the same prefix.
 */
export function drawioViewerShellDocument(basePath: string): string {
  const scriptPath = `${basePath}${DRAWIO_VIEWER_SCRIPT_PATH}`
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base href="${basePath}/">
<title>Diagram</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; }
  #host { width: 100%; height: 100%; }
  #failed { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #52525B; padding: 16px; white-space: pre-wrap; }
</style>
</head>
<body>
<div id="host"></div>
<script src="${scriptPath}"><\/script>
<script src="${basePath}/js/viewer-static.min.js"><\/script>
</body>
</html>
`
}

/**
 * The bridge, as its own file — the shell's CSP has no `'unsafe-inline'`, so it cannot be inline.
 *
 * It runs **before** the viewer script (the order of the tags above): it claims every path
 * drawio would otherwise point at viewer.diagrams.net, and those have to be in place first.
 */
export function drawioViewerBridgeScript(basePath: string): string {
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
  window.STENCIL_PATH = '${basePath}/stencils'
  window.SHAPES_PATH = '${basePath}/shapes'
  window.STYLE_PATH = '${basePath}/styles'
  window.IMAGE_PATH = '${basePath}/images'
  window.GRAPH_IMAGE_PATH = '${basePath}/img'
  window.DRAW_MATH_URL = '${basePath}/math4/es5'
  window.mxImageBasePath = '${basePath}/mxgraph/images'
  window.mxBasePath = '${basePath}/mxgraph'

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
