import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DRAWIO_BRIDGE_PROTOCOL, DRAWIO_VIEWER_PATH } from '@craft-agent/shared/drawio/types'
import { DRAWIO_ENGINE_PATH, DRAWIO_ENGINE_SURFACE, registerDrawioHandler, registerDrawioOrigin } from '../drawio-host'
import type { ProtocolHostSession } from '../local-http'

interface Host {
  origin: string
  serve: (path: string, init?: RequestInit) => Promise<Response>
  close: () => void
}

/**
 * A stand-in for the vendored bundle: the files the shell document and the editor
 * actually ask for, and nothing else.
 *
 * Driven from a temp directory rather than the real bundle, because the bundle is
 * fetched rather than committed — a test that needed it would only pass on a machine
 * that had run the fetch script, which is exactly the kind of test that stops being
 * run.
 */
function hostFor(): Host {
  const dir = mkdtempSync(join(tmpdir(), 'craft-drawio-host-'))
  mkdirSync(join(dir, 'js'), { recursive: true })
  mkdirSync(join(dir, 'stencils'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>diagram</title>')
  writeFileSync(join(dir, 'js', 'viewer-static.min.js'), 'window.GraphViewer = undefined;')
  writeFileSync(join(dir, 'stencils', 'aws.xml'), '<shapes/>')

  const fake = fakeSession()
  registerDrawioHandler(fake.session)
  const handler = fake.handler()
  const origin = registerDrawioOrigin(dir)

  return {
    origin,
    serve: (path: string, init: RequestInit = {}) =>
      Promise.resolve(handler(new Request(new URL(path, origin).toString(), init))),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Stand in for the app session: it only has to remember the handler. */
function fakeSession(): {
  session: ProtocolHostSession
  handler: () => (request: Request) => Promise<Response>
} {
  let registered: ((request: Request) => Promise<Response> | Response) | null = null

  return {
    session: {
      protocol: {
        handle: (_scheme, handler) => {
          registered = handler
        },
      },
    },
    handler: () => async (request: Request) => {
      if (!registered) throw new Error('no handler was registered')
      return registered(request)
    },
  }
}

/**
 * The engine script, run — against a stand-in editor, because what it does is *timing*.
 *
 * The bridge is generated text, so nothing type-checks it, and the whole protocol lives inside
 * it: the editor announces itself, then each action is posted and its own event waited for. The
 * two things that can go wrong there — a step that talks to the editor when it has nothing to
 * say, or one that never says anything at all — compile perfectly well and fail at the far end of
 * a tool call, as "the diagram editor refused the document". Driving it here is the only place
 * that is visible.
 */
function runEngine(script: string): {
  render: (options: Record<string, unknown>) => Promise<string>
  /** What the bridge told the editor, in order. */
  posted: Record<string, unknown>[]
  /** The editor says something, the way drawio's embed protocol does: one JSON string per event. */
  announce: (event: string, extra?: Record<string, unknown>) => void
} {
  const posted: Record<string, unknown>[] = []
  const listeners: Array<(event: unknown) => void> = []
  /** The editor's own window: what the bridge posts to, and what it is checked against. */
  const editor = { postMessage: (raw: string) => posted.push(JSON.parse(raw) as Record<string, unknown>) }
  const frame = { id: '', setAttribute: () => {}, contentWindow: editor }
  const sandbox = {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      if (name === 'message') listeners.push(handler)
    },
  }
  const sandboxDocument = { createElement: () => frame, body: { appendChild: () => {} } }

  new Function('window', 'document', script)(sandbox, sandboxDocument)

  const surface = (sandbox as unknown as {
    __craftDiagram?: { render: (options: Record<string, unknown>) => Promise<string> }
  }).__craftDiagram
  if (!surface) throw new Error('the engine script defined no render surface')

  return {
    render: (options) => surface.render(options),
    posted,
    announce: (event, extra = {}) => {
      for (const listener of listeners) {
        listener({ source: editor, data: JSON.stringify({ event, ...extra }) })
      }
    },
  }
}

/** Let the engine's own `await`s run: a settled request resumes a microtask later. */
const nextMicrotask = () => Promise.resolve()

describe('drawio at its own origin', () => {
  // The shell document is app code, not a vendored file, so it must be answered even
  // though nothing of that name exists on disk.
  it('synthesizes the shell document at its reserved path', async () => {
    const host = hostFor()
    try {
      const response = await host.serve(DRAWIO_VIEWER_PATH)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
    } finally {
      host.close()
    }
  })

  // The shell's own policy is `script-src 'self'` with no `'unsafe-inline'` and no nonce, so
  // an inline bridge is blocked — silently. The page then never says `ready`, and the card
  // embedding it can only read that as "still loading": a progress line with nothing in the
  // logs to explain it. Keeping the bridge in its own file is what makes that impossible, and
  // this is the assertion that notices if somebody inlines it back.
  it('loads its bridge as a file, and never inline', async () => {
    const host = hostFor()
    try {
      const shell = await (await host.serve(DRAWIO_VIEWER_PATH)).text()

      expect(shell).toContain('/__craft/viewer.js')
      // The bridge carries the protocol; the shell must not, because that means it is inline.
      expect(shell).not.toContain(DRAWIO_BRIDGE_PROTOCOL)

      const bridge = await host.serve('/__craft/viewer.js')
      expect(bridge.headers.get('content-type')).toContain('text/javascript')
      expect(await bridge.text()).toContain(DRAWIO_BRIDGE_PROTOCOL)
    } finally {
      host.close()
    }
  })

  // The paths must be claimed *before* the viewer script runs, so the order in the shell is a
  // real invariant and not a detail. With the viewer first, a diagram comes out unstyled: its
  // styles, images and stencils are fetched from viewer.diagrams.net (that is what the shipped
  // defaults point at) and this document's own policy then blocks them.
  it('starts its bridge before the viewer it configures', async () => {
    const host = hostFor()
    try {
      const shell = await (await host.serve(DRAWIO_VIEWER_PATH)).text()
      const bridge = await (await host.serve('/__craft/viewer.js')).text()

      expect(shell.indexOf('/__craft/viewer.js')).toBeLessThan(
        shell.indexOf('/js/viewer-static.min.js'),
      )

      for (const name of ['STENCIL_PATH', 'STYLE_PATH', 'IMAGE_PATH', 'mxBasePath']) {
        expect(bridge).toContain(`window.${name} =`)
      }
      // Claimed at this origin — so no assignment may point at the hosted one. Matching the
      // assignment rather than the bare host, because the explanation above names it.
      expect(bridge).not.toMatch(/=\s*['"]https:\/\/viewer\.diagrams\.net/)
    } finally {
      host.close()
    }
  })

  // The frame is an engine: it draws and hands the drawing back, and it is the app's own
  // document that shows it. Nothing about scrollbars, sizes or cursors belongs on this side of
  // the boundary any more — that is what the frame was relieved of.
  it('draws a diagram and hands back its SVG', async () => {
    const host = hostFor()
    try {
      const bridge = await (await host.serve('/__craft/viewer.js')).text()

      expect(bridge).toContain('svg.outerHTML')
      // And at the size the document was authored, which is a flag and not a default: left to
      // itself the viewer fits a diagram wider than the box it draws in, down to that box —
      // measured on one 2218-wide document, 1030x611 stated and scale(0.46,0.46) without this,
      // 2218x1304 and scale(1,1) with it.
      expect(bridge).toContain("'allow-zoom-out': false")
      // Addressed here, and *not* sized: the viewer hands back an SVG with no `viewBox` and no
      // size attributes (measured against the vendored bundle), so the app measures what it was
      // given — a size written on this side would be one nothing reads.
      expect(bridge).toContain('absolutizeImages')
      // And which scheme it was drawn for, stated on the drawing itself: the viewer keeps its own
      // on a container the app never sees, and `light-dark()` with no color-scheme is always the
      // light value — which is how a preview came to sit in a dark app looking light.
      expect(bridge).toContain('declareColorScheme(svg, dark)')
      expect(bridge).toContain("color-scheme: ' + (dark ? 'dark' : 'light')")
      expect(bridge).not.toMatch(/setAttribute\(\s*['"]width/)
      expect(bridge).toContain("setAttributeNS('http://www.w3.org/1999/xlink'")
      // Gone with the frame: it was the display surface that made these necessary.
      expect(bridge).not.toContain('window.scrollTo(')
      expect(bridge).not.toContain('resize:')
      expect(bridge).not.toContain('cursor')
    } finally {
      host.close()
    }
  })

  // Both documents are built by interpolating into a template literal, and the ways that can
  // go wrong are silent: a backtick or a `*/` inside an interpolated comment closes the
  // comment or the literal early, and what the app then serves is a broken document nobody
  // sees until a frame fails to load. Compiling the served text catches the whole class, and
  // has caught four of these already — this is the cheapest place to keep catching them.
  it('serves documents that parse as scripts', async () => {
    const host = hostFor()
    try {
      const bridge = await (await host.serve('/__craft/viewer.js')).text()
      const shell = await (await host.serve(DRAWIO_VIEWER_PATH)).text()

      expect(() => new Function(bridge)).not.toThrow()
      // The shell's own scripts are the two files it loads; its inline parts are a style and
      // markup. Its body is therefore not compiled here — nothing in it is generated as code.
      expect(shell).toContain('<script src="/__craft/viewer.js">')
    } finally {
      host.close()
    }
  })

  // "Offline" is a property of the document, not a promise: the policy is what stops
  // a diagram from reaching the network.
  it('pins the shell document to this origin', async () => {
    const host = hostFor()
    try {
      const policy = (await host.serve(DRAWIO_VIEWER_PATH)).headers.get('content-security-policy') ?? ''

      expect(policy).toContain("default-src 'self'")
      expect(policy).toContain("connect-src 'self'")
      expect(policy).not.toContain('https:')
    } finally {
      host.close()
    }
  })

  it('serves the viewer script the shell asks for', async () => {
    const host = hostFor()
    try {
      const response = await host.serve('/js/viewer-static.min.js')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/javascript')
    } finally {
      host.close()
    }
  })

  // The reason the content-type table gained `.xml`: responses carry `nosniff`, so a
  // stencil answered as octet-stream would be refused rather than parsed.
  it('names a stencil document as XML', async () => {
    const host = hostFor()
    try {
      const response = await host.serve('/stencils/aws.xml')

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/xml')
    } finally {
      host.close()
    }
  })

  it('opens the editor at the address root', async () => {
    const host = hostFor()
    try {
      const response = await host.serve('/', { headers: { accept: 'text/html' } })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('diagram')
    } finally {
      host.close()
    }
  })

  // A path that names a file must never come back as HTML: answering a missing script
  // with a document turns a clear 404 into a confusing parse error.
  it('404s a missing file instead of falling back to the document', async () => {
    const host = hostFor()
    try {
      const response = await host.serve('/js/missing.min.js')

      expect(response.status).toBe(404)
    } finally {
      host.close()
    }
  })

  // The shell is app code and must never be served from a cache; the vendored files are a
  // fetched release and must be, or every open re-reads about 10 MB of editor scripts.
  it('caches the bundle but never the app’s own shell', async () => {
    const host = hostFor()
    try {
      expect((await host.serve('/js/viewer-static.min.js')).headers.get('cache-control')).toContain('max-age')
      expect((await host.serve(DRAWIO_VIEWER_PATH)).headers.get('cache-control')).toBe('no-store')
    } finally {
      host.close()
    }
  })

  it('refuses a path that leaves the bundle', async () => {
    const host = hostFor()
    try {
      // An encoded slash, because the URL parser normalises a plain `%2e%2e` segment
      // into `..` before this host ever sees it — the escape has to survive parsing to
      // be worth refusing. `..` reaching the fence is the case this host must decide on.
      expect((await host.serve('/%2e%2e%2fsecrets.txt')).status).toBe(403)
      // A backslash is a separator on Windows, so it must not be a way past the fence.
      expect((await host.serve('/%5C..%5Csecrets.txt')).status).toBe(403)
    } finally {
      host.close()
    }
  })
})

// `drawio_tool`'s side of this origin: the headless engine, which nobody embeds. It is a page
// of its own because the person is not involved — conversion and rendering happen whether or not
// a window is open — and its two residents are loaded only when the half that needs them is
// asked for.
describe('the engine document', () => {
  it('synthesizes the engine page and its script at their reserved paths', async () => {
    const host = hostFor()
    try {
      const page = await host.serve(DRAWIO_ENGINE_PATH)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')

      const script = await host.serve('/__craft/engine.js')
      expect(script.headers.get('content-type')).toContain('text/javascript')
    } finally {
      host.close()
    }
  })

  it('pins the engine document to this origin, like the viewer', async () => {
    const host = hostFor()
    try {
      const policy = (await host.serve(DRAWIO_ENGINE_PATH)).headers.get('content-security-policy') ?? ''

      expect(policy).toContain("default-src 'self'")
      expect(policy).not.toContain('https:')
    } finally {
      host.close()
    }
  })

  // The editor installs its message handler only when it is inside a frame (`initializeEmbedMode`
  // tests `window.parent !== window`), so the engine embeds it rather than loading it as the
  // document — a top-level editor deliberately listens to nothing.
  it('embeds the editor rather than loading it as the document', async () => {
    const host = hostFor()
    try {
      const page = await (await host.serve(DRAWIO_ENGINE_PATH)).text()
      const script = await (await host.serve('/__craft/engine.js')).text()

      expect(page).toContain('<script src="/__craft/engine.js">')
      expect(script).toContain("document.createElement('iframe')")
      expect(script).toContain("setAttribute('src', EDITOR_URL)")
    } finally {
      host.close()
    }
  })

  // The one contract across the process boundary: the bridge defines this surface and
  // `drawio-render.ts` calls into it. A rename on one side only fails as "undefined is not a
  // function" inside a hidden window, which reads as a broken engine rather than a mismatched pair.
  it('offers the surface the render host calls', async () => {
    const host = hostFor()
    try {
      const script = await (await host.serve('/__craft/engine.js')).text()

      expect(script).toContain(`${DRAWIO_ENGINE_SURFACE} = { render: render }`)
    } finally {
      host.close()
    }
  })

  // The PNG path is the local canvas export (`Editor.exportToCanvas`), which is the only one
  // available offline: drawio's remote export service is refused because the document is
  // offline by construction, and its absence yields a blank image rather than an error.
  it('asks the editor to export, in the format the caller named', async () => {
    const host = hostFor()
    try {
      const script = await (await host.serve('/__craft/engine.js')).text()

      expect(script).toContain("action: 'export'")
      expect(script).toContain('format: options.format')
      // A reply that never arrives has to fail rather than hang: a tool call must return.
      expect(script).toContain('did not answer in time')
    } finally {
      host.close()
    }
  })

  // Generated documents are built by interpolating into template literals, and the ways that can
  // go wrong are silent — an unescaped backtick inside one of the engine's comments would close
  // the literal and serve a broken document. Compiling the served text catches the whole class.
  it('serves an engine script that parses', async () => {
    const host = hostFor()
    try {
      const script = await (await host.serve('/__craft/engine.js')).text()

      expect(() => new Function(script)).not.toThrow()
    } finally {
      host.close()
    }
  })

  // The protocol, driven end to end. `init` is the step that has nothing to post — the editor
  // announces itself and that is the whole of it — and a bridge that *called* something there
  // threw before it ever got to the document: every conversion and every rendering came back as
  // "run is not a function", with `pages` working, because `pages` starts no engine at all.
  it('drives the editor through its announcement, the load and the export', async () => {
    const host = hostFor()
    try {
      const engine = runEngine(await (await host.serve('/__craft/engine.js')).text())

      const rendering = engine.render({ xml: '<mxfile/>', format: 'svg', dark: false })
      // Nothing is asked of an editor that has not announced itself.
      expect(engine.posted).toEqual([])

      engine.announce('init')
      await nextMicrotask()
      expect(engine.posted).toEqual([{ action: 'load', xml: '<mxfile/>', dark: false }])

      engine.announce('load')
      await nextMicrotask()
      // `asText` for an SVG: a picture arrives as markup and is written as the drawing itself.
      expect(engine.posted[1]).toEqual({ action: 'export', format: 'svg', asText: true })

      engine.announce('export', { format: 'svg', data: '<svg><g/></svg>' })
      expect(await rendering).toBe('<svg><g/></svg>')
    } finally {
      host.close()
    }
  })

  // The theme is one axis with two halves, and both have to reach the editor: the export carries it
  // (an SVG states it in the file), and the load carries `dark` (the editor's own dark mode, which is
  // what a raster is drawn by). A theme that arrived at neither would be a file that quietly kept
  // adapting — or a picture drawn light when dark was asked for.
  it('carries the theme onto the export, and its dark half onto the load', async () => {
    const host = hostFor()
    try {
      const engine = runEngine(await (await host.serve('/__craft/engine.js')).text())

      const light = engine.render({ xml: '<mxfile/>', format: 'svg', theme: 'light' })

      engine.announce('init')
      await nextMicrotask()
      engine.announce('load')
      await nextMicrotask()
      expect(engine.posted[0]).toEqual({ action: 'load', xml: '<mxfile/>', dark: false })
      expect(engine.posted[1]).toMatchObject({ action: 'export', theme: 'light' })

      engine.announce('export', { format: 'svg', data: '<svg><g/></svg>' })
      expect(await light).toBe('<svg><g/></svg>')

      // The same flag, asked for dark: the editor goes dark, which is what draws a picture dark — and
      // the export still names the scheme, for the formats that have somewhere to state it.
      const dark = engine.render({ xml: '<mxfile/>', format: 'png', theme: 'dark' })
      engine.announce('init')
      await nextMicrotask()
      engine.announce('load')
      await nextMicrotask()
      expect(engine.posted[2]).toEqual({ action: 'load', xml: '<mxfile/>', dark: true })
      expect(engine.posted[3]).toMatchObject({ action: 'export', format: 'png', theme: 'dark' })

      engine.announce('export', { format: 'png', data: 'data:image/png;base64,AAAA' })
      expect(await dark).toBe('data:image/png;base64,AAAA')
    } finally {
      host.close()
    }
  })

  // The editor files its answer by format — a picture in `data`, a document in `xml` — and one
  // field is read either way. This is the whole of that translation, and `--format drawio` is the
  // path that depends on the second half: an answer that is not there has to fail rather than
  // come back as an empty document.
  it('takes the document from the field a document arrives in', async () => {
    const host = hostFor()
    try {
      const engine = runEngine(await (await host.serve('/__craft/engine.js')).text())

      const written = engine.render({ xml: '<mxfile/>', format: 'xml', dark: false })
      engine.announce('init')
      await nextMicrotask()
      engine.announce('load')
      await nextMicrotask()
      engine.announce('export', { format: 'xml', xml: '<mxfile><diagram/></mxfile>' })
      expect(await written).toBe('<mxfile><diagram/></mxfile>')

      const refused = engine.render({ xml: '<mxfile/>', format: 'png', dark: false })
      engine.announce('init')
      await nextMicrotask()
      engine.announce('load')
      await nextMicrotask()
      engine.announce('export', { format: 'png' })
      await expect(refused).rejects.toThrow('produced no png')
    } finally {
      host.close()
    }
  })
})

describe('an address nobody served', () => {
  // The scheme is the app's own, so there is nothing to pass a foreign label through to:
  // a label this run never handed out is a request for something that does not exist.
  it('is refused rather than passed on', async () => {
    const host = hostFor()
    try {
      const response = await host.serve('//somebody-else/app.js')

      expect(response.status).toBe(404)
    } finally {
      host.close()
    }
  })
})
