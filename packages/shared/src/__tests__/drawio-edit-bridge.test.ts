import { describe, expect, it } from 'bun:test'
import {
  DRAWIO_EDIT_BRIDGE_PATH,
  drawioEditBridgeScript,
  injectDrawioEditBridge,
} from '../drawio/edit-bridge'
import {
  buildDrawioLoadMessage,
  DRAWIO_MAX_DOCUMENT_CHARS,
  parseDrawioEditMessage,
  parseDrawioEmbedEvent,
} from '../drawio/types'

/**
 * The editor's side of "somebody else changed the file while you were drawing".
 *
 * What is under test is a string that becomes a script inside someone else's application, so the
 * checks are the ones that would only fail there: a path that serves, an injection that lands
 * where the page can run it, and a parser that refuses everything the frame has no business
 * sending. The protocol itself was measured against the real bundle (see MEMORY: the four rounds,
 * with a person typing in the middle); what a unit test can hold on to is its shape.
 */
describe('drawio edit bridge', () => {
  it('is served from a reserved path, beside the vendored bundle rather than inside it', () => {
    expect(DRAWIO_EDIT_BRIDGE_PATH.startsWith('/__craft/')).toBe(true)
    expect(DRAWIO_EDIT_BRIDGE_PATH).not.toContain('..')
  })

  it('is a script, with nothing in it that would end the tag it is loaded from', () => {
    const script = drawioEditBridgeScript('')

    expect(() => new Function(script)).not.toThrow()
    // A `</script>` inside a file is fine, but this one is served as a document that parses: the
    // check that matters is that the source does not close the app's own tag if ever inlined.
    expect(script).not.toContain('</script>')
  })

  it('hooks the editor where an instance exists, and waits for it', () => {
    const script = drawioEditBridgeScript('')

    expect(script).toContain('EditorUi.prototype')
    expect(script).toContain('__craftEditHooked')
    // The application is large and this file loads before it: giving up early would leave an
    // editor nobody can push a change into, with no error anywhere.
    expect(script).toContain('setTimeout')
  })

  it('computes the diff in the frame and names the target checksum', () => {
    const script = drawioEditBridgeScript('')

    // The engine is drawio's own — a second implementation would drift from the editor using it.
    expect(script).toContain('diffPages')
    expect(script).toContain('getPagesForXml')
    // The hash of what the editor should hold afterwards, which is what drawio compares with.
    expect(script).toContain('getHashValueForPages')
  })

  it('applies the patch undoably, so the person can take the change back', () => {
    const script = drawioEditBridgeScript('')

    // `file.patch(patches, resolver, undoable)` — the third argument is the whole point: with it
    // the change is recorded like the person's own edit and becomes one step of their undo. The
    // editor's own patch action passes false, which is why a remote change cannot be undone there.
    expect(script).toContain('patch([patch], null, true)')
    // And when the editor cannot take one, the patch is still handed out rather than dropped.
    expect(script).toContain("craft: 'diff'")
    expect(script).toContain("craft: 'applied'")
  })

  it('takes a private port, because the editor answers what it does not know', () => {
    const script = drawioEditBridgeScript('')

    // Measured: an unrecognised message on drawio's own channel is echoed back with the whole
    // message attached — which for an apply is the document.
    expect(script).toContain('event.ports')
    expect(script).toContain('postMessage')
  })

  it('appends itself before the end of the editor document', () => {
    const html = '<!doctype html><html><body><div id="x"></div></body></html>'

    const injected = injectDrawioEditBridge(html, '')

    expect(injected).toBe(
      `<!doctype html><html><body><div id="x"></div><script src="${DRAWIO_EDIT_BRIDGE_PATH}"></script></body></html>`,
    )
  })

  it('carries the base path the web UI serves drawio under', () => {
    const injected = injectDrawioEditBridge('<body></body>', '/drawio')

    expect(injected).toContain(`src="/drawio${DRAWIO_EDIT_BRIDGE_PATH}"`)
  })

  it('leaves a document with no body alone rather than guessing where to put it', () => {
    const fragment = '<div>not a document</div>'

    expect(injectDrawioEditBridge(fragment, '')).toBe(fragment)
  })
})

/**
 * The load message, and the two small parsers that carry the exchange.
 */
describe('the load message asks for diff sync', () => {
  it('turns diff sync on and keeps the whole document coming', () => {
    const message = JSON.parse(buildDrawioLoadMessage('<mxfile/>')) as Record<string, unknown>

    expect(message.action).toBe('load')
    // Both, and neither is optional: `autosave` is how the file still arrives whole (the app writes
    // files whole), `diffSync` is how a patch becomes expressible at all.
    expect(message.autosave).toBe(1)
    expect(message.diffSync).toBe(1)
    expect(message.xml).toBe('<mxfile/>')
  })
})

describe('parsing what the frame says', () => {
  it('reads a patch, with the checksum it was computed against', () => {
    const parsed = parseDrawioEditMessage(
      JSON.stringify({ craft: 'diff', id: 7, patch: { u: {} }, checksum: 12345 }),
    )

    expect(parsed).toEqual({ kind: 'diff', id: 7, patch: { u: {} }, checksum: 12345 })
  })

  it('reads the reply that says the change is already in the editor', () => {
    const parsed = parseDrawioEditMessage(
      JSON.stringify({ craft: 'applied', id: 4, xml: '<mxfile><diagram/></mxfile>' }),
    )

    expect(parsed).toEqual({ kind: 'applied', id: 4, xml: '<mxfile><diagram/></mxfile>' })
    // A change that landed with no document attached tells the caller nothing about what to write.
    expect(parseDrawioEditMessage(JSON.stringify({ craft: 'applied', id: 4 }))).toBeNull()
  })

  it('reads the document the editor holds', () => {
    const parsed = parseDrawioEditMessage(
      JSON.stringify({ craft: 'state', id: 3, xml: '<mxfile><diagram/></mxfile>' }),
    )

    expect(parsed).toEqual({ kind: 'state', id: 3, xml: '<mxfile><diagram/></mxfile>' })
  })

  it('keeps the frame’s refusal in the frame’s own words', () => {
    const parsed = parseDrawioEditMessage(JSON.stringify({ craft: 'refused', id: 1, reason: 'not loaded' }))

    expect(parsed).toEqual({ kind: 'refused', id: 1, reason: 'not loaded' })
  })

  it('drops a message with no id, because a reply nothing is waiting for is not a reply', () => {
    expect(parseDrawioEditMessage(JSON.stringify({ craft: 'diff', patch: {} }))).toBeNull()
    expect(parseDrawioEditMessage(JSON.stringify({ craft: 'state', id: 'one', xml: '<mxfile/>' }))).toBeNull()
  })

  it('drops anything that is not one of its three shapes', () => {
    for (const data of [
      'not json',
      JSON.stringify({ craft: 'apply', id: 1, xml: '<mxfile/>' }), // ours out, not in
      JSON.stringify({ craft: 'diff', id: 1 }), // no patch
      JSON.stringify({ event: 'init' }), // drawio's own, for the other parser
      JSON.stringify({ craft: 'state', id: 1, xml: '' }),
    ]) {
      expect(parseDrawioEditMessage(data)).toBeNull()
    }
  })

  it('drops a document larger than the one it would accept going out', () => {
    const huge = 'x'.repeat(DRAWIO_MAX_DOCUMENT_CHARS + 1)
    expect(parseDrawioEditMessage(JSON.stringify({ craft: 'state', id: 1, xml: huge }))).toBeNull()
  })

  it('reads drawio’s acknowledgement of a patch, mismatch and all', () => {
    expect(parseDrawioEmbedEvent(JSON.stringify({ event: 'patch', checksum: 9 }))).toEqual({
      event: 'patch',
      checksum: 9,
      checksumMismatch: false,
    })
    expect(
      parseDrawioEmbedEvent(JSON.stringify({ event: 'patch', checksum: 9, checksumMismatch: true })),
    ).toEqual({ event: 'patch', checksum: 9, checksumMismatch: true })
    expect(parseDrawioEmbedEvent(JSON.stringify({ event: 'patch', error: 'no file' }))).toEqual({
      event: 'patch',
      checksum: null,
      checksumMismatch: false,
      error: 'no file',
    })
  })
})
