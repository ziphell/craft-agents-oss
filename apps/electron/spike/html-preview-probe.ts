/**
 * Does a previewed page behave like a page — and still not reach the app?
 *
 * Serves one HTML file through the real host (`htmlOriginFor` + the real `craft-local` router),
 * frames it exactly as the preview does (opaque origin, scripts allowed), and reports four facts
 * from inside the frame:
 *
 *   `title`       — its own script ran
 *   `sheet`       — a stylesheet beside it resolved (the `<base>` points at the file's folder)
 *   `image`       — an image beside it loaded (naturalWidth > 0)
 *   `reachParent` — `parent.document` threw, i.e. the sandbox kept it out of the app
 *
 * Build and run (from the repo root):
 *   bunx esbuild apps/electron/spike/html-preview-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/html-preview-probe.cjs
 *   (cd apps/electron && ../../node_modules/electron/dist/electron.exe spike/html-preview-probe.cjs)
 */
import { app, BrowserWindow, session } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { htmlOriginFor } from '../src/main/html-origin'
import { SERVED_PAGE_SANDBOX } from '@craft-agent/shared/html-preview'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})
process.on('uncaughtException', (error) => {
  console.log('[probe] uncaught', error)
  app.exit(2)
})

app.whenReady().then(async () => {
  registerLocalOriginHandler(session.defaultSession)

  const dir = mkdtempSync(join(tmpdir(), 'html-preview-probe-'))
  const page = join(dir, 'report.html')
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8">
       <link rel="stylesheet" href="style.css">
       <title>before</title></head>
     <body>
       <h1 id="heading">产物页面：中文标题</h1>
       <img id="pic" src="pic.svg" alt="">
       <script>
         document.title = 'ran';
         document.getElementById('heading').dataset.script = 'yes';
       </script>
     </body></html>`,
    'utf8',
  )
  writeFileSync(join(dir, 'style.css'), '#heading { color: rgb(12, 34, 56); }', 'utf8')
  writeFileSync(
    join(dir, 'pic.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#c33"/></svg>',
    'utf8',
  )

  const url = htmlOriginFor(page)
  if (!url) {
    console.log('[probe] the host refused to name the page')
    app.exit(1)
    return
  }

  const host = join(dir, 'host.html')
  writeFileSync(
    host,
    `<!doctype html><html><body style="margin:0;background:#eee">
       <iframe id="frame" src="${url}" sandbox="${SERVED_PAGE_SANDBOX}"
               style="border:0;width:900px;height:300px;background:#fff"></iframe>
     </body></html>`,
  )

  const win = new BrowserWindow({ show: false, width: 980, height: 420, backgroundColor: '#ffffff' })
  win.webContents.on('console-message', (...args: unknown[]) => {
    const message = args.find((value) => typeof value === 'string' && value.length > 0)
    if (typeof message === 'string') console.log('  [console]', message.slice(0, 200))
  })
  await win.loadFile(host)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const frame = win.webContents.mainFrame.frames[0]
  const facts = await frame.executeJavaScript(`(() => {
    const reachParent = (() => { try { return Boolean(parent.document.body) } catch (error) { return 'blocked' } })();
    const ownStorage = (() => { try { return Boolean(localStorage) } catch (error) { return 'blocked' } })();
    return {
      url: location.href,
      title: document.title,
      scriptRan: document.getElementById('heading').dataset.script === 'yes',
      sheet: getComputedStyle(document.getElementById('heading')).color,
      image: document.getElementById('pic').naturalWidth,
      reachParent,
      ownStorage,
      base: document.baseURI,
    };
  })()`)

  const shot = join(dir, 'preview.png')
  const image = await win.webContents.capturePage()
  writeFileSync(shot, image.toPNG())

  console.log('\n[probe] served at', url)
  console.log('[probe] facts:', JSON.stringify(facts, null, 2))
  console.log('[probe] picture:', shot, `${Math.round(image.toPNG().length / 1024)} KB`)
  app.exit(0)
})
