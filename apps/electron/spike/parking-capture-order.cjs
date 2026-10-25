/**
 * Parking-window capture *order* spike — temporary, not part of the app.
 *
 * Question: the app's own log shows a `browser_screenshot` succeeding on a tab that lives in a
 * parking window at 21440,0 that has never been on a display — while `parking-surface.cjs` measured
 * `capturePage` refusing that exact window. What is different? The candidates are the call itself
 * (`capturePage` with `{stayHidden, stayAwake}`, which `capturePageImage` passes on its in-place
 * branch) and the calls before it (any CDP traffic — an attach, an `evaluate`, a screenshot).
 *
 * So this measures, on ONE parking window, in this order, reporting each step:
 *   A capturePage()                     plain, nothing has touched the page yet
 *   B capturePage({stayHidden,stayAwake})  what the app's first attempt passes
 *   C Page.captureScreenshot (CDP)
 *   D capturePage()                     again — did C leave a surface behind?
 *   E Page.startScreencast for 2s       an *animating* page, so frames have something to say
 *   F capturePage()                     after the screencast
 *
 * E is the measurement `parking-surface.cjs` could not make: its page was a solid colour, so a
 * static page and a window with no compositor both read as "1 frame".
 *
 * Run (from the repo root):
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/parking-capture-order.cjs
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const { appendFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const W = 900
const H = 620
const CAPTURE_TIMEOUT_MS = 1200
const CDP_TIMEOUT_MS = 1500
const SETTLE_MS = 700
const FRAMES_MS = 2000
const WATCHDOG_MS = 90_000

const LOG_PATH = join(__dirname, 'parking-capture-order.log')
writeFileSync(LOG_PATH, '')
const say = (text) => {
  try { console.log(text) } catch { /* no console attached */ }
  try { appendFileSync(LOG_PATH, text + '\n') } catch { /* a spike's log is a convenience */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page that keeps changing, so a working compositor has something to send. */
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;width:100%;height:100%;background:#225;overflow:hidden}
  #box{position:absolute;top:0;left:0;width:220px;height:220px;background:#e33;
       animation:slide 0.6s linear infinite alternate}
  @keyframes slide{from{transform:translateX(0)}to{transform:translateX(660px)}}
  #tick{color:#fff;font:16px monospace;padding:12px}
</style></head>
<body><div id="box"></div><div id="tick">0</div><script>
  window.__frames = 0
  ;(function loop(){ window.__frames++; requestAnimationFrame(loop) })()
  window.__ticks = 0
  setInterval(() => { window.__ticks++; document.getElementById('tick').textContent = String(window.__ticks) }, 100)
</script></body></html>`

async function load(wc, label) {
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`load timed out: ${label}`)), 8000)
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  wc.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(PAGE_HTML)}`).catch(() => {})
  await done
}

async function capturePageRow(webContents, options) {
  let timer = null
  const noAnswer = new Promise((resolve) => { timer = setTimeout(() => resolve('no answer'), CAPTURE_TIMEOUT_MS) })
  try {
    const image = await Promise.race([webContents.capturePage(undefined, options), noAnswer])
    if (typeof image === 'string') return image
    const size = image.getSize()
    return size.width > 0 && size.height > 0 ? `answered ${size.width}x${size.height}` : `answered ${size.width}x${size.height} (empty)`
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function cdpScreenshotRow(webContents) {
  try { await webContents.debugger.attach('1.3') } catch { /* already attached */ }
  const shot = webContents.debugger.sendCommand('Page.captureScreenshot', {
    format: 'jpeg', quality: 80, fromSurface: true,
  })
  shot.catch(() => {})
  let timer = null
  const noAnswer = new Promise((resolve) => { timer = setTimeout(() => resolve('no answer'), CDP_TIMEOUT_MS) })
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

async function screencastFrames(webContents, ms) {
  let frames = 0
  const onMessage = (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return
    frames += 1
    webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  }
  try { await webContents.debugger.attach('1.3') } catch { /* already attached */ }
  webContents.debugger.on('message', onMessage)
  try {
    await webContents.debugger.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 60, everyNthFrame: 1 })
    await sleep(ms)
  } catch (error) {
    return `start refused: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    webContents.debugger.sendCommand('Page.stopScreencast').catch(() => {})
    webContents.debugger.removeListener('message', onMessage)
  }
  return frames
}

const readPage = (wc) => wc.executeJavaScript(`({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  visibility: document.visibilityState, hidden: document.hidden,
  frames: window.__frames, ticks: window.__ticks,
})`)

app.whenReady().then(async () => {
  setTimeout(() => {
    say('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, WATCHDOG_MS)

  const displays = screen.getAllDisplays()
  const d = screen.getPrimaryDisplay().bounds
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const top = Math.min(...displays.map((display) => display.bounds.y))
  // The product's own spot: `offscreenSpot` asks for right + OFFSCREEN_PARK_MARGIN (20_000).
  const spot = { x: right + 20000, y: top }

  say('SPIKE_DISPLAYS ' + JSON.stringify(displays.map((display) => ({ id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor }))))
  say(`SPIKE_SPOT ${spot.x},${spot.y}`)

  try {
    const win = new BrowserWindow({
      x: spot.x,
      y: spot.y,
      width: W,
      height: H,
      show: false,
      frame: false,
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
    })
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    view.setBounds({ x: 0, y: 0, width: W, height: H })
    win.contentView.addChildView(view)
    await load(view.webContents, 'parking')
    // The parking window is shown, never activated — exactly `parkingWindowFor`.
    win.showInactive()
    await sleep(SETTLE_MS)

    const wc = view.webContents
    const row = {
      landed: win.getBounds(),
      visible: win.isVisible(),
      pageBefore: await readPage(wc),
    }
    row.a_plain = await capturePageRow(wc, undefined)
    row.b_stayHidden = await capturePageRow(wc, { stayHidden: true, stayAwake: true })
    row.c_cdp = await cdpScreenshotRow(wc)
    row.d_plainAfterCdp = await capturePageRow(wc, undefined)
    row.e_screencast = await screencastFrames(wc, FRAMES_MS)
    row.pageAfter = await readPage(wc)
    row.f_plainAfterScreencast = await capturePageRow(wc, undefined)

    // Does the priming belong to the window or to the view? A second view added to the same (now
    // primed) window answers whether a tab parked later is covered for free, and `hide()` answers
    // whether it survives the window going away and coming back.
    const second = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    second.setBounds({ x: 0, y: 0, width: W, height: H })
    win.contentView.addChildView(second)
    await load(second.webContents, 'second')
    await sleep(400)
    row.g_secondViewPlain = await capturePageRow(second.webContents, undefined)
    row.secondViewPage = await readPage(second.webContents)
    win.hide()
    await sleep(400)
    row.h_afterHidePlain = await capturePageRow(wc, undefined)
    win.showInactive()
    await sleep(400)
    row.i_afterShowAgainPlain = await capturePageRow(wc, undefined)
    say('SPIKE_ROW ' + JSON.stringify(row))

    // Second window, untouched by the first: is a *plain* CDP command (the `Runtime.evaluate` the
    // app's own screenshot runs first, `getViewportMetrics`) enough to prime the surface, or does it
    // take `Page.captureScreenshot`?
    const win2 = new BrowserWindow({
      x: spot.x, y: spot.y, width: W, height: H, show: false, frame: false,
      enableLargerThanScreen: true, alwaysOnTop: true, skipTaskbar: true,
    })
    const view2 = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    view2.setBounds({ x: 0, y: 0, width: W, height: H })
    win2.contentView.addChildView(view2)
    await load(view2.webContents, 'parking-2')
    win2.showInactive()
    await sleep(SETTLE_MS)

    const wc2 = view2.webContents
    const row2 = { landed: win2.getBounds(), pageBefore: await readPage(wc2) }
    try { await wc2.debugger.attach('1.3') } catch { /* already attached */ }
    row2.g_afterEvaluate = 'evaluate failed'
    try {
      await wc2.debugger.sendCommand('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true })
      row2.g_afterEvaluate = await capturePageRow(wc2, undefined)
    } catch (error) {
      row2.g_afterEvaluate = `evaluate refused: ${error instanceof Error ? error.message : String(error)}`
    }
    row2.pageAfterEvaluate = await readPage(wc2)
    row2.h_afterCdpShot = await cdpScreenshotRow(wc2)
    row2.i_plainAfterCdp = await capturePageRow(wc2, undefined)
    row2.pageAfter = await readPage(wc2)
    say('SPIKE_ROW2 ' + JSON.stringify(row2))

    say('SPIKE_DONE')
    win2.destroy()
    win.destroy()
    app.exit(0)
  } catch (error) {
    say('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
