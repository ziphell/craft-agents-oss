/**
 * Tab-memory spike — temporary, not part of the app.
 *
 * Question it answers: **does one window with many views actually cost less than one window per
 * page, and by how much?** The number that matters is not the process count — Chromium gives
 * every page its own renderer either way — but how big each renderer's working set is, which is
 * what the *viewport* and the *throttling* decide.
 *
 * Four identical pages, four page-by-page configurations, measured by attributing each
 * renderer's working set to the page that owns it (`webContents.getProcessId()`):
 *
 *   views-parked-0x0        one window, background pages parked at zero size (before A)
 *   views-fullsize-throttled one window, every page real-sized (A's geometry, flag not set)
 *   views-fullsize-unthrottled one window, real-sized and never throttled (A as shipped first)
 *   windows-offscreen        one native window per page, parked off screen (the other design)
 *
 * Each page is served from its own loopback address, so Chromium treats them as separate sites
 * the way real pages are — otherwise it would merge them into one process and the numbers would
 * be about nothing.
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/memory   (from the repo root)
 */
const { app, BrowserWindow, BrowserView, screen } = require('electron')
const http = require('http')

const PAGES = 4
const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The tear-down steps below close every window on purpose, which would otherwise end the app
// before the last measurements are taken.
app.on('window-all-closed', () => {})

function pageHtml(color, label) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:${color}}</style></head><body><script>window.__label=${JSON.stringify(label)}</script></body></html>`
}

/** Working set per process, and the pages' share of it, by PID. */
async function snapshot(label, pages) {
  await sleep(2500)
  const metrics = app.getAppMetrics()
  const byPid = new Map(metrics.map((metric) => [metric.pid, metric]))
  const mb = (metric) => (metric && metric.memory ? Math.round(metric.memory.workingSetSize / 1024) : -1)

  const perPage = pages.map((page) => ({
    label: page.label,
    pid: page.webContents.getProcessId(),
    workingSetMb: mb(byPid.get(page.webContents.getProcessId())),
  }))

  const byType = {}
  for (const metric of metrics) {
    const key = metric.type || 'unknown'
    byType[key] = (byType[key] || 0) + Math.max(0, mb(metric))
  }

  return {
    label,
    totalMb: Object.values(byType).reduce((sum, value) => sum + value, 0),
    byTypeMb: byType,
    processes: metrics.length,
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    perPage,
  }
}

app.whenReady().then(async () => {
  try {
    const workArea = screen.getPrimaryDisplay().workArea
    const W = Math.min(900, Math.floor(workArea.width * 0.5))
    const H = Math.min(700, Math.floor(workArea.height * 0.5))
    const taken = []

    // One server, one loopback address per page: distinct sites, so distinct renderers.
    const server = http.createServer((request, response) => {
      // `127.0.0.2:port` → page 2 (the address is the site identity here).
      const host = (request.headers.host || '').split(':')[0]
      const index = Number(host.split('.')[3]) - 1
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(pageHtml(COLORS[index] || '#888888', `page-${index}`))
    })
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
    const port = server.address().port
    const urls = Array.from({ length: PAGES }, (_, index) => `http://127.0.0.${index + 1}:${port}/`)

    const load = async (webContents, url) => {
      const loaded = new Promise((resolve) => {
        webContents.once('did-finish-load', () => resolve('ok'))
        webContents.once('did-fail-load', (_event, code, description) => resolve(`failed: ${code} ${description}`))
      })
      await webContents.loadURL(url)
      return loaded
    }

    taken.push(await snapshot('nothing open', []))

    // -- One window, many views -----------------------------------------------------------
    const win = new BrowserWindow({ x: workArea.x + 20, y: workArea.y + 20, width: W, height: H, frame: false, show: true })
    const views = []
    for (let index = 0; index < PAGES; index += 1) {
      const view = new BrowserView({ webPreferences: { backgroundThrottling: true } })
      win.addBrowserView(view)
      view.setBounds({ x: 0, y: 0, width: W, height: H })
      views.push({ label: `view-${index}`, webContents: view.webContents, view })
    }
    win.setTopBrowserView(views[0].view)
    const loadResults = await Promise.all(views.map((page, index) => load(page.webContents, urls[index])))
    console.log('SPIKE_PAGES ' + JSON.stringify(loadResults))

    taken.push(await snapshot('views: all real-sized, throttled', views))

    for (const page of views.slice(1)) page.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    taken.push(await snapshot('views: background parked 0x0 (before A)', views))

    for (const page of views) {
      page.view.setBounds({ x: 0, y: 0, width: W, height: H })
      page.webContents.setBackgroundThrottling(false)
    }
    taken.push(await snapshot('views: all real-sized, never throttled (A)', views))

    win.destroy()
    for (const page of views) {
      if (!page.webContents.isDestroyed()) page.webContents.destroy()
    }
    await sleep(1500)

    // -- One window per page -------------------------------------------------------------
    const windows = []
    for (let index = 0; index < PAGES; index += 1) {
      const hidden = index > 0
      const pageWindow = new BrowserWindow({
        x: hidden ? workArea.x + workArea.width + 300 + index * 30 : workArea.x + 20,
        y: hidden ? workArea.y : workArea.y + 20,
        width: W,
        height: H,
        frame: false,
        skipTaskbar: true,
        show: false,
        webPreferences: { backgroundThrottling: true },
      })
      windows.push({ label: `window-${index}`, webContents: pageWindow.webContents, window: pageWindow })
    }
    await Promise.all(windows.map((page, index) => load(page.webContents, urls[index])))
    windows[0].window.showInactive()
    for (const page of windows.slice(1)) page.window.showInactive()

    taken.push(await snapshot('windows: one per page, off screen', windows))

    for (const page of windows) page.window.destroy()
    await sleep(1500)
    taken.push(await snapshot('after teardown', []))

    console.log('SPIKE_JSON ' + JSON.stringify(taken))
    console.log('\nconfiguration                                 procs  total   browser gpu  tab   per page (MB)')
    for (const entry of taken) {
      const pages = entry.perPage.map((page) => `${page.label}=${page.workingSetMb}`).join(' ')
      console.log(
        `${entry.label.padEnd(44)}  ${String(entry.processes).padEnd(5)} ${String(entry.totalMb).padEnd(6)} ${String(entry.byTypeMb.Browser ?? '-').padEnd(7)} ${String(entry.byTypeMb.GPU ?? '-').padEnd(4)} ${String(entry.byTypeMb.Tab ?? '-').padEnd(5)} ${pages}`,
      )
    }

    server.close()
    app.quit()
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
