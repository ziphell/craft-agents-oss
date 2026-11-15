/**
 * Does the sheets editor draw a file when the host answers like the app's frame?
 *
 * The poster and the editor load the same bundle with the same sidecar, so the only variable left
 * is the *host* they talk to. This probe stands in for one of them, twice:
 *
 *   PROBE_VARIANT=missing   — what the app's `OfficeFrame` answers today: `hasQueuedWorkbook`
 *                             falls through to `officeWorkbookCall`, which does not know it
 *                             (`noteUnwired` → `undefined`).
 *   PROBE_VARIANT=answered  — the same, plus `hasQueuedWorkbook: true` (what the poster's export
 *                             host answers).
 *
 * Both print every method the editor asked for, then a picture and the page's own words.
 *
 * Build and run (from the repo root):
 *   bunx esbuild apps/electron/spike/sheets-open-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/sheets-open-probe.cjs
 *   (cd apps/electron && ../../node_modules/electron/dist/electron.exe spike/sheets-open-probe.cjs)
 */
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { officeOriginUrl } from '../src/main/office-origin'
import { officeWorkbookCall } from '@craft-agent/office-host'

const VARIANT = process.env.PROBE_VARIANT === 'answered' ? 'answered' : 'missing'
const FILE = process.env.PROBE_FILE
  ?? 'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\sessions\\261102-rapid-diamond\\data\\bench\\sheet.xlsx'
const OUT = process.env.PROBE_OUT
  ?? 'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\sessions\\261102-fresh-coast\\data'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})
process.on('uncaughtException', (error) => {
  console.log('[probe] uncaught', error)
  app.exit(2)
})

app.whenReady().then(async () => {
  registerLocalOriginHandler(session.defaultSession)
  const origin = officeOriginUrl()
  if (!origin) {
    console.log('[probe] no office origin (bundles not built)')
    app.exit(1)
    return
  }
  mkdirSync(OUT, { recursive: true })

  const calls: string[] = []
  ipcMain.handle('probe-answer', async (_event, method: string, args: unknown[]) => {
    calls.push(method)
    // The settings the frame answers without asking anyone (OfficeFrame's first cases).
    switch (method) {
      case 'getLanguage':
      case 'getSystemLocale':
        return 'en'
      case 'getTheme':
      case 'getDocumentTheme':
        return 'light'
      case 'getAutoSaveDefault':
        return false
      case 'getAuthorName':
        return ''
      case 'getAiPanelPrefs':
        return { open: false }
      case 'hasQueuedWorkbook':
        if (VARIANT === 'answered') return true
        break
      default:
        break
    }
    // Everything else is the workbook door, with the path in front — exactly OfficeFrame's default.
    return officeWorkbookCall(method, [FILE, ...args])
  })

  const win = new BrowserWindow({
    show: false,
    width: 1250,
    height: 849,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'sheets-open-probe-preload.cjs'),
      contextIsolation: true,
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (...args: unknown[]) => {
    const message = args.find((value) => typeof value === 'string' && value.length > 0)
    if (typeof message === 'string' && !message.includes('Autofill')) console.log('  [console]', message.slice(0, 240))
  })
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.log('  [fail-load]', code, description, String(url).slice(0, 120))
  })

  // The frame is embedded exactly as the app embeds it: a page on `file://` with the editor in an
  // iframe, so `event.source === window.parent` holds and the CSP's `frame-ancestors file:` admits it.
  const parent = join(OUT, `sheets-open-${VARIANT}-host.html`)
  writeFileSync(
    parent,
    `<!doctype html><html><body style="margin:0;background:#fff">
       <iframe id="editor" src="${origin}/sheets/" style="border:0;width:100vw;height:100vh"></iframe>
     </body></html>`,
  )
  await win.loadFile(parent)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const base64 = readFileSync(FILE).toString('base64')
  const name = FILE.split(/[\/]/).pop() ?? FILE
  await win.webContents.executeJavaScript(`(() => {
    const binary = atob(${JSON.stringify(base64)});
    const all = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) all[at] = binary.charCodeAt(at);
    const frame = document.getElementById('editor');
    frame.contentWindow.postMessage({ protocol: 'craft-office/1', type: 'open', file: {
      id: ${JSON.stringify(FILE)}, path: ${JSON.stringify(FILE)}, name: ${JSON.stringify(name)},
      bytes: all.buffer,
    } }, '*');
    return true;
  })()`)

  // Long enough for the sidecar to parse and the grid to paint; the poster waits ~2 s.
  await new Promise((resolve) => setTimeout(resolve, 9000))

  const child = win.webContents.mainFrame.frames[0]
  const facts = await child.executeJavaScript(`(() => {
    const text = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240);
    return {
      text,
      opening: !!document.querySelector('.workbook-opening-screen'),
      canvases: Array.from(document.querySelectorAll('canvas')).map((c) => c.width + 'x' + c.height),
      tabs: Array.from(document.querySelectorAll('[class*="sheet-tab"]')).map((e) => (e.textContent || '').trim()).slice(0, 12),
      nameBox: (document.querySelector('[class*="name-box"] input') || {}).value || null,
    };
  })()`)
  const image = await win.webContents.capturePage()
  const png = join(OUT, `sheets-open-${VARIANT}.png`)
  writeFileSync(png, image.toPNG())

  console.log(`\n[probe] variant=${VARIANT}`)
  console.log('[probe] methods asked:', JSON.stringify(calls))
  console.log('[probe] facts:', JSON.stringify(facts, null, 2))
  console.log('[probe] picture:', png, `${Math.round(image.toPNG().length / 1024)} KB`)
  app.exit(0)
})
