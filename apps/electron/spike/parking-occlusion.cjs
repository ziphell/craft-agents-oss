// 用法:
//   electron.exe occlusion-spike.js                -> 禁用遮挡计算（应用现在的开关）
//   electron.exe occlusion-spike.js --allow-occ    -> 不禁用，作为对照
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const fs = require('fs'), path = require('path')

const ALLOW_OCCLUSION = process.argv.includes('--allow-occ')
if (!ALLOW_OCCLUSION) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')

const REPORT = path.join(__dirname, `parking-occlusion${ALLOW_OCCLUSION ? '-allow' : ''}.report.json`)
const write = (o) => { try { fs.writeFileSync(REPORT, JSON.stringify(o, null, 1)) } catch (e) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>paint</title>
<style>html,body{margin:0;height:100%;background:linear-gradient(90deg,#f00,#0f0,#00f)}</style></head>
<body><h1>paint</h1><p>${'text '.repeat(150)}</p>
<script>
window.__raf = 0
requestAnimationFrame(function t(){ window.__raf++; requestAnimationFrame(t) })
window.__st = () => JSON.stringify({ raf: window.__raf, visibility: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), screenX: window.screenX })
<\/script></body></html>`)

async function probe(wc) {
  const a = JSON.parse(await wc.executeJavaScript('window.__st()'))
  const t0 = Date.now()
  await sleep(400)
  const b = JSON.parse(await wc.executeJavaScript('window.__st()'))
  const ms = Date.now() - t0
  let capBytes = 0, capErr = null
  try { const img = await wc.capturePage(); capBytes = img.toPNG().length } catch (e) { capErr = String(e.message || e) }
  // screencast 帧：真正的"还在不在画"
  let frames = 0, castErr = null
  const dbg = wc.debugger
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
    const onMsg = (_e, method) => { if (method === 'Page.screencastFrame') frames++ }
    dbg.on('message', onMsg)
    await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 1 })
    await sleep(900)
    try { await dbg.sendCommand('Page.stopScreencast') } catch (e) {}
    dbg.removeListener('message', onMsg)
  } catch (e) { castErr = String(e.message || e) }
  return { ...b, rafTicks: b.raf - a.raf, window: ms, captureBytes: capBytes, captureErr: capErr, screencastFrames: frames, screencastErr: castErr }
}

app.whenReady().then(async () => {
  const r = { allowOcclusion: ALLOW_OCCLUSION, occlusionDisabled: !ALLOW_OCCLUSION }
  const wa = screen.getPrimaryDisplay().workArea
  const X = wa.x + 200, Y = wa.y + 200, W = 900, H = 700

  // 停车窗（屏内合法坐标）
  const park = new BrowserWindow({ x: X, y: Y, width: W, height: H, show: false, frame: false, skipTaskbar: true, focusable: false })
  park.setOpacity(Number(process.env.PARK_OPACITY || 0))
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  park.contentView.addChildView(view)
  park.showInactive()
  await new Promise((res) => { view.webContents.once('did-finish-load', res); view.webContents.loadURL(PAGE) })
  await sleep(600)
  r.parkWindow = { bounds: park.getBounds(), opacity: park.getOpacity() }

  r.uncovered = await probe(view.webContents)

  // 盖一个不透明的窗口，完全覆盖它
  const cover = new BrowserWindow({ x: X, y: Y, width: W, height: H, show: true, frame: true, backgroundColor: '#333300' })
  await cover.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;height:100%;background:#330">cover</body>'))
  cover.moveTop(); cover.focus()
  await sleep(700)
  r.covered = await probe(view.webContents)
  r.coveredState = { coverFocused: cover.isFocused(), parkFocused: park.isFocused() }

  // 再叠一层，确保不是"刚好没挡住"
  const cover2 = new BrowserWindow({ x: X - 50, y: Y - 50, width: W + 100, height: H + 100, show: true, frame: false, backgroundColor: '#003300' })
  await cover2.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;height:100%;background:#030">cover2</body>'))
  cover2.moveTop()
  await sleep(700)
  r.doubleCovered = await probe(view.webContents)

  // 把盖的窗口最小化
  cover.hide(); cover2.hide()
  await sleep(700)
  r.revealed = await probe(view.webContents)

  write(r)
  app.exit(0)
}).catch((e) => { write({ fatal: String(e && e.stack || e) }); app.exit(1) })
