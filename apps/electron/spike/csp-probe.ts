/**
 * Does the app's own meta policy change what a `craft-local://` frame may run?
 *
 * The host here carries the exact `<meta http-equiv="Content-Security-Policy">` from
 * `src/renderer/index.html`, and frames the served page. A parent's policy does not reach into a
 * cross-origin child — this is the measurement that says so, or names the exception.
 */
import { app, BrowserWindow, session } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { htmlOriginFor } from '../src/main/html-origin'
import { SERVED_PAGE_SANDBOX } from '@craft-agent/shared/html-preview'

const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:8097; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https: file: thumbnail: http://*.localhost craft-local:; frame-src 'self' http://*.localhost craft-local:; connect-src 'self' https: http://localhost:* ws://localhost:* wss://localhost:*; font-src 'self' data: https://fonts.gstatic.com;"

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  registerLocalOriginHandler(session.defaultSession)
  const dir = mkdtempSync(join(tmpdir(), 'csp-probe-'))
  const page = 'C:\Users\Ryan\.craft-agent\workspaces\my-workspace\sessions\261102-fresh-coast\data\selection-paint.html'
  const host = join(dir, 'host.html')
  writeFileSync(
    host,
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${APP_CSP.replace(/"/g, '&quot;')}"></head>
     <body style="margin:0">
       <iframe id="f" src="${htmlOriginFor(page)}" sandbox="${SERVED_PAGE_SANDBOX}" style="width:800px;height:160px;border:0"></iframe>
     </body></html>`,
  )
  const win = new BrowserWindow({ show: false, width: 840, height: 220, backgroundColor: '#fff' })
  await win.loadFile(host)
  await new Promise((r) => setTimeout(r, 2500))
  const child = win.webContents.mainFrame.frames[0]
  console.log('[probe] child url:', child.url)
  const facts = await child
    .executeJavaScript(`(() => ({
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 120) : '(no body)',
      canvases: document.querySelectorAll('canvas').length,
      hasSelect: typeof window.selectBoth,
    }))()`)
    .catch((error) => ({ error: String(error) }))
  console.log('[probe] under the app CSP:', JSON.stringify(facts))
  writeFileSync(join(dir, 'shot.png'), (await win.webContents.capturePage()).toPNG())
  console.log('[probe] picture:', join(dir, 'shot.png'))
  app.exit(0)
})
