/**
 * Does this window's DPI actually follow the display it is moved onto?
 *
 * The question the browser window's chrome raises: after a person drags the window onto a
 * display whose scale factor differs, do the *renderers* in the window (the rail, the bar, the
 * overlay document, the page) learn the new device pixel ratio — or do they keep the one they
 * were created with, while the main process keeps laying views out in DIP? The second case
 * shows up exactly as the panel's hairline/rounded corners no longer matching the page, since
 * one side of that pair is drawn in CSS pixels and the other is a native view rectangle.
 *
 * Built to mirror the real window's shape: a frameless `BrowserWindow` whose own webContents is
 * unused, chrome as legacy `BrowserView`s, a page as a `WebContentsView` with a native corner
 * radius, and — because that window is hidden rather than destroyed when it is closed — a phase
 * that moves it while it is hidden.
 *
 * Run: node_modules\electron\dist\electron.exe apps\electron\spike\dpi-scale.cjs
 * Log: apps\electron\spike\dpi-scale.log (NDJSON, one line per observation)
 *
 * Only meaningful on a machine with two displays of different scale factors: with one display
 * it reports the single-display state and stops after the hidden-move phase.
 */
const { app, BrowserWindow, BrowserView, WebContentsView, screen } = require('electron')
const fs = require('fs')
const path = require('path')

const LOG = path.join(__dirname, 'dpi-scale.log')

function log(tag, data) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${tag} ${JSON.stringify(data)}\n`)
}

/** A page that reports what the renderer believes about its own scale. */
const PROBE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { margin: 0; width: 100%; height: 100%; background: #16324f; }
  #ruler { position: fixed; left: 10px; top: 10px; width: 100px; height: 20px; background: #0a0; }
</style>
</head><body><div id="ruler"></div></body></html>`)}`

const MEASURE = `(() => ({
  dpr: window.devicePixelRatio,
  screenWidth: window.screen.width,
  screenAvailWidth: window.screen.availWidth,
  resolution2: matchMedia('(resolution: 2dppx)').matches,
  resolution15: matchMedia('(resolution: 1.5dppx)').matches,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  ruler: document.getElementById('ruler').getBoundingClientRect().toJSON(),
}))()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function measure(webContents) {
  try {
    return await webContents.executeJavaScript(MEASURE)
  } catch (error) {
    return { error: String(error) }
  }
}

function displayOf(win) {
  const d = screen.getDisplayMatching(win.getBounds())
  return { id: d.id, scale: d.scaleFactor, workArea: d.workArea }
}

app.whenReady().then(async () => {
  try {
    fs.writeFileSync(LOG, '')
    const displays = screen.getAllDisplays().map((d) => ({ id: d.id, scale: d.scaleFactor, bounds: d.bounds }))
    log('displays', displays)
    log('electron', { electron: process.versions.electron, chrome: process.versions.chrome })

    const start = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      x: start.x + 40,
      y: start.y + 40,
      width: 1200,
      height: 900,
      frame: false,
      show: true,
      backgroundColor: '#202020',
    })

    // The window's own webContents — the piece a `BaseWindow` would not have. Never loaded by
    // the app, but loaded here so its renderer can be asked what it thinks the scale is.
    await win.webContents.loadURL(PROBE_PAGE)

    const rail = new BrowserView({ webPreferences: {} })
    const overlay = new BrowserView({ webPreferences: {} })
    const page = new WebContentsView({ webPreferences: {} })
    const railView = rail.webContentsView || rail
    const overlayView = overlay.webContentsView || overlay

    win.contentView.addChildView(railView)
    win.contentView.addChildView(page)
    win.contentView.addChildView(overlayView)

    railView.setBackgroundColor('#00000000')
    overlayView.setBackgroundColor('#00000000')
    page.setBorderRadius(10)
    page.setBackgroundColor('#00000000')

    await rail.webContents.loadURL(PROBE_PAGE)
    await overlay.webContents.loadURL(PROBE_PAGE)
    await page.webContents.loadURL(PROBE_PAGE)

    const layout = () => {
      const [width, height] = win.getContentSize()
      railView.setBounds({ x: 0, y: 0, width: 200, height })
      page.setBounds({ x: 206, y: 48, width: Math.max(1, width - 206 - 6), height: Math.max(1, height - 48 - 6) })
      overlayView.setBounds({ x: 200, y: 48, width: Math.max(1, width - 200), height: Math.max(1, height - 48) })
      win.contentView.addChildView(overlayView)
      win.contentView.addChildView(railView)
    }
    layout()
    win.on('resize', layout)

    let movedEvents = 0
    for (const event of ['resize', 'resized', 'move', 'moved']) {
      win.on(event, () => {
        movedEvents += 1
        log(`event:${event}`, { contentSize: win.getContentSize(), display: displayOf(win) })
      })
    }

    await sleep(800)

    const report = async (tag) => {
      log(tag, {
        winBounds: win.getBounds(),
        contentSize: win.getContentSize(),
        visible: win.isVisible(),
        display: displayOf(win),
        window: await measure(win.webContents),
        rail: await measure(rail.webContents),
        overlay: await measure(overlay.webContents),
        page: await measure(page.webContents),
        railsViewBounds: railView.getBounds(),
        pageViewBounds: page.getBounds(),
        overlayViewBounds: overlayView.getBounds(),
      })
    }

    await report('start')

    const others = screen.getAllDisplays().filter((d) => d.id !== displayOf(win).id)
    if (!others.length) {
      log('single-display', 'no second display: the cross-display case cannot be measured here')
    }

    for (const target of others) {
      win.setBounds({ x: target.workArea.x + 40, y: target.workArea.y + 40, width: 1200, height: 900 })
      await sleep(1800)
      await report(`moved-visible-to-${target.id}-scale-${target.scaleFactor}`)
    }

    // The app's window is hidden rather than destroyed on close (`keepAliveOnWindowClose`), and
    // shown again later — possibly on another display. Does a renderer that was hidden while the
    // move happened catch up when it is shown?
    const hiddenTarget = others.length ? others[0] : null
    win.hide()
    await sleep(400)
    if (hiddenTarget) {
      win.setBounds({ x: hiddenTarget.workArea.x + 40, y: hiddenTarget.workArea.y + 40, width: 1200, height: 900 })
      await sleep(900)
    }
    win.show()
    await sleep(1200)
    await report(hiddenTarget ? `moved-hidden-shown-on-${hiddenTarget.id}` : 'hidden-shown')

    log('done', { moveResizeEvents: movedEvents })
    await sleep(200)
    app.quit()
  } catch (error) {
    log('fatal', String(error && error.stack ? error.stack : error))
    app.quit()
  }
})
