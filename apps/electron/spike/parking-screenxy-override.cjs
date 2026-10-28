const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const fs = require('fs')
const path = require('path')
const REPORT = path.join(__dirname, 'parking-screenxy-override.report.json')
const write = (o) => { try { fs.writeFileSync(REPORT, JSON.stringify(o, null, 1)) } catch (e) {} }

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>p</title></head>
<body><h1>p</h1><p>${'text '.repeat(300)}</p>
<script>
window.__p = function () { const s = screen; return {
  screenX: window.screenX, screenLeft: window.screenLeft, screenY: window.screenY,
  outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight],
  screen: [s.width, s.height], avail: [s.availWidth, s.availHeight], availLeft: s.availLeft,
  hasFocus: document.hasFocus(), visibility: document.visibilityState, dpr: devicePixelRatio } }
window.__ev = null
addEventListener('mousemove', e => { window.__ev = [e.clientX, e.clientY, e.screenX, e.screenY] }, true)
window.__patchReport = function () {
  const d0 = Object.getOwnPropertyDescriptor(Window.prototype, 'screenX')
  const before = { protoHasGetter: !!(d0 && d0.get), src: d0 && Function.prototype.toString.call(d0.get), own: !!Object.getOwnPropertyDescriptor(window, 'screenX') }
  const getter = function screenX() { return 40 }
  Object.defineProperty(Window.prototype, 'screenX', { get: getter, set: d0 && d0.set, configurable: true, enumerable: d0 && d0.enumerable })
  const d1 = Object.getOwnPropertyDescriptor(Window.prototype, 'screenX')
  return JSON.stringify({ before, afterSrc: Function.prototype.toString.call(d1.get), value: window.screenX,
    leftStillReal: window.screenLeft, eventSrcPatched: false,
    toStringOfToString: Function.prototype.toString.call(Function.prototype.toString) })
}
<\/script></body></html>`)

async function load(wc) { const done = new Promise(r => wc.once('did-finish-load', r)); await wc.loadURL(PAGE); await done; await sleep(250) }
const p = async (wc) => { try { return await wc.executeJavaScript('window.__p()') } catch (e) { return { error: String(e.message || e) } } }

app.whenReady().then(async () => {
  const r = {}
  const wa = screen.getPrimaryDisplay().workArea
  const SIZE = { width: 1100, height: 845 }
  const win = new BrowserWindow({ x: wa.x + wa.width + 20000, y: wa.y, ...SIZE, show: false, frame: false, skipTaskbar: true })
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, ...SIZE })
  win.contentView.addChildView(view)
  win.showInactive()
  const wc = view.webContents
  await load(wc)
  const dbg = wc.debugger
  dbg.attach('1.3')

  r.baseline = await p(wc)

  // 让页面自己记录一次 mousemove 的 screenX（不覆盖任何东西）
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 300 })
  await sleep(120)
  r.baselineEvent = await wc.executeJavaScript('JSON.stringify(window.__ev)')

  // 变体 1：完整 override，screenHeight 用真实屏幕高
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: SIZE.width, height: SIZE.height, deviceScaleFactor: 2, mobile: false,
    screenWidth: 1440, screenHeight: 960, positionX: 0, positionY: 0,
  })
  await sleep(200)
  r.variant1 = await p(wc)
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 240, y: 400 })
  await sleep(120)
  r.variant1Event = await wc.executeJavaScript('JSON.stringify(window.__ev)')

  // 变体 2：dontSetVisibleSize，别动真实视口
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: SIZE.width, height: SIZE.height, deviceScaleFactor: 2, mobile: false,
    screenWidth: 1440, screenHeight: 960, positionX: 0, positionY: 0, dontSetVisibleSize: true,
  })
  await sleep(200)
  r.variant2 = await p(wc)

  // 变体 3：把 positionX 设成一个"屏幕内"的值，看 screenX 是否跟着走
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: SIZE.width, height: SIZE.height, deviceScaleFactor: 2, mobile: false,
    screenWidth: 1440, screenHeight: 960, positionX: 137, positionY: 41, dontSetVisibleSize: true,
  })
  await sleep(200)
  r.variant3 = await p(wc)

  // 变体 4：清掉 override 是否回退
  await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
  await sleep(250)
  r.afterClear = await p(wc)

  // JS 补丁留下的痕迹
  try { r.jsPatch = JSON.parse(await wc.executeJavaScript('window.__patchReport()')) } catch (e) { r.jsPatch = { error: String(e.message || e) } }

  write(r)
  app.exit(0)
}).catch(e => { write({ fatal: String(e && e.stack || e) }); app.exit(1) })
