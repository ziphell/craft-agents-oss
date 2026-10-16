/**
 * Hidden/minimized window usability spike — temporary, not part of the app.
 *
 * Question it answers: **a window is not on screen — is a view still *inside* it (not parked) still
 * usable, or is the parking window needed for more than a screenshot?** `capture-methods.cjs`
 * measured the *shot* (`capturePage` answers for a hidden window on macOS, nothing on Windows) and
 * `background-viewport.ts` measured a view *outside its window's rectangle*. Neither measured a view
 * left inside a window that is hidden or minimized — which is exactly where `tabHome` puts the tab on
 * macOS (`hasBeenShown && canCaptureHiddenWindows`). So this measures the rest of what automation
 * needs, per state:
 *
 *   usable      does the page keep a viewport (a view `setBounds` → `innerWidth` and a `resize`),
 *               does it paint, does `executeJavaScript` run, does CDP input land at the page's own
 *               coordinates, does `capturePage` answer
 *   resizable   `viewport-resize`'s two branches — the window (the person's window is the tab's, so
 *               the window is grown) against the tab's own view. Today the window branch is refused
 *               for a minimized window (`windowHasSize`: `isMinimized()`), and the refusal is silent:
 *               `viewport-resize` still answers with the viewport it *asked* for.
 *
 * Window states, as in `capture-methods.cjs`:
 *
 *   visible              shown, and left shown
 *   minimized            shown once, then `minimize()`
 *   hidden-after-show    shown once, then `hide()`
 *   never-shown          never shown
 *   parked               shown and off every display — what the parking window is, the baseline
 *
 * Every call is raced against a timeout, so "never comes back" is a result rather than a hang.
 *
 * Run (from the repo root):
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/hidden-window-usability.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/hidden-window-usability.cjs
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const { appendFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

// The app's own switch (`index.ts`): Chromium stops producing frames for a window it counts as
// occluded, which would make "it still paints" a measurement of this spike rather than of the state.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const W = 900
const H = 620
const WANTED = { width: 1400, height: 900 }   // what `viewport-resize 1400 900` asks for
/** Chrome the window keeps, so `pageAreaBounds` is the wanted size when the window holds it. */
const INSETS = { left: 60, right: 20, top: 60, bottom: 20 }
const TIMEOUT_MS = 1200
const PAINT_MS = 700

const LOG_PATH = join(__dirname, 'hidden-window-usability.log')
writeFileSync(LOG_PATH, '')
const say = (text) => {
  try { console.log(text) } catch { /* no console attached */ }
  try { appendFileSync(LOG_PATH, text + '\n') } catch { /* a spike's log is a convenience */ }
}
const progress = (message) => say(`SPIKE_STEP ${new Date().toISOString().slice(11, 23)} ${message}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page that reports its own layout, and counts clicks on one box. */
const PAGE_HTML = (colour) => `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:${colour};overflow:hidden}</style></head>
<body><div id="target" style="position:absolute;left:120px;top:80px;width:180px;height:60px;background:#111"></div>
<script>
  window.__resizes = 0; window.__frames = 0; window.__clicks = 0
  window.addEventListener('resize', () => { window.__resizes++ })
  document.getElementById('target').addEventListener('click', () => { window.__clicks++ })
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

/** What the page believes about itself, in one round trip. */
const readPage = (wc) => wc.executeJavaScript(`({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  visibility: document.visibilityState, hidden: document.hidden,
  resizes: window.__resizes, frames: window.__frames, clicks: window.__clicks,
})`)

async function framesOver(wc, ms) {
  const before = (await readPage(wc)).frames
  await sleep(ms)
  return (await readPage(wc)).frames - before
}

/** A CDP click at the box the page itself says is at {120,80}. */
async function clickThePagesOwnTarget(wc) {
  try { await wc.debugger.attach('1.3') } catch { /* already attached */ }
  const box = await wc.executeJavaScript('(() => { const r = document.getElementById("target").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()')
  const x = box.x + box.w / 2
  const y = box.y + box.h / 2
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(200)
  return (await readPage(wc)).clicks
}

async function captureInPlace(wc) {
  try {
    return await Promise.race([
      wc.capturePage().then((image) => `answered ${image.getSize().width}x${image.getSize().height}`),
      sleep(TIMEOUT_MS).then(() => 'no answer'),
    ])
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** One window with one view in it, put into `state`, then measured. */
async function measureUsable(state, colour, spot) {
  const win = new BrowserWindow({ ...spot, width: W, height: H, show: false, frame: false, skipTaskbar: true })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  win.contentView.addChildView(view)
  await load(view.webContents, colour, state)
  if (state !== 'never-shown') {
    win.showInactive()
    await sleep(PAINT_MS)
    if (state === 'minimized') { win.minimize(); await sleep(1200) }
    if (state === 'hidden-after-show') { win.hide(); await sleep(PAINT_MS) }
  }

  const wc = view.webContents
  const row = { scenario: state }
  row.before = await readPage(wc)
  row.framesOver700ms = await framesOver(wc, PAINT_MS)

  // The page's viewport, and whether its own `resize` follows a view `setBounds` — the primitive
  // every other measurement rests on.
  const resizesBefore = row.before.resizes
  view.setBounds({ x: 0, y: 0, ...WANTED })
  await sleep(PAINT_MS)
  row.afterTheViewWasGivenAWantedSize = {
    viewBounds: view.getBounds(),
    innerWidth: (await readPage(wc)).innerWidth,
    resizesCaused: (await readPage(wc)).resizes - resizesBefore,
  }

  row.executeJavaScriptRan = true
  row.cdpClickAtThePagesOwnCoordinates = await clickThePagesOwnTarget(wc)
  row.capturePage = await captureInPlace(wc)
  row.windowAtEnd = { visible: win.isVisible(), minimized: win.isMinimized() }

  say('SPIKE_ROW ' + JSON.stringify(row))
  return { row, win }
}

/**
 * `viewport-resize`'s window branch, per the rule the manager uses — `rule: 'today'` is
 * `windowHasSize` as it is (a minimized window is refused outright), `rule: 'reported-size'` asks
 * only whether the window reports a size.
 */
async function measureResize(state, colour, rule) {
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, skipTaskbar: true })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  win.contentView.addChildView(view)
  await load(view.webContents, colour, `${state} (${rule})`)
  win.showInactive()
  await sleep(PAINT_MS)
  if (state === 'minimized') { win.minimize(); await sleep(1200) }
  if (state === 'hidden-after-show') { win.hide(); await sleep(PAINT_MS) }

  const wc = view.webContents
  const before = await readPage(wc)

  win.setContentSize(WANTED.width + INSETS.left + INSETS.right, WANTED.height + INSETS.top + INSETS.bottom)
  const [width, height] = win.getContentSize()
  const canLayOut = rule === 'today'
    ? !win.isMinimized() && width > 0 && height > 0
    : width > 0 && height > 0
  if (canLayOut) view.setBounds({ x: 0, y: 0, ...WANTED })
  await sleep(PAINT_MS)

  const after = win.getContentSize()
  const row = {
    scenario: `${state} (${rule})`,
    laidOut: canLayOut,
    windowContentSize: after,
    viewBounds: view.getBounds(),
    // what `resizeViewport` answers with: `pageAreaBounds`, the window's content minus the chrome
    answersWith: { width: Math.max(0, after[0] - INSETS.left - INSETS.right), height: Math.max(0, after[1] - INSETS.top - INSETS.bottom) },
    pageActuallyHas: await readPage(wc),
    pageWantedIt: before.innerWidth,
  }
  say('SPIKE_ROW ' + JSON.stringify(row))
  return { row, win }
}

/**
 * Which events a window actually fires, and what the manager's own flag would read — because
 * `tabHome` does not use `isVisible()`: it uses a flag set from `show`/`hide` alone
 * (`instance.isVisible`). Whether a **minimize** reaches that flag is the platform's business, and
 * the two do not agree: measured on macOS, `minimize()` fires `minimize` and then `hide` a few ms
 * later, so the flag goes false; on Windows the same question is open, and it decides which branch
 * of `tabHome` a minimized window's tab takes (and therefore whether `viewport-resize` can land).
 *
 * Also measured here: our own `hide()` on a window that is *already* minimized — whether a second
 * `hide` arrives, and what `isMinimized()` says, which is what any "a minimize is not a hide" guard
 * would have to key on.
 */
async function measureWindowEvents() {
  const startedAt = Date.now()
  const trace = (win, label) => {
    const events = []
    // The manager's flag, mirrored: `show` sets it, `hide` clears it, nothing else touches it.
    let flagIsVisible = false
    let flagHasBeenShown = false
    const record = (name) => events.push({
      step: label,
      event: name,
      atMs: Date.now() - startedAt,
      isMinimized: win.isMinimized(),
      isVisible: win.isVisible(),
      flagIsVisible,
      flagHasBeenShown,
    })
    win.on('show', () => { flagIsVisible = true; flagHasBeenShown = true; record('show') })
    win.on('hide', () => { flagIsVisible = false; record('hide') })
    for (const name of ['minimize', 'restore', 'blur', 'focus']) win.on(name, () => record(name))
    return events
  }

  const window = new BrowserWindow({ width: W, height: H, show: false, frame: false, skipTaskbar: true })
  const events = trace(window, 'a window a person puts aside')
  window.showInactive()
  await sleep(700)
  // The question: does minimizing reach the flag the manager keeps?
  window.minimize()
  await sleep(1200)
  window.restore()
  await sleep(1200)
  const afterRestore = { isMinimized: window.isMinimized(), isVisible: window.isVisible() }

  // …and the second question: our own `hide()` on a window that is already minimized.
  const other = new BrowserWindow({ width: W, height: H, show: false, frame: false, skipTaskbar: true })
  const otherEvents = trace(other, 'our own hide() while minimized')
  other.showInactive()
  await sleep(700)
  other.minimize()
  await sleep(1200)
  const theTrailBeforeOurHide = otherEvents.length
  other.hide()
  await sleep(1200)
  const afterOurOwnHide = { isMinimized: other.isMinimized(), isVisible: other.isVisible(), hidesFromOurOwnHide: otherEvents.length - theTrailBeforeOurHide }

  const row = {
    scenario: 'window events',
    minimizeReachesTheFlag: events.some((entry) => entry.event === 'hide'),
    afterRestore,
    ourOwnHideWhileMinimized: afterOurOwnHide,
    trail: events,
    trailOfOurOwnHide: otherEvents,
  }
  say('SPIKE_ROW ' + JSON.stringify(row))
  return { row, win: window, other }
}

app.whenReady().then(async () => {
  setTimeout(() => {
    say('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, 120000)

  const workArea = screen.getPrimaryDisplay().workArea
  const displays = screen.getAllDisplays()
  const parkedSpot = {
    x: Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)) + 4000,
    y: Math.min(...displays.map((display) => display.bounds.y)),
  }

  // Every window is kept until the end: a teardown while others are still measuring takes a shared
  // renderer with it.
  const kept = []
  const usable = []
  const resize = []
  let events = null

  try {
    for (const [state, colour] of [
      ['visible', '#115588'],
      ['minimized', '#553311'],
      ['hidden-after-show', '#338855'],
      ['never-shown', '#883355'],
      ['parked', '#5588aa'],
    ]) {
      progress(`usable • ${state}`)
      const spot = state === 'parked'
        ? { x: parkedSpot.x, y: parkedSpot.y }
        : { x: workArea.x + 20, y: workArea.y + 20 }
      // The parked state is the same build, only shown off every display.
      const { row, win } = await measureUsable(state, colour, spot)
      usable.push(row)
      kept.push(win)
      await sleep(200)
    }

    for (const [state, colour] of [
      ['visible', '#115588'],
      ['minimized', '#553311'],
      ['hidden-after-show', '#338855'],
    ]) {
      for (const rule of ['today', 'reported-size']) {
        progress(`resize • ${state} • ${rule}`)
        const { row, win } = await measureResize(state, colour, rule)
        resize.push(row)
        kept.push(win)
        await sleep(200)
      }
    }

    progress('window events • does a minimize reach the flag the manager keeps?')
    const measured = await measureWindowEvents()
    events = measured.row
    kept.push(measured.win, measured.other)

    say('SPIKE_JSON ' + JSON.stringify({ usable, resize, events }, null, 1))
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
