/**
 * Parking-window display-surface spike — temporary, not part of the app.
 *
 * Question it answers: **does a window that is off every display have a display surface on macOS,
 * and if not, how much of it has to be on a display for one to exist?**
 *
 * The product keeps every browser window the person may not see off every display on purpose
 * (`parkingWindowFor` / `keepOffEveryDisplay` in browser-pane-manager.ts: `frame: false`,
 * `enableLargerThanScreen`, asked for 20_000 DIPs out, landed at the desktop's 16_383 cap). A
 * viewer-created window is parked there from birth, and on one machine `capturePage` refused it
 * with "Current display surface not available for capture" — for the window *and* for the parking
 * window its tab lives in. Earlier measurements do not settle it:
 *
 *   capture-methods.cjs        never-shown → capturePage 0ms error, CDP 98ms own pixels (macOS)
 *   hidden-window-usability.cjs 'parked' row answered 1400×900 — but that window did **not** set
 *                              `enableLargerThanScreen`, so macOS may have brought it back onto a
 *                              display (`constrainFrameRect:toScreen:`), which would make the row a
 *                              measurement of "partly on screen" instead of "off every display"
 *   capture-hidden-frames.cjs  'offscreen' row had 120 frames/2s — but that window was shown **on**
 *                              a display first and then moved out
 *
 * So this one varies one thing only: **the intersection between the window's rectangle and the
 * displays**, from "fully inside" to "1×1 px at a corner" to "touching the edge with no area" to
 * "far outside". Per variant it reports where the window actually landed (macOS may overrule the
 * request), how much of it overlaps a display, `capturePage`, CDP `Page.captureScreenshot`,
 * CDP screencast frames, the page's own rAF, and whether a surface survives `hide()`.
 *
 * Run (from the repo root):
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/parking-surface.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/parking-surface.cjs
 *
 * It writes apps/electron/spike/parking-surface.log line by line (a hang leaves the last line as
 * the answer), keeps a 180s watchdog, and exits by itself.
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const { appendFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

// The app's own switch (`index.ts`): Chromium stops producing frames for a window it counts as
// occluded, which would make "it still paints" a measurement of this spike rather than of the state.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const W = 900
const H = 620
/** How long a `capturePage` may take before "never comes back" is the answer. */
const CAPTURE_TIMEOUT_MS = 1200
/** How long a CDP screenshot may take before the same. */
const CDP_TIMEOUT_MS = 1500
/** Give the window its first frame before asking for a picture of it. */
const SETTLE_MS = 700
/** How long the screencast is counted for. */
const FRAMES_MS = 2000
const WATCHDOG_MS = 180_000

const LOG_PATH = join(__dirname, 'parking-surface.log')
writeFileSync(LOG_PATH, '')
const say = (text) => {
  try { console.log(text) } catch { /* no console attached */ }
  try { appendFileSync(LOG_PATH, text + '\n') } catch { /* a spike's log is a convenience */ }
}
const progress = (message) => say(`SPIKE_STEP ${new Date().toISOString().slice(11, 23)} ${message}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page that reports its own state and counts the frames it is given. */
const PAGE_HTML = (colour) => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:${colour};overflow:hidden}</style></head>
<body><script>
  window.__frames = 0
  ;(function loop(){ window.__frames++; requestAnimationFrame(loop) })()
</script></body></html>`

async function load(wc, colour, label) {
  progress(`load ${label}`)
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`load timed out: ${label}`)), 8000)
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  wc.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(PAGE_HTML(colour))}`).catch(() => {})
  await done
}

const readPage = (wc) => wc.executeJavaScript(`({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  visibility: document.visibilityState, hidden: document.hidden,
  frames: window.__frames,
})`)

async function framesOver(wc, ms) {
  const before = (await readPage(wc)).frames
  await sleep(ms)
  return (await readPage(wc)).frames - before
}

/** How much of `rect` sits on any display, in square DIPs, and on which display. */
function overlap(rect) {
  let best = { area: 0, displayId: null, size: { width: 0, height: 0 } }
  for (const display of screen.getAllDisplays()) {
    const width = Math.min(rect.x + rect.width, display.bounds.x + display.bounds.width)
      - Math.max(rect.x, display.bounds.x)
    const height = Math.min(rect.y + rect.height, display.bounds.y + display.bounds.height)
      - Math.max(rect.y, display.bounds.y)
    const area = Math.max(0, width) * Math.max(0, height)
    if (area > best.area) {
      best = { area, displayId: display.id, size: { width: Math.max(0, width), height: Math.max(0, height) } }
    }
  }
  return best
}

/**
 * `capturePage`, but "never comes back" is a result rather than a hang.
 *
 * The interesting answer is the *shape* of the failure: an immediate refusal means there is no
 * display surface object at all, while no answer at all is what a surface that cannot be copied
 * looks like.
 */
async function capturePageRow(wc) {
  let timer = null
  const noAnswer = new Promise((resolve) => {
    timer = setTimeout(() => resolve('no answer'), CAPTURE_TIMEOUT_MS)
  })
  try {
    const image = await Promise.race([wc.capturePage(), noAnswer])
    if (typeof image === 'string') return image
    const size = image.getSize()
    return size.width > 0 && size.height > 0 ? `answered ${size.width}x${size.height}` : `answered ${size.width}x${size.height} (empty)`
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Chromium's own screenshot — the path that does not need a display surface. */
async function cdpScreenshotRow(wc) {
  try { await wc.debugger.attach('1.3') } catch { /* already attached */ }
  const shot = wc.debugger.sendCommand('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    fromSurface: true,
  })
  // A command that answers after the bound is not this call's answer anymore.
  shot.catch(() => {})
  let timer = null
  const noAnswer = new Promise((resolve) => {
    timer = setTimeout(() => resolve('no answer'), CDP_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([shot, noAnswer])
    if (typeof result === 'string') return result
    const data = result?.data
    if (typeof data !== 'string' || data.length === 0) return 'answered without data'
    return `answered ${Buffer.from(data, 'base64').length} bytes`
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Frames a CDP screencast delivers over `ms` — the stream path, which is a different sink. */
async function screencastFrames(wc, ms) {
  let frames = 0
  const onMessage = (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return
    frames += 1
    wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  }
  try { await wc.debugger.attach('1.3') } catch { /* already attached */ }
  wc.debugger.on('message', onMessage)
  try {
    await wc.debugger.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      everyNthFrame: 1,
    })
    await sleep(ms)
  } finally {
    wc.debugger.sendCommand('Page.stopScreencast').catch(() => {})
    wc.debugger.removeListener('message', onMessage)
  }
  return frames
}

/**
 * One window in one position, measured. Every variant is its own window: a window that has been
 * shown once is not the same question as one that has never been shown, and the point is to keep
 * the two apart.
 */
async function measure(label, requested, options, colour) {
  progress(`variant ${label} requested=${requested.x},${requested.y}`)
  const win = new BrowserWindow({
    x: requested.x,
    y: requested.y,
    width: W,
    height: H,
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    ...options,
  })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  win.contentView.addChildView(view)
  await load(view.webContents, colour, label)
  win.showInactive()
  await sleep(SETTLE_MS)

  const landed = win.getBounds()
  const row = {
    label,
    requested,
    landed,
    movedByTheDesktop: landed.x !== requested.x || landed.y !== requested.y,
    sizeChanged: landed.width !== W || landed.height !== H,
    overlap: overlap(landed),
    visible: win.isVisible(),
    page: await readPage(view.webContents),
    framesOver700ms: await framesOver(view.webContents, 700),
    capturePage: await capturePageRow(view.webContents),
    cdpScreenshot: await cdpScreenshotRow(view.webContents),
    screencastFrames: await screencastFrames(view.webContents, FRAMES_MS),
  }

  // Does the surface survive being hidden? On macOS `hidden-after-show` answered in 3–12ms in
  // `capture-methods.cjs`, which would make "show it once, then keep it away" a usable strategy.
  win.hide()
  await sleep(400)
  row.capturePageAfterHide = await capturePageRow(view.webContents)
  win.showInactive()
  await sleep(400)
  row.capturePageAfterShowAgain = await capturePageRow(view.webContents)

  say('SPIKE_ROW ' + JSON.stringify(row))
  return { row, win }
}

app.whenReady().then(async () => {
  setTimeout(() => {
    say('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, WATCHDOG_MS)

  const displays = screen.getAllDisplays()
  say('SPIKE_DISPLAYS ' + JSON.stringify(displays.map((display) => ({
    id: display.id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id,
  }))))

  const d = screen.getPrimaryDisplay().bounds
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const top = Math.min(...displays.map((display) => display.bounds.y))

  // `enableLargerThanScreen` is what the product sets; `offscreen-legacy` is the same spot without
  // it, which is the window the earlier 'parked' row measured (macOS may have pulled that one back
  // onto a display — `landed` answers whether it did).
  const variants = [
    ['onscreen-control', { x: d.x + 40, y: d.y + 40 }, {}, '#115588'],
    ['offscreen-product', { x: right + 20000, y: top }, { enableLargerThanScreen: true }, '#445566'],
    ['offscreen-legacy', { x: right + 20000, y: top }, {}, '#445566'],
    // Touching a corner of the primary display with **no** shared pixel: 0 px on screen.
    ['edge-0px-tl', { x: d.x - W, y: d.y - H }, { enableLargerThanScreen: true }, '#336633'],
    ['edge-0px-tr', { x: d.x + d.width, y: d.y - H }, { enableLargerThanScreen: true }, '#336633'],
    ['edge-0px-bl', { x: d.x - W, y: d.y + d.height }, { enableLargerThanScreen: true }, '#336633'],
    ['edge-0px-br', { x: d.x + d.width, y: d.y + d.height }, { enableLargerThanScreen: true }, '#336633'],
    // Exactly **1×1 px** of the window inside the display, at each corner.
    ['corner-1px-tl', { x: d.x - W + 1, y: d.y - H + 1 }, { enableLargerThanScreen: true }, '#663333'],
    ['corner-1px-tr', { x: d.x + d.width - 1, y: d.y - H + 1 }, { enableLargerThanScreen: true }, '#663333'],
    ['corner-1px-bl', { x: d.x - W + 1, y: d.y + d.height - 1 }, { enableLargerThanScreen: true }, '#663333'],
    ['corner-1px-br', { x: d.x + d.width - 1, y: d.y + d.height - 1 }, { enableLargerThanScreen: true }, '#663333'],
  ]

  // Every window is kept until the end: a teardown while others are still measuring takes a shared
  // renderer with it.
  const kept = []
  try {
    for (const [label, spot, options, colour] of variants) {
      const { win } = await measure(label, spot, options, colour)
      kept.push(win)
      await sleep(200)
    }
    say('SPIKE_DONE')
    for (const win of kept) {
      if (!win.isDestroyed()) win.destroy()
    }
    app.exit(0)
  } catch (error) {
    say('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
