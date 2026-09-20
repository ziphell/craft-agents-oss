/**
 * Real-manager screenshot spike — temporary, not part of the app.
 *
 * Question it answers: **can a background tab be shot, in both window states — and does shooting
 * it leave the window, the tab on screen and the locks exactly as they were?**
 *
 * The unit tests answer the manager's flow with a mocked `capturePage`; this drives the real
 * `BrowserPaneManager` in a real Electron, in the shape the report is about:
 *
 *   window shown once, then hidden   (the plan's `hidden-after-show`, where the surface goes away)
 *   one tab on screen                (what the person is looking at)
 *   one tab behind it                (what the agent works on: `activate: false`)
 *
 * and calls `screenshot(id, options, tabId)` the way the desktop app's session manager does, for
 * all four combinations (both tabs × both window states). For each it checks that an image comes
 * back, that the pixels are *that* tab's (a page whose colour is unique to it), which recovery it
 * needed, and — for a hidden window — that the window was never shown on a display while it was
 * taken. Afterwards it checks the window is hidden again and the tab on screen never moved.
 *
 * Then what a parked shot does to the person's focus: no focus event may fire for the window that is
 * shown for it, and the app's focused window may not change.
 *
 * What the measurements behind the fix were (2026-09-18, this machine):
 *
 *   - a hidden window: every capture path stops answering — not an empty image, a promise that never
 *     settles. Nothing inside it has a surface, so the shot cannot be taken there at all.
 *   - a tab that has never been composited (a tab opened behind the person's, `activate: false`, which
 *     is how an agent's tab is opened): no surface either, *even with the window up*. `setVisible`,
 *     `invalidate`, `setBounds`, unthrottling and the window being visible all missed.
 *   - so the shot is taken from a **view parked in a window nobody can see** (`captureWhileParked`):
 *     a window outside every display, shown because a window that is never shown is not composited
 *     either (measured: parked but never shown → `Current display surface not available`, 27ms; parked
 *     and shown off screen → that tab's own pixels, **38ms**). It has to be taken while the view is
 *     parked: handed back into a hidden window, the same capture misses again (29ms).
 *   - the round trip is cheap: 16ms of wait is enough (0ms is not), the parking window costs ~5–18ms
 *     to make and 1–3ms to drop, and the person's window's bounds and stacking are unchanged. The app's
 *     own window is never shown, moved, re-stacked or touched on the taskbar for a picture — which is
 *     what made the earlier "reveal the window off screen" machinery unnecessary, along with the
 *     taskbar flag and position restore it needed.
 *
 * Build + run (from the repo root):
 *   bunx esbuild apps/electron/spike/screenshot-e2e.ts --bundle --platform=node --format=cjs \
 *     --external:electron --external:@anthropic-ai/claude-agent-sdk \
 *     --outfile=apps/electron/spike/screenshot-e2e.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/screenshot-e2e.cjs
 */
import { app, BrowserWindow, WebContentsView, nativeImage, screen } from 'electron'
import { execFileSync } from 'node:child_process'
import { BrowserPaneManager } from '../src/main/browser-pane-manager'

/**
 * The app's own switch, taken from `index.ts`: Chromium stops producing frames for a window it
 * judges fully covered. A harness without it measures a Chromium the app does not ship.
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// The harness destroys its own windows as it goes; without this, the first teardown that leaves
// none takes the whole run with it (Electron's default is to quit on `window-all-closed`).
app.on('window-all-closed', () => {})

const TIMEOUT_MS = 20_000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The spot `parkOffScreen` puts a window in: past the right edge of the union of the displays.
 * Asked for inside `whenReady` — the `screen` module is not available before that.
 */
function parkedSpot() {
  const displays = screen.getAllDisplays()
  return {
    offScreen: {
      x: Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)) + 400,
      y: Math.min(...displays.map((display) => display.bounds.y)),
    },
  }
}

const FRONT = { hex: '#ff0000', bgra: [0, 0, 255, 255], label: 'the tab on screen' }
const BACK = { hex: '#0000ff', bgra: [255, 0, 0, 255], label: 'the tab the agent works on' }
const PARKED_WARNING = 'parked that tab in a window nobody can see'
/** The app's own bound for waiting on that first frame (`SCREENSHOT_FIRST_FRAME_MS`). */
const FIRST_FRAME_WAIT_MS = 16

function page(colour: string, label: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:${colour};overflow:hidden}</style></head>
<body><h1 style="font:14px sans-serif">${label}</h1></body></html>`
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

/** The colour at the middle of a shot, in BGRA, as the page painted it. */
function centrePixel(buffer: Buffer): number[] {
  const image = nativeImage.createFromBuffer(buffer)
  const size = image.getSize()
  const bitmap = image.toBitmap()
  const x = Math.floor(size.width / 2)
  const y = Math.floor(size.height / 2)
  const i = (y * size.width + x) * 4
  return [bitmap[i]!, bitmap[i + 1]!, bitmap[i + 2]!, bitmap[i + 3]!]
}

const matches = (bgra: number[], expected: number[]) =>
  expected.every((channel, index) => Math.abs(channel - bgra[index]!) <= 10)

/** The command must finish whatever happens; a shot that never comes back is a result too. */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
  const timedOut = Symbol('timeout')
  let timer: ReturnType<typeof setTimeout> | null = null
  const outcome = await Promise.race([
    work,
    new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), TIMEOUT_MS) }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome === timedOut) throw new Error(`screenshot did not come back within ${TIMEOUT_MS}ms`)
  return outcome as T
}

/**
 * What one tab's page is doing, wherever its view happens to be living: its viewport, whether
 * Chromium counts it visible, how many frames it produced in half a second, how many resizes it has
 * seen, and whether its pixels can be read where it is.
 */
async function readTab(tab: any): Promise<{
  innerWidth: number
  visibility: { state: string; hidden: boolean }
  framesPer500ms: number
  resizes: number
  capture: string
}> {
  const wc = tab.tabView.webContents
  const framesA = await wc.executeJavaScript('window.__frames')
  await sleep(500)
  const framesB = await wc.executeJavaScript('window.__frames')
  const resizes = await wc.executeJavaScript('window.__resizes')
  const innerWidth = await wc.executeJavaScript('window.innerWidth')
  // `layoutTabView` says a covered tab is "counted visible" by Chromium (that is why the tabs carry
  // `backgroundThrottling: false`); the frame count says it produces no frames. Which of the two that
  // means is worth having in the same reading: visibility state, not compositing.
  const visibility = await wc.executeJavaScript('({ state: document.visibilityState, hidden: document.hidden })')
  let capture: string
  try {
    const shot = await withTimeout(wc.capturePage())
    capture = shot.isEmpty() ? 'empty' : `${shot.getSize().width}x${shot.getSize().height}`
  } catch (error) {
    capture = `error: ${error instanceof Error ? error.message : String(error)}`
  }
  return { innerWidth, visibility, framesPer500ms: framesB - framesA, resizes, capture }
}

/** The page every size measurement uses: it counts its resizes, its frames, and its intersections. */
const movingPage = (colour: string) => `data:text/html;charset=UTF-8,${encodeURIComponent(
  `<html><body style="background:#${colour};margin:0">`
  + '<div id="sentinel" style="position:absolute;top:4000px;left:0;width:100px;height:40px"></div>'
  + '<div style="height:5000px"></div><script>'
  + 'window.__resizes=0;window.addEventListener("resize",()=>{window.__resizes++});'
  + 'window.__frames=0;(function loop(){window.__frames++;requestAnimationFrame(loop)})();'
  + 'window.__io=0;new IntersectionObserver((es)=>{for(const e of es) if(e.isIntersecting) window.__io++})'
  + '.observe(document.getElementById("sentinel"));'
  + '</script></body></html>'
)}`

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — a screenshot never came back')
    app.exit(3)
  }, 180_000)

  const failures: string[] = []
  const rows: Record<string, unknown>[] = []

  try {
    const manager = new BrowserPaneManager()
    const { offScreen } = parkedSpot()

    const onADisplay = (bounds: { x: number; y: number; width: number; height: number }) =>
      screen.getAllDisplays().some((display) => {
        const d = display.bounds
        return bounds.x < d.x + d.width && bounds.x + bounds.width > d.x
          && bounds.y < d.y + d.height && bounds.y + bounds.height > d.y
      })

    // One window per state, each with its own freshly-born background tab: a tab that has already
    // been composited once keeps its surface (that is the whole mechanism), so reusing one window
    // would quietly test the *easy* case in the second state and never the case the person is asking
    // about — a hidden window whose background tab has never been on screen at all.
    for (const windowState of ['visible', 'hidden'] as const) {
      const stateId = manager.createInstance(`state-${windowState}`, { show: true })
      const stateInstance = (manager as any).instances.get(stateId)
      await sleep(700)
      if (!stateInstance.window.isVisible()) stateInstance.window.showInactive()
      await sleep(300)

      // Every time the window is shown, and where it stood: the reveal is the only moment it could be
      // in front of the person, so "is that rectangle on any display" is the whole question of whether
      // a background shot shows them anything.
      const shownAt: Array<{ x: number; y: number; width: number; height: number }> = []
      stateInstance.window.on('show', () => shownAt.push(stateInstance.window.getBounds()))

      const onScreenTab = manager.createTab(stateId, { url: page(FRONT.hex, FRONT.label), activate: true })
      await sleep(900)
      if (windowState === 'hidden') {
        manager.hide(stateId)
        await sleep(400)
        console.log(`SPIKE_STEP window hidden visible=${stateInstance.window.isVisible()}`)
      }
      // The agent's tab, opened behind the person's — the shape the plan asks for (第十三轮). While
      // the window is hidden it is opened *after* the hide, so it has never been composited either.
      const behindTab = manager.createTab(stateId, { url: page(BACK.hex, BACK.label), activate: false })
      await sleep(900)

      for (const [where, tabId] of [['on screen', onScreenTab], ['behind it', behindTab]] as const) {
        const expected = tabId === onScreenTab ? FRONT : BACK
        const started = Date.now()
        const revealsBefore = shownAt.length
        let row: Record<string, unknown>
        try {
          const shot = await withTimeout(manager.screenshot(stateId, { format: 'png', includeMetadata: true }, tabId))
          const pixel = centrePixel(shot.imageBuffer)
          const warnings = shot.metadata?.warnings ?? []
          // Where the window stood while this shot was being taken, if it was shown to take it.
          const shownDuringThisShot = shownAt.slice(revealsBefore)
          row = {
            window: windowState,
            tab: where,
            shown: shownDuringThisShot.length === 0 ? 'not shown' : onADisplay(shownDuringThisShot[0]!) ? 'on a display' : 'off screen',
            ms: Date.now() - started,
            bytes: shot.imageBuffer.length,
            format: shot.imageFormat,
            centrePixel: pixel,
            ownPixels: matches(pixel, expected.bgra),
            notTheOtherTab: !matches(pixel, (tabId === onScreenTab ? BACK : FRONT).bgra),
            parked: warnings.some((warning) => warning.includes(PARKED_WARNING)),
          }
          if (!row.ownPixels) failures.push(`${windowState} window, ${where} tab: colour is not that tab's`)
          if (!row.notTheOtherTab) failures.push(`${windowState} window, ${where} tab: it shot the other tab`)
          // Nobody may see the person's window: it is not shown, and it does not move.
          if (shownDuringThisShot.length > 0) {
            failures.push(`${windowState} window, ${where} tab: the person's window was shown for a picture`)
          }
        } catch (error) {
          row = { window: windowState, tab: '?', ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
          failures.push(`${windowState} window: ${row.error}`)
        }
        rows.push(row)
        console.log(`SPIKE_STEP ${windowState.padEnd(7)} window → ${String(row.tab).padEnd(20)} ${JSON.stringify(row)}`)
      }

      // Nothing about the window or the person's tab may have moved.
      const stateTabs = manager.listTabs(stateId)
      if (stateTabs.find((tab) => tab.active)?.id !== onScreenTab) failures.push(`${windowState} window: the tab on screen was switched`)
      if (windowState === 'hidden' && stateInstance.window.isVisible()) failures.push('the window was left visible')
      manager.destroyInstance(stateId)
    }

    console.log('SPIKE_JSON ' + JSON.stringify({ rows, failures }))
    console.log(failures.length === 0 ? '\nSPIKE_OK — every combination came back with its own tab' : `\nSPIKE_FAILURES ${JSON.stringify(failures, null, 2)}`)

    // Phase 1c — the question that follows from the reveal: if pulling the *view* out gives it a
    // surface, does the whole "show the window" machinery need to exist at all? A window that is
    // never shown, with a view that has never been composited, shot three ways.
    //
    // The views here are the probe's **own**, not a tab from the manager: a tab that is not on screen
    // is housed in a *shown* parking window now, so its view has a surface already, and these rows
    // are about the mechanism itself — a view answers a capture only once something composited it.
    //
    //   capturedWhileParkedNotShown  view handed to an off-screen window that is **never shown**,
    //                                captured there (nothing is displayed anywhere, by anyone)
    //   capturedWhileParkedShown     the same, with the parking window shown off screen
    //   capturedAfterHandingBack     given its first frame off screen, handed back into an unshown
    //                                window, then captured — to know whether the capture has to
    //                                happen while the view is parked
    {
      const attempts: Record<string, unknown> = {}
      const keptAlive: BrowserWindow[] = []
      for (const how of ['capturedWhileParkedNotShown', 'capturedWhileParkedShown', 'capturedAfterHandingBack'] as const) {
        const bounds = { x: 0, y: 0, width: 700, height: 500 }
        // A home that is never shown, so the view has been composited nowhere.
        const home = new BrowserWindow({
          x: offScreen.x, y: offScreen.y - 600, width: bounds.width, height: bounds.height,
          show: false, frame: false, skipTaskbar: true,
        })
        const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
        home.contentView.addChildView(view)
        view.setBounds(bounds)
        await view.webContents.loadURL(page(BACK.hex, `park back ${how}`))
        await sleep(600)

        const parking = new BrowserWindow({
          x: offScreen.x, y: offScreen.y, width: bounds.width, height: bounds.height,
          show: false, frame: false, skipTaskbar: true, backgroundColor: '#202020',
        })
        keptAlive.push(parking)

        const started = Date.now()
        parking.contentView.addChildView(view)
        view.setBounds(bounds)
        // Shown off screen for one of the two parked rows; never shown for the other.
        if (how === 'capturedWhileParkedShown') parking.showInactive()
        await sleep(FIRST_FRAME_WAIT_MS)

        let result: Record<string, unknown>
        if (how === 'capturedAfterHandingBack') {
          home.contentView.addChildView(view)
          view.setBounds(bounds)
        }
        try {
          const captured = await withTimeout(view.webContents.capturePage())
          result = captured.isEmpty() ? { empty: true } : { ownPixels: matches(centrePixel(captured.toPNG()), BACK.bgra) }
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) }
        }
        result.ms = Date.now() - started
        parking.hide()
        attempts[how] = result
        console.log(`SPIKE_STEP parked view — ${how.padEnd(28)} ${JSON.stringify(result)}`)
        keptAlive.push(home)
      }
      for (const window of keptAlive) {
        if (!window.isDestroyed()) window.destroy()
      }
      // The three rows are the premises of the parked shot, so each is asserted in its own direction:
      // a window that is never shown is not composited (so the parking window has to be shown); a
      // window shown off screen is (so that works); and a view handed back into an unshown window
      // never is (so the capture cannot wait until it is handed back).
      if ((attempts.capturedWhileParkedNotShown as { ownPixels?: boolean }).ownPixels === true) {
        failures.push('a view parked in a window that is never shown was captured after all — then the parking window would not need showing')
      }
      if ((attempts.capturedWhileParkedShown as { ownPixels?: boolean }).ownPixels !== true) {
        failures.push('a hidden window\'s tab could not be captured from a view parked in a window shown off screen')
      }
      if ((attempts.capturedAfterHandingBack as { ownPixels?: boolean }).ownPixels === true) {
        failures.push('a hidden window\'s tab was captured after the view was handed back — then the shot would not need parking')
      }
    }

    {
      const offId = manager.createInstance('offscreen-tab', { show: true })
      const offInstance = (manager as any).instances.get(offId)
      await sleep(700)
      if (!offInstance.window.isVisible()) offInstance.window.showInactive()

      manager.createTab(offId, { url: page(FRONT.hex, 'off front'), activate: true })
      await sleep(800)
      const frontView = offInstance.tabs[0].tabView
      const pageBounds = { ...frontView.getBounds() }
      const windowState = { bounds: { ...offInstance.window.getBounds() }, onTop: offInstance.window.contentView.children.length }

      // A window nobody sees: off every display, no taskbar button, never focused.
      const createParkingWindow = () => new BrowserWindow({
        x: offScreen.x,
        y: offScreen.y,
        width: pageBounds.width,
        height: pageBounds.height,
        show: false,
        frame: false,
        skipTaskbar: true,
        backgroundColor: '#202020',
      })

      // What one round costs, and how long the frame wait has to be: each wait gets its own tab,
      // because a tab that has been composited once keeps its surface and would answer for the next.
      const rounds: Record<string, unknown> = {}
      for (const waitMs of [0, 16, 32, 200]) {
        const backId = manager.createTab(offId, { url: page(BACK.hex, `off back ${waitMs}`), activate: false })
        await sleep(600)
        const back = offInstance.tabs.find((tab: any) => tab.id === backId)

        const createStarted = Date.now()
        const parking = createParkingWindow()
        const createMs = Date.now() - createStarted

        const started = Date.now()
        parking.contentView.addChildView(back.tabView)
        back.tabView.setBounds({ x: 0, y: 0, width: pageBounds.width, height: pageBounds.height })
        parking.showInactive()
        await sleep(waitMs)
        offInstance.window.contentView.addChildView(back.tabView)
        back.tabView.setBounds(pageBounds)
        offInstance.window.contentView.addChildView(frontView)
        parking.hide()
        const outAndBackMs = Date.now() - started

        let surface: Record<string, unknown>
        try {
          const captured = await withTimeout(back.tabView.webContents.capturePage())
          if (captured.isEmpty()) surface = { empty: true }
          else {
            const pixel = centrePixel(captured.toPNG())
            surface = { pixel, ownPixels: matches(pixel, BACK.bgra) }
          }
        } catch (error) {
          surface = { error: error instanceof Error ? error.message : String(error) }
        }

        const destroyStarted = Date.now()
        parking.destroy()
        rounds[`wait${waitMs}ms`] = { createMs, outAndBackMs, destroyMs: Date.now() - destroyStarted, ...surface }
      }

      // The person's window: same place, and their tab still on top of every other tab.
      const children = offInstance.window.contentView.children
      const frontIndex = children.indexOf(frontView)
      const everyTabBelowThePerson = offInstance.tabs
        .filter((tab: any) => tab.tabView !== frontView && children.includes(tab.tabView))
        .every((tab: any) => children.indexOf(tab.tabView) < frontIndex)
      const result = {
        rounds,
        boundsUnchanged: JSON.stringify(windowState.bounds) === JSON.stringify(offInstance.window.getBounds()),
        thePersonsTabStillOnTop: everyTabBelowThePerson,
      }
      console.log('SPIKE_STEP offscreen-tab ' + JSON.stringify(result))
      if (!result.boundsUnchanged) failures.push('preparing a tab that way moved the person\'s window')
      if (!result.thePersonsTabStillOnTop) failures.push('preparing a tab that way left it above the person\'s tab')
      for (const [label, round] of Object.entries(rounds)) {
        const ready = (round as { ownPixels?: boolean }).ownPixels === true
        // `wait0ms` is the "asked before a frame could land" case: a miss there is the finding, not
        // a failure — the point of the row is that the surface is there a frame later.
        if (label === 'wait0ms') {
          if (ready) console.log('SPIKE_STEP note — the surface was ready with no wait at all')
        } else if (!ready) {
          failures.push(`${label}: moving the view to an off-screen window did not give it a surface`)
        }
      }

      manager.destroyInstance(offId)
    }

    // Phase 2 — what a parked shot does to the person's focus. The app's own window is no longer
    // shown at all (that is what parking the view bought: no reveal, no taskbar juggling, no position
    // to put back), so what is left to check is that the window which *is* shown — the parking one,
    // created outside every display with no taskbar button and shown inactive — does not take the
    // focus and does not fire a focus event for itself.
    //
    // The taskbar half of this phase used to be measured here, with the shell's own button list. It
    // is gone with the reveal: nothing of the app's window is shown for a picture any more, and the
    // parking window lives for about 40ms (created with `skipTaskbar: true`, which is the documented
    // way and read 0 buttons in the one dependable run of that probe). That probe was also not
    // dependable — later runs listed no entry for this app even with its window plainly on screen —
    // which is the other reason it is not asserted here.
    const probeId = manager.createInstance('probe', { show: true })
    const probe = (manager as any).instances.get(probeId)
    await sleep(700)
    if (!probe.window.isVisible()) probe.window.showInactive()
    const probeBack = manager.createTab(probeId, { url: page(BACK.hex, 'probe back'), activate: true })
    await sleep(800)
    manager.hide(probeId)
    await sleep(300)

    const focusEvents: string[] = []
    const onWindowFocus = (_event: unknown, window: Electron.BrowserWindow) => focusEvents.push(window.getTitle())
    app.on('browser-window-focus', onWindowFocus)
    const focusedBefore = BrowserWindow.getFocusedWindow()?.getTitle() ?? null

    const started = Date.now()
    const shot = await withTimeout(manager.screenshot(probeId, { format: 'png', includeMetadata: true }, probeBack))
    const focus = {
      ms: Date.now() - started,
      ownPixels: matches(centrePixel(shot.imageBuffer), BACK.bgra),
      focusedBefore,
      focusedAfter: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
      focusEvents,
      windowLeftHidden: !probe.window.isVisible(),
      parked: (shot.metadata?.warnings ?? []).some((warning) => warning.includes(PARKED_WARNING)),
    }
    app.off('browser-window-focus', onWindowFocus)

    console.log('SPIKE_STEP parked shot, focus ' + JSON.stringify(focus))

    if (!focus.ownPixels) failures.push('the parked shot of a hidden window did not come back with that tab\'s pixels')
    if (focus.focusedBefore !== focus.focusedAfter) failures.push('the parked shot moved the app\'s focus')
    if (focus.focusEvents.length > 0) failures.push(`the parked shot fired focus events: ${JSON.stringify(focus.focusEvents)}`)
    if (!focus.windowLeftHidden) failures.push('the person\'s window was left visible')

    // Phase 3 — who can change the size of the person's window, and who gets resized when they do
    // it. Two separate questions, both of them about the fact that every tab view is laid out at the
    // page area and Chromium keeps counting the background ones visible:
    //
    //   aPageResizingTheWindow   a page calling `window.resizeTo` — in the *background*, which is
    //                            where an agent's tab lives — and whether the person's window follows
    //   aPageMovingTheWindow     the same with `window.moveTo`
    //   backgroundTabsResized    how many `resize` events a background tab's page sees while the
    //                            person drags the window (the layout gives every tab the new bounds)
    //
    // Reported rather than asserted: these say what the platform does, and what to do about it is a
    // decision, not a measurement.
    {
      const parkId = manager.createInstance('sizes', { show: true })
      const park = (manager as any).instances.get(parkId)
      await sleep(700)
      if (!park.window.isVisible()) park.window.showInactive()
      const probePage = (colour: string) => `data:text/html;charset=UTF-8,${encodeURIComponent(
        `<html><body style="background:#${colour};margin:0"></body><script>`
        + 'window.__resizes=0;window.addEventListener("resize",()=>{window.__resizes++});'
        + '</script></html>'
      )}`
      manager.createTab(parkId, { url: probePage(FRONT.hex), activate: true })
      await sleep(800)
      const behindId = manager.createTab(parkId, { url: probePage(BACK.hex), activate: false })
      await sleep(800)
      const behind = park.tabs.find((candidate: any) => candidate.id === behindId)
      const area = (manager as any).pageAreaBounds(park)

      const windowBefore = park.window.getBounds()
      // A page in the background asking for a smaller window, exactly as a scripted one would.
      await behind.tabView.webContents.executeJavaScript('window.resizeTo(400, 300)')
      await sleep(600)
      const afterResizeTo = park.window.getBounds()
      await behind.tabView.webContents.executeJavaScript('window.moveTo(60, 60)')
      await sleep(600)
      const afterMoveTo = park.window.getBounds()

      // And what a drag does to a background tab's page.
      const resizesBefore = await behind.tabView.webContents.executeJavaScript('window.__resizes')
      const personSize = { width: windowBefore.width + 120, height: windowBefore.height + 80 }
      park.window.setBounds({ x: windowBefore.x, y: windowBefore.y, ...personSize })
      await sleep(500)
      park.window.setBounds(windowBefore)
      await sleep(500)
      const resizesAfter = await behind.tabView.webContents.executeJavaScript('window.__resizes')

      const sizes = {
        windowBefore: { x: windowBefore.x, y: windowBefore.y, width: windowBefore.width, height: windowBefore.height },
        afterResizeTo: { x: afterResizeTo.x, y: afterResizeTo.y, width: afterResizeTo.width, height: afterResizeTo.height },
        afterMoveTo: { x: afterMoveTo.x, y: afterMoveTo.y },
        thePageResizedTheWindow: afterResizeTo.width !== windowBefore.width || afterResizeTo.height !== windowBefore.height,
        thePageMovedTheWindow: afterMoveTo.x !== windowBefore.x || afterMoveTo.y !== windowBefore.y,
        backgroundTabsResized: resizesAfter - resizesBefore,
        pageArea: { width: area.width, height: area.height },
        behindTabBounds: (() => { const b = behind.tabView.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } })(),
      }
      console.log('SPIKE_STEP sizes ' + JSON.stringify(sizes))

      // The one CDP call that is about size: `Emulation.setDeviceMetricsOverride`, sent to the
      // *background* tab — a 375x812 phone viewport. Three things to know about it: does the page
      // take it, does the person resizing the window still reach the page through it, and what does a
      // capture of an overridden view look like.
      const emulation: Record<string, unknown> = {}
      try {
        behind.tabView.webContents.debugger.attach('1.3')
      } catch { /* already attached by the manager's own CDP session, or unusable — measured below */ }
      try {
        await behind.tabView.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: 375,
          height: 812,
          deviceScaleFactor: 1,
          mobile: true,
        })
        await sleep(400)
        emulation.innerWidthAfterOverride = await behind.tabView.webContents.executeJavaScript('window.innerWidth')
        emulation.visualViewportAfterOverride = await behind.tabView.webContents.executeJavaScript('window.visualViewport ? window.visualViewport.width : null')
        emulation.viewBoundsStill = (() => { const b = behind.tabView.getBounds(); return { width: b.width, height: b.height } })()

        const resizesBeforeOverrideResize = await behind.tabView.webContents.executeJavaScript('window.__resizes')
        park.window.setBounds({ x: windowBefore.x, y: windowBefore.y, width: personSize.width, height: personSize.height })
        await sleep(500)
        emulation.innerWidthAfterWindowResize = await behind.tabView.webContents.executeJavaScript('window.innerWidth')
        emulation.resizeEventsDuringOverride = (await behind.tabView.webContents.executeJavaScript('window.__resizes')) - resizesBeforeOverrideResize
        park.window.setBounds(windowBefore)
        await sleep(400)

        const shot = await withTimeout(behind.tabView.webContents.capturePage())
        emulation.captureSize = shot.isEmpty() ? 'empty' : shot.getSize()

        await behind.tabView.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
        await sleep(300)
        emulation.innerWidthAfterClear = await behind.tabView.webContents.executeJavaScript('window.innerWidth')
      } catch (error) {
        emulation.error = error instanceof Error ? error.message : String(error)
      }
      console.log('SPIKE_STEP emulation ' + JSON.stringify(emulation))

      manager.destroyInstance(parkId)
    }

    // Phase 4 — the same trick as the parked shot, but kept on: what happens to a background tab's
    // view when its bounds are moved *outside* the window's content rectangle (x negative, so it can
    // never poke back into view however the window is sized), still a child of the window, and — for
    // the second one — at an offset of its own so no two parked views overlap.
    //
    //   baseline      covered as today: stacked under the tab on screen, same bounds
    //   parked        moved out of the window's rectangle, same size
    //   parkedSecond  a second parked view, at its own offset (mutual occlusion, or not)
    //
    // What matters for the idea: does the page keep its viewport, does it keep running, and can it
    // still be captured where it is. Reported rather than asserted.
    {
      const parkId = manager.createInstance('offscreen-views', { show: true })
      const park = (manager as any).instances.get(parkId)
      await sleep(700)
      if (!park.window.isVisible()) park.window.showInactive()
      manager.createTab(parkId, { url: movingPage(FRONT.hex), activate: true })
      await sleep(800)
      const firstId = manager.createTab(parkId, { url: movingPage(BACK.hex), activate: false })
      await sleep(800)
      const secondId = manager.createTab(parkId, { url: movingPage(BACK.hex), activate: false })
      await sleep(800)
      const first = park.tabs.find((candidate: any) => candidate.id === firstId)
      const second = park.tabs.find((candidate: any) => candidate.id === secondId)
      const area = (manager as any).pageAreaBounds(park)

      const views: Record<string, unknown> = {}
      // Covered, the way it is today.
      views.baselineCovered = { bounds: (() => { const b = first.tabView.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } })(), ...(await readTab(first)) }

      // Outside the window's rectangle, same size, still in the tree, at an offset of its own.
      first.tabView.setBounds({ x: -10000, y: 0, width: area.width, height: area.height })
      second.tabView.setBounds({ x: -20000, y: 0, width: area.width, height: area.height })
      await sleep(500)
      views.parkedFirst = { bounds: (() => { const b = first.tabView.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } })(), ...(await readTab(first)) }
      views.parkedSecond = { bounds: (() => { const b = second.tabView.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } })(), ...(await readTab(second)) }

      // …and the same two at one shared spot, in case what Chromium does with them depends on
      // whether they overlap each other.
      first.tabView.setBounds({ x: -10000, y: 0, width: area.width, height: area.height })
      second.tabView.setBounds({ x: -10000, y: 0, width: area.width, height: area.height })
      await sleep(500)
      views.stackParked = { first: await readTab(first), second: await readTab(second) }

      // Does the tab on screen still work while they sit out there? It has to.
      const front = park.tabs[0]
      views.frontWhileOthersParked = await readTab(front)

      console.log('SPIKE_STEP offscreen views ' + JSON.stringify(views))
      if (views.frontWhileOthersParked.innerWidth !== area.width) {
        failures.push('the tab on screen lost its viewport while the others were parked outside the window')
      }

      manager.destroyInstance(parkId)
    }

    // Phase 5 — the other way to be off screen, and the one the parked shot uses: a *window* that
    // sits outside every display and is shown. The evidence there (38ms, own pixels) says a view in
    // one gets a surface; the view in phase 4 was only outside its own window's rectangle, which
    // Chromium treats as hidden (no surface, no frames). This keeps a background tab's view in such a
    // window for good, which is what it would take to have background tabs be real, live, shootable
    // tabs that no window resize can disturb:
    //
    //   alone     one view in it
    //   top       two views stacked there — the one on top
    //   bottom    …and the one underneath, which is where "no two parked views overlap" would come in
    //   beside    two views side by side instead, so neither covers the other
    //
    // And whether they see the person resizing their window (they should not: nothing tells them).
    {
      const id = manager.createInstance('off-display', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      manager.createTab(id, { url: movingPage(FRONT.hex), activate: true })
      await sleep(800)
      const bgId = manager.createTab(id, { url: movingPage(BACK.hex), activate: false })
      await sleep(800)
      const bg = instance.tabs.find((candidate: any) => candidate.id === bgId)
      const pageArea = (manager as any).pageAreaBounds(instance)

      const holder = new BrowserWindow({
        x: offScreen.x,
        y: offScreen.y,
        width: pageArea.width + 40,
        height: pageArea.height + 40,
        show: false,
        frame: false,
        skipTaskbar: true,
      })
      holder.contentView.addChildView(bg.tabView)
      bg.tabView.setBounds({ x: 0, y: 0, width: pageArea.width, height: pageArea.height })
      holder.showInactive()
      await sleep(120)

      const offDisplay: Record<string, unknown> = {}
      offDisplay.holderIsOffEveryDisplay = !onADisplay(holder.getBounds())
      offDisplay.alone = await readTab(bg)
      // The rows phase 6 shows are dead in a background tab of the person's window: the frame count
      // says the rendering lifecycle runs here, and an IntersectionObserver rides that same
      // lifecycle — so this is the one to check.
      await bg.tabView.webContents.executeJavaScript('window.scrollTo(0, 4000)')
      await sleep(600)
      offDisplay.intersectionInHolder = await bg.tabView.webContents.executeJavaScript('window.__io')

      // A second background tab, handed to the same off-screen window — first stacked on top of the
      // first, then beside it.
      const secondBgId = manager.createTab(id, { url: movingPage(BACK.hex), activate: false })
      await sleep(800)
      const secondBg = instance.tabs.find((candidate: any) => candidate.id === secondBgId)
      holder.contentView.addChildView(secondBg.tabView)
      secondBg.tabView.setBounds({ x: 0, y: 0, width: pageArea.width, height: pageArea.height })
      await sleep(400)
      offDisplay.stackedTop = await readTab(secondBg)
      offDisplay.stackedBottom = await readTab(bg)

      secondBg.tabView.setBounds({ x: pageArea.width + 20, y: 0, width: pageArea.width, height: pageArea.height })
      await sleep(400)
      offDisplay.besideSecond = await readTab(secondBg)
      offDisplay.besideFirst = await readTab(bg)

      // The person resizes their window. Nothing was told to these views, so they should not move or
      // resize — but the manager's own layout may reach them anyway, which is the thing a real
      // implementation would have to keep it from doing.
      const beforeResize = { first: await readTab(bg), second: await readTab(secondBg) }
      const home = instance.window.getBounds()
      instance.window.setBounds({ x: home.x, y: home.y, width: home.width - 160, height: home.height - 120 })
      await sleep(500)
      const afterResize = { first: await readTab(bg), second: await readTab(secondBg) }
      offDisplay.personResize = {
        firstResizes: afterResize.first.resizes - beforeResize.first.resizes,
        secondResizes: afterResize.second.resizes - beforeResize.second.resizes,
        firstBounds: (() => { const b = bg.tabView.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } })(),
        firstInnerWidth: afterResize.first.innerWidth,
      }
      instance.window.setBounds(home)
      await sleep(400)

      console.log('SPIKE_STEP off-display holder ' + JSON.stringify(offDisplay))

      holder.hide()
      holder.destroy()
      manager.destroyInstance(id)
    }

    // Phase 6 — what `hidden: true` and no surface cost *automation*, on a background tab exactly as
    // it is today (covered in the person's window). Screenshots are the known one; these are the
    // primitives the agent actually drives pages with:
    //
    //   evaluate            `Runtime.evaluate` — the tool everything else is built on
    //   accessibilityTree   `Accessibility.getFullAXTree` — what `snapshot` reads
    //   clickByCdp          `Input.dispatchMouseEvent` at the button's own box — what `click` does
    //   waitsForAFrame      `await new Promise(r => requestAnimationFrame(r))` — the idiom any
    //                       "wait until it has painted" helper uses, ours or a page's own
    //   intersection        an IntersectionObserver firing on a sentinel scrolled into view — how
    //                       lazy loading and "load more on scroll" work
    //   focusState          `document.hasFocus()` — pages that gate behaviour on it
    {
      const id = manager.createInstance('automation', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      const automationPage = `data:text/html;charset=UTF-8,${encodeURIComponent(`
        <html><body style="margin:0">
          <button id="btn" style="position:absolute;left:40px;top:40px;width:200px;height:80px">go</button>
          <div id="sentinel" style="position:absolute;top:4000px;left:0;width:100px;height:40px"></div>
          <div style="height:5000px"></div>
          <script>
            window.__clicks = 0
            document.getElementById('btn').addEventListener('click', () => { window.__clicks++ })
            window.__io = 0
            new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) window.__io++ })
              .observe(document.getElementById('sentinel'))
            window.__frames = 0
            ;(function loop(){ window.__frames++; requestAnimationFrame(loop) })()
          </script>
        </body></html>
      `)}`
      manager.createTab(id, { url: automationPage, activate: true })
      await sleep(600)
      const onScreen = instance.tabs[0]
      const bgId = manager.createTab(id, { url: automationPage, activate: false })
      await sleep(900)
      const bg = instance.tabs.find((candidate: any) => candidate.id === bgId)

      const probe = async (tab: any, label: string) => {
        const wc = tab.tabView.webContents
        const result: Record<string, unknown> = { label }

        // Everything in this file already proves `evaluate` answers; the visibility state is what
        // makes the difference for the rest of the rows.
        result.visibility = await wc.executeJavaScript('document.visibilityState')
        result.hasFocus = await wc.executeJavaScript('document.hasFocus()')

        try {
          await wc.debugger.attach('1.3')
        } catch { /* the manager's session may hold it already */ }
        try {
          const ax = await withTimeout(wc.debugger.sendCommand('Accessibility.getFullAXTree') as Promise<any>)
          result.accessibilityNodes = Array.isArray(ax?.nodes) ? ax.nodes.length : `unexpected: ${JSON.stringify(ax)?.slice(0, 60)}`
        } catch (error) {
          result.accessibilityNodes = `error: ${error instanceof Error ? error.message : String(error)}`
        }

        // A click on the button's own box, the way `click` sends one.
        try {
          const box = await wc.executeJavaScript('(() => { const r = document.getElementById("btn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()')
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
          await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
          await sleep(300)
          result.clicksLanded = await wc.executeJavaScript('window.__clicks')
        } catch (error) {
          result.clicksLanded = `error: ${error instanceof Error ? error.message : String(error)}`
        }

        // The "wait until it has painted" idiom, with a bound of its own so this row cannot hang.
        try {
          await withTimeout(wc.executeJavaScript('new Promise((r) => requestAnimationFrame(() => r("a frame came")))') as Promise<string>)
          result.waitsForAFrame = 'a frame came'
        } catch (error) {
          result.waitsForAFrame = `never came (${error instanceof Error ? error.message : String(error)})`
        }

        // Scrolling to a sentinel: does the observer see it?
        try {
          await wc.executeJavaScript('window.scrollTo(0, 4000)')
          await sleep(500)
          result.intersectionFired = await wc.executeJavaScript('window.__io')
        } catch (error) {
          result.intersectionFired = `error: ${error instanceof Error ? error.message : String(error)}`
        }

        result.framesPer500ms = await (async () => {
          const a = await wc.executeJavaScript('window.__frames')
          await sleep(500)
          return (await wc.executeJavaScript('window.__frames')) - a
        })()

        return result
      }

      const automation: Record<string, unknown> = {
        onScreenTab: await probe(onScreen, 'on screen'),
        backgroundTab: await probe(bg, 'background'),
      }
      console.log('SPIKE_STEP automation ' + JSON.stringify(automation))

      // The one that must hold: `evaluate` has to answer on a background tab, whatever else does not.
      if (typeof (automation.backgroundTab as any).accessibilityNodes === 'string'
        && ((automation.backgroundTab as any).accessibilityNodes as string).startsWith('error')) {
        console.log('SPIKE_STEP automation note — the accessibility tree could not be read on a background tab')
      }

      manager.destroyInstance(id)
    }

    // Phase 7 — why the tab in the background is the one reporting `document.hasFocus()`. Two
    // explanations, and three tabs tell them apart: either "background tabs are focused and the one
    // on screen is not", or "the last view created holds it" (the agent's tabs are created with
    // `activate: false`, so the newest one is always a background one). A: activated, B and C
    // created after it without activating, so the second reading of A says whether activating a tab
    // moves the focus at all. The chrome views are read too, since one of them could be holding it.
    {
      const id = manager.createInstance('focus-probe', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      const simple = (colour: string) => `data:text/html;charset=UTF-8,${encodeURIComponent(
        `<html><body style="background:#${colour};margin:0">x</body></html>`
      )}`
      const a = manager.createTab(id, { url: simple(FRONT.hex), activate: true })
      await sleep(700)
      const b = manager.createTab(id, { url: simple(BACK.hex), activate: false })
      await sleep(700)
      const c = manager.createTab(id, { url: simple(BACK.hex), activate: false })
      await sleep(700)

      const tabOf = (tabId: string) => instance.tabs.find((candidate: any) => candidate.id === tabId)
      const look = async (label: string, wc: any) => {
        let hasFocus: unknown
        let activeElement: unknown
        try {
          hasFocus = await wc.executeJavaScript('document.hasFocus()')
          activeElement = await wc.executeJavaScript('document.activeElement ? document.activeElement.tagName : null')
        } catch (error) {
          hasFocus = `error: ${error instanceof Error ? error.message : String(error)}`
        }
        return { label, hasFocus, activeElement, electronIsFocused: wc.isFocused() }
      }

      const focus: Record<string, unknown> = {}
      focus.createdOrder = 'A activated, then B, then C (both without activating)'
      focus.tabs = [
        await look('A (activated first)', tabOf(a).tabView.webContents),
        await look('B (created second)', tabOf(b).tabView.webContents),
        await look('C (created last)', tabOf(c).tabView.webContents),
      ]
      focus.tabOnScreen = instance.activeTabId === a ? 'A' : instance.activeTabId === b ? 'B' : 'C'
      focus.window = {
        focusedWindowOfTheApp: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
        theWindowItselfIsFocused: instance.window.isFocused(),
      }
      focus.chromeViews = {
        toolbar: await look('toolbar', instance.toolbarView.webContents),
        rail: await look('rail', instance.railView.webContents),
        overlay: instance.nativeOverlayReady ? await look('overlay', instance.nativeOverlayView.webContents) : 'not ready',
      }

      // Activating A again: does anything focus the tab that is now on screen?
      manager.activateTab(id, a)
      await sleep(600)
      focus.afterActivatingA = [
        await look('A (now on screen)', tabOf(a).tabView.webContents),
        await look('C (still background)', tabOf(c).tabView.webContents),
      ]

      console.log('SPIKE_STEP focus ' + JSON.stringify(focus, null, 1))
      manager.destroyInstance(id)
    }

    // Phase 8 — whose doing "the newest view holds the focus" is, whether it can be kept off a
    // background tab, and what that changes.
    //
    //   8a  bare `WebContentsView`s of our own, read **before** and **after** they are added to a
    //       window — once with that window inactive, once with it active: if attaching is what focuses
    //       a view, this is Electron's doing and not ours, and it would say whether the *newest* view
    //       winning is the same mechanism
    //   8b  after the manager creates a background tab, focusing the tab on screen instead — does
    //       `hasFocus` move, does the app steal the person's window focus
    //   8c  where the keyboard actually goes. `before-input-event` is the one place a webContents
    //       reports keys routed to *it*, so a synthesized key press from the OS says which view the
    //       window sends typing to — as it is today, and with the tab on screen focused
    //   8d  a tab created the way the agent's are (behind, `activate: false`) **while the window is
    //       genuinely behind another window**, read from behind so the reading cannot be confused with
    //       "the window was in front at the time"
    {
      const ordering: Record<string, unknown> = {}
      const bareWindow = new BrowserWindow({
        x: offScreen.x, y: offScreen.y + 600, width: 500, height: 400, show: false, frame: false, skipTaskbar: true,
      })
      const bare = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
      ordering.bareViewIsFocusedOnCreation = bare.webContents.isFocused()
      bareWindow.contentView.addChildView(bare)
      bare.setBounds({ x: 0, y: 0, width: 500, height: 400 })
      bareWindow.showInactive()
      await sleep(400)
      ordering.bareViewIsFocusedAfterAttaching = bare.webContents.isFocused()

      // The same thing with the window **active**: is it attaching, or attaching *into the window
      // that is in front*? A second view is added, and both are read.
      bareWindow.focus()
      await sleep(400)
      ordering.bareWindowIsFocusedBeforeSecondView = bareWindow.isFocused()
      const bareSecond = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
      bareWindow.contentView.addChildView(bareSecond)
      bareSecond.setBounds({ x: 0, y: 0, width: 500, height: 400 })
      await sleep(500)
      ordering.firstBareViewIsFocusedAfterSecondAttached = bare.webContents.isFocused()
      ordering.secondBareViewIsFocusedAfterAttaching = bareSecond.webContents.isFocused()
      bareWindow.destroy()

      // A window of the manager's own, with the tab the person is on, then an agent's tab behind it.
      const id = manager.createInstance('focus-fix', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      const simple = (colour: string) => `data:text/html;charset=UTF-8,${encodeURIComponent(
        `<html><body style="background:#${colour};margin:0">x</body></html>`
      )}`
      const onScreenId = manager.createTab(id, { url: simple(FRONT.hex), activate: true })
      await sleep(700)
      const behindId = manager.createTab(id, { url: simple(BACK.hex), activate: false })
      await sleep(700)
      const tabOf = (tabId: string) => instance.tabs.find((candidate: any) => candidate.id === tabId)
      const onScreenTab = tabOf(onScreenId)
      const behindTab = tabOf(behindId)

      const keys: Record<string, number> = { windowItself: 0, toolbar: 0, rail: 0, onScreen: 0, behind: 0 }
      const listen = (label: string, wc: any) => wc.on('before-input-event', () => { keys[label] = (keys[label] ?? 0) + 1 })
      listen('windowItself', instance.window.webContents)
      listen('toolbar', instance.toolbarView.webContents)
      listen('rail', instance.railView.webContents)
      listen('onScreen', onScreenTab.tabView.webContents)
      listen('behind', behindTab.tabView.webContents)

      const pressAKey = () => {
        try {
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("x")'],
          { encoding: 'utf8', windowsHide: true })
          return 'sent'
        } catch (error) {
          return `could not send: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const whereTypingGoes = async () => {
        for (const key of Object.keys(keys)) keys[key] = 0
        instance.window.focus()
        await sleep(400)
        const sent = pressAKey()
        await sleep(500)
        return { sent, ...keys }
      }

      const focusFix: Record<string, unknown> = { ordering }
      focusFix.asItIsToday = {
        onScreenTabHasFocus: await onScreenTab.tabView.webContents.executeJavaScript('document.hasFocus()'),
        behindTabHasFocus: await behindTab.tabView.webContents.executeJavaScript('document.hasFocus()'),
        typing: await whereTypingGoes(),
      }

      // The change: focus the tab that is on screen, and see what moves.
      onScreenTab.tabView.webContents.focus()
      await sleep(500)
      focusFix.afterFocusingTheOnScreenTab = {
        focusedWindowWhileFocused: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
        theBrowserWindowIsFocused: instance.window.isFocused(),
        onScreenTabHasFocus: await onScreenTab.tabView.webContents.executeJavaScript('document.hasFocus()'),
        behindTabHasFocus: await behindTab.tabView.webContents.executeJavaScript('document.hasFocus()'),
        onScreenTabElectronIsFocused: onScreenTab.tabView.webContents.isFocused(),
        behindTabElectronIsFocused: behindTab.tabView.webContents.isFocused(),
        typing: await whereTypingGoes(),
      }

      // Does focusing a page *activate* its window? A window that is not in front must not be brought
      // in front for an agent's command — so the browser window is put behind another of the app's
      // windows (titled, so the readings cannot be confused) and the page is focused from there.
      const otherWindow = new BrowserWindow({ x: offScreen.x, y: offScreen.y + 900, width: 300, height: 200, show: true })
      otherWindow.setTitle('OTHER-WINDOW')
      await sleep(400)
      otherWindow.focus()
      await sleep(500)
      const focusedBefore = BrowserWindow.getFocusedWindow()?.getTitle() ?? null
      const browserWindowFocusedBefore = instance.window.isFocused()
      onScreenTab.tabView.webContents.focus()
      await sleep(500)
      focusFix.focusingAPageWhileAnotherWindowIsInFront = {
        focusedBefore,
        browserWindowFocusedBefore,
        focusedAfter: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
        theBrowserWindowCameForward: instance.window.isFocused(),
        onScreenTabHasFocus: await onScreenTab.tabView.webContents.executeJavaScript('document.hasFocus()'),
      }

      // Whose doing is it — attaching a view, or the window being in front when it is attached? The
      // other window is put back in front (the read above brought the browser window forward, so
      // without this the next reading would be taken with the browser window active, not behind it),
      // and a tab is created the way the agent's tabs are. Both windows are read first, so the
      // reading is known to be taken from behind.
      otherWindow.focus()
      await sleep(500)
      const beforeCreatingBehind = {
        focusedWindow: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
        theBrowserWindowIsFocused: instance.window.isFocused(),
      }
      const whileBlurredId = manager.createTab(id, { url: simple(BACK.hex), activate: false })
      await sleep(800)
      focusFix.aTabCreatedWhileTheWindowIsBehind = {
        ...beforeCreatingBehind,
        newTabElectronIsFocused: tabOf(whileBlurredId).tabView.webContents.isFocused(),
        newTabHasFocus: await tabOf(whileBlurredId).tabView.webContents.executeJavaScript('document.hasFocus()'),
        onScreenTabElectronIsFocused: onScreenTab.tabView.webContents.isFocused(),
        behindTabElectronIsFocused: behindTab.tabView.webContents.isFocused(),
      }
      otherWindow.destroy()

      console.log('SPIKE_STEP focus fix ' + JSON.stringify(focusFix, null, 1))

      // Reported, not asserted: these are about focus, which the screenshot work does not depend on —
      // and one of them (focusing a page brings its window forward) is the reason the obvious fix
      // cannot be used as it is.
      const wentNowhere = focusFix.afterFocusingTheOnScreenTab.typing
      if (focusFix.afterFocusingTheOnScreenTab.onScreenTabHasFocus !== true) {
        console.log('SPIKE_STEP focus note — focusing the tab on screen did not give its page focus')
      }
      if (focusFix.afterFocusingTheOnScreenTab.behindTabHasFocus !== false) {
        console.log('SPIKE_STEP focus note — the background tab still reports focus after that')
      }
      if (focusFix.focusingAPageWhileAnotherWindowIsInFront.theBrowserWindowCameForward) {
        console.log('SPIKE_STEP focus note — `webContents.focus()` brings its window to the front, so it cannot be used on a tab for a background command')
      }
      if ((wentNowhere as any).onScreen === 0) {
        console.log('SPIKE_STEP focus note — the synthesized key reached no page, so which view the window sends typing to was not settled')
      }

      manager.destroyInstance(id)
    }

    // Phase 9 — the accounting for the **person's own tab**. A shot of a background tab parks that
    // tab's view in another window and hands it straight back; this asks whether that moves the page
    // focus — off the tab the person activated, or onto the agent's tab — and whether the front
    // window changes. Read before, while the shot is in flight (the parked stretch is ~40–150ms, so
    // the synchronous `isFocused()` is sampled every 8ms), and after.
    {
      const id = manager.createInstance('front-tab', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      const simple = (colour: string, label: string) => page(colour, label)
      const tabOf = (tabId: string) => instance.tabs.find((candidate: any) => candidate.id === tabId)
      const pageFocus = async (wc: any) => ({
        hasFocus: await wc.executeJavaScript('document.hasFocus()').catch((error: unknown) => `error: ${String(error)}`),
        electronIsFocused: wc.isFocused(),
      })

      const personTab = manager.createTab(id, { url: simple(FRONT.hex, FRONT.label), activate: true })
      await sleep(700)
      const agentTab = manager.createTab(id, { url: simple(BACK.hex, BACK.label), activate: false })
      await sleep(700)
      const personWc = tabOf(personTab).tabView.webContents
      const agentWc = tabOf(agentTab).tabView.webContents

      const run = async (windowState: 'visible' | 'hidden') => {
        instance.window.focus()
        await sleep(400)
        if (windowState === 'hidden') {
          instance.window.hide()
          await sleep(500)
        }
        const before = {
          frontWindow: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
          windowIsFocused: instance.window.isFocused(),
          theTabOnScreen: await pageFocus(personWc),
          theAgentTabBehind: await pageFocus(agentWc),
        }

        const samples: Array<Record<string, unknown>> = []
        let inFlight = true
        const sampler = (async () => {
          while (inFlight) {
            samples.push({ person: personWc.isFocused(), agent: agentWc.isFocused(), window: instance.window.isFocused() })
            await sleep(8)
          }
        })()
        const started = Date.now()
        const shot = await withTimeout(manager.screenshot(id, { format: 'png', includeMetadata: true }, agentTab))
        inFlight = false
        await sampler

        const pixel = centrePixel(shot.imageBuffer)
        const warnings = shot.metadata?.warnings ?? []
        // Two controls for those pixels: the same tab read straight from its own webContents, with
        // none of the manager's machinery (if that answers with the page's colour, the two paths
        // differ — not the tab), and what the page itself says it painted.
        let rawPixel: unknown
        try {
          rawPixel = centrePixel((await withTimeout(agentWc.capturePage())).toPNG())
        } catch (error) {
          rawPixel = `no answer (${error instanceof Error ? error.message : String(error)})`
        }
        const thePageItself = await agentWc
          .executeJavaScript('getComputedStyle(document.body).backgroundColor + "|" + document.body.innerText.trim()')
          .catch((error: unknown) => `error: ${String(error)}`)
        const after = {
          ms: Date.now() - started,
          bytes: shot.imageBuffer.length,
          centrePixel: pixel,
          ownPixels: matches(pixel, BACK.bgra),
          notThePersonsTab: !matches(pixel, FRONT.bgra),
          parked: warnings.some((warning) => warning.includes(PARKED_WARNING)),
          warnings,
          rawFromTheWebContents: rawPixel,
          thePageItself,
          frontWindow: BrowserWindow.getFocusedWindow()?.getTitle() ?? null,
          windowIsFocused: instance.window.isFocused(),
          theTabOnScreen: await pageFocus(personWc),
          theAgentTabBehind: await pageFocus(agentWc),
        }
        return {
          before,
          after,
          samples: samples.length,
          samplesWhereTheAgentTabHeldIt: samples.filter((s) => s.agent === true && s.person === false).length,
          samplesWhereThePersonsTabHeldIt: samples.filter((s) => s.person === true && s.agent === false).length,
          samplesWhereTheWindowWasNotFocused: samples.filter((s) => s.window === false).length,
        }
      }

      const front: Record<string, unknown> = {
        visibleWindow: await run('visible'),
        // Again, with the agent's tab now composited once: if the pixels differ between this and the
        // first run, it is the never-composited path that answers differently, not the parking.
        visibleWindowAgain: await run('visible'),
        hiddenWindow: await run('hidden'),
      }
      console.log('SPIKE_STEP front tab ' + JSON.stringify(front, null, 1))
      manager.destroyInstance(id)
    }

    // Phase 10 — who hands a new view the focus, and what a tab switch ought to do about it.
    //
    //   10a  a bare view of our own in a window that is already in front: attached, then navigated.
    //        If the *navigation* is what takes the focus, that is Chromium's doing — an attached view
    //        that never loads anything does not take it (phase 8a)
    //   10b  the app's own window, with the cursor in a field on the tab the person is on: what
    //        creating an agent's tab behind it does to that cursor, and what switching away and back
    //        does. Each tab keeps its own focused element, so coming back to a tab is expected to
    //        come back to where the person was — that is what a browser does
    {
      const mechanism: Record<string, unknown> = {}
      const bareWindow = new BrowserWindow({
        x: offScreen.x, y: offScreen.y + 1200, width: 420, height: 320, show: false, frame: false, skipTaskbar: true,
      })
      bareWindow.showInactive()
      await sleep(300)
      bareWindow.focus()
      await sleep(400)
      mechanism.theWindowIsInFront = bareWindow.isFocused()
      const bareFirst = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
      bareWindow.contentView.addChildView(bareFirst)
      bareFirst.setBounds({ x: 0, y: 0, width: 420, height: 320 })
      await bareFirst.webContents.loadURL(page('#00ff00', 'the first view'))
      await sleep(400)
      mechanism.theFirstViewIsFocusedOnceLoaded = bareFirst.webContents.isFocused()
      const bareSecond = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
      bareWindow.contentView.addChildView(bareSecond)
      bareSecond.setBounds({ x: 0, y: 0, width: 420, height: 320 })
      mechanism.theFirstViewIsFocusedAfterTheSecondWasAttached = bareFirst.webContents.isFocused()
      mechanism.theSecondViewIsFocusedAfterAttaching = bareSecond.webContents.isFocused()
      await bareSecond.webContents.loadURL(page('#00ff00', 'the second view'))
      await sleep(500)
      mechanism.theFirstViewIsFocusedAfterTheSecondLoaded = bareFirst.webContents.isFocused()
      mechanism.theSecondViewIsFocusedAfterLoading = bareSecond.webContents.isFocused()
      bareWindow.destroy()

      const id = manager.createInstance('focus-order', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      instance.window.focus()
      await sleep(400)

      const form = (colour: string) => `data:text/html;charset=UTF-8,${encodeURIComponent(
        `<!doctype html><html><head><meta charset="utf-8">`
        + `<style>html,body{margin:0;width:100%;height:100%;background:${colour}}</style></head><body>`
        + `<input id="field" style="margin:60px;width:200px">`
        + `<p id="note" style="font:14px sans-serif;color:#fff">the field has never had the cursor</p>`
        + `<script>const field=document.getElementById("field");const note=document.getElementById("note");`
        + `field.addEventListener("focus",()=>{note.textContent="the cursor is in the field"});`
        + `field.addEventListener("blur",()=>{note.textContent="the cursor left the field"})</script></body></html>`)}`
      const tabOf = (tabId: string) => instance.tabs.find((candidate: any) => candidate.id === tabId)
      const look = async (wc: any) => ({
        hasFocus: await wc.executeJavaScript('document.hasFocus()').catch((error: unknown) => `error: ${String(error)}`),
        isFocused: wc.isFocused(),
        activeElement: await wc
          .executeJavaScript('document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null')
          .catch((error: unknown) => `error: ${String(error)}`),
        // The page's own note, so the readings above are not the only witness:
        theNote: await wc.executeJavaScript('document.getElementById("note").textContent').catch(() => null),
      })

      const personTab = manager.createTab(id, { url: form(FRONT.hex), activate: true })
      await sleep(800)
      const personWc = tabOf(personTab).tabView.webContents
      // The person puts the cursor in the field.
      await personWc.executeJavaScript('document.getElementById("field").focus()')
      await sleep(300)
      const order: Record<string, unknown> = { mechanism, beforeTheAgentOpensATab: await look(personWc) }

      const agentTab = manager.createTab(id, { url: form(BACK.hex), activate: false })
      await sleep(800)
      const agentWc = () => tabOf(agentTab).tabView.webContents
      order.afterTheAgentOpenedATabBehindIt = { theTabOnScreen: await look(personWc), theAgentTab: await look(agentWc()) }

      manager.activateTab(id, agentTab)
      await sleep(600)
      order.afterSwitchingToTheAgentTab = { thePersonTab: await look(personWc), theAgentTab: await look(agentWc()) }

      manager.activateTab(id, personTab)
      await sleep(600)
      order.afterSwitchingBackToThePersonsTab = { thePersonTab: await look(personWc), theAgentTab: await look(agentWc()) }

      // …and the same question one step on: the tab on screen is closed, so what the window
      // shows next has to take the keyboard, or the person is left typing nowhere.
      manager.closeTab(id, personTab)
      await sleep(700)
      order.afterClosingTheTabOnScreen = { theTabThatTookOver: await look(agentWc()) }
      order.theFrontWindowAtTheEnd = BrowserWindow.getFocusedWindow()?.getTitle() ?? null

      console.log('SPIKE_STEP focus order ' + JSON.stringify(order, null, 1))

      // The two things a person notices, **asserted** rather than reported: opening a tab behind
      // theirs must not take the keyboard off their page, and switching back to their tab must give
      // it back. Both were wrong once — the keyboard was asked for *before* the view was moved into
      // the window, and the move dropped it (the app's own tab strip goes through `activateTab`).
      const openedBehind = order.afterTheAgentOpenedATabBehindIt as any
      const switchedBack = order.afterSwitchingBackToThePersonsTab as any
      if (openedBehind.theTabOnScreen.hasFocus !== true) {
        failures.push('a tab opened behind took the keyboard off the tab on screen')
      }
      if (switchedBack.thePersonTab.hasFocus !== true) {
        failures.push('switching back to the person\'s tab did not give its page the keyboard')
      }
      if (switchedBack.theAgentTab.hasFocus !== false) {
        failures.push('the tab that is not on screen kept the keyboard after switching back')
      }
      manager.destroyInstance(id)
    }

    // Phase 11 — a tab that is not on screen lives in the **parking window** and keeps the viewport
    // it was opened at. The person resizing their window must not reach it (primitives measured in
    // `background-viewport.ts`); this is the same question through the manager, plus what the freeze
    // does to a shot of that tab and whether the parking window is invisible to the person.
    {
      const id = manager.createInstance('frozen-viewport', { show: true })
      const instance = (manager as any).instances.get(id)
      await sleep(700)
      if (!instance.window.isVisible()) instance.window.showInactive()
      const personTab = manager.createTab(id, { url: page(FRONT.hex, FRONT.label), activate: true })
      await sleep(800)
      const agentTab = manager.createTab(id, { url: page(BACK.hex, BACK.label), activate: false })
      await sleep(800)
      const tabOf = (tabId: string) => instance.tabs.find((candidate: any) => candidate.id === tabId)
      const personWc = tabOf(personTab).tabView.webContents
      const agentWc = tabOf(agentTab).tabView.webContents
      for (const wc of [personWc, agentWc]) {
        await wc.executeJavaScript('window.__resizes = 0; window.addEventListener("resize", () => { window.__resizes++ })')
      }
      const sizeOf = async (wc: any) => ({
        innerWidth: await wc.executeJavaScript('window.innerWidth'),
        innerHeight: await wc.executeJavaScript('window.innerHeight'),
        resizes: await wc.executeJavaScript('window.__resizes'),
        hidden: await wc.executeJavaScript('document.hidden'),
        viewBounds: (() => {
          const tab = wc === personWc ? tabOf(personTab) : tabOf(agentTab)
          return tab.tabView.getBounds()
        })(),
      })

      const frozen: Record<string, unknown> = {
        before: { theTabOnScreen: await sizeOf(personWc), theAgentTab: await sizeOf(agentWc) },
        theParkingWindow: (() => {
          const parking = instance.parkingWindow
          if (!parking) return 'none'
          const displays = screen.getAllDisplays()
          const [x] = parking.getPosition()
          return {
            isVisible: parking.isVisible(),
            isFocused: parking.isFocused(),
            x,
            offEveryDisplay: displays.every((display) => x >= display.bounds.x + display.bounds.width
              || x + parking.getContentSize()[0] <= display.bounds.x),
            holdsTheParkedTab: parking.contentView.children.includes(tabOf(agentTab).tabView),
            thePersonsWindowDoesNot: !instance.window.contentView.children.includes(tabOf(agentTab).tabView),
          }
        })(),
      }
      // The person drags the window bigger, through the same call the app's own resize uses.
      frozen.promised = manager.windowResize(id, 1200, 900)
      await sleep(700)
      frozen.afterTheWindowGrew = { theTabOnScreen: await sizeOf(personWc), theAgentTab: await sizeOf(agentWc) }

      // The shot of the tab that is not on screen: taken from a parked view built to *its* size, so
      // the page's viewport does not change for it.
      const started = Date.now()
      const shot = await withTimeout(manager.screenshot(id, { format: 'png', includeMetadata: true }, agentTab))
      frozen.theShotOfTheAgentTab = {
        ms: Date.now() - started,
        imageSize: nativeImage.createFromBuffer(shot.imageBuffer).getSize(),
        ownPixels: matches(centrePixel(shot.imageBuffer), BACK.bgra),
        parked: (shot.metadata?.warnings ?? []).some((warning: string) => warning.includes(PARKED_WARNING)),
        afterTheShot: await sizeOf(agentWc),
      }

      // …and coming forward is where it gets the window's size: one resize, then.
      manager.activateTab(id, agentTab)
      await sleep(700)
      frozen.afterComingForward = { theTabOnScreen: await sizeOf(personWc), theAgentTab: await sizeOf(agentWc) }

      // The other direction: the person makes the window *smaller* than the viewport the tab that is
      // not on screen still has. Nothing of that tab can be exposed, because it is not in the
      // person's window at all — which is the point of housing it in a window of its own, and better
      // than either clamping it or moving it outside the window (a view outside its window gets an
      // empty viewport: `background-viewport.ts` section E).
      manager.activateTab(id, personTab)
      await sleep(500)
      manager.windowResize(id, 700, 500)
      await sleep(700)
      frozen.afterTheWindowShrank = {
        theTabOnScreen: await sizeOf(personWc),
        theAgentTab: await sizeOf(agentWc),
        thePersonsWindowDoesNotHoldTheAgentTab: !instance.window.contentView.children.includes(tabOf(agentTab).tabView),
      }

      console.log('SPIKE_STEP frozen viewport ' + JSON.stringify(frozen, null, 1))
      manager.destroyInstance(id)
    }

    console.log('SPIKE_JSON ' + JSON.stringify({ rows, failures, focus }))
    console.log(failures.length === 0 ? '\nSPIKE_OK — every combination came back with its own tab, unseen and unfelt' : `\nSPIKE_FAILURES ${JSON.stringify(failures, null, 2)}`)

    manager.destroyInstance(probeId)
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && (error as Error).stack ? (error as Error).stack : String(error)))
    app.exit(2)
  }
})
