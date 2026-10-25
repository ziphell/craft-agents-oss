/**
 * Agent-first-shot spike — temporary, not part of the app.
 *
 * The claim under test: **an agent that opens a browser and takes a screenshot gets a picture even
 * though no window has ever been on a display.** `capturePageWithRecovery` has two arms, so both
 * are reproduced here, in the order the app runs them, on two windows that are *never* shown on a
 * display (`show: false`, no `showInactive`):
 *
 *   A  view in the window the agent's instance was born with, `capturePage(undefined,
 *      {stayHidden, stayAwake})`  — `capturePageWithRecovery`'s first arm
 *   B  the same view moved into a parking window (`showInactive`, off screen), plain
 *      `capturePage()`            — its second arm
 *
 * A third window repeats A after a CDP `Page.captureScreenshot`, which is the one thing
 * `parking-capture-order.cjs` measured to create a surface, to see whether the two states agree.
 *
 * Run (from the repo root):
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/agent-first-shot.cjs
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const { appendFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const W = 1100
const H = 845
const CAPTURE_TIMEOUT_MS = 1200
const CDP_TIMEOUT_MS = 1500
const SETTLE_MS = 700
const WATCHDOG_MS = 90_000

const LOG_PATH = join(__dirname, 'agent-first-shot.log')
writeFileSync(LOG_PATH, '')
const say = (text) => {
  try { console.log(text) } catch { /* no console attached */ }
  try { appendFileSync(LOG_PATH, text + '\n') } catch { /* a spike's log is a convenience */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%;background:#264;overflow:hidden}
#box{position:absolute;top:0;left:0;width:200px;height:200px;background:#e33;
     animation:slide 0.6s linear infinite alternate}
@keyframes slide{from{transform:translateX(0)}to{transform:translateX(880px)}}
</style></head>
<body><div id="box"></div><script>
  window.__frames = 0
  ;(function loop(){ window.__frames++; requestAnimationFrame(loop) })()
</script></body></html>`

/** Frames `Page.startScreencast` delivers over `ms` — the sink a viewer's stream reads. */
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
  } finally {
    webContents.debugger.sendCommand('Page.stopScreencast').catch(() => {})
    webContents.debugger.removeListener('message', onMessage)
  }
  return frames
}

async function load(wc) {
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('load timed out')), 8000)
    wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
  })
  wc.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(PAGE_HTML)}`).catch(() => {})
  await done
}

async function captureRow(webContents, options) {
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

async function cdpShot(webContents) {
  try { await webContents.debugger.attach('1.3') } catch { /* already attached */ }
  const shot = webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 80, fromSurface: true })
  shot.catch(() => {})
  let timer = null
  const noAnswer = new Promise((resolve) => { timer = setTimeout(() => resolve('no answer'), CDP_TIMEOUT_MS) })
  try {
    const result = await Promise.race([shot, noAnswer])
    if (typeof result === 'string') return result
    const data = result?.data
    return typeof data === 'string' && data.length > 0 ? `answered ${Buffer.from(data, 'base64').length} bytes` : 'answered without data'
  } catch (error) {
    return `refused: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const readPage = (wc) => wc.executeJavaScript(`({
  innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  visibility: document.visibilityState, hidden: document.hidden, frames: window.__frames,
})`)

/** A window the agent's instance is born with: hidden, frameless, never shown. */
function agentWindow(x, y) {
  const win = new BrowserWindow({
    x, y, width: W, height: H, show: false, frame: false,
    backgroundColor: '#264', skipTaskbar: true,
  })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  win.contentView.addChildView(view)
  return { win, view }
}

app.whenReady().then(async () => {
  setTimeout(() => {
    say('SPIKE_WATCHDOG — still running; nothing more came back')
    app.exit(3)
  }, WATCHDOG_MS)

  const displays = screen.getAllDisplays()
  const d = screen.getPrimaryDisplay().bounds
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const top = Math.min(...displays.map((display) => display.bounds.y))
  const spot = { x: right + 20000, y: top }
  say('SPIKE_DISPLAYS ' + JSON.stringify(displays.map((display) => ({ id: display.id, bounds: display.bounds }))))

  try {
    // --- A then B: the agent's own two arms, on one instance that is never shown ---
    const a = agentWindow(d.x + 40, d.y + 40)
    await load(a.view.webContents)
    await sleep(SETTLE_MS)
    // `screenshot` runs this before every capture (`getViewportMetrics`).
    try { await a.view.webContents.debugger.attach('1.3') } catch { /* already attached */ }
    await a.view.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true }).catch(() => {})

    const rowA = {
      windowShown: a.win.isVisible(),
      page: await readPage(a.view.webContents),
      armA_stayHidden: await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true }),
    }

    // Arm B: the view is moved into the parking window the way `parkTab` does — and then `moveTop`,
    // which `raiseParkedView` does before every shot. Isolated: capture first without it, then with.
    const parking = new BrowserWindow({
      x: spot.x, y: spot.y, width: W, height: H, show: false, frame: false,
      enableLargerThanScreen: true, alwaysOnTop: true, skipTaskbar: true,
    })
    parking.showInactive()
    parking.contentView.addChildView(a.view)
    await sleep(16)
    rowA.landedParking = parking.getBounds()
    rowA.pageParkedBeforeMoveTop = await readPage(a.view.webContents)
    rowA.armB_beforeMoveTop = await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true })
    parking.moveTop()
    await sleep(16)
    rowA.pageParkedAfterMoveTop = await readPage(a.view.webContents)
    rowA.armB_afterMoveTop = await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true })
    // The viewer's own sink, on the state `startViewCapture` now sets up before subscribing.
    rowA.screencastFrames2s = await screencastFrames(a.view.webContents, 2000)

    // What does a commit/relayout do to that surface? `layoutAllViews` runs on every navigation and
    // parks the view again (`addChildView` + `setBounds`) and re-asserts its corner radius. Each of
    // those is applied here on the primed view, with `moveTop` restoring it in between so the next
    // test starts from the same state. The question is "which one loses the picture", not "does any".
    const step = async (label, apply) => {
      apply()
      await sleep(16)
      const result = await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true })
      // Restore before the next one, so a failure is that step's and not the previous one's.
      parking.moveTop()
      await sleep(16)
      return { label, result, restored: await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true }) }
    }
    rowA.afterSteps = [
      await step('addChildView', () => parking.contentView.addChildView(a.view)),
      await step('setBounds', () => a.view.setBounds({ x: 0, y: 0, width: W, height: H })),
      await step('setBorderRadius', () => a.view.setBorderRadius(10)),
      await step('invalidate', () => a.view.webContents.invalidate()),
    ]

    // …and the reported symptom itself: a *commit* — the address bar's Enter. A new document (and,
    // cross-site, a new renderer) may be born without the compositing the old one had, which would
    // be exactly why the picture comes back only when something asks for the view again.
    await a.view.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(PAGE_HTML.replace('#264', '#426'))}`).catch(() => {})
    await sleep(800)
    rowA.pageAfterNavigate = await readPage(a.view.webContents)
    rowA.afterNavigate = await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true })
    parking.moveTop()
    await sleep(16)
    rowA.pageAfterNavigateMoveTop = await readPage(a.view.webContents)
    rowA.afterNavigateMoveTop = await captureRow(a.view.webContents, { stayHidden: true, stayAwake: true })
    rowA.screencastAfterNavigate2s = await screencastFrames(a.view.webContents, 2000)
    say('SPIKE_ROW_A ' + JSON.stringify(rowA))

    // --- C: same thing, but a CDP screenshot first — the state `parking-capture-order.cjs` primes ---
    const c = agentWindow(d.x + 40, d.y + 40)
    await load(c.view.webContents)
    c.win.showInactive()
    await sleep(SETTLE_MS)
    const rowC = { pageBefore: await readPage(c.view.webContents) }
    rowC.plainBefore = await captureRow(c.view.webContents, undefined)
    rowC.cdp = await cdpShot(c.view.webContents)
    rowC.plainAfter = await captureRow(c.view.webContents, undefined)
    rowC.pageAfter = await readPage(c.view.webContents)
    say('SPIKE_ROW_C ' + JSON.stringify(rowC))

    say('SPIKE_DONE')
    app.exit(0)
  } catch (error) {
    say('SPIKE_ERROR ' + (error && error.stack ? error.stack : String(error)))
    app.exit(1)
  }
})
