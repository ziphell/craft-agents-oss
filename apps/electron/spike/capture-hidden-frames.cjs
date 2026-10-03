/**
 * Hidden-tab continuous capture spike — temporary, not part of the app.
 *
 * Question it answers: **a tab gets parked (its window goes off every display, or is hidden)
 * — do the two *continuous* capture paths keep delivering frames, and which of them
 * survives?** `capture-methods.cjs` already showed that one-shot shots die when the window
 * is hidden (capturePage and `Page.captureScreenshot` both time out; a reveal fixes both).
 * A recording is not a shot: it needs a stream, and the two candidates are different
 * mechanisms that may not answer the same way:
 *
 *   cdp-screencast   `Page.startScreencast` over `webContents.debugger`. Chromium's own
 *                    remote-viewing stream — the same one DevTools and headless capture
 *                    use — so it is the candidate that *should* cope with a page nobody
 *                    can see. Frames are counted from `Page.screencastFrame`, and each one
 *                    is acked: without the ack Chromium stops after the first frame, so the
 *                    ack is part of the mechanism, not a courtesy.
 *   display-media    `navigator.mediaDevices.getDisplayMedia()`, answered by
 *                    `setDisplayMediaRequestHandler` with the tab's `WebFrameMain` — what
 *                    the person's record button uses today. Frames are counted in the
 *                    renderer with `requestVideoFrameCallback`, which fires per delivered
 *                    frame and says nothing when none arrive.
 *
 * Three window states, because "off the displays" and "hidden" are different states and the
 * app's parking window is the first one:
 *
 *   visible     shown, at the work area's corner — the baseline
 *   offscreen   shown, moved far past every display (what `keepOffEveryDisplay` does)
 *   hidden      `hide()` — the state `capture-methods.cjs` measured the shots dying in
 *
 * and a fourth pass back in `visible`, because the point is not only whether the stream
 * stops but whether it **comes back**.
 *
 * The page repaints on every animation frame (`backgroundThrottling: false`, the setting the
 * app's own tab views use), so "no frames" can only mean the capture stopped — a page that
 * had nothing to paint would make the same measurement say nothing.
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/capture-hidden-frames.cjs
 *      (from the repo root)
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const W = 600
const H = 420
const SAMPLE_MS = 2000
const SETTLE_MS = 400
const OFFSCREEN_MARGIN = 20_000
const LOAD_TIMEOUT_MS = 8000
const WATCHDOG_MS = 120_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const progress = (message) => console.log(`SPIKE_STEP ${new Date().toISOString().slice(11, 23)} ${message}`)

/** A page that repaints every frame, so a frame count is about the capture and nothing else. */
const SUBJECT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head>
<body><script>
  let n = 0
  function paint() {
    n += 1
    document.body.style.background = 'hsl(' + (n % 360) + ' 100% 50%)'
    window.__paints = n
    requestAnimationFrame(paint)
  }
  requestAnimationFrame(paint)
</script></body></html>`

/**
 * The renderer that asks for display media and counts what arrives.
 *
 * Loaded from a file rather than a `data:` URL: `navigator.mediaDevices` needs a potentially
 * trustworthy origin, and an opaque one does not have it.
 */
const HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><script>
  window.__frames = 0
  window.__error = null
  window.__start = async function () {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const video = document.createElement('video')
      video.muted = true
      video.srcObject = stream
      await video.play()
      const tick = () => { window.__frames += 1; video.requestVideoFrameCallback(tick) }
      video.requestVideoFrameCallback(tick)
      window.__track = stream.getVideoTracks()[0].label
      return true
    } catch (error) {
      window.__error = String(error && error.message ? error.message : error)
      return false
    }
  }
  window.__count = function () { return window.__frames }
  window.__reset = function () { window.__frames = 0 }
</script></body></html>`

async function loadHtml(wc, html, label) {
  const file = join(tmpdir(), `craft-spike-${label}-${process.pid}.html`)
  writeFileSync(file, html)
  progress(`load ${label}`)
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`load timed out: ${label}`)), LOAD_TIMEOUT_MS)
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  wc.loadFile(file).catch(() => {})
  await done
  progress(`loaded ${label}`)
}

/** A CDP screencast on that tab's own debugger; returns a counter and a stop. */
async function startScreencast(wc, onFrame) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  wc.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.screencastFrame') return
    onFrame()
    // Acking is what keeps frames coming: Chromium waits for it between frames.
    wc.debugger.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
  })
  await wc.debugger.sendCommand('Page.startScreencast', {
    format: 'jpeg',
    quality: 50,
    everyNthFrame: 1,
  })
}

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, WATCHDOG_MS)

  const workArea = screen.getPrimaryDisplay().workArea
  const rows = []

  try {
    // The subject: one tab view inside a real window, never-throttled like the app's own.
    const win = new BrowserWindow({
      x: workArea.x + 20,
      y: workArea.y + 20,
      width: W,
      height: H,
      frame: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#202020',
    })
    const subject = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    win.contentView.addChildView(subject)
    subject.setBounds({ x: 0, y: 0, width: W, height: H })

    // The host: a second window whose renderer asks for the subject's picture.
    const hostWin = new BrowserWindow({ width: 320, height: 200, show: false })
    hostWin.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
      callback({ video: subject.webContents.mainFrame })
    })

    await Promise.all([
      loadHtml(subject.webContents, SUBJECT_HTML, 'subject'),
      loadHtml(hostWin.webContents, HOST_HTML, 'host'),
    ])

    win.showInactive()
    await sleep(SETTLE_MS)

    let cdpFrames = 0
    await startScreencast(subject.webContents, () => { cdpFrames += 1 })

    const started = await hostWin.webContents.executeJavaScript('window.__start()')
    if (!started) {
      const error = await hostWin.webContents.executeJavaScript('window.__error')
      console.log('SPIKE_NOTE display-media could not start: ' + error)
    }
    await sleep(SETTLE_MS)

    /** Count both mechanisms over one sample, in the window's current state. */
    const sample = async (state) => {
      cdpFrames = 0
      await hostWin.webContents.executeJavaScript('window.__reset()')
      const paintsBefore = await subject.webContents.executeJavaScript('window.__paints')
      await sleep(SAMPLE_MS)
      const paintsAfter = await subject.webContents.executeJavaScript('window.__paints')
      const mediaFrames = await hostWin.webContents.executeJavaScript('window.__count()')
      const row = {
        state,
        cdpFrames,
        mediaFrames,
        paints: (paintsAfter ?? 0) - (paintsBefore ?? 0),
        visibility: await subject.webContents.executeJavaScript('document.visibilityState'),
        windowVisible: win.isVisible(),
      }
      progress(`${state}: cdp=${row.cdpFrames} media=${row.mediaFrames} paints=${row.paints}`)
      rows.push(row)
      return row
    }

    await sample('visible')

    // Off every display, the way the parking window is held off them.
    win.setPosition(workArea.x + OFFSCREEN_MARGIN, workArea.y + OFFSCREEN_MARGIN)
    await sleep(SETTLE_MS)
    await sample('offscreen')

    win.hide()
    await sleep(SETTLE_MS)
    await sample('hidden')

    // Back on screen: the point is not only whether it stopped, but whether it returns.
    win.setPosition(workArea.x + 20, workArea.y + 20)
    win.showInactive()
    await sleep(SETTLE_MS)
    await sample('visible-again')

    await subject.webContents.debugger.sendCommand('Page.stopScreencast').catch(() => {})

    console.log('SPIKE_JSON ' + JSON.stringify(rows))
    console.log('')
    console.log('state          window    page-vis  paints  cdp-screencast  display-media')
    for (const row of rows) {
      console.log(
        `${row.state.padEnd(14)} ${String(row.windowVisible).padEnd(9)} ${String(row.visibility).padEnd(9)} ` +
        `${String(row.paints).padStart(6)}  ${String(row.cdpFrames).padStart(14)}  ${String(row.mediaFrames).padStart(13)}`,
      )
    }
    console.log('')
    console.log(`(each sample is ${SAMPLE_MS}ms; "paints" is the page's own animation frames, so a zero there means nothing was painting at all)`)

    for (const other of [win, hostWin]) {
      if (!other.isDestroyed()) other.destroy()
    }
    app.quit()
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
