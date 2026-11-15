/**
 * Why a `.drawio` poster comes back as "the viewer drew nothing".
 *
 * The poster's path is: load `/__craft/viewer.html` on the drawio origin, post it a `render`
 * message, wait for `#host svg`. This reproduces exactly that, one step at a time, with the
 * console, the network statuses and the page's own state printed in between — the capture window
 * is invisible, so none of it is otherwise observable.
 *
 * Build and run (repo root):
 *   bunx esbuild apps/electron/spike/drawio-poster-spike.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:@anthropic-ai/claude-agent-sdk --external:koffi --external:@trycua/cua-driver \
 *     --outfile=apps/electron/spike/drawio-poster-spike.cjs
 *   (cd apps/electron && ../../node_modules/electron/dist/electron.exe spike/drawio-poster-spike.cjs)
 */
import { app, BrowserWindow, session } from 'electron'
import { readFileSync } from 'node:fs'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { drawioOriginUrl } from '../src/main/drawio-host'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { DRAWIO_BRIDGE_PROTOCOL, drawioViewerUrl } from '@craft-agent/shared/drawio/types'

const DIAGRAM = 'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\sessions\\260927-pure-bear\\diagrams\\demo.drawio'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})

app
  .whenReady()
  .then(async () => {
    registerLocalOriginHandler(session.defaultSession)
    const origin = drawioOriginUrl()
    console.log('[origin]', origin)
    if (!origin) return app.exit(1)

    session.defaultSession.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) console.log('[http]', details.statusCode, details.url.slice(0, 160))
    })

    const win = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      width: 1000,
      height: 625,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, javascript: true },
    })

    win.webContents.on('console-message', (...args: unknown[]) => {
      console.log('[console]', JSON.stringify(args.map((a) => (typeof a === 'string' ? a : typeof a))).slice(0, 500))
    })
    win.webContents.on('did-fail-load', (...args: unknown[]) => {
      console.log('[fail-load]', JSON.stringify(args.map((a) => String(a).slice(0, 120))).slice(0, 400))
    })
    win.webContents.on('preload-error', (_e, path, error) => console.log('[preload-error]', path, String(error)))

    const url = drawioViewerUrl(origin)
    console.log('[url]', url)
    await win.loadURL(url)
    console.log('[loaded]', win.webContents.getURL())
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const before = await win.webContents.executeJavaScript(`({
      ready: document.readyState,
      scripts: [...document.scripts].map((s) => s.src),
      hostChildren: (document.getElementById('host') || { childElementCount: -1 }).childElementCount,
      hostHtml: ((document.getElementById('host') || {}).innerHTML || '').length,
      failed: (document.getElementById('failed') || { textContent: null }).textContent,
      viewerDefined: typeof window.GraphViewer,
      stencilClaimed: window.STENCIL_PATH,
      parentIsSelf: window.parent === window,
      hostExists: !!document.getElementById('host'),
      frames: window.length,
    })`)
    console.log('[before]', JSON.stringify(before).slice(0, 600))

    const xml = readFileSync(DIAGRAM, 'utf8')
    const payload = { protocol: DRAWIO_BRIDGE_PROTOCOL, type: 'render', xml, dark: false }
    // An **object**, not a JSON string: the bridge reads `event.data.protocol`.
    await win.webContents.executeJavaScript(`window.postMessage(${JSON.stringify(payload)}, '*'); true`)
    console.log('[posted] object with', xml.length, 'chars of xml')

    // Does a message reach the bridge at all? Delivered directly, with an explicit source.
    const direct = await win.webContents.executeJavaScript(`(() => {
      let seen = false
      const probe = () => { seen = true }
      window.addEventListener('message', probe)
      window.dispatchEvent(new MessageEvent('message', { data: { protocol: 'craft-drawio/v1', type: 'ready' }, source: window }))
      window.removeEventListener('message', probe)
      return seen
    })()`)
    console.log('[message delivered to a listener]', direct)

    for (let step = 0; step < 12; step++) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const state = await win.webContents.executeJavaScript(`({
        svg: !!document.querySelector('#host svg'),
        hostHtml: ((document.getElementById('host') || {}).innerHTML || '').length,
        failed: (document.getElementById('failed') || { textContent: null }).textContent,
      })`)
      console.log(`[state +${((step + 1) * 0.5).toFixed(1)}s]`, JSON.stringify(state).slice(0, 300))
      if (state.svg) break
    }

    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error('[spike] failed', error)
    app.exit(1)
  })
