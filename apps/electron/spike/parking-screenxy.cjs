// 跑法: node_modules/electron/dist/electron.exe <此文件>
// 目的：window.screenX 究竟能不能被"合法地"改掉/避开，逐个试。
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const fs = require('fs')
const path = require('path')

const REPORT = path.join(__dirname, 'parking-screenxy.report.json')
const write = (o) => { try { fs.writeFileSync(REPORT, JSON.stringify(o, null, 1)) } catch (e) {} }

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')

const PROBE = `
window.__p = function () {
  const s = window.screen
  return {
    screenX: window.screenX, screenY: window.screenY,
    screenLeft: window.screenLeft, screenTop: window.screenTop,
    outer: [window.outerWidth, window.outerHeight],
    inner: [window.innerWidth, window.innerHeight],
    screen: [s.width, s.height],
    avail: [s.availWidth, s.availHeight],
    availLeft: s.availLeft, availTop: s.availTop,
    hasFocus: document.hasFocus(),
    visibility: document.visibilityState,
    hidden: document.hidden,
    dpr: window.devicePixelRatio,
  }
}
window.__evScreenX = null
addEventListener('mousemove', (e) => { window.__evScreenX = [e.clientX, e.clientY, e.screenX, e.screenY] }, true)
`
const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head><body>
   <h1>probe</h1><p>${'text '.repeat(200)}</p>
   <script>${PROBE}<\/script></body></html>`,
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function readAll(wc) {
  try { return await wc.executeJavaScript('window.__p()') } catch (e) { return { error: String(e && e.message || e) } }
}

async function load(wc) {
  const done = new Promise((r) => wc.once('did-finish-load', r))
  await wc.loadURL(PAGE)
  await done
  await sleep(300)
}

app.whenReady().then(async () => {
  const report = { electron: process.versions.electron, chrome: process.versions.chrome }
  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }))
  report.displays = displays
  const wa = screen.getPrimaryDisplay().workArea
  const SIZE = { width: 1100, height: 845 }

  // ---------- A. 照应用现在的做法：屏幕外停车窗 ----------
  const parking = new BrowserWindow({
    x: wa.x + wa.width + 20000, y: wa.y, ...SIZE, show: false, frame: false, skipTaskbar: true,
  })
  const viewA = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  viewA.setBounds({ x: 0, y: 0, ...SIZE })
  parking.contentView.addChildView(viewA)
  parking.showInactive()
  await load(viewA.webContents)
  report.A_offscreenParking = {
    asked: { x: wa.x + wa.width + 20000, y: wa.y },
    actualBounds: parking.getBounds(),
    probe: await readAll(viewA.webContents),
  }

  // ---------- B. CDP 的 Emulation 能不能改 ----------
  const dbg = viewA.webContents.debugger
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
    const before = await readAll(viewA.webContents)
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: SIZE.width, height: SIZE.height, deviceScaleFactor: 2, mobile: false,
      screenWidth: 1440, screenHeight: 912, positionX: 0, positionY: 0,
    })
    await sleep(200)
    const afterMetrics = await readAll(viewA.webContents)
    // 单独看 positionX/Y 是否影响 availLeft/Top 或 screenX
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: SIZE.width, height: SIZE.height, deviceScaleFactor: 2, mobile: false,
      screenWidth: 1440, screenHeight: 912, positionX: 0, positionY: 0, dontSetVisibleSize: false,
    })
    await sleep(200)
    report.B_cdpEmulation = { before, afterMetrics, afterSecond: await readAll(viewA.webContents) }
    try { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride') } catch (e) {}
  } catch (e) {
    report.B_cdpEmulation = { error: String(e && e.message || e) }
  }

  // ---------- C. 负坐标（Windows 允许负数，不会被钳到 16383） ----------
  const neg = new BrowserWindow({ x: -SIZE.width - 400, y: 0, ...SIZE, show: false, frame: false, skipTaskbar: true })
  const viewB = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  viewB.setBounds({ x: 0, y: 0, ...SIZE })
  neg.contentView.addChildView(viewB)
  neg.showInactive()
  await load(viewB.webContents)
  report.C_negativeX = { actualBounds: neg.getBounds(), probe: await readAll(viewB.webContents) }

  // ---------- D. 完全不要窗口：offscreen rendering ----------
  let osr = null
  try {
    osr = new BrowserWindow({
      ...SIZE, show: false, frame: false, webPreferences: { offscreen: true, backgroundThrottling: false },
    })
    await load(osr.webContents)
    report.D_osr = { probe: await readAll(osr.webContents), bounds: osr.getBounds(), isVisible: osr.isVisible() }
  } catch (e) {
    report.D_osr = { error: String(e && e.message || e) }
  }

  // ---------- E. JS 层补丁能做到什么，又留下什么 ----------
  try {
    const wc = viewA.webContents
    const native = `JSON.stringify({
      ownDesc: !!Object.getOwnPropertyDescriptor(window, 'screenX'),
      protoDesc: (function(){ var d = Object.getOwnPropertyDescriptor(Window.prototype, 'screenX')
        return d ? { hasGet: !!d.get, getSource: Function.prototype.toString.call(d.get), configurable: d.configurable } : null })(),
      value: window.screenX
    })`
    const beforePatch = await wc.executeJavaScript(native)
    // 只在原型上换成自己的 getter（不动 window 自身，descriptor 形状保持不变）
    const patch = `(() => {
      const fake = 40
      const target = Window.prototype
      const d = Object.getOwnPropertyDescriptor(target, 'screenX')
      if (!d || !d.get) return 'no getter'
      const getter = function screenX() { return fake }
      Object.defineProperty(getter, 'name', { value: 'get screenX', configurable: true })
      Object.defineProperty(target, 'screenX', { get: getter, set: d.set, configurable: d.configurable, enumerable: d.enumerable })
      return 'patched'
    })()`
    const patched = await wc.executeJavaScript(patch)
    const afterPatch = await wc.executeJavaScript(native)
    const consistency = await wc.executeJavaScript(`JSON.stringify({
      screenX: window.screenX, screenLeft: window.screenLeft, value: window.screenX,
      availLeftPlusWidth: screen.availLeft + screen.availWidth
    })`)
    // 再进一步：把 toString 也补上，看还漏什么
    const deeper = await wc.executeJavaScript(`(() => {
      const origToString = Function.prototype.toString
      const fake = new WeakMap()
      const t = function toString() { return fake.get(this) || origToString.call(this) }
      fake.set(t, Function.prototype.toString.call(origToString))
      Object.defineProperty(Function.prototype, 'toString', { value: t, writable: true, configurable: true })
      const g = Object.getOwnPropertyDescriptor(Window.prototype, 'screenX').get
      fake.set(g, 'function get screenX() { [native code] }')
      return JSON.stringify({
        getSource: Function.prototype.toString.call(g),
        toStringSource: Function.prototype.toString.call(Function.prototype.toString)
      })
    })()`)
    report.E_jsPatch = { beforePatch: JSON.parse(beforePatch), patched, afterPatch: JSON.parse(afterPatch), consistency: JSON.parse(consistency), deeper: JSON.parse(deeper) }
  } catch (e) {
    report.E_jsPatch = { error: String(e && e.message || e) }
  }

  // ---------- F. 屏幕内 + 遮挡（对照：合法坐标长什么样） ----------
  try {
    const legal = new BrowserWindow({ x: wa.x + 40, y: wa.y + 40, ...SIZE, show: false, frame: false, skipTaskbar: true, opacity: 0 })
    const viewC = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
    viewC.setBounds({ x: 0, y: 0, ...SIZE })
    legal.contentView.addChildView(viewC)
    legal.showInactive()
    await load(viewC.webContents)
    report.F_legalCoords = { bounds: legal.getBounds(), opacity: legal.getOpacity(), probe: await readAll(viewC.webContents) }
  } catch (e) {
    report.F_legalCoords = { error: String(e && e.message || e) }
  }

  write(report)
  app.exit(0)
}).catch((e) => { write({ fatal: String(e && e.stack || e) }); app.exit(1) })
