/**
 * Tab-visibility spike — temporary, not part of the app.
 *
 * Question it answers: **which way of keeping a page "off screen" still leaves it a
 * foreground page to Chromium?** Three things ride on that answer — a real viewport for
 * coordinates, unthrottled timers/rendering, and a screenshot that is not blank — and they
 * decide whether background work needs the three-piece set (route per page + real bounds +
 * no throttling) or one window per page.
 *
 * Seven ways a page can be parked, measured side by side:
 *
 *   active-view             the tab on screen (the control: must be foreground)
 *   covered-view            full bounds, under the active view, in the same window
 *   covered-unthrottled     the same, with `backgroundThrottling: false`
 *   zero-view               bounds 0x0, what the app does today for a background page
 *   offscreen-window        its own window, shown but placed off screen
 *   faded-window            its own window, shown at 0 opacity
 *   hidden-window           its own window, never shown
 *
 * Each page paints a solid colour, counts animation frames, and schedules 20 x 50ms timers,
 * so the numbers are unambiguous: full frame rate and ~1000ms for the timers means
 * "foreground"; a handful of frames and ~20000ms means "throttled"; and a captured pixel
 * that is the page's own colour means the compositor is still painting it.
 *
 * Run: node_modules/electron/dist/electron.exe apps/electron/spike   (from the repo root)
 */
const { app, BrowserWindow, BrowserView, screen } = require('electron')

const WAIT_MS = 2500
const TIMER_TICKS = 20
const TIMER_INTERVAL_MS = 50
const TOLERANCE = 10

const results = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A page that paints one colour and reports what it is allowed to do. */
function pageHtml(color, label) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:${color};overflow:hidden}</style></head>
<body>
<script>
  window.__label = ${JSON.stringify(label)};
  window.__frames = 0;
  window.__maxGapMs = 0;
  var last = performance.now();
  function tick(now) {
    window.__frames++;
    var gap = now - last;
    if (gap > window.__maxGapMs) window.__maxGapMs = gap;
    last = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__timers = 0;
  window.__timerStart = performance.now();
  function timerTick() {
    window.__timers++;
    if (window.__timers < ${TIMER_TICKS}) setTimeout(timerTick, ${TIMER_INTERVAL_MS});
    else window.__timerElapsedMs = performance.now() - window.__timerStart;
  }
  setTimeout(timerTick, ${TIMER_INTERVAL_MS});
  window.__probe = function () {
    return {
      label: window.__label,
      visibility: document.visibilityState,
      hidden: document.hidden,
      focused: document.hasFocus(),
      frames: window.__frames,
      maxGapMs: Math.round(window.__maxGapMs),
      timers: window.__timers,
      timerElapsedMs: Math.round(window.__timerElapsedMs === undefined ? -1 : window.__timerElapsedMs),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  };
</script>
</body></html>`
}

/** Load a scenario page into a webContents and wait until it is there. */
async function load(wc, color, label) {
  const loaded = new Promise((resolve) => wc.once('did-finish-load', resolve))
  await wc.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(pageHtml(color, label))}`)
  await loaded
}

/** BGRA at the centre of a capture, and whether it is the colour we asked for. */
function centrePixel(image, expectedBgra) {
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const x = Math.floor(size.width / 2)
  const y = Math.floor(size.height / 2)
  const i = (y * size.width + x) * 4
  const bgra = [bitmap[i], bitmap[i + 1], bitmap[i + 2], bitmap[i + 3]]
  const matches = expectedBgra.every((channel, index) => Math.abs(channel - bgra[index]) <= TOLERANCE)
  return { size: `${size.width}x${size.height}`, bgra, expectedBgra, matches }
}

async function measure(scenario) {
  const wc = scenario.webContents
  const entry = { scenario: scenario.name, how: scenario.how }

  try {
    entry.probe = await wc.executeJavaScript('window.__probe && window.__probe()')
  } catch (error) {
    entry.probe = { error: String(error && error.message ? error.message : error) }
  }

  try {
    entry.capture = centrePixel(await wc.capturePage(), scenario.expectedBgra)
  } catch (error) {
    entry.capture = { error: String(error && error.message ? error.message : error) }
  }

  if (scenario.describe) Object.assign(entry, scenario.describe())
  if (typeof wc.isPainting === 'function') entry.isPainting = wc.isPainting()
  if (typeof wc.getBackgroundThrottling === 'function') entry.backgroundThrottling = wc.getBackgroundThrottling()

  results.push(entry)
}

function totalWorkingSetKb() {
  try {
    return app.getAppMetrics().reduce((sum, metric) => sum + (metric.memory ? metric.memory.workingSetSize : 0), 0)
  } catch {
    return -1
  }
}

/** What this app costs, now: RSS, the processes' working set, and their CPU. */
function sampleMemory() {
  const metrics = (() => {
    try {
      return app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        workingSetMb: metric.memory ? Math.round(metric.memory.workingSetSize / 1024) : -1,
        cpuPercent: metric.cpu ? Number(metric.cpu.percentCPUUsage.toFixed(1)) : -1,
      }))
    } catch {
      return []
    }
  })()
  return {
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    workingSetMb: Math.round(totalWorkingSetKb() / 1024),
    cpuPercent: Number(metrics.reduce((sum, metric) => sum + Math.max(0, metric.cpuPercent), 0).toFixed(1)),
    processes: metrics,
  }
}

app.whenReady().then(async () => {
  try {
  const workArea = screen.getPrimaryDisplay().workArea
  const W = Math.min(900, Math.floor(workArea.width * 0.6))
  const H = Math.min(700, Math.floor(workArea.height * 0.6))
  const baseline = sampleMemory()

  // -- The one window the app has today, with the four view flavours inside it ----------
  const main = new BrowserWindow({
    x: workArea.x + 20,
    y: workArea.y + 20,
    width: W,
    height: H,
    frame: false,
    show: true,
    backgroundColor: '#202020',
    webPreferences: { backgroundThrottling: true },
  })

  const covered = new BrowserView({ webPreferences: { backgroundThrottling: true } })
  const coveredUnthrottled = new BrowserView({ webPreferences: { backgroundThrottling: false } })
  const zero = new BrowserView({ webPreferences: { backgroundThrottling: true } })
  const active = new BrowserView({ webPreferences: { backgroundThrottling: true } })

  main.addBrowserView(covered)
  main.addBrowserView(coveredUnthrottled)
  main.addBrowserView(zero)
  main.addBrowserView(active)
  main.setTopBrowserView(active)

  covered.setBounds({ x: 0, y: 0, width: W, height: H })
  coveredUnthrottled.setBounds({ x: 0, y: 0, width: W, height: H })
  zero.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  active.setBounds({ x: 0, y: 0, width: W, height: H })

  await Promise.all([
    load(covered.webContents, '#00ff00', 'covered-view'),
    load(coveredUnthrottled.webContents, '#0000ff', 'covered-unthrottled'),
    load(zero.webContents, '#ffff00', 'zero-view'),
    load(active.webContents, '#ff0000', 'active-view'),
  ])

  // -- One window per page: shown but out of sight, faded, and plainly hidden -----------
  const offscreen = new BrowserWindow({
    x: workArea.x + workArea.width + 200,
    y: workArea.y,
    width: W,
    height: H,
    frame: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#202020',
    webPreferences: { backgroundThrottling: true },
  })
  const faded = new BrowserWindow({
    x: workArea.x + 20,
    y: workArea.y + 20,
    width: W,
    height: H,
    frame: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#202020',
    webPreferences: { backgroundThrottling: true },
  })
  const hidden = new BrowserWindow({
    x: workArea.x + 20,
    y: workArea.y + 20,
    width: W,
    height: H,
    frame: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#202020',
    webPreferences: { backgroundThrottling: true },
  })
  // The app's own case, which a fresh `show: false` window does *not* reproduce: a window
  // that was on screen and was then hidden. This is what the screenshot rescue exists for.
  const hiddenAfterShow = new BrowserWindow({
    x: workArea.x + 40,
    y: workArea.y + 40,
    width: W,
    height: H,
    frame: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#202020',
    webPreferences: { backgroundThrottling: true },
  })

  await Promise.all([
    load(offscreen.webContents, '#ff8800', 'offscreen-window'),
    load(faded.webContents, '#00ffaa', 'faded-window'),
    load(hidden.webContents, '#8800ff', 'hidden-window'),
    load(hiddenAfterShow.webContents, '#ff00ff', 'hidden-after-show'),
  ])
  offscreen.showInactive()
  faded.setOpacity(0)
  faded.showInactive()
  hiddenAfterShow.showInactive()
  await sleep(300)
  hiddenAfterShow.hide()

  const afterFirstPhase = sampleMemory()

  await sleep(WAIT_MS)

  await measure({ name: 'active-view', how: 'on screen, top view of the window', webContents: active.webContents, expectedBgra: [0, 0, 255, 255] })
  await measure({ name: 'covered-view', how: 'full bounds, under the active view', webContents: covered.webContents, expectedBgra: [0, 255, 0, 255] })
  await measure({ name: 'covered-unthrottled', how: 'same, backgroundThrottling: false', webContents: coveredUnthrottled.webContents, expectedBgra: [255, 0, 0, 255] })
  await measure({ name: 'zero-view', how: 'bounds 0x0 (what the app does today)', webContents: zero.webContents, expectedBgra: [0, 255, 255, 255] })
  await measure({
    name: 'offscreen-window',
    how: 'own window, shown off screen',
    webContents: offscreen.webContents,
    expectedBgra: [0, 136, 255, 255],
    describe: () => ({ window: { visible: offscreen.isVisible(), focused: offscreen.isFocused(), bounds: offscreen.getBounds() } }),
  })
  await measure({
    name: 'faded-window',
    how: 'own window, shown at opacity 0',
    webContents: faded.webContents,
    expectedBgra: [170, 255, 0, 255],
    describe: () => ({ window: { visible: faded.isVisible(), focused: faded.isFocused(), opacity: faded.getOpacity() } }),
  })
  await measure({
    name: 'hidden-window',
    how: 'own window, never shown',
    webContents: hidden.webContents,
    expectedBgra: [255, 0, 136, 255],
    describe: () => ({ window: { visible: hidden.isVisible(), focused: hidden.isFocused() } }),
  })
  await measure({
    name: 'hidden-after-show',
    how: 'own window, shown once then hidden (the app\'s case)',
    webContents: hiddenAfterShow.webContents,
    expectedBgra: [255, 255, 0, 255],
    describe: () => ({ window: { visible: hiddenAfterShow.isVisible(), focused: hiddenAfterShow.isFocused() } }),
  })

  // -- Phase 2: what does "keep every page foreground" cost, page for page? -------------
  // The same three pages, first parked the way the app parks them today (0x0, throttled),
  // then given real bounds and `backgroundThrottling: false`. Same pages, same window — only
  // the parking differs, so the delta is what the decision is about.
  const extra = ['#112233', '#223344', '#334455'].map(() => new BrowserView({ webPreferences: { backgroundThrottling: true } }))
  for (const view of extra) {
    main.addBrowserView(view)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  }
  main.setTopBrowserView(active)
  await Promise.all(extra.map((view, index) => load(view.webContents, `#${['112233', '223344', '334455'][index]}`, `extra-${index}`)))
  await sleep(WAIT_MS)
  const parked = sampleMemory()

  for (const view of extra) {
    view.webContents.setBackgroundThrottling(false)
    view.setBounds({ x: 0, y: 0, width: W, height: H })
  }
  await sleep(WAIT_MS)
  const foregrounded = sampleMemory()

  const parkingCost = {
    pages: extra.length,
    parked,
    foregrounded,
    deltaWorkingSetMb: foregrounded.workingSetMb - parked.workingSetMb,
    deltaCpuPercent: Number((foregrounded.cpuPercent - parked.cpuPercent).toFixed(1)),
  }

  console.log('SPIKE_JSON ' + JSON.stringify({ baseline, afterFirstPhase, parkingCost, results }))
  console.log('\nscenario              vis       hidden focused frames maxGap timers timerMs  capture')
  for (const entry of results) {
    const probe = entry.probe || {}
    const capture = entry.capture || {}
    const captured = capture.error ? `error: ${capture.error}` : `${capture.matches ? 'OK' : 'WRONG'} ${capture.size} ${JSON.stringify(capture.bgra)}`
    console.log(
      `${entry.scenario.padEnd(20)}  ${String(probe.visibility ?? '-').padEnd(9)} ${String(probe.hidden ?? '-').padEnd(6)} ${String(probe.focused ?? '-').padEnd(7)} ${String(probe.frames ?? '-').padEnd(6)} ${String(probe.maxGapMs ?? '-').padEnd(6)} ${String(probe.timers ?? '-').padEnd(6)} ${String(probe.timerElapsedMs ?? '-').padEnd(8)} ${captured}`,
    )
  }
  console.log('\n(viewport per page: ' + results.map((entry) => `${entry.scenario}=${(entry.probe && entry.probe.innerWidth) || '?'}x${(entry.probe && entry.probe.innerHeight) || '?'}`).join(' ') + ')')

  console.log('\nphase 2 — three pages, parked then foregrounded')
  console.log(`  parked        workingSet=${parked.workingSetMb}MB rss=${parked.rssMb}MB cpu=${parked.cpuPercent}%`)
  console.log(`  foregrounded  workingSet=${foregrounded.workingSetMb}MB rss=${foregrounded.rssMb}MB cpu=${foregrounded.cpuPercent}%`)
  console.log(`  delta for ${parkingCost.pages} pages: workingSet=${parkingCost.deltaWorkingSetMb}MB cpu=${parkingCost.deltaCpuPercent}%`)
  console.log(`  baseline (before any window) workingSet=${baseline.workingSetMb}MB rss=${baseline.rssMb}MB cpu=${baseline.cpuPercent}%`)
  console.log('  processes: ' + JSON.stringify(afterFirstPhase.processes))

  for (const win of [main, offscreen, faded, hidden, hiddenAfterShow]) {
    if (!win.isDestroyed()) win.destroy()
  }
  app.quit()
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
