/**
 * Covered-window capture — temporary spike, not part of the app.
 *
 * Question: **when a window is covered by another window, does it still answer `capturePage`
 * — and does it matter whether the covering is off every display or on one?**
 *
 * Two configurations, because they turn out to be different things (measured: the off-screen
 * one is harmless, which is why it is kept here as the control):
 *
 *   parked       two parking windows at the **same** spot off every display — what two
 *                workspaces (`craft-agents`) or two connections (`open-webui/desktop`) do,
 *                since `offscreenSpot` is a function of the window's size
 *   on-screen    a window on a display, covered by another window at its exact rect — the
 *                case `craft-agents` names in `index.ts`: Chromium stops producing frames for
 *                a window it judges fully covered, `capturePage` then fails with "current
 *                display surface not available for capture", and the agent would have to raise
 *                the browser window (stealing the person's view) before every background shot
 *
 * …and, for each, the remedy: `moveTop()` on the covered window, then a frame.
 *
 * Modes, because the switch is read at startup and cannot be toggled in-process — run the
 * spike once per mode and compare:
 *
 *   (default)            Chromium judging a covered window hidden, as on Windows today
 *   --disable-occlusion  `disable-features=CalculateNativeWinOcclusion`, what craft ships
 *   --always-on-top      the windows raised with `alwaysOnTop` (what craft sets at
 *                        construction, and what open-webui sets on macOS only)
 *
 * What is asserted (every platform):
 *   - the parked controls answer: alone, apart, the one on top, and the covered one **after**
 *     a raise. Those are the invariants the apps depend on.
 *   - with `--disable-occlusion`, the covered window answers **before** any raise, in both
 *     configurations — that is what the switch is for, so it must hold where it is set.
 *
 * What is only reported: the covered window before a raise in `(default)` mode. That is the
 * measurement, and the interesting number is whether it differs between the two modes.
 *
 * NOTE: the `on-screen` configuration puts two small windows on the person's display for a
 * moment (that is the point of it). Run it with the machine to yourself.
 *
 * Run (from the repo root), once per mode you care about:
 *   node_modules/electron/dist/electron.exe apps/electron/spike/occluded-window-capture.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/occluded-window-capture.cjs --disable-occlusion
 *
 * Exit code 0 when every assertion held, 1 when one did not.
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')

const DISABLE_OCCLUSION = process.argv.includes('--disable-occlusion')
const ALWAYS_ON_TOP = process.argv.includes('--always-on-top')

// Read at startup, so it is set here and cannot be changed later in the run.
if (DISABLE_OCCLUSION) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

const W = 640
const H = 480
const TIMEOUT_MS = 2500
/** Left alone after the windows are up: a window that has just been shown has no frame yet. */
const SETTLE_MS = 800
/** Covered **on a display**: Chromium's occlusion tracker polls, so give it time to judge. */
const OCCLUSION_SETTLE_MS = 1500
/** After a raise: one frame is enough (measured ~16–34ms), this is well past it. */
const AFTER_RAISE_MS = 200
const OFFSCREEN_PARK_MARGIN = 20_000

const rows = []
const checks = []
const parks = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const progress = (message) => console.log(`SPIKE_STEP ${new Date().toISOString().slice(11, 23)} ${message}`)

const mode = [
  DISABLE_OCCLUSION ? 'occlusion-judgement OFF (--disable-occlusion)' : 'occlusion-judgement ON (default)',
  ALWAYS_ON_TOP ? 'alwaysOnTop' : 'no alwaysOnTop',
].join(' · ')

/** A page that paints one solid colour, so a captured pixel says whether it answered at all. */
function pageHtml(color, label) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:${color};overflow:hidden}</style></head>
<body><script>window.__label = ${JSON.stringify(label)};</script></body></html>`
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

/** RGB at the centre of an image, and whether it is the colour the page paints. */
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

/** Run one capture, race it against a timeout, and describe what came back — or that nothing did. */
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

/** A spot off every display, as `offscreenSpot` picks one — `side` selects which of the four. */
function offscreenSpot(size, side) {
  const displays = screen.getAllDisplays()
  const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
  const left = Math.min(...displays.map((d) => d.bounds.x))
  const top = Math.min(...displays.map((d) => d.bounds.y))
  const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
  const candidates = [
    { x: right + OFFSCREEN_PARK_MARGIN, y: top },
    { x: left - OFFSCREEN_PARK_MARGIN - size.width, y: top },
    { x: left, y: bottom + OFFSCREEN_PARK_MARGIN },
    { x: left, y: top - OFFSCREEN_PARK_MARGIN - size.height },
  ]
  return candidates[side % candidates.length]
}

/**
 * A parking window as the apps make one: frameless, larger-than-screen, out of the taskbar,
 * shown without being activated (`showInactive`, because a window that is never shown is never
 * composited), holding one full-size view.
 *
 * `alwaysOnTop` is optional on purpose: `craft-agents` sets it on every platform, and
 * `open-webui/desktop` only on macOS.
 */
async function makePark(spot, color, label) {
  const win = new BrowserWindow({
    x: spot.x,
    y: spot.y,
    width: spot.width,
    height: spot.height,
    show: false,
    frame: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    ...(ALWAYS_ON_TOP ? { alwaysOnTop: true } : {}),
  })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: spot.width, height: spot.height })
  win.contentView.addChildView(view)
  win.showInactive()
  await load(view.webContents, color, label)
  const park = { win, view, label, color }
  parks.push(park)
  return park
}

const capture = (park, expectedRgb) => attempt(() => park.view.webContents.capturePage(), expectedRgb)

async function measure(config, park, expectedRgb) {
  const outcome = await capture(park, expectedRgb)
  const bounds = park.win.getBounds()
  const row = { config, window: `${bounds.x},${bounds.y}`, ...outcome }
  rows.push(row)
  progress(`${config} → ${row.verdict}${row.detail ? ` (${row.detail})` : ''}`)
  return outcome
}

/** One assertion. Prints and records; the exit code is decided from `checks`. */
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`SPIKE_CHECK ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, 180_000)

  try {
    const size = { width: W, height: H }
    console.log(`SPIKE_JSON ${JSON.stringify({ platform: process.platform, mode })}`)
    progress(`mode: ${mode}`)

    // ── parked: two parking windows at the same spot, off every display ──────────
    const firstSpot = { ...offscreenSpot(size, 0), ...size }
    const apartSpot = { ...offscreenSpot(size, 1), ...size }
    progress(`spots: first=${firstSpot.x},${firstSpot.y} apart=${apartSpot.x},${apartSpot.y}`)

    const alpha = await makePark(firstSpot, '#ff0000', 'alpha (red, alone)')
    await sleep(SETTLE_MS)
    const alone = await measure('parked · alone', alpha, [255, 0, 0])
    check('parked · alone answers', alone.verdict === 'own-pixels', alone.verdict)

    const beside = await makePark(apartSpot, '#00ff00', 'beside (green, apart)')
    await sleep(SETTLE_MS)
    const apart = await measure('parked · apart (the first, never covered)', alpha, [255, 0, 0])
    check('parked · apart (the first, never covered) answers', apart.verdict === 'own-pixels', apart.verdict)
    const besideOwn = await measure('parked · apart (the second)', beside, [0, 255, 0])
    check('parked · apart (the second) answers', besideOwn.verdict === 'own-pixels', besideOwn.verdict)

    const cover = await makePark(firstSpot, '#0000ff', 'cover (blue, on top of alpha)')
    await sleep(SETTLE_MS)
    const parkedCovered = await measure('parked · overlapping (the covered one, before any raise)', alpha, [255, 0, 0])
    const coverOwn = await measure('parked · overlapping (the window on top)', cover, [0, 0, 255])
    check('parked · overlapping (the window on top) answers', coverOwn.verdict === 'own-pixels', coverOwn.verdict)

    alpha.win.moveTop()
    await sleep(AFTER_RAISE_MS)
    const parkedRaised = await measure('parked · raised (the covered one, after moveTop)', alpha, [255, 0, 0])
    check('parked · raised (the covered one) answers after moveTop', parkedRaised.verdict === 'own-pixels', parkedRaised.verdict)

    // ── on-screen: a window on a display, covered by another at the same rect ────
    const display = screen.getPrimaryDisplay().bounds
    const onScreenSpot = {
      x: display.x + display.width - W - 24,
      y: display.y + display.height - H - 24,
      width: W,
      height: H,
    }
    const under = await makePark(onScreenSpot, '#ff8800', 'under (orange, on a display)')
    await sleep(SETTLE_MS)
    const underOwn = await measure('on-screen · visible (not covered yet)', under, [255, 136, 0])
    check('on-screen · visible (not covered yet) answers', underOwn.verdict === 'own-pixels', underOwn.verdict)

    const over = await makePark(onScreenSpot, '#8800ff', 'over (violet, covering it)')
    await sleep(OCCLUSION_SETTLE_MS)
    const onScreenCovered = await measure('on-screen · covered (before any raise)', under, [255, 136, 0])
    const overOwn = await measure('on-screen · the covering window', over, [136, 0, 255])
    check('on-screen · the covering window answers', overOwn.verdict === 'own-pixels', overOwn.verdict)

    under.win.moveTop()
    await sleep(AFTER_RAISE_MS)
    const onScreenRaised = await measure('on-screen · raised (the covered one, after moveTop)', under, [255, 136, 0])
    check('on-screen · raised (the covered one) answers after moveTop', onScreenRaised.verdict === 'own-pixels', onScreenRaised.verdict)

    // The claim the switch exists for: with it, a covered window keeps painting — no raise needed.
    if (DISABLE_OCCLUSION) {
      check('parked · the covered one answers without a raise', parkedCovered.verdict === 'own-pixels', parkedCovered.verdict)
      check('on-screen · the covered one answers without a raise', onScreenCovered.verdict === 'own-pixels', onScreenCovered.verdict)
    }

    console.log('SPIKE_JSON ' + JSON.stringify(rows))
    printTable(rows)

    const failed = checks.filter((entry) => !entry.ok)
    console.log(`\nassertions: ${checks.length - failed.length}/${checks.length} held`)
    console.log(
      '\ncompare the two modes by hand: the rows that matter are `parked · overlapping (the covered one, before any raise)`\n' +
        'and `on-screen · covered (before any raise)` — if they differ between modes, the occlusion judgement is the cause.',
    )

    for (const park of parks) {
      if (!park.win.isDestroyed()) park.win.destroy()
    }
    app.exit(failed.length === 0 ? 0 : 1)
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})

function printTable(rows) {
  console.log('\nconfig                                                         window        verdict        time   size       rgb')
  for (const row of rows) {
    const detail = row.detail ? ` ${row.detail}` : ''
    console.log(
      `${String(row.config).padEnd(62)} ${String(row.window).padEnd(13)} ${String(row.verdict).padEnd(14)} ${String(row.ms ?? '-').padStart(5)}ms ${String(row.size ?? '').padEnd(10)} ${row.rgb ? JSON.stringify(row.rgb) : ''}${detail}`,
    )
  }
}
