/**
 * Spike — a background tab's viewport: **if we stop resizing it, does its layout stop moving — and
 * what does that cost the shot and the coordinates?** (实施方案 §22 第十七轮, 探讨稿)
 *
 * The proposal under test: a tab that is not on screen keeps the size it had the last time it *was*
 * on screen, and only gets the window's size back when it comes forward — so an agent's background
 * work is not re-laid-out every time the person drags the window. Today `layoutTabView` gives every
 * tab `pageAreaBounds`, so a window resize reaches the background page (measured, 第十二轮: `resize`
 * fires and the page reflows).
 *
 * Four questions, in this order, because each one can kill the idea for the next:
 *
 *   A  **the primitive**: with the window grown, does a view whose bounds are left alone keep its
 *      layout? (its own `resize` count and `innerWidth`, against the same view after a `setBounds`)
 *   B  **the shot**: a view parked into another window to be captured — does being handed to another
 *      window reflow it, and what size is the picture? (the picture has to agree with the layout,
 *      or the agent gets one size of layout and another size of screenshot)
 *   C  **the coordinates**: a frozen view inside a bigger window — do CDP clicks land where the
 *      *page* says its elements are, and what happens outside the frozen viewport?
 *   D  **coming forward**: how long after `setBounds` does the page's `resize` arrive? (the number
 *      that decides whether the person sees a frame of the old size)
 *
 * Build + run (from the repo root):
 *   bunx esbuild apps/electron/spike/background-viewport.ts --bundle --platform=node --format=cjs \
 *     --external:electron --outfile=apps/electron/spike/background-viewport.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/background-viewport.cjs
 */
import { app, BrowserWindow, WebContentsView, nativeImage, screen } from 'electron'

/** The app's own switch, taken from `index.ts`: Chromium stops producing frames for a covered window. */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const FROZEN = { width: 900, height: 620 }
const GROWN = { width: 1400, height: 900 }

/**
 * A page that says what its own layout is doing: every `resize` is logged with a timestamp and the
 * `innerWidth` it was laid out at, frames are counted, and there is one target box that counts clicks
 * on itself.
 */
function page(colour: string, label: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:${colour};overflow:hidden}</style></head>
<body>
<div id="target" style="position:absolute;left:120px;top:80px;width:180px;height:60px;background:#111"></div>
<p id="note" style="font:13px sans-serif;color:#fff;position:absolute;left:120px;top:160px">${label}</p>
<script>
  window.__resizes = 0
  window.__resizeLog = []
  window.__frames = 0
  window.__clicks = 0
  window.addEventListener('resize', () => {
    window.__resizes++
    window.__resizeLog.push({ at: Date.now(), innerWidth: window.innerWidth, innerHeight: window.innerHeight })
  })
  document.getElementById('target').addEventListener('click', () => { window.__clicks++ })
  ;(function loop() { window.__frames++; requestAnimationFrame(loop) })()
</script>
</body></html>`
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`
}

/** What a page believes about itself, in one round trip. */
async function read(wc: Electron.WebContents, label: string) {
  const state = await wc.executeJavaScript(`({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visibility: document.visibilityState,
    hidden: document.hidden,
    resizes: window.__resizes,
    lastResize: window.__resizeLog.length ? window.__resizeLog[window.__resizeLog.length - 1] : null,
    frames: window.__frames,
    clicks: window.__clicks,
  })`)
  return { label, ...state }
}

/** Frames over 500ms — a covered view was measured at 0 (第十二轮), a shown one at ~30. */
async function framesIn500ms(wc: Electron.WebContents): Promise<number> {
  const before = await wc.executeJavaScript('window.__frames')
  await sleep(500)
  return (await wc.executeJavaScript('window.__frames')) - before
}

/** Load, and say which step failed rather than the whole harness dying on it. */
async function load(view: WebContentsView, url: string, where: string): Promise<void> {
  try {
    await view.webContents.loadURL(url)
  } catch (error) {
    console.log(`SPIKE_STEP load failed at ${where}: ${error instanceof Error ? error.message : String(error)} — trying once more`)
    await sleep(300)
    await view.webContents.loadURL(url)
  }
}

async function main(): Promise<void> {
  const offScreen = screen.getAllDisplays().reduce(
    (spot, display) => ({
      x: Math.max(spot.x, display.bounds.x + display.bounds.width),
      y: display.bounds.y,
    }),
    { x: 0, y: -4000 },
  )

  // Off every display by default (nothing of the app's is shown for a measurement), and on a real
  // display with `--on-screen`: whether a *covered* view counts as hidden is the one reading that
  // looks different off screen, so section A is worth having both ways.
  const onScreen = process.argv.includes('--on-screen')
  const spot = (offset: number) => (onScreen ? { x: 160, y: 160 + offset } : { x: offScreen.x, y: offScreen.y + offset })

  const report: Record<string, unknown> = {}
  // Windows are kept until the end and destroyed together: a `destroy()` mid-run makes the *next*
  // window's `loadURL` reject with the abort of the one just torn down (the repo has this on record
  // — `prototype-workbench-dev.md` §3.3), which is a property of the harness, not of the question.
  const keptAlive: BrowserWindow[] = []

  // ---------------------------------------------------------------------------------------------
  // A — the primitive: leave a view's bounds alone while the window grows.
  // ---------------------------------------------------------------------------------------------
  {
    const window = new BrowserWindow({
      ...spot(0), width: FROZEN.width, height: FROZEN.height,
      show: false, frame: false, skipTaskbar: true,
    })
    const front = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    const behind = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    // Added in this order so the one on screen (`front`) is the one on top, as it is in the app.
    window.contentView.addChildView(behind)
    window.contentView.addChildView(front)
    front.setBounds({ x: 0, y: 0, ...FROZEN })
    behind.setBounds({ x: 0, y: 0, ...FROZEN })
    window.showInactive()
    await load(front, page('#ff0000', 'front, following the window'), 'A front')
    await load(behind, page('#0000ff', 'behind, left alone'), 'A behind')
    await sleep(600)

    const before = { front: await read(front.webContents, 'front'), behind: await read(behind.webContents, 'behind') }

    // The person drags the window bigger. Only the tab on screen is laid out again.
    const startedAt = Date.now()
    window.setContentSize(GROWN.width, GROWN.height)
    front.setBounds({ x: 0, y: 0, ...GROWN })
    await sleep(700)
    const after = { front: await read(front.webContents, 'front'), behind: await read(behind.webContents, 'behind') }

    // …and the same view once it *is* laid out: this is the contrast that says the freeze is the
    // `setBounds` we did not make, not something else about covered views.
    const beforeCatchingUp = Date.now()
    behind.setBounds({ x: 0, y: 0, ...GROWN })
    await sleep(700)
    const caughtUp = await read(behind.webContents, 'behind, now laid out')

    report.leftAloneWhileTheWindowGrew = {
      before,
      after,
      caughtUp,
      frontFramesPer500ms: await framesIn500ms(front.webContents),
      behindFramesPer500ms: await framesIn500ms(behind.webContents),
      theResizeArrivedMsAfterSetBounds: {
        front: (after.front.lastResize?.at ?? 0) - startedAt,
        behind: (caughtUp.lastResize?.at ?? 0) - beforeCatchingUp,
      },
    }
    keptAlive.push(window)
  }

  // ---------------------------------------------------------------------------------------------
  // B — the shot: a view handed to another window to be captured. Does re-parenting reflow it, and
  // what size is the picture? (the picture must agree with the layout)
  // ---------------------------------------------------------------------------------------------
  {
    const home = new BrowserWindow({
      ...spot(1000), width: GROWN.width, height: GROWN.height,
      show: false, frame: false, skipTaskbar: true,
    })
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    home.contentView.addChildView(view)
    // The "frozen" tab: it was 900 wide when it was last on screen, and the window has grown since.
    view.setBounds({ x: 0, y: 0, ...FROZEN })
    home.showInactive()
    await load(view, page('#00aa00', 'the frozen tab, parked to be shot'), 'B frozen view')
    await sleep(600)

    const beforeParking = await read(view.webContents, 'frozen view')
    const resizesBeforeParking = beforeParking.resizes

    // The parking window the app builds today is the size of the *current* page area (the grown one).
    const parking = new BrowserWindow({
      ...spot(2000), width: GROWN.width, height: GROWN.height,
      show: false, frame: false, skipTaskbar: true,
    })
    parking.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, ...FROZEN })
    parking.showInactive()
    await sleep(120)
    let capturedSize: unknown
    let capturedBytes = 0
    try {
      const image = await view.webContents.capturePage()
      const buffer = image.toPNG()
      capturedBytes = buffer.length
      const size = image.getSize()
      const bitmap = nativeImage.createFromBuffer(buffer).toBitmap()
      const i = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4
      capturedSize = { ...size, centrePixel: [bitmap[i], bitmap[i + 1], bitmap[i + 2], bitmap[i + 3]] }
    } catch (error) {
      capturedSize = `no answer: ${error instanceof Error ? error.message : String(error)}`
    }
    const afterParking = await read(view.webContents, 'frozen view, parked')

    // …and handing it back, the way the app does.
    home.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, ...FROZEN })
    await sleep(200)
    const afterHandingBack = await read(view.webContents, 'frozen view, handed back')
    keptAlive.push(parking)

    report.theShotOfAFrozenView = {
      beforeParking,
      afterParking,
      afterHandingBack,
      resizesCausedByParking: afterParking.resizes - resizesBeforeParking,
      capturedBytes,
      capturedSize,
      parkingWindowIsBiggerThanTheView: { parkingWindow: GROWN, viewBounds: FROZEN },
    }
    keptAlive.push(home)
  }

  // ---------------------------------------------------------------------------------------------
  // C — the coordinates: a frozen view inside a bigger window. Do CDP clicks land where the page
  // says its elements are, and what is outside the frozen viewport?
  // ---------------------------------------------------------------------------------------------
  {
    const window = new BrowserWindow({
      ...spot(3000), width: GROWN.width, height: GROWN.height,
      show: false, frame: false, skipTaskbar: true,
    })
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, ...FROZEN })
    window.showInactive()
    await load(view, page('#3333ff', 'frozen layout, inside a grown window'), 'C frozen view')
    await sleep(600)

    const wc = view.webContents
    try {
      await wc.debugger.attach('1.3')
    } catch { /* already attached */ }
    const clickAt = async (x: number, y: number) => {
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await sleep(150)
    }

    const box = await wc.executeJavaScript(`(() => { const r = document.getElementById('target').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const windowViewport = await read(wc, 'the frozen page')
    await clickAt(centre.x, centre.y)
    const clicksInsideTheFrozenViewport = await wc.executeJavaScript('window.__clicks')
    // Where the page thinks a point beyond its own viewport lands: the window is 1400 wide, the
    // layout is 900 — so this is the question "is the rest of the window the page's, or not?"
    const elementAt1400 = await wc.executeJavaScript('document.elementFromPoint(1300, 400) ? document.elementFromPoint(1300, 400).tagName : null')
    await clickAt(1300, 400)
    const clicksAfterClickingBeyond = await wc.executeJavaScript('window.__clicks')

    report.theCoordinatesOfAFrozenView = {
      windowViewport,
      theTargetBoxAsThePageSeesIt: box,
      clickedAtThePagesOwnCentre: centre,
      clicksInsideTheFrozenViewport,
      elementAt1300x400: elementAt1400,
      clicksAfterClickingBeyond: clicksAfterClickingBeyond,
      viewBounds: FROZEN,
      windowContentSize: GROWN,
    }
    keptAlive.push(window)
  }

  // ---------------------------------------------------------------------------------------------
  // D — coming forward: how long after the bounds change does the page's `resize` arrive?
  // ---------------------------------------------------------------------------------------------
  {
    const window = new BrowserWindow({
      ...spot(4000), width: FROZEN.width, height: FROZEN.height,
      show: false, frame: false, skipTaskbar: true,
    })
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, ...FROZEN })
    window.showInactive()
    await load(view, page('#ff8800', 'the tab that comes forward'), 'D view')
    await sleep(600)

    const before = await read(view.webContents, 'before')
    window.setContentSize(GROWN.width, GROWN.height)
    const atSetBounds = Date.now()
    view.setBounds({ x: 0, y: 0, ...GROWN })

    // Read straight back, then poll for the page's own `resize`, to see what the page knew when.
    const rightAfterSetBounds = await read(view.webContents, 'immediately after setBounds')
    let arrivedAt: number | null = null
    for (let attempt = 0; attempt < 40 && arrivedAt === null; attempt++) {
      const at = await view.webContents.executeJavaScript('window.__resizeLog.length ? window.__resizeLog[window.__resizeLog.length - 1].at : null')
      if (at !== null) arrivedAt = at
      else await sleep(5)
    }
    const after = await read(view.webContents, 'after')

    report.comingForward = {
      before,
      rightAfterSetBounds,
      after,
      theResizeArrivedMsAfterSetBounds: arrivedAt === null ? 'never within 200ms' : arrivedAt - atSetBounds,
      // A frame is presented about every 16ms; if the page's `resize` landed inside that window, the
      // first frame the person can see is already at the new size.
      withinOneFrame: arrivedAt !== null && arrivedAt - atSetBounds <= 16,
    }
    keptAlive.push(window)
  }

  // ---------------------------------------------------------------------------------------------
  // E — where a tab that is not on screen lives: **outside its window's rectangle**. There are two
  // ways to get there and they are *not* the same state, so both are measured:
  //
  //   E1  **born outside** — the view's bounds are the negative ones before it is ever in the window,
  //       so it is never composited. This is the shape the manager produces (`attachTab` sets bounds
  //       and `layoutTabView` moves every tab that is not on screen out, both before a frame).
  //   E2  **moved out after being composited** — it was inside the window first, and the surface it
  //       got there survives the move.
  //
  // What a tab that is not on screen has to keep is its **usability**: the layout it was given
  // (`innerWidth`, no `resize`), `executeJavaScript`, and CDP input at its own coordinates. What it
  // does not need is a surface — a shot of it goes through the parking window either way.
  // ---------------------------------------------------------------------------------------------
  {
    const wcOf = (view: WebContentsView) => view.webContents
    const clickedAtItsTarget = async (wc: Electron.WebContents) => {
      try {
        await wc.debugger.attach('1.3')
      } catch { /* already attached */ }
      const box = await wc.executeJavaScript(
        '(() => { const r = document.getElementById("target").getBoundingClientRect(); return { x: r.x, y: r.y } })()',
      )
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 5, y: box.y + 5, button: 'left', clickCount: 1 })
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 5, y: box.y + 5, button: 'left', clickCount: 1 })
      await sleep(200)
      return { theTargetBox: box, clicks: await wc.executeJavaScript('window.__clicks') }
    }
    /** A capture in place, bounded: a view with no surface never answers (`captureWithinBound`). */
    const captureInPlace = async (wc: Electron.WebContents) => {
      try {
        return await Promise.race([
          wc.capturePage().then((image) => `answered ${image.getSize().width}×${image.getSize().height}`),
          sleep(1200).then(() => 'no answer within 1200ms'),
        ])
      } catch (error) {
        return `refused: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const bornOutside = new BrowserWindow({
      ...spot(5000), width: FROZEN.width, height: FROZEN.height, show: false, frame: false, skipTaskbar: true,
    })
    const outside = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    // Negative bounds **before** the view is ever in the window: it is never composited anywhere.
    outside.setBounds({ x: -FROZEN.width - 1, y: -FROZEN.height - 1, ...FROZEN })
    bornOutside.contentView.addChildView(outside)
    bornOutside.showInactive()
    await load(outside, page('#aa00aa', 'born outside its window'), 'E1 view')
    await sleep(600)

    const e1WhileOutside = {
      ...(await read(wcOf(outside), 'born outside, still outside')),
      captureInPlace: await captureInPlace(wcOf(outside)),
      framesPer500ms: await framesIn500ms(wcOf(outside)),
      ...(await clickedAtItsTarget(wcOf(outside))),
    }

    // …and what happens when such a view is put inside the window: this is "the tab comes forward".
    outside.setBounds({ x: 0, y: 0, ...FROZEN })
    await sleep(600)
    const e1AfterComingInside = {
      ...(await read(wcOf(outside), 'born outside, now inside')),
      captureInPlace: await captureInPlace(wcOf(outside)),
    }
    keptAlive.push(bornOutside)

    // E2: the same view, moved out after it has been composited inside.
    const movedOut = new BrowserWindow({
      ...spot(6000), width: FROZEN.width, height: FROZEN.height, show: false, frame: false, skipTaskbar: true,
    })
    const composited = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    composited.setBounds({ x: 0, y: 0, ...FROZEN })
    movedOut.contentView.addChildView(composited)
    movedOut.showInactive()
    await load(composited, page('#aa00aa', 'moved out after being composited'), 'E2 view')
    await sleep(600)
    composited.setBounds({ x: -FROZEN.width - 1, y: -FROZEN.height - 1, ...FROZEN })
    await sleep(600)
    const e2AfterBeingMovedOut = {
      ...(await read(wcOf(composited), 'composited, then moved out')),
      captureInPlace: await captureInPlace(wcOf(composited)),
      ...(await clickedAtItsTarget(wcOf(composited))),
    }
    keptAlive.push(movedOut)

    report.aViewParkedOutsideItsWindow = { bornOutside: e1WhileOutside, afterComingInside: e1AfterComingInside, movedOutAfterBeingComposited: e2AfterBeingMovedOut }
  }

  // ---------------------------------------------------------------------------------------------
  // F — the order of "hand the keyboard over" and "move the view": a tab coming forward is moved out
  // of the parking window and raised in the person's window, and whichever of the two is done second
  // wins. A/B, because the app got this wrong (the keyboard was asked for *before* the move, and the
  // person switching back to their own tab got nothing).
  // ---------------------------------------------------------------------------------------------
  {
    const home = new BrowserWindow({
      ...spot(7000), width: FROZEN.width, height: FROZEN.height, show: false, frame: false, skipTaskbar: true,
    })
    const resident = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    resident.setBounds({ x: 0, y: 0, ...FROZEN })
    home.contentView.addChildView(resident)
    home.showInactive()
    await load(resident, page('#00aa88', 'the tab on screen'), 'F resident')
    await sleep(600)

    const parked = new BrowserWindow({
      ...spot(8000), width: FROZEN.width, height: FROZEN.height, show: false, frame: false, skipTaskbar: true,
    })
    const arriving = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    arriving.setBounds({ x: 0, y: 0, ...FROZEN })
    parked.contentView.addChildView(arriving)
    parked.showInactive()
    await load(arriving, page('#8800aa', 'the tab coming forward'), 'F arriving')
    await sleep(600)

    const says = async (wc: Electron.WebContents) => ({
      hasFocus: await wc.executeJavaScript('document.hasFocus()'),
      isFocused: wc.isFocused(),
    })
    const focusedBeforeAnything = { resident: await says(resident.webContents), arriving: await says(arriving.webContents) }

    // A: the keyboard first, the move second — what the app did.
    arriving.webContents.focus()
    await sleep(250)
    const arrivingAfterBeingFocusedInTheParkingWindow = await says(arriving.webContents)
    home.contentView.addChildView(arriving)
    arriving.setBounds({ x: 0, y: 0, ...FROZEN })
    await sleep(400)
    const afterFocusingItFirstThenMoving = { resident: await says(resident.webContents), arriving: await says(arriving.webContents) }

    // B: the move first, the keyboard second — what the app does now.
    parked.contentView.addChildView(arriving)
    arriving.setBounds({ x: 0, y: 0, ...FROZEN })
    await sleep(400)
    home.contentView.addChildView(arriving)
    arriving.setBounds({ x: 0, y: 0, ...FROZEN })
    await sleep(400)
    arriving.webContents.focus()
    await sleep(400)
    const afterMovingItFirstThenFocusing = { resident: await says(resident.webContents), arriving: await says(arriving.webContents) }

    report.theOrderOfFocusAndTheMove = {
      focusedBeforeAnything,
      arrivingAfterBeingFocusedInTheParkingWindow,
      afterFocusingItFirstThenMoving,
      afterMovingItFirstThenFocusing,
    }
    keptAlive.push(home, parked)
  }

  for (const window of keptAlive) {
    if (!window.isDestroyed()) window.destroy()
  }

  console.log('SPIKE_STEP background viewport ' + JSON.stringify(report, null, 1))
  console.log('\nSPIKE_DONE')
  app.exit(0)
}

app.whenReady().then(() => {
  main().catch((error) => {
    console.error('SPIKE_FAILED', error)
    app.exit(1)
  })
})

