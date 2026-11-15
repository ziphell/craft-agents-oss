/**
 * Would a `file://` frame be enough, under the app's own policy?
 *
 * The app's `index.html` carries a `<meta http-equiv="Content-Security-Policy">` whose `frame-src`
 * is `'self' http://*.localhost craft-local:` — no `file:`. This probe frames the file with that
 * exact policy in place and reports two things: whether the page's own script painted (its visible
 * text is drawn on a canvas, so a blank canvas means no script), and whether the frame stayed
 * opaque to the host.
 */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' http://localhost:8097; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https: file: thumbnail: http://*.localhost craft-local:; frame-src 'self' http://*.localhost craft-local:; connect-src 'self' https: http://localhost:* ws://localhost:* wss://localhost:*; font-src 'self' data: https://fonts.gstatic.com;"

const PAGE =
  'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\sessions\\261102-fresh-coast\\data\\selection-paint.html'

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-frame-probe-'))
  const url = pathToFileURL(PAGE).href
  const host = join(dir, 'host.html')
  writeFileSync(
    host,
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${APP_CSP.replace(/"/g, '&quot;')}"></head>
     <body style="margin:0;background:#1b1b1d">
       <iframe id="f" src="${url}" sandbox="allow-scripts allow-forms allow-top-navigation-by-user-activation"
               style="width:820px;height:150px;border:1px solid #444;background:#fff"></iframe>
     </body></html>`,
  )

  const win = new BrowserWindow({ show: false, width: 860, height: 200, backgroundColor: '#fff' })
  win.webContents.on('console-message', (...args: unknown[]) => {
    const message = args.find((value) => typeof value === 'string' && value.length > 0)
    if (typeof message === 'string') console.log('  [console]', message.slice(0, 200))
  })
  await win.loadFile(host)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const facts = await win.webContents
    .executeJavaScript(`(() => {
      const frame = document.getElementById('f');
      let reach = 'blocked';
      try { reach = frame.contentDocument ? 'SAME-ORIGIN (readable)' : 'blocked'; } catch (error) { reach = 'blocked'; }
      return { hostReadsFrame: reach, frames: window.frames.length };
    })()`)
    .catch((error) => ({ error: String(error) }))
  console.log('[probe] host facts:', JSON.stringify(facts))

  const child = win.webContents.mainFrame.frames[0]
  const inside = child
    ? await child
        .executeJavaScript(`(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return { canvases: 0, url: location.href };
          const data = canvas.getContext('2d').getImageData(20, 20, 1, 1).data;
          return { canvases: 1, pixel: [data[0], data[1], data[2]].join(','), hasSelect: typeof window.selectBoth };
        })()`)
        .catch((error) => ({ error: String(error) }))
    : { frames: 0 }
  console.log('[probe] frame facts:', JSON.stringify(inside))

  writeFileSync(join(dir, 'shot.png'), (await win.webContents.capturePage()).toPNG())
  console.log('[probe] picture:', join(dir, 'shot.png'))
  app.exit(0)
})
