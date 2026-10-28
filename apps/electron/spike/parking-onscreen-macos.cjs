/**
 * 方案 C（屏内透明停车窗）在 macOS 上的缺口测试 —— 补 `parking-window-position.md` §6 的 M3 / M6。
 *
 * `topmost-transparent-window.cjs` 只量了"它在那儿能不能出帧/抓图/抢焦点"（M1/M2/M7/M8/M10）。
 * 这里补三件它量不到的：
 *   A. 被一扇**更高层级**的不透明窗口完全盖住时，还出帧吗？（M3：会不会被判 occluded）
 *   B. 被一扇**普通层级**的不透明窗口盖住时，盖得住吗？（置顶层是不是真的挡住了遮挡）
 *   C. 真实系统点击能不能穿透到下面的窗口？（M6；用 System Events 发真点击，没权限就报出来）
 *
 * 跑法（仓库根目录）：
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/electron/spike/parking-onscreen-macos.cjs
 *
 * 读数写 `parking-onscreen-macos.report.json`，逐行打印。
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPORT = path.join(__dirname, 'parking-onscreen-macos.report.json')
const WIDTH = 900
const HEIGHT = 640
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
<title>parked</title>
<style>html,body{margin:0;height:100%;background:linear-gradient(120deg,#1b6ca8,#6a1b9a);color:#fff;font:16px/1.5 system-ui,sans-serif}</style></head>
<body><h1>parked window</h1>
<script>
window.__raf = 0
window.__clicks = { down: 0, up: 0, move: 0 }
requestAnimationFrame(function tick(){ window.__raf++; requestAnimationFrame(tick) })
addEventListener('mousedown', () => window.__clicks.down++, true)
addEventListener('mouseup', () => window.__clicks.up++, true)
addEventListener('mousemove', () => window.__clicks.move++, true)
window.__st = () => JSON.stringify({
  raf: window.__raf,
  screenX: window.screenX, screenY: window.screenY,
  outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight],
  avail: [screen.availWidth, screen.availHeight], screen: [screen.width, screen.height],
  visibility: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(),
  dpr: devicePixelRatio,
})
window.__cl = () => JSON.stringify(window.__clicks)
</script></body></html>`)

/** 一扇"停车窗"：透明、置顶、不抢焦点、不接鼠标 —— 与方案 C 的选项一致。 */
function makeParking(area, opacity) {
  const bounds = { x: area.x + 120, y: area.y + 80, width: WIDTH, height: HEIGHT }
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    title: '',
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
  })
  window.setOpacity(opacity)
  window.setIgnoreMouseEvents(true)
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
  window.contentView.addChildView(view)
  window.showInactive()
  window.setAlwaysOnTop(true, 'floating')
  window.moveTop()
  window.setHiddenInMissionControl(true)
  return { window, view }
}

async function load(view) {
  await new Promise((resolve) => { view.webContents.once('did-finish-load', resolve); view.webContents.loadURL(PAGE) })
}

/** rAF 400ms 内的节拍 + 页面自报几何 + 抓图。 */
async function probe(label, view) {
  const before = JSON.parse(await view.webContents.executeJavaScript('window.__st()'))
  await sleep(400)
  const after = JSON.parse(await view.webContents.executeJavaScript('window.__st()'))
  let capture
  try {
    const shot = await view.webContents.capturePage()
    capture = { size: shot.getSize(), bytes: shot.toPNG().length }
  } catch (error) {
    capture = { error: String(error && error.message || error) }
  }
  const row = { label, ...after, rafTicksIn400ms: after.raf - before.raf, capture }
  console.log('MAC_ROW ' + JSON.stringify(row))
  return row
}

const osa = (script) => new Promise((resolve) => {
  execFile('osascript', ['-e', script], { timeout: 8000 }, (error, stdout, stderr) => {
    resolve(error ? { error: String(stderr || error.message).trim() } : { ok: String(stdout).trim() })
  })
})

async function main() {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const report = {
    display: { id: display.id, bounds: display.bounds, workArea: area, scaleFactor: display.scaleFactor },
    platform: process.platform,
    electron: process.versions.electron,
    scenarios: [],
  }

  // ---------- A：更高层级的不透明窗口把它完全盖住 ----------
  {
    const { window, view } = makeParking(area, 0)
    await load(view)
    await sleep(700)
    const clear = await probe('A1-uncovered', view)

    const cover = new BrowserWindow({
      x: area.x, y: area.y, width: area.width, height: area.height,
      show: true, frame: false, skipTaskbar: true, focusable: false, hasShadow: false,
      backgroundColor: '#101010',
    })
    cover.setAlwaysOnTop(true, 'screen-saver')
    cover.moveTop()
    await sleep(600)
    const covered = await probe('A2-covered-by-screen-saver', view)
    const coverVisible = cover.isVisible()

    cover.hide()
    await sleep(700)
    const afterUncover = await probe('A3-cover-removed', view)
    cover.destroy()
    report.scenarios.push({ name: 'A-higher-level-cover', clear, covered, coverVisible, afterUncover })
    window.destroy()
  }

  // ---------- B：普通层级的不透明窗口盖不住它（floating 压过 normal） ----------
  {
    const { window, view } = makeParking(area, 0)
    await load(view)
    await sleep(700)
    const clear = await probe('B1-uncovered', view)

    const cover = new BrowserWindow({
      x: area.x, y: area.y, width: area.width, height: area.height,
      show: true, frame: true, skipTaskbar: true,
      backgroundColor: '#101010',
    })
    cover.setAlwaysOnTop(false)
    await sleep(600)
    const covered = await probe('B2-covered-by-normal', view)
    report.scenarios.push({ name: 'B-normal-level-cover', clear, covered, coverAlwaysOnTop: cover.isAlwaysOnTop() })
    cover.destroy()
    window.destroy()
  }

  // ---------- C：真实系统点击是否穿透 ----------
  {
    const bottom = new BrowserWindow({
      x: area.x + 120, y: area.y + 80, width: WIDTH, height: HEIGHT,
      show: true, frame: false, skipTaskbar: true, backgroundColor: '#222',
    })
    const bottomView = new WebContentsView()
    bottomView.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
    bottom.contentView.addChildView(bottomView)
    await load(bottomView)
    await sleep(500)
    bottom.moveTop()
    await sleep(300)

    const point = { x: area.x + 120 + Math.round(WIDTH / 2), y: area.y + 80 + Math.round(HEIGHT / 2) }
    const clickOnce = async () => {
      const result = await osa(`tell application "System Events" to click at {${point.x}, ${point.y}}`)
      await sleep(500)
      return {
        result,
        bottom: JSON.parse(await bottomView.webContents.executeJavaScript('window.__cl()')),
      }
    }
    // System Events 偶尔第一次调用报 -600（没启动起来），先热一次再点
    const warmUp = await osa('tell application "System Events" to count processes')

    // 基线：没有透明窗挡着，同一个点必须点得到下面的窗口，否则这一整段读数没有意义
    const baseline = await clickOnce()

    const { window, view } = makeParking(area, 0)
    await load(view)
    bottom.moveTop()
    window.moveTop()
    await sleep(500)
    const through = await clickOnce()
    const topClicks = JSON.parse(await view.webContents.executeJavaScript('window.__cl()'))

    // 对照：关掉穿透，同一个点应该被上面那扇吞掉
    window.setIgnoreMouseEvents(false)
    await sleep(300)
    const swallowed = await clickOnce()
    const topClicksIgnoring = JSON.parse(await view.webContents.executeJavaScript('window.__cl()'))

    report.scenarios.push({
      name: 'C-click-through',
      point,
      warmUp,
      baseline,
      through: { ...through, top: topClicks },
      swallowed: { ...swallowed, top: topClicksIgnoring },
      note: 'baseline.bottom 必须是 down>=1；through.bottom 增加而 through.top 不增加才算穿透；swallowed.top 增加才算对照成立',
    })
    window.destroy()
    bottom.destroy()
  }

  // ---------- D：对照 —— 完全屏外（+ moveTop）在 macOS 上，页面读到什么、还出不出帧 ----------
  // 照抄 agent-first-shot 的那条路径：view 先在别处（一个从不显示的窗口里）load 好，再移进
  // 已经 showInactive 的停车窗 —— 产品里 tab 就是这样从浏览器窗口搬进停车窗的。
  // 两个位置：`right + 20000`（改动前）与 `bottom + 48`（方案 B）。
  {
    const displays = screen.getAllDisplays()
    const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width))
    const top = Math.min(...displays.map((d) => d.bounds.y))
    const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height))
    const left = Math.min(...displays.map((d) => d.bounds.x))
    const spots = [
      { label: 'D1-old-20000', spot: { x: right + 20000, y: top } },
      { label: 'D2-plan-b-48', spot: { x: left, y: bottom + 48 } },
    ]

    for (const { label, spot } of spots) {
      const birth = new BrowserWindow({ x: 40, y: 40, width: WIDTH, height: HEIGHT, show: false, frame: false })
      const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
      view.setBounds({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
      birth.contentView.addChildView(view)
      await load(view)
      await sleep(700)

      const window = new BrowserWindow({
        x: spot.x, y: spot.y, width: WIDTH, height: HEIGHT,
        show: false, frame: false, skipTaskbar: true,
        enableLargerThanScreen: true, alwaysOnTop: true,
        backgroundColor: '#2a2a2a',
      })
      window.showInactive()
      window.setAlwaysOnTop(true, 'floating')
      window.contentView.addChildView(view)
      await sleep(16)
      // agent-first-shot 在 moveTop 之前还做了两件事：attach debugger（产品每次截图前都会做，
      // 见 getViewportMetrics）和一次带 stayHidden/stayAwake 的 capturePage。照抄，否则测到的
      // 是"没被任何东西叫醒"的窗口，不是产品那条路径。
      try { await view.webContents.debugger.attach('1.3') } catch { /* 已经 attach 过 */ }
      await view.webContents.debugger.sendCommand('Runtime.evaluate', { expression: 'window.innerWidth', returnByValue: true }).catch(() => {})
      const primed = await Promise.race([
        view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }).then((i) => `answered ${i.getSize().width}x${i.getSize().height}`).catch((e) => `refused: ${e.message}`),
        sleep(1200).then(() => 'no answer'),
      ])
      window.moveTop()
      await sleep(16)

      const row = await probe(label, view)
      report.scenarios.push({
        name: `D-offscreen-${label}`,
        requested: spot,
        landed: window.getBounds(),
        primedCaptureBeforeMoveTop: primed,
        row,
        note: 'screenX / screenY 是页面在"完全屏外但被 moveTop"时读到的数',
      })
      view.webContents.debugger.detach?.()
      birth.destroy()
      window.destroy()
      await sleep(300)
    }
  }

  // ---------- E：导航之后还出帧吗（屏外方案在 macOS 上就是在这里丢合成的） ----------
  {
    const { window, view } = makeParking(area, 0)
    await load(view)
    await sleep(700)
    const before = await probe('E1-before-navigate', view)
    await view.webContents.loadURL(PAGE.replace('parked%20window', 'parked%20window%20(2)')).catch(() => {})
    await sleep(800)
    const after = await probe('E2-after-navigate-no-moveTop', view)
    report.scenarios.push({
      name: 'E-navigate-on-a-display',
      before,
      after,
      note: '导航后不补 moveTop；屏外方案在这种情况下会掉到 hidden / 0x0',
    })
    window.destroy()
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1))
  console.log('MAC_DONE')
  app.exit(0)
}

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')
// 每个场景都会把上一场的窗口全关掉；默认行为是此时直接退出应用，会把后面的场景一起掐掉。
app.on('window-all-closed', () => { /* 场景之间没有窗口是正常的 */ })
app.whenReady().then(() => main().catch((error) => {
  fs.writeFileSync(REPORT, JSON.stringify({ fatal: String(error && error.stack || error) }, null, 1))
  console.error('MAC_FATAL', error)
  app.exit(1)
}))
