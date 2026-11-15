/**
 * Why a previewed page can look white-on-white while the same file reads black elsewhere.
 *
 * The three frames a page can be shown in are not the same document:
 *
 *   served   — `craft-local://` at its own origin, scripts running (what the app does now)
 *   srcdoc   — the text, same-origin, no scripts (`allow-same-origin`, the fallback)
 *   file://  — the file itself, a browser would show this
 *
 * The hypothesis being tested: a **same-origin** frame inherits the embedder's *used colour
 * scheme*, so in a dark app a page with no `color-scheme` of its own starts from white text on a
 * dark canvas; the served page is a separate origin and starts from the light default.
 *
 * Build and run (from the repo root):
 *   bunx esbuild apps/electron/spike/html-theme-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/html-theme-probe.cjs
 *   (cd apps/electron && ../../node_modules/electron/dist/electron.exe spike/html-theme-probe.cjs)
 */
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { htmlOriginFor } from '../src/main/html-origin'
import { DRAWN_PAGE_SANDBOX } from '@craft-agent/shared/html-preview'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})
process.on('uncaughtException', (error) => {
  console.log('[probe] uncaught', error)
  app.exit(2)
})

const PAGE =
  'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\sessions\\261102-fresh-coast\\data\\selection-paint.html'

app.whenReady().then(async () => {
  registerLocalOriginHandler(session.defaultSession)
  nativeTheme.themeSource = 'dark'

  const dir = mkdtempSync(join(tmpdir(), 'html-theme-probe-'))
  const html = readFileSync(PAGE, 'utf8')
  const served = htmlOriginFor(PAGE)!

  const host = join(dir, 'host.html')
  writeFileSync(
    host,
    `<!doctype html><html><head><style>
       html { color-scheme: dark }
       body { margin:0;background:#1b1b1d;color:#eee;font:12px system-ui }
       .row { padding:4px }
       iframe { width:760px;height:150px;border:1px solid #444;background:#fff }
     </style></head><body>
       <div class="row">served (craft-local, own origin, scripts run)</div>
       <iframe id="served" src="${served}" sandbox="allow-scripts allow-forms allow-top-navigation-by-user-activation"></iframe>
       <div class="row">srcdoc (same origin, no scripts)</div>
       <iframe id="srcdoc" sandbox="${DRAWN_PAGE_SANDBOX}"></iframe>
       <div class="row">file:// in the app's Chromium</div>
       <iframe id="file" src="file:///${PAGE.replace(/\\/g, '/')}" sandbox="allow-scripts"></iframe>
     </body></html>`,
  )

  const win = new BrowserWindow({ show: false, width: 820, height: 620, backgroundColor: '#ffffff' })
  await win.loadFile(host)
  await win.webContents.executeJavaScript(
    `document.getElementById('srcdoc').srcdoc = ${JSON.stringify(html)}; true`,
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const read = (index: number) =>
    win.webContents.mainFrame.frames[index]?.executeJavaScript(`(() => {
      const body = getComputedStyle(document.body);
      const root = getComputedStyle(document.documentElement);
      const canvas = document.querySelector('canvas');
      let pixel = null;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(20, 20, 1, 1).data;
        pixel = [data[0], data[1], data[2], data[3]].join(',');
      }
      return {
        bodyBg: body.backgroundColor,
        bodyColor: body.color,
        rootBg: root.backgroundColor,
        scheme: root.colorScheme || '(none)',
        canvasPixel: pixel,
        title: document.title || '(none)',
      };
    })()`)

  for (const [name, index] of [['served', 0], ['srcdoc', 1], ['file', 2]] as const) {
    const facts = await read(index).catch((error) => ({ error: String(error) }))
    console.log(`[probe] ${name}:`, JSON.stringify(facts))
  }

  const shot = join(dir, 'frames.png')
  writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
  console.log('[probe] picture:', shot)
  app.exit(0)
})
