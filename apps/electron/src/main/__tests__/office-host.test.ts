import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  registerExportFile,
  registerExportHost,
  registerOfficeOrigin,
  releaseExportFile,
  releaseExportHost,
  serveOfficeRequest,
} from '../office-origin'
import { OFFICE_SHIM_PATH } from '@craft-agent/shared/office/types'

/**
 * The rules this host is: which addresses exist, what the document looks like on the way out,
 * and what the fence refuses. Driven from a temporary directory so the real bundle is not
 * required (and the vendored bytes are not what is under test).
 */

const VENDORED_INDEX = `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' genoffice-docx-media:">
<title>GenOffice Docs</title>
<script type="module" src="./assets/index.js"></script>
</head><body><div id="root"></div></body></html>`

let root: string
let origin: string

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${origin}${path}`, init)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'office-host-'))
  mkdirSync(join(root, 'docs', 'assets'), { recursive: true })
  writeFileSync(join(root, 'docs', 'index.html'), VENDORED_INDEX)
  writeFileSync(join(root, 'docs', 'assets', 'index.js'), 'export const booted = 1\n')
  origin = registerOfficeOrigin(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('office-host > the document', () => {
  it('serves the editor with our script in front of its module script', async () => {
    const response = await serveOfficeRequest(request('/docs/'))
    expect(response?.status).toBe(200)

    const html = await response!.text()
    const shim = html.indexOf(OFFICE_SHIM_PATH)
    const boot = html.indexOf('./assets/index.js')
    expect(shim).toBeGreaterThan(-1)
    expect(boot).toBeGreaterThan(-1)
    expect(shim).toBeLessThan(boot)
  })

  it("drops the bundle's own meta policy, which forbids the blob: the editor opens through", async () => {
    const html = await (await serveOfficeRequest(request('/docs/')))!.text()
    expect(html).not.toContain('http-equiv="Content-Security-Policy"')
    // …and answers with the host's policy instead, which does allow it.
    const response = await serveOfficeRequest(request('/docs/'))
    expect(response!.headers.get('content-security-policy')).toContain("connect-src 'self' blob:")
    expect(response!.headers.get('content-security-policy')).toContain("frame-ancestors 'self'")
  })

  /**
   * The clause that was missing.
   *
   * `'self'` is this document's own origin (the `craft-local://office-…` label), never the app
   * shell that embeds it — so on its own it blocks every embed, and the frame comes up blank with
   * `did-fail-load` -27. The packaged shell is `file://`; the development one is the Vite server,
   * and that is added only when it exists.
   */
  it('admits the shell that embeds the editor, not just its own origin', async () => {
    const policy = async () => (await serveOfficeRequest(request('/docs/')))!.headers.get('content-security-policy') ?? ''

    const plain = await policy()
    expect(plain).toContain("frame-ancestors 'self' file:")
    expect(plain).not.toContain('http://localhost')

    const previous = process.env.VITE_DEV_SERVER_URL
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5219'
    try {
      expect(await policy()).toContain("frame-ancestors 'self' file: http://localhost:5219")
    } finally {
      if (previous === undefined) delete process.env.VITE_DEV_SERVER_URL
      else process.env.VITE_DEV_SERVER_URL = previous
    }
  })

  it('sends /docs to /docs/ so the editor’s relative assets resolve', async () => {
    const response = await serveOfficeRequest(request('/docs'))
    expect(response?.status).toBe(302)
    expect(response?.headers.get('location')).toBe('/docs/')
  })
})

describe('office-host > the shim', () => {
  it('synthesizes the script rather than reading it from the vendored directory', async () => {
    const response = await serveOfficeRequest(request(OFFICE_SHIM_PATH))
    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toContain('text/javascript')

    const source = await response!.text()
    expect(source).toContain("window.desktop = new Proxy")
    expect(source).toContain('craft-office/1')
    // The one method whose answer the editor needs before it can mount.
    expect(source).toContain('consumePendingOpenDocx')
  })

  /**
   * The rule a preview inside a conversation relies on.
   *
   * The frame is the real editor — it draws the real document — so "do not change anything from
   * here" cannot be a matter of hiding buttons: the editor's own save would still reach the disk.
   * `?readonly=1` turns the shim's write calls into refusals before they leave the frame.
   */
  /**
   * The direction that did not exist until Save As needed it.
   *
   * `on*` used to hand back a no-op unsubscribe, because the host never emitted anything. A save
   * path is the host's to know (it comes from a dialog), so the host speaks first — and an editor
   * whose listener was never registered waits forever for a copy that has already been written.
   */
  it('registers a listener for the pushes the host makes', async () => {
    const source = await (await serveOfficeRequest(request(OFFICE_SHIM_PATH)))!.text()
    expect(source).toContain("data.type === 'event'")
    expect(source).toContain('eventListeners[key]')
    expect(source).not.toContain("if (key.indexOf('on') === 0) return function () { return function () {} }")
  })

  it('refuses writes when the preview is read-only', async () => {
    const writable = await (await serveOfficeRequest(request(OFFICE_SHIM_PATH)))!.text()
    expect(writable).toContain('var READ_ONLY = false')

    const readOnly = await (await serveOfficeRequest(request(`${OFFICE_SHIM_PATH}?readonly=1`)))!.text()
    expect(readOnly).toContain('var READ_ONLY = true')
    expect(readOnly).toContain('This is a read-only preview.')
    // The guard has to name the calls it turns away, or it would only look like one.
    expect(readOnly).toContain('if (READ_ONLY && WRITES[method])')
    // Page surgery rewrites the open file: a block that is only being read must not reach it.
    expect(readOnly).toContain('replacePages: true')
    // A deck's notes and comments are part of the file too, and the notes pane is reachable.
    expect(readOnly).toContain('setNotes: true')
    expect(readOnly).toContain('addComment: true')

    // Refusing saves is half of it: without the other half the page still takes typing, and the
    // person learns it was a preview when their save is refused. So the shim asks the editor for
    // its own read mode — and only when this frame is the read-only one.
    expect(readOnly).toContain("cmd: 'readMode'")
    // The script carries the call either way; what differs is that it returns at once in a
    // writable frame, so the editor is never locked there.
    expect(writable).toContain('if (!READ_ONLY) return')
  })

  /**
   * The AI chrome that does not read the preference.
   *
   * `showAiSidebar: false` hides the dock and the Ask-AI pill, but the slides app draws its stage
   * bar unconditionally and the Home ribbon carries the same group — so the shim removes them by
   * stylesheet. If this expectation ever fails, an app has renamed those classes and the buttons
   * are back on screen offering a model nobody here has.
   */
  it('removes the AI chrome that ignores the AI preference', async () => {
    const source = await (await serveOfficeRequest(request(OFFICE_SHIM_PATH)))!.text()
    expect(source).toContain('.stage-ai-bar{display:none !important}')
    expect(source).toContain('.ribbon-group:has(.ai-entry){display:none !important}')
    // It has to run before the app draws, or the bar is on screen for a frame and then vanishes.
    expect(source.indexOf('hideAiChrome()')).toBeLessThan(source.indexOf('var PROTOCOL'))
  })

  /**
   * An export window is its own parent, so the message transport has nowhere to go.
   *
   * Measured before this existed: the docs editor did not mount for 60 seconds (two calls, 30
   * seconds each) and every print gave up at 20. The rules below are the fix, and they are worth
   * pinning because the failure was silence, not a crash.
   */
  it('answers an export window itself instead of waiting on a parent that is itself', async () => {
    const plain = await (await serveOfficeRequest(request(OFFICE_SHIM_PATH)))!.text()
    expect(plain).toContain('window.parent !== window')
    // Settings a frame would ask the person's preferences for.
    expect(plain).toContain('getDocumentTheme')
    expect(plain).toContain('getAutoSaveDefault')
  })

  it('gives an export window a door to the main process, and no door without one', async () => {
    const frame = await (await serveOfficeRequest(request(OFFICE_SHIM_PATH)))!.text()
    expect(frame).toContain('var CALL_URL = null')

    const token = registerExportFile('C:/tmp/shims/door.docx', new Uint8Array([1, 2, 3]))
    registerExportHost(token, async () => null)
    const answered = await (
      await serveOfficeRequest(request(`${OFFICE_SHIM_PATH}?export=${encodeURIComponent(token)}`))
    )!.text()
    releaseExportHost(token)
    releaseExportFile(token)
    expect(answered).toContain("'/__craft/office-call/'")
    expect(answered).toContain(token)
  })
})

describe('office-host > the call route', () => {
  it('answers a live token and refuses one nobody handed out', async () => {
    registerExportHost('route-test', async (method, args) => ({ method, args }))
    const answer = await serveOfficeRequest(
      request('/__craft/office-call/route-test', {
        method: 'POST',
        body: JSON.stringify({ method: 'reopenWorkbook', args: ['x.xlsx'] }),
      }),
    )
    releaseExportHost('route-test')
    expect(answer?.status).toBe(200)
    expect(await answer!.json()).toEqual({
      ok: true,
      value: { method: 'reopenWorkbook', args: ['x.xlsx'] },
    })

    const stale = await serveOfficeRequest(
      request('/__craft/office-call/route-test', { method: 'POST', body: '{}' }),
    )
    expect(stale?.status).toBe(404)
  })

  it('carries bytes, which JSON cannot', async () => {
    registerExportHost('bytes-test', async () => new Uint8Array([1, 2, 3]))
    const answer = await serveOfficeRequest(
      request('/__craft/office-call/bytes-test', {
        method: 'POST',
        body: JSON.stringify({ method: 'readFile', args: ['a.pdf'] }),
      }),
    )
    releaseExportHost('bytes-test')
    expect(await answer!.json()).toEqual({ ok: true, value: { $bytes: 'AQID' } })
  })

  it('reports a refused call as an answer, not as a dead route', async () => {
    registerExportHost('refuse-test', async () => {
      throw new Error('No deck is open for this file.')
    })
    const answer = await serveOfficeRequest(
      request('/__craft/office-call/refuse-test', {
        method: 'POST',
        body: JSON.stringify({ method: 'consumePendingOpen', args: [] }),
      }),
    )
    releaseExportHost('refuse-test')
    expect(await answer!.json()).toEqual({ ok: false, error: 'No deck is open for this file.' })
  })
})

describe('office-host > the fence', () => {
  it('serves assets under the app it was asked for', async () => {
    const response = await serveOfficeRequest(request('/docs/assets/index.js'))
    expect(response?.status).toBe(200)
    expect(await response!.text()).toContain('booted')
  })

  it('refuses a path that leaves the app directory', async () => {
    const response = await serveOfficeRequest(request('/docs/../../etc/passwd'))
    expect(response?.status).not.toBe(200)
  })

  it('refuses an app it does not serve', async () => {
    const response = await serveOfficeRequest(request('/notes/index.html'))
    expect(response?.status).toBe(404)
  })

  it('refuses a label this run never handed out', async () => {
    const response = await serveOfficeRequest(new Request('craft-local://someone-else/docs/'))
    expect(response).toBeNull()
  })

  it('answers only GET and HEAD', async () => {
    const response = await serveOfficeRequest(request('/docs/', { method: 'POST' }))
    expect(response?.status).toBe(405)
  })
})
