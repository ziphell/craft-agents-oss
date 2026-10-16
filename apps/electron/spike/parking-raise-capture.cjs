/**
 * Parking-window "raise instead of build" spike — temporary, not part of the app.
 *
 * Question it answers: **for a shot of a parked tab, can the shared parking window be
 * used as it stands — by raising the target view to the top — instead of building a
 * throwaway window for every shot (`captureWhileParked`)? And how soon after the raise
 * does a capture answer?**
 *
 * The app's shape is reproduced exactly, and the ordering is the part that matters:
 * the parking window is created `show: false` and then **shown** (`showInactive`), and the
 * tab views are added to it **after it is shown** — which is `parkTab`'s path, and the one
 * thing `capture-methods.cjs` did not measure (there both views were in the window *before*
 * it was shown). A view added to an already-shown window and immediately covered is the
 * case the app's comment blames for the throwaway window.
 *
 * Measured, in order:
 *
 *   premise topmost     the topmost parked view, captured where it is — cold (right after
 *                       the views are added) and again once the window has settled
 *   premise covered     a covered parked view, captured where it is — cold and settled
 *   shared-raise        that covered view raised to the top of the shared parking window
 *                       (`addChildView`), sampled at several delays from the raise on
 *   after raise         the view the raise displaced (was composited, now covered)
 *   throwaway-window    the same view handed to a brand-new window built for the shot and
 *                       shown — `captureWhileParked` as it is today, the baseline
 *   hidden-home         a view whose home is a window that was shown and then hidden (the
 *                       tab on screen of a window that is not on screen), moved into the
 *                       parking window
 *
 * Every capture is the app's own call: `capturePage(undefined, { stayHidden: true,
 * stayAwake: true })`, raced against a timeout so "never comes back" is a result rather
 * than a hang. Each result reports the **RGB** centre pixel, so "an image came back" is not
 * mistaken for "the right page came back". The summary at the end is the answer to read:
 * per scenario, the first delay at which the shot came back with its own pixels.
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike/parking-raise-capture.cjs
 *      (from the repo root)
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')

const W = 800
const H = 600
const TIMEOUT_MS = 2500
/** How long the parking window is left to composite once the views are in it. */
const SETTLE_MS = 800
/** Waits (ms) between the move and the capture. Finer at the start, where the frame lands. */
const DELAYS = [0, 4, 8, 16, 24, 32, 48, 96, 300]
/** As far out as the app asks for (`OFFSCREEN_PARK_MARGIN`). The desktop may cap it. */
const OFFSCREEN_MARGIN = 20_000
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
      dpr: window.devicePixelRatio || 1,
    };
  };
</script></body></html>`
}

async function load(wc, color, label) {
  const url = `data:text/html;charset=UTF-8,${encodeURIComponent(pageHtml(color, label))}`
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`load timed out: ${label}`)), 8000)
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  wc.loadURL(url).catch(() => {})
  await done
}

/** The RGB (not BGRA) at the centre of an image, and whether it is the colour we asked for. */
function centrePixel(image, expectedRgb) {
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return { size: `${size.width}x${size.height}`, verdict: 'empty' }
  const bitmap = image.toBitmap()
  if (!bitmap || bitmap.length < 4) return { size: `${size.width}x${size.height}`, verdict: 'no-bitmap' }
  const x = Math.floor(size.width / 2)
  const y = Math.floor(size.height / 2)
  const i = (y * size.width + x) * 4
  const rgb = [bitmap[i + 2], bitmap[i + 1], bitmap[i]]
  const matches = expectedRgb.every((channel, index) => Math.abs(channel - rgb[index]) <= 10)
  return { size: `${size.width}x${size.height}`, rgb, verdict: matches ? 'own-pixels' : 'WRONG-colour' }
}

/**
 * Run one capture, race it against a timeout, and describe what came back — or that nothing
 * did. The run is settled into a value (never a rejection), so a call that answers after the
 * timeout leaves nothing unhandled behind.
 */
async function attempt(run, expectedRgb) {
  const started = Date.now()
  const timeout = Symbol('timeout')
  let timer
  const settled = Promise.resolve().then(() => run()).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  try {
    const outcome = await Promise.race([
      settled,
      new Promise((resolve) => { timer = setTimeout(() => resolve(timeout), TIMEOUT_MS) }),
    ])
    const ms = Date.now() - started
    if (outcome === timeout) return { verdict: 'TIMED-OUT', ms }
    if (!outcome.ok) return { verdict: 'error', ms, detail: String(outcome.error && outcome.error.message ? outcome.error.message : outcome.error) }
    const image = outcome.value
    if (!image) return { verdict: 'null-image', ms }
    if (typeof image.isEmpty === 'function' && image.isEmpty()) return { verdict: 'empty', ms }
    return { ms, ...centrePixel(image, expectedRgb) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The app's own call, on whatever view is asked for. */
const capture = (view, expected) => attempt(() => view.webContents.capturePage(undefined, CAPTURE_PAGE_OPTS), expected)

/** A spot off every display, as `offscreenSpot` picks one. */
function offscreenSpot(size) {
  const displays = screen.getAllDisplays()
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
  const left = Math.min(...displays.map((d) => d.bounds.x))
  const top = Math.min(...displays.map((d) => d.bounds.y))
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  const overlaps = (rect) => displays.some((d) => (
    rect.x < d.bounds.x + d.bounds.width && rect.x + rect.width > d.bounds.x &&
    rect.y < d.bounds.y + d.bounds.height && rect.y + rect.height > d.bounds.y
  ))
  const candidates = [
    { x: right + OFFSCREEN_MARGIN, y: top },
    { x: left - OFFSCREEN_MARGIN - size.width, y: top },
    { x: left, y: bottom + OFFSCREEN_MARGIN },
    { x: left, y: top - OFFSCREEN_MARGIN - size.height },
  ]
  for (const candidate of candidates) if (!overlaps({ ...candidate, ...size })) return candidate
  return candidates[0]
}

/**
 * A window as the app's parking window is made: frameless + larger-than-screen so the OS
 * leaves it off every display, at a spot that is clear of them all. `show` mirrors the two
 * orders the app uses — the parking window is shown at construction, a throwaway shot
 * window is built `show: false` and shown only once the view is inside it.
 */
function makeWindow(size, show) {
  const spot = offscreenSpot(size)
  const win = new BrowserWindow({
    x: spot.x,
    y: spot.y,
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
  })
  if (show) win.showInactive()
  return win
}

/** A tab view as the app makes one (`backgroundThrottling: false`), sized to its viewport. */
async function makeTab(label, color) {
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  await load(view.webContents, color, label)
  return view
}

const probe = (view) => view.webContents.executeJavaScript('window.__probe && window.__probe()').catch(() => null)

/** Capture a view repeatedly, at the delays above, from `movedAt` (or now when there is no move). */
async function measureSampled(scenario, view, expected, at = Date.now()) {
  for (const wait of DELAYS) {
    const due = wait
    if (due) await sleep(Math.max(0, due - (Date.now() - at)))
    const outcome = await capture(view, expected)
    const row = { scenario, atMs: Date.now() - at, ...outcome }
    results.push(row)
    progress(`${scenario} +${row.atMs}ms → ${row.verdict}`)
  }
}

/** One reading, where waiting is not the point — the cold and settled premises. */
async function measureOnce(scenario, view, expected) {
  const outcome = await capture(view, expected)
  results.push({ scenario, atMs: null, ...outcome })
  progress(`${scenario} → ${outcome.verdict}`)
}

app.whenReady().then(async () => {
  // A stall anywhere above is a result; the watch ends the run rather than the shell's.
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, 180_000)

  try {
    const size = { width: W, height: H }

    // The app's parking window, shown first — then the tabs are added to it (parkTab's order).
    progress('parking window up')
    const parking = makeWindow(size, true)

    const blue = await makeTab('A (blue, covered)', '#0000ff')
    const green = await makeTab('B (green, covered)', '#00ff00')
    const red = await makeTab('C (red, on top)', '#ff0000')
    const BLUE = [0, 0, 255]
    const GREEN = [0, 255, 0]
    const RED = [255, 0, 0]
    const YELLOW = [255, 255, 0]

    // Added to a window that is already shown — red last, so red is on top and blue/green covered.
    for (const view of [blue, green, red]) {
      parking.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: W, height: H })
    }

    // Cold: right after the views went in.
    await measureOnce('premise cold (red, topmost, in place)', red, RED)
    await measureOnce('premise cold (blue, covered, in place)', blue, BLUE)

    // Settled: the window left alone to composite.
    await sleep(SETTLE_MS)
    console.log('SPIKE_JSON ' + JSON.stringify({
      parkingBounds: parking.getBounds(),
      parked: {
        blue: { probe: await probe(blue), size: blue.getBounds() },
        red: { probe: await probe(red), size: red.getBounds() },
      },
    }))
    await measureOnce('premise settled (red, topmost, in place)', red, RED)
    await measureOnce('premise settled (blue, covered, in place)', blue, BLUE)

    // Scenario 1 — raise the covered view to the top of the shared window and shoot it there.
    parking.contentView.addChildView(blue)
    await measureSampled('shared-raise (blue raised in the parking window)', blue, BLUE)
    // …and what the raise did to the view it displaced (was composited, now covered).
    await measureOnce('after raise (red, now covered)', red, RED)

    // Scenario 2 — the app's throwaway window for the same covered view, as the baseline:
    // built `show: false`, the view handed to it, and shown (captureWhileParked's order).
    {
      const win = makeWindow(size, false)
      await measureSampled('throwaway-window (green in a new window)', green, GREEN, (() => {
        win.contentView.addChildView(green)
        green.setBounds({ x: 0, y: 0, width: W, height: H })
        win.showInactive()
        return Date.now()
      })())
      // Hand it back to the parking window, as the app's `finally` does.
      parking.contentView.addChildView(green)
      green.setBounds({ x: 0, y: 0, width: W, height: H })
      if (!win.isDestroyed()) win.destroy()
    }

    // Scenario 3 — the tab on screen of a window that was shown and then hidden: its home
    // is a window that is not on screen, and the view has to be moved somewhere composited.
    {
      const home = makeWindow(size, false)
      const yellow = await makeTab('D (yellow, hidden home)', '#ffff00')
      home.contentView.addChildView(yellow)
      yellow.setBounds({ x: 0, y: 0, width: W, height: H })
      home.showInactive()
      await sleep(SETTLE_MS)
      home.hide()
      await sleep(200)

      await measureOnce('premise hidden-home (yellow, in its hidden window)', yellow, YELLOW)
      parking.contentView.addChildView(yellow)
      await measureSampled('hidden-home (yellow moved into the parking window)', yellow, YELLOW)
      if (!home.isDestroyed()) home.destroy()
    }

    console.log('SPIKE_JSON ' + JSON.stringify(results))
    printTable(results)

    if (!parking.isDestroyed()) parking.destroy()
    app.quit()
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})

/** The smallest delay at which a sampled scenario came back with its own pixels — the answer. */
function firstOwnPixels(rows) {
  const at = rows
    .filter((row) => row.verdict === 'own-pixels' && row.atMs !== null)
    .reduce((min, row) => Math.min(min, row.atMs), Infinity)
  return Number.isFinite(at) ? at : null
}

function printTable(rows) {
  const byScenario = new Map()
  for (const row of rows) {
    if (!byScenario.has(row.scenario)) byScenario.set(row.scenario, [])
    byScenario.get(row.scenario).push(row)
  }

  console.log('\nscenario                                                   at      verdict        time   size       rgb')
  for (const [scenario, scenarios] of byScenario) {
    for (const row of scenarios) {
      const detail = row.detail ? ` ${row.detail}` : ''
      console.log(
        `${scenario.padEnd(58)} ${String(row.atMs === null ? '-' : `+${row.atMs}`).padEnd(7)} ${String(row.verdict).padEnd(14)} ${String(row.ms ?? '-').padStart(5)}ms ${String(row.size ?? '').padEnd(10)} ${row.rgb ? JSON.stringify(row.rgb) : ''}${detail}`,
      )
    }
  }

  console.log('\nsummary (first delay with own pixels, sampled scenarios only)')
  for (const [scenario, scenarios] of byScenario) {
    if (scenarios.every((row) => row.atMs === null)) continue
    const at = firstOwnPixels(scenarios)
    console.log(`  ${scenario.padEnd(58)} ${at === null ? 'never' : `from +${at}ms`}`)
  }
}
