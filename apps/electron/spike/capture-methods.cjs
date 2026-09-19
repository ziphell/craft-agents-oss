/**
 * Screenshot-methods spike — temporary, not part of the app.
 *
 * Question it answers: **the window is hidden, and the tab we want is not the one on
 * top — which capture path still returns that tab's pixels, and which one just never
 * comes back?** The app's screenshot takes `tabView.webContents` and (per the report)
 * only ever finds pixels once the window is up *and* that tab is the one on screen;
 * this measures the candidates side by side, per window state:
 *
 *   capturePage-hidden   `capturePage(undefined, { stayHidden: true, stayAwake: true })`,
 *                        which is what `capturePageWithRecovery` tries first
 *   capturePage-plain    `capturePage()` with no options
 *   cdp-screenshot       `Page.captureScreenshot` over `webContents.debugger`, which is how
 *                        DevTools and Puppeteer take a shot of a tab nobody is looking at
 *
 * and, for a covered tab, three more: what the shot looks like after the app's current
 * rescue (`showInactive` + a paint delay), after the same delay with a `capturePage`, and
 * after raising that tab's view over the other one.
 *
 * Three window states, because a `show: false` window is not the same thing as one that
 * was on screen and then hidden — the plan's `hidden-after-show`, for which the rescue
 * exists at all:
 *
 *   visible              shown, and left shown
 *   hidden-after-show    shown once, then `hide()` — the app's case
 *   never-shown          never shown (a window created for background work)
 *
 * Every call is raced against a timeout, so "never comes back" is a result rather than a
 * hang. Timings are reported: a path that takes seconds is not a path to put on the
 * screenshot command's critical path.
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/capture-methods.cjs
 *      (from the repo root)
 */
const { app, BrowserWindow, WebContentsView, nativeImage, screen } = require('electron')

const W = 600
const H = 420
const TIMEOUT_MS = 2500
const PAINT_DELAY_MS = 180

const CAPTURE_PAGE_OPTS = { stayHidden: true, stayAwake: true }

const results = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const progress = (message) => console.log(`SPIKE_STEP ${new Date().toISOString().slice(11, 23)} ${message}`)

/** A page that paints one solid colour, so a captured pixel says which page it is. */
function pageHtml(color, label) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:${color};overflow:hidden}</style></head>
<body><script>
  window.__label = ${JSON.stringify(label)};
  window.__probe = function () {
    return {
      label: window.__label,
      visibility: document.visibilityState,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  };
</script></body></html>`
}

/**
 * Load a data URL and wait for the document, not for `loadURL`'s promise: that promise
 * rejects with `ERR_FAILED` on a renderer a neighbouring window's teardown happens to
 * share, while the document is there and usable.
 */
async function load(wc, color, label) {
  const url = `data:text/html;charset=UTF-8,${encodeURIComponent(pageHtml(color, label))}`
  progress(`load ${label}`)
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`load timed out: ${label}`)), 8000)
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  wc.loadURL(url).catch(() => {})
  await done
  progress(`loaded ${label}`)
}

/** BGRA at the centre of an image, and whether it is the colour we asked for. */
function centrePixel(image, expectedBgra) {
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return { size: `${size.width}x${size.height}`, verdict: 'empty' }
  const bitmap = image.toBitmap()
  if (!bitmap || bitmap.length < 4) return { size: `${size.width}x${size.height}`, verdict: 'no-bitmap' }
  const x = Math.floor(size.width / 2)
  const y = Math.floor(size.height / 2)
  const i = (y * size.width + x) * 4
  const bgra = [bitmap[i], bitmap[i + 1], bitmap[i + 2], bitmap[i + 3]]
  const matches = expectedBgra.every((channel, index) => Math.abs(channel - bgra[index]) <= 10)
  return { size: `${size.width}x${size.height}`, bgra, verdict: matches ? 'own-pixels' : 'WRONG-colour' }
}

/** Run a capture, race it against a timeout, and describe what came back — or that nothing did. */
async function attempt(label, run, expectedBgra) {
  const started = Date.now()
  progress(`→ ${label}`)
  const timeout = Symbol('timeout')
  let timer
  try {
    const outcome = await Promise.race([
      run().then((value) => ({ value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), TIMEOUT_MS) }),
    ])
    const ms = Date.now() - started
    if (outcome === timeout) return { method: label, verdict: 'TIMED-OUT', ms }
    const image = outcome.value
    if (!image) return { method: label, verdict: 'null-image', ms }
    if (typeof image.isEmpty === 'function' && image.isEmpty()) return { method: label, verdict: 'empty', ms }
    return { method: label, ms, ...centrePixel(image, expectedBgra) }
  } catch (error) {
    return { method: label, verdict: 'error', ms: Date.now() - started, detail: String(error && error.message ? error.message : error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `Page.captureScreenshot` on that tab's own debugger — no window, no view stack. */
async function cdpScreenshot(wc) {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  const shot = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
  return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'))
}

/**
 * One window with two tabs: a covered one under an on-top one, at full bounds each —
 * the app's shape (`attachTab` + `raiseActiveTab`), minus everything else.
 */
async function makeTabbedWindow(state, workArea) {
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

  const covered = new WebContentsView({ webPreferences: { backgroundThrottling: true } })
  const onTop = new WebContentsView({ webPreferences: { backgroundThrottling: true } })
  win.contentView.addChildView(covered)
  win.contentView.addChildView(onTop)
  covered.setBounds({ x: 0, y: 0, width: W, height: H })
  onTop.setBounds({ x: 0, y: 0, width: W, height: H })

  await Promise.all([
    load(covered.webContents, '#ff0000', state + ' • covered tab'),
    load(onTop.webContents, '#0000ff', state + ' • tab on top'),
  ])

  if (state !== 'never-shown') {
    win.showInactive()
    await sleep(300)
    if (state === 'hidden-after-show') win.hide()
  }

  return { win, covered, onTop }
}

async function measureTab(state, where, view, expectedBgra, win, covered, onTop) {
  const wc = view.webContents
  const row = { scenario: state, tab: where, methods: [] }

  try {
    row.probe = await wc.executeJavaScript('window.__probe && window.__probe()')
  } catch (error) {
    row.probe = { error: String(error && error.message ? error.message : error) }
  }
  row.isPainting = typeof wc.isPainting === 'function' ? wc.isPainting() : undefined

  // Started once and shared with `attempt`: if it settles only after the timeout, the
  // rejection still has a handler and the run continues.
  const stickyHidden = wc.capturePage(undefined, CAPTURE_PAGE_OPTS)
  stickyHidden.catch(() => {})
  row.methods.push(await attempt('capturePage-hidden', () => stickyHidden, expectedBgra))
  row.methods.push(await attempt('capturePage-plain', () => wc.capturePage(), expectedBgra))
  row.methods.push(await attempt('cdp-screenshot', () => cdpScreenshot(wc), expectedBgra))

  if (where === 'covered') {
    const wasVisible = win.isVisible()
    // What the app's rescue does today: reveal the window, wait for a paint, shoot again.
    if (!wasVisible) {
      win.showInactive()
      await sleep(PAINT_DELAY_MS)
    }
    row.afterRevealCdp = await attempt('cdp-screenshot', () => cdpScreenshot(wc), expectedBgra)
    row.afterReveal = await attempt('capturePage-hidden', () => wc.capturePage(undefined, CAPTURE_PAGE_OPTS), expectedBgra)
    if (!wasVisible) win.hide()
    await sleep(PAINT_DELAY_MS)

    // And what raising this tab's view over the other one does, with no reveal at all.
    win.contentView.addChildView(view)
    row.afterRaise = await attempt('capturePage-hidden', () => wc.capturePage(undefined, CAPTURE_PAGE_OPTS), expectedBgra)
    // Back to on-top-last, so the next measurement starts from the app's stacking.
    win.contentView.addChildView(onTop)
    covered.setBounds({ x: 0, y: 0, width: W, height: H })
    onTop.setBounds({ x: 0, y: 0, width: W, height: H })
  }

  results.push(row)
}

app.whenReady().then(async () => {
  // A stall anywhere above is a result; the watch ends the run rather than the shell's.
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, 90000)

  try {
    const workArea = screen.getPrimaryDisplay().workArea
    const states = ['visible', 'hidden-after-show', 'never-shown']

    // All three windows up front and kept alive: a teardown while other windows are
    // still measuring can take a shared renderer down with it.
    const windows = []
    for (const state of states) {
      progress(`window ${state}`)
      windows.push({ state, ...(await makeTabbedWindow(state, workArea)) })
    }
    await sleep(300)

    for (const { state, win, covered, onTop } of windows) {
      progress(`measure ${state} • covered`)
      await measureTab(state, 'covered', covered, [0, 0, 255, 255], win, covered, onTop)
      progress(`measure ${state} • on-top`)
      await measureTab(state, 'on-top', onTop, [255, 0, 0, 255], win, covered, onTop)
    }

    console.log('SPIKE_JSON ' + JSON.stringify(windows.map(({ state, win }) => ({ state, windowVisible: win.isVisible() }))))
    console.log('SPIKE_JSON ' + JSON.stringify(results))

    console.log('\nscenario            tab      vis      painting  method                                 verdict        time')
    for (const row of results) {
      for (const method of row.methods) line(row, method)
      for (const [key, method] of [['after reveal', row.afterReveal], ['after reveal (cdp)', row.afterRevealCdp], ['raised to top', row.afterRaise]]) {
        if (method) line(row, { ...method, method: key })
      }
    }

    for (const { win } of windows) {
      if (!win.isDestroyed()) win.destroy()
    }
    app.quit()
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})

function line(row, method) {
  const detail = method.detail ? ` ${method.detail}` : method.bgra ? ` ${JSON.stringify(method.bgra)} ${method.size}` : ''
  console.log(
    `${row.scenario.padEnd(19)} ${row.tab.padEnd(8)} ${String((row.probe && row.probe.visibility) ?? '-').padEnd(8)} ${String(row.isPainting).padEnd(9)} ${String(method.method).padEnd(38)} ${String(method.verdict).padEnd(13)} ${String(method.ms ?? '-').padStart(5)}ms${detail}`,
  )
}
