/**
 * M6：用一次真实点击换一个数字 —— 透明置顶层下面的普通窗口，到底有没有收到 mousedown。
 *
 * 两扇窗完全重叠：下面一扇普通窗（会被激活、能收点击），上面一扇 0.55 不透明度、置顶、忽略鼠标。
 *
 * 上一轮什么数都没收到，原因是这扇 demo 应用**不是活动应用**：普通层级的下面那扇排在终端的后面，
 * 点击于是穿过了透明窗、落进了终端（人看到的就是"穿透下去了"），而下面的计数窗根本没被点到。
 * 所以这里先 `app.focus({steal:true})` 把自己变成活动应用，再把下面那扇窗 focus 起来。
 *
 * 两个窗口都 `acceptFirstMouse: true`：否则"点一扇没有焦点的窗，第一次按下只用来激活它"，
 * 不会送进页面。
 *
 *   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /tmp/m6-click.cjs
 */
const { app, BrowserWindow, WebContentsView, screen } = require('electron')

const W = 760
const H = 520
const DEADLINE_MS = 240_000

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;font:16px/1.5 system-ui,sans-serif;color:#fff}
body{display:flex;align-items:center;justify-content:center;text-align:center;background:__BG__}
h1{font-size:20px;margin:0 0 8px} p{margin:0;opacity:.9}
b{font-size:64px;display:block;margin:10px 0 2px}</style></head>
<body><div><h1>__TITLE__</h1><p>__BODY__</p><b id="n">0</b><p>mousedown</p></div>
<script>
window.__clicks = { down: 0, up: 0, move: 0 }
const paint = () => { document.getElementById('n').textContent = String(window.__clicks.down) }
addEventListener('mousedown', () => { window.__clicks.down++; paint() }, true)
addEventListener('mouseup', () => window.__clicks.up++, true)
addEventListener('mousemove', () => window.__clicks.move++, true)
window.__cl = () => JSON.stringify(window.__clicks)
</script></body></html>`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')
app.on('window-all-closed', () => {})

async function main() {
  const area = screen.getPrimaryDisplay().workArea
  const bounds = { x: area.x + 140, y: area.y + 60, width: W, height: H }

  const bottom = new BrowserWindow({
    ...bounds, show: false, frame: false, backgroundColor: '#0b2b3a', acceptFirstMouse: true,
  })
  const bottomView = new WebContentsView()
  bottomView.setBounds({ x: 0, y: 0, width: W, height: H })
  bottom.contentView.addChildView(bottomView)

  const overlay = new BrowserWindow({
    ...bounds, show: false, frame: false, skipTaskbar: true,
    focusable: false, hasShadow: false, alwaysOnTop: true, acceptFirstMouse: true,
  })
  overlay.setOpacity(0.55)
  overlay.setIgnoreMouseEvents(true)
  const overlayView = new WebContentsView()
  overlayView.setBounds({ x: 0, y: 0, width: W, height: H })
  overlay.contentView.addChildView(overlayView)

  const load = (view, title, body, bg) => new Promise((resolve) => {
    view.webContents.once('did-finish-load', resolve)
    view.webContents.loadURL(
      PAGE.replace('__TITLE__', title).replace('__BODY__', body).replace('__BG__', bg),
    )
  })
  await load(bottomView, '下面这扇窗（普通层级，会被激活）', '点到它，数字变 1', 'rgb(11,43,58)')
  await load(overlayView, '上面这扇窗（0.55 / 置顶 / 忽略鼠标）', '点这块紫色；它这里应该一直是 0', 'linear-gradient(120deg,rgb(123,47,247),rgb(241,7,163))')

  // 让这个应用成为活动应用：普通层级的窗只有在活动应用里才排在别的应用前面，
  // 否则点击穿过透明窗之后落进的是终端的窗口，而不是这扇计数窗。
  bottom.show()
  app.focus({ steal: true })
  await sleep(300)
  bottom.focus()
  await sleep(500)
  overlay.showInactive()
  overlay.setAlwaysOnTop(true, 'floating')
  overlay.moveTop()
  if (process.platform === 'darwin') overlay.setHiddenInMissionControl(true)
  await sleep(800)

  // 没能把这扇窗变成活动窗口，就把下面那扇也抬到 floating（排在 overlay 之下），
  // 这样点击穿透之后落到的仍然是它，而不是终端。
  let fallback = 'none'
  if (!BrowserWindow.getFocusedWindow()) {
    bottom.setAlwaysOnTop(true, 'floating')
    bottom.moveTop()
    overlay.moveTop()
    fallback = 'bottom-raised-to-floating'
    await sleep(300)
  }

  const read = async (view) => {
    try {
      return JSON.parse(await view.webContents.executeJavaScript('window.__cl()'))
    } catch (error) {
      return { error: String(error && error.message || error) }
    }
  }
  const active = () => BrowserWindow.getFocusedWindow()?.getTitle() || '(none)'
  console.log(`M6_READY box=${bounds.x},${bounds.y} ${W}x${H} center=${bounds.x + Math.round(W / 2)},${bounds.y + Math.round(H / 2)} focused=${active()} fallback=${fallback}`)

  const started = Date.now()
  let lastLine = ''
  while (Date.now() - started < DEADLINE_MS) {
    await sleep(1000)
    const top = await read(overlayView)
    const under = await read(bottomView)
    const line = `top=${JSON.stringify(top)} bottom=${JSON.stringify(under)} focused=${active()}`
    if (line !== lastLine) {
      console.log(`M6_TICK ${line}`)
      lastLine = line
    }
    if (under.down > 0 || top.down > 0) {
      await sleep(800)
      const top2 = await read(overlayView)
      const under2 = await read(bottomView)
      console.log(`M6_RESULT ${JSON.stringify({ top: top2, bottom: under2 })}`)
      console.log(under2.down > 0 && top2.down === 0 ? 'M6_PASS' : 'M6_FAIL')
      app.exit(0)
      return
    }
  }
  console.log('M6_RESULT none — 240 秒内没有任何 mousedown')
  app.exit(1)
}

app.whenReady().then(() => main().catch((error) => {
  console.error('M6_FATAL', error)
  app.exit(1)
}))
