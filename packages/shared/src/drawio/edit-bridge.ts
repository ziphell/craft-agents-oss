/**
 * The editor's half of "somebody else changed the file while you were drawing".
 *
 * drawio's embed mode already knows how to take a **patch** — a cell-level diff against the version
 * it was loaded with — and apply it in place, keeping the selection, the view and the undo history.
 * What it does not know is that this app exists. So the two ends are joined here, in a script served
 * beside the bundled editor rather than patched into it: `resources/drawio` is fetched and pruned by
 * `scripts/fetch-drawio-assets.ts`, and an edit inside it would survive until the next refetch.
 *
 * **Why the diff is computed in here.** `diffPages` is drawio's own engine, and it lives in the
 * editor's page. Computing the patch outside would mean a second copy of that engine, or a second
 * editor instance to run it in — either one drifts from the editor the patch is for.
 *
 * **Why the patch is applied by the page that hosts it.** The editor's message handler keeps the
 * sync baseline (`embedShadowPages`) in a closure that nothing outside it can reach. Applying a
 * patch directly against `file.patch()` would leave that baseline behind, and the *next* thing the
 * person types would then be diffed against a version that still contains our change — a diff that
 * carries our own edit back out. So the bridge hands the patch to its parent and the parent sends it
 * in as drawio's own `patch` action, which is the only path that advances the baseline.
 *
 * The full round trip, all of it in `drawio/types.ts` shapes:
 *
 * ```
 * app   -> frame  { craft: 'apply', id, xml }        bring the editor to this document
 * frame -> app    { craft: 'diff', id, patch, checksum }   the minimal patch, drawn from here
 * app   -> frame  { action: 'patch', patch, checksum }     drawio's own action, sent back in
 * frame -> app    { event: 'patch', checksum, checksumMismatch? }
 * frame -> app    { craft: 'state', id, xml }        what the editor holds now
 * ```
 *
 * `checksum` is the hash of the **target** document, not of the one being replaced: drawio compares
 * it with the hash it computes after applying, so a match means "the editor now equals what was
 * asked for". A person who typed in between makes that false, and the app is told so instead of
 * being told the edit landed.
 */

import { DRAWIO_MAX_DOCUMENT_CHARS } from './types'

/** Where the bridge is served, relative to the editor's base path. */
export const DRAWIO_EDIT_BRIDGE_PATH = '/__craft/edit.js'

/**
 * The editor's own document, with the bridge appended — the one edit either host makes to it.
 *
 * Appended before `</body>` rather than after the last script: drawio's bundle is written as a
 * module the page's own inline code waits on, and a tag after it would be the last thing to run.
 * Loading the bridge earlier costs nothing (it waits for the editor to be made) and guarantees it is
 * listening before the first thing a person can do.
 *
 * A document with no `</body>` — not a shape drawio ships — is returned unchanged rather than
 * guessed at: a bridge in the wrong place is worse than an editor that only reloads.
 */
export function injectDrawioEditBridge(html: string, basePath: string): string {
  const tag = `<script src="${basePath}${DRAWIO_EDIT_BRIDGE_PATH}"></script></body>`
  const at = html.lastIndexOf('</body>')
  if (at < 0) return html
  return html.slice(0, at) + tag + html.slice(at + '</body>'.length)
}

/**
 * The bridge, as a script file.
 *
 * `basePath` is `''` on the desktop's own origin and `'/drawio'` on the web UI's — the same
 * parameter `viewer-shell.ts` takes, for the same reason.
 */
export function drawioEditBridgeScript(basePath: string): string {
  return `(function () {
  var ui = null
  var attempts = 0

  /**
   * The one handle there is.
   *
   * drawio keeps no global reference to the running editor, so it is taken where it is made: the
   * prototype's \`init\` is the only moment a page's EditorUi is reachable from outside.
   */
  function hook() {
    if (window.EditorUi && window.EditorUi.prototype && !window.EditorUi.prototype.__craftEditHooked) {
      var original = window.EditorUi.prototype.init
      window.EditorUi.prototype.init = function () {
        ui = this
        return original.apply(this, arguments)
      }
      window.EditorUi.prototype.__craftEditHooked = true
      return
    }
    // ~10s: the editor is a large application and this file loads before it.
    if (attempts++ > 400) return
    setTimeout(hook, 25)
  }
  hook()

  /**
   * The channel this app actually talks on.
   *
   * The editor listens on \`window\` for its *own* messages, and anything it does not recognise is
   * answered with \`unknownMessage\` — **carrying the whole message back**, which for an \`apply\`
   * means the document. A private port is the only way to be unheard by a listener that filters
   * nothing: the app creates it, hands one end over once, and everything after that travels
   * outside the editor's \`window\`.
   *
   * Until the port arrives (it is sent right after \`init\`) replies go the long way round.
   */
  var port = null

  function post(message) {
    if (port) {
      port.postMessage(message)
      return
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify(message), '*')
    }
  }

  /**
   * The document as the editor would save it — the same serialization an autosave carries, so what
   * this app writes to disk is what the person's own save would have written.
   */
  function currentXml() {
    try {
      var multipage = typeof urlParams === 'undefined' || urlParams['pages'] != '0' ||
        (ui.pages != null && ui.pages.length > 1)
      return multipage ? ui.getFileData(true) : mxUtils.getXml(ui.editor.getGraphXml())
    } catch (error) {
      return null
    }
  }

  function checksumOf(xml) {
    var pages = ui.getPagesForXml(xml, true)
    return pages ? ui.getHashValueForPages(pages) : null
  }

  function refuse(id, reason) {
    post({ craft: 'refused', id: id, reason: reason })
  }

  function apply(id, xml, undoable) {
    if (!ui || !ui.pages) {
      refuse(id, 'the editor is not loaded yet')
      return
    }
    var current = currentXml()
    if (current == null) {
      refuse(id, 'the editor could not say what it holds')
      return
    }
    if (current === xml) {
      post({ craft: 'state', id: id, xml: current, unchanged: true })
      return
    }

    var from = ui.getPagesForXml(current, true)
    var to = ui.getPagesForXml(xml, true)
    if (!from || !to || to.length === 0) {
      refuse(id, 'the new document could not be read')
      return
    }

    var patch
    try {
      patch = ui.diffPages(from, to)
    } catch (error) {
      refuse(id, 'the documents could not be compared: ' + String(error && error.message ? error.message : error))
      return
    }

    var empty = patch == null || Object.keys(patch).length === 0
    if (empty) {
      post({ craft: 'state', id: id, xml: current, unchanged: true })
      return
    }

    /**
     * The undoable path: the patch goes into the model **as the person's own edit would**, so it
     * is one step of their undo.
     *
     * drawio's own patch action applies the same patch, but with changeListenerEnabled false — it
     * is built for a document arriving from somewhere else, and a remote change is deliberately not
     * something the person can undo. Here it is: the person asked for this change, watched it
     * appear, and must be able to take it back with the same key that takes back anything else.
     *
     * The cost is that the editor now reports the change like any other — an autosave follows, and
     * the sync baseline is behind until the app sends resetDiff. Both are the app's business.
     *
     * If this file cannot take one (no file yet, or the patch refused), the patch is handed out
     * instead: a change that cannot be undone is still better than a change that is lost.
     */
    if (undoable) {
      var file = null
      try {
        file = ui.getCurrentFile()
      } catch (error) {
        file = null
      }
      if (file && typeof file.patch === 'function') {
        try {
          file.patch([patch], null, true)
          post({ craft: 'applied', id: id, xml: currentXml() })
          return
        } catch (error) {
          // Fall through: the caller applies it the other way round.
        }
      }
    }

    // The hash of what the editor *should* hold afterwards: drawio compares it with the hash it
    // computes once the patch is in, so a mismatch means somebody changed something in between.
    post({ craft: 'diff', id: id, patch: patch, checksum: checksumOf(xml) })
  }

  function receive(data) {
    if (data == null || typeof data.craft !== 'string') return

    if (data.craft === 'apply') {
      if (typeof data.xml !== 'string') {
        refuse(data.id, 'no document was sent')
        return
      }
      try {
        apply(data.id, data.xml, data.undoable === true)
      } catch (error) {
        refuse(data.id, String(error && error.message ? error.message : error))
      }
      return
    }

    if (data.craft === 'read') {
      var xml = ui ? currentXml() : null
      if (xml == null) refuse(data.id, 'the editor cannot say what it holds')
      else post({ craft: 'state', id: data.id, xml: xml })
    }
  }

  window.addEventListener('message', function (event) {
    if (!window.parent || event.source !== window.parent) return

    // The handover itself: one message on the editor's own channel, carrying a port that
    // everything afterwards travels on.
    if (event.ports && event.ports.length > 0) {
      port = event.ports[0]
      // The two channels carry different encodings and that is not an accident: the editor's own
      // channel is string-based (\`proto=json\`), a port is not. Both are accepted here so that a
      // message cannot be lost to which door it came through.
      port.onmessage = function (message) {
        var data = message.data
        if (typeof data === 'string') {
          if (data.length > ${String(DRAWIO_MAX_DOCUMENT_CHARS)}) return
          try {
            data = JSON.parse(data)
          } catch (error) {
            return
          }
        }
        receive(data)
      }
      return
    }

    if (typeof event.data !== 'string' || event.data.length > ${String(DRAWIO_MAX_DOCUMENT_CHARS)}) return

    var data
    try {
      data = JSON.parse(event.data)
    } catch (error) {
      return
    }
    receive(data)
  })
})()
`
}
