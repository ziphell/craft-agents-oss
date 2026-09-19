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
import { app, BrowserWindow, nativeImage, screen } from 'electron'
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

app.whenReady().then(async () => {
  setTimeout(() => {
    console.log('SPIKE_WATCHDOG — a screenshot never came back')
    app.exit(3)
  }, 90_000)

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
    // surface, does the whole "show the window" machinery need to exist at all? A hidden window with
    // a tab that has never been composited, shot three ways. Each row gets its own window and tab —
    // once a tab has been composited it keeps its surface and would answer for the next row.
    //
    //   capturedWhileParkedNotShown  view handed to an off-screen window that is **never shown**,
    //                                captured there (nothing is displayed anywhere, by anyone)
    //   capturedWhileParkedShown     the same, with the parking window shown off screen
    //   capturedAfterHandingBack     given its first frame off screen, handed back into the hidden
    //                                window, then captured — to know whether the capture has to
    //                                happen while the view is parked
    {
      const attempts: Record<string, unknown> = {}
      for (const how of ['capturedWhileParkedNotShown', 'capturedWhileParkedShown', 'capturedAfterHandingBack'] as const) {
        const caseId = manager.createInstance(`park-${how}`, { show: true })
        const caseInstance = (manager as any).instances.get(caseId)
        await sleep(700)
        if (!caseInstance.window.isVisible()) caseInstance.window.showInactive()
        manager.createTab(caseId, { url: page(FRONT.hex, 'park front'), activate: true })
        await sleep(800)
        manager.hide(caseId)
        await sleep(300)
        const freshId = manager.createTab(caseId, { url: page(BACK.hex, `park back ${how}`), activate: false })
        await sleep(700)
        const fresh = caseInstance.tabs.find((tab: any) => tab.id === freshId)
        const area = caseInstance.tabs[0].tabView.getBounds()

        const parking = new BrowserWindow({
          x: offScreen.x,
          y: offScreen.y,
          width: area.width,
          height: area.height,
          show: false,
          frame: false,
          skipTaskbar: true,
          backgroundColor: '#202020',
        })

        const started = Date.now()
        parking.contentView.addChildView(fresh.tabView)
        fresh.tabView.setBounds({ x: 0, y: 0, width: area.width, height: area.height })
        // Shown off screen for one of the two parked rows; never shown for the other.
        if (how === 'capturedWhileParkedShown') parking.showInactive()
        await sleep(FIRST_FRAME_WAIT_MS)

        let result: Record<string, unknown>
        if (how === 'capturedAfterHandingBack') {
          caseInstance.window.contentView.addChildView(fresh.tabView)
          fresh.tabView.setBounds(area)
        }
        try {
          const captured = await withTimeout(fresh.tabView.webContents.capturePage())
          result = captured.isEmpty() ? { empty: true } : { ownPixels: matches(centrePixel(captured.toPNG()), BACK.bgra) }
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) }
        }
        result.ms = Date.now() - started
        parking.hide()
        parking.destroy()
        caseInstance.window.contentView.addChildView(fresh.tabView)
        fresh.tabView.setBounds(area)
        attempts[how] = result
        console.log(`SPIKE_STEP parked view — ${how.padEnd(28)} ${JSON.stringify(result)}`)
        manager.destroyInstance(caseId)
      }
      // The three rows are the premises of the parked shot, so each is asserted in its own direction:
      // a window that is never shown is not composited (so the parking window has to be shown); a
      // window shown off screen is (so that works); and a hidden window's own tree never is (so the
      // capture cannot wait until the view is handed back).
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

    console.log('SPIKE_JSON ' + JSON.stringify({ rows, failures, focus }))
    console.log(failures.length === 0 ? '\nSPIKE_OK — every combination came back with its own tab, unseen and unfelt' : `\nSPIKE_FAILURES ${JSON.stringify(failures, null, 2)}`)

    manager.destroyInstance(probeId)
    app.exit(failures.length === 0 ? 0 : 1)
  } catch (error) {
    console.log('SPIKE_ERROR ' + (error && (error as Error).stack ? (error as Error).stack : String(error)))
    app.exit(2)
  }
})
