/**
 * Does a scripted page get photographed *after* its scripts have painted?
 *
 * The page here is deliberately one a static screenshot cannot show: its body is a heading and a
 * status line until a `setTimeout` — 900 ms after load, past the first paint and past the
 * `isPicture` gate — replaces them with a grid of cells. It also links a stylesheet beside it, so
 * the picture says whether the page was served from its own folder.
 *
 * Three runs, same page: scripts off, scripts on, and scripts on but captured before the timer
 * fires (the control that proves the wait is what makes the difference).
 *
 * Build and run (from the repo root):
 *   bunx esbuild apps/electron/spike/web-page-shot-probe.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/web-page-shot-probe.cjs
 *   (cd apps/electron && ../../node_modules/electron/dist/electron.exe spike/web-page-shot-probe.cjs)
 */
import { app, session } from 'electron'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { htmlOriginFor } from '../src/main/html-origin'
import { captureWebPage } from '../src/main/capture-web-page'
import { createCreationThumbnailer } from '../src/main/creation-thumbnailer'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})
process.on('uncaughtException', (error) => {
  console.log('[probe] uncaught', error)
  app.exit(2)
})

const cells = Array.from({ length: 6 }, (_, row) =>
  `<div>第 ${row + 1} 行：季度汇总 销售额 ${(row + 1) * 1234} 元</div>`,
).join('')

app.whenReady().then(async () => {
  registerLocalOriginHandler(session.defaultSession)

  const dir = mkdtempSync(join(tmpdir(), 'web-shot-probe-'))
  const page = join(dir, 'chart.html')
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8">
       <link rel="stylesheet" href="page.css">
     </head><body>
       <h1>季度报表</h1>
       <p id="status">正在加载图表…</p>
       <div id="chart"></div>
       <script>
         // Past the first paint, past \`isPicture\`, and past a naive settle: only a capture that
         // actually waits for the page can have this.
         setTimeout(function () {
           document.getElementById('status').remove();
           document.getElementById('chart').innerHTML = ${JSON.stringify(cells)};
         }, 900);
       </script>
     </body></html>`,
    'utf8',
  )
  writeFileSync(join(dir, 'page.css'), 'body{font:16px/1.6 system-ui;margin:16px} h1{color:#123456}', 'utf8')

  const url = htmlOriginFor(page)
  if (!url) {
    console.log('[probe] the host refused to name the page')
    app.exit(1)
    return
  }
  console.log('\n[probe] served at', url)

  const shots = join(dir, 'out')
  mkdirSync(shots, { recursive: true })

  const runs: Array<{ name: string; options: Parameters<typeof captureWebPage>[3] }> = [
    { name: '1-scripts-off', options: { scripts: false } },
    { name: '2-scripts-on', options: { scripts: true } },
    { name: '3-no-confirm', options: { scripts: true, confirmAfterMs: 0, quietMs: 0 } },
  ]

  for (const run of runs) {
    const started = Date.now()
    const png = await captureWebPage(url, { width: 1000, height: 500 }, 20_000, run.options)
    const file = join(shots, `${run.name}.png`)
    if (png) writeFileSync(file, png)
    console.log(
      `[probe] ${run.name}: ${png ? `${Math.round(png.length / 1024)} KB` : 'NO PICTURE'} ` +
        `in ${Date.now() - started} ms${png ? ` → ${file}` : ''}`,
    )
  }

  // The real poster path, not just the capture: lane, cache, JPEG. A card whose format is html
  // must show the page the preview shows.
  const thumbnailer = createCreationThumbnailer((message) => console.log(`  ${message}`))
  const started = Date.now()
  const poster = await thumbnailer.ensure({
    workspaceRootPath: join(dir, 'workspace'),
    path: page,
    format: 'html',
    mtimeMs: 1,
    bytes: 1,
  })
  console.log(
    `[probe] poster: ${poster ? `${poster}` : 'NO POSTER'} in ${Date.now() - started} ms`,
  )

  app.exit(0)
})
