/**
 * 置顶透明窗口 —— 一个能跑、能量、能看的 demo。
 *
 * 它做的事就是"停车窗"该有的四件事，一次到位：
 *   1. 透明：`setOpacity(0)`，并对不支持的平台（Linux）报出来，而不是假装成功；
 *   2. 置顶：`setAlwaysOnTop(true,'floating')` + `moveTop()`，所以它不可能被遮挡 —— 出帧不依赖"屏幕外"；
 *   3. 不打扰：`focusable:false` + `showInactive()` + `setIgnoreMouseEvents(true)`（不设这个会吞掉点击和悬停）；
 *   4. 不显眼：`skipTaskbar`、空标题、无阴影。
 *
 * 跑法（仓库根目录）：
 *   node_modules/electron/dist/electron.exe apps/electron/spike/topmost-transparent-window.cjs
 *   node_modules/electron/dist/electron.exe apps/electron/spike/topmost-transparent-window.cjs --show
 *   node_modules/electron/dist/electron.exe apps/electron/spike/topmost-transparent-window.cjs --show --through
 *   node_modules/electron/dist/electron.exe apps/electron/spike/topmost-transparent-window.cjs --keep
 *
 *   （默认量完就退出；--show 用 0.55 的不透明度亮出来给你看一眼；--through 让那扇亮着的窗
 *   仍然忽略鼠标 —— 这是 macOS 上唯一还没验过的前提（M6）：点一下它，下面的窗口应该收到。）
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const fs = require('fs')
const path = require('path')

const SHOW = process.argv.includes('--show')
const THROUGH = process.argv.includes('--through')
const KEEP = process.argv.includes('--keep')
const REPORT = path.join(__dirname, 'topmost-transparent-window.report.json')
const writeReport = (payload) => { try { fs.writeFileSync(REPORT, JSON.stringify(payload, null, 1)) } catch { /* 写不进去也不该让 demo 挂掉 */ } }

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')

const WIDTH = 900
const HEIGHT = 640

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
<title>parked</title>
<style>html,body{margin:0;height:100%;background:linear-gradient(120deg,#1b6ca8,#6a1b9a);color:#fff;font:16px/1.5 system-ui,sans-serif}
h1{margin:0;padding:24px;font-size:22px}</style></head>
<body><h1>parked window — 你看不见我，但我一直在画</h1><p style="padding:0 24px">${'这一行用来让页面持续重排。'.repeat(40)}</p>
<script>
window.__raf = 0
requestAnimationFrame(function tick(){ window.__raf++; requestAnimationFrame(tick) })
window.__st = () => JSON.stringify({
  raf: window.__raf,
  screenX: window.screenX, screenY: window.screenY,
  screenLeft: window.screenLeft, screenTop: window.screenTop,
  outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight],
  avail: [screen.availWidth, screen.availHeight], screen: [screen.width, screen.height],
  visibility: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(),
  dpr: devicePixelRatio,
})
</script></body></html>`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const report = { show: SHOW, keep: KEEP }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay()
  const area = display.workArea
  report.display = { id: display.id, workArea: area, scaleFactor: display.scaleFactor }

  // 摆在 workArea 左上角 + 一点偏移：屏幕内、合法、像一扇真的窗口
  const bounds = { x: area.x + 8, y: area.y + 8, width: WIDTH, height: HEIGHT }

  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    title: '',
    enableLargerThanScreen: true,
  })

  // 1) 透明 —— 读回来确认它真的生效（Linux 上是 no-op）
  window.setOpacity(SHOW ? 0.55 : 0)
  const opacity = window.getOpacity()
  report.transparent = { requested: SHOW ? 0.55 : 0, actual: opacity, opacityWorks: opacity === 0 || SHOW }

  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
  window.contentView.addChildView(view)

  // 3) 不打扰：忽略鼠标（穿透）+ 不抢焦点
  //    --through 让"亮着的那扇窗"也忽略鼠标：一次人工点击就能回答 macOS 的 M6
  //    （Windows 那边已用真实 SendInput 验过：不设就吞，设了就穿）。
  const through = THROUGH || !SHOW
  if (through) window.setIgnoreMouseEvents(true)

  window.showInactive()
  // 2) 置顶：先设层级再 raise，顺序无所谓，但两件都要做
  window.setAlwaysOnTop(true, 'floating')
  window.moveTop()
  if (process.platform === 'darwin') window.setHiddenInMissionControl(true)

  await new Promise((resolve) => { view.webContents.once('did-finish-load', resolve); view.webContents.loadURL(PAGE) })
  await sleep(700)

  const state = async () => {
    const before = JSON.parse(await view.webContents.executeJavaScript('window.__st()'))
    await sleep(400)
    const after = JSON.parse(await view.webContents.executeJavaScript('window.__st()'))
    return { ...after, rafTicksIn400ms: after.raf - before.raf }
  }

  report.state = await state()
  report.bounds = window.getBounds()
  report.isVisible = window.isVisible()
  report.isFocused = window.isFocused()
  report.alwaysOnTop = window.isAlwaysOnTop()
  try {
    const shot = await view.webContents.capturePage()
    const png = shot.toPNG()
    report.capture = { size: shot.getSize(), bytes: png.length }
  } catch (error) {
    report.capture = { error: String(error && error.message || error) }
  }

  // 用户能被抢走什么：焦点现在应该还在原来的窗口上
  const focused = BrowserWindow.getFocusedWindow()
  report.focusHolder = focused ? focused.getTitle() || '(untitled)' : '(none)'

  console.log(JSON.stringify(report, null, 1))
  writeReport(report)

  if (SHOW && through) {
    console.log('')
    console.log('=== M6：点一下上面那块半透明的区域 ===')
    console.log('下面的窗口（Finder / 终端 / 任何窗口）应该收到这次点击；收不到就是没穿透，C 方案在 macOS 上不成立。')
  }

  if (KEEP) return // 常驻，Ctrl+C 结束

  await sleep(SHOW ? 6000 : 300)
  app.exit(0)
}

app.whenReady().then(() => main().catch((error) => {
  writeReport({ fatal: String(error && error.stack || error) })
  app.exit(1)
}))
