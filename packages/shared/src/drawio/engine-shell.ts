/**
 * The diagram engine: the page `drawio_tool` drives, and the bridge that drives it.
 *
 * Both hosts need exactly this, and neither may own it: the desktop loads it in a hidden window on
 * the origin it serves (`apps/electron/src/main/drawio-host.ts`), a hub loads it in the headless
 * browser on an origin `packages/render-host` serves. What must not happen is two copies of the
 * embed protocol drifting apart — drawio's replies have no request id, so a mismatched pair does
 * not fail loudly, it waits.
 *
 * Shape: a page of its own rather than something an editor embeds, because **the person is not
 * involved** — a `.drawio` converts whether or not a window is open, which is what a tool at this
 * level has to do.
 */

/** Where the engine document lives on whichever origin serves it. */
export const DRAWIO_ENGINE_PATH = '/__craft/engine.html'

/** The bridge, as its own file: the shell's CSP has no `'unsafe-inline'`. */
export const DRAWIO_ENGINE_SCRIPT_PATH = '/__craft/engine.js'

/**
 * The surface the engine offers, by name — the one place both ends of the call agree.
 *
 * `drawio-render.ts` (and this package's `renderDrawio`) call into it and the bridge below defines
 * it, and a rename on one side alone would be silent: the caller would reject with "undefined is
 * not a function" and read as a broken engine rather than as a mismatched pair.
 */
export const DRAWIO_ENGINE_SURFACE = 'window.__craftDiagram'

/**
 * The shell's policy: this origin only.
 *
 * The vendored app is copied in whole and must not reach out — a diagram is drawn offline by
 * construction, and `connect-src 'self'` is what keeps that true. The inline style allowance is
 * drawio's own; scripts get none, which is why the bridge is a separate file rather than an inline
 * `<script>` (inlining it would be blocked silently, the page would never answer, and that reads
 * as "still loading" forever).
 */
export const DRAWIO_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
].join('; ')

/** The engine document: nothing on screen, one on-demand resident. */
export function drawioEngineShellDocument(): string {
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
<script src="${DRAWIO_ENGINE_SCRIPT_PATH}"><\/script>
</body>
</html>
`
}

/**
 * The engine's script: drawio in its own embed mode, off-screen, loaded on the first request.
 *
 * Everything a document can be turned into — SVG, PNG, HTML — is drawio's code running in drawio's
 * application; nothing here reimplements an exporter. PNG in particular is `Editor.exportToCanvas`,
 * which is local: the remote export service is off because the document is offline by construction.
 *
 * The failure paths are the point: every one of them comes back as a rejection with a sentence,
 * because a blank document and a diagram with no shapes in it look the same.
 *
 * @param embedParams drawio's embed query string (`DRAWIO_EMBED_PARAMS`), which decides whether the
 *   editor is allowed to talk to the network at all.
 */
export function drawioEngineBridgeScript(embedParams: string): string {
  const editorUrl = JSON.stringify(`/?${embedParams}`)
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
