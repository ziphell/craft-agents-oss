// node_modules/electron/dist/electron.exe input-spike2.js
const { app, BrowserWindow, screen } = require('electron')
const fs = require('fs'), path = require('path')
const { execFileSync } = require('child_process')
const REPORT = path.join(__dirname, 'parking-input-passthrough.report.json')
const write = (o) => { try { fs.writeFileSync(REPORT, JSON.stringify(o, null, 1)) } catch (e) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')

const PAGE = (tag, color) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${tag}</title>
<style>html,body{margin:0;height:100%;background:${color};font:16px sans-serif}</style></head>
<body><h1>${tag}</h1><p>${'text '.repeat(120)}</p>
<script>
window.__log = { down: 0, up: 0, move: 0, enter: 0, lastXY: null }
addEventListener('mousedown', e => { window.__log.down++; window.__log.lastXY = [e.clientX, e.clientY, e.isTrusted] }, true)
addEventListener('mouseup', () => window.__log.up++, true)
addEventListener('mousemove', () => window.__log.move++, true)
addEventListener('mouseenter', () => window.__log.enter++, true)
<\/script></body></html>`)

const read = async (wc) => { try { return JSON.parse(await wc.executeJavaScript('JSON.stringify(window.__log)')) } catch (e) { return { err: String(e.message || e) } } }
const reset = async (wc) => { try { await wc.executeJavaScript('window.__log={down:0,up:0,move:0,enter:0,lastXY:null}') } catch (e) {} }

const PRELUDE = `Add-Type -Namespace W -Name A -MemberDefinition '
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, System.UIntPtr e);
'; [void][W.A]::SetProcessDpiAwareness(2);`

function moveTo(x, y) {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${PRELUDE} [void][W.A]::SetCursorPos(${x},${y});`], { stdio: 'ignore', timeout: 20000 })
}
function clickAt(x, y) {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${PRELUDE} [void][W.A]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 150; [W.A]::mouse_event(0x0002,0,0,0,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [W.A]::mouse_event(0x0004,0,0,0,[System.UIntPtr]::Zero);`], { stdio: 'ignore', timeout: 20000 })
}
function windowStyles(handle) {
  const ps = `Add-Type -Namespace W -Name S -MemberDefinition '[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex); [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);'; $h=[IntPtr]${handle}; $ex=[W.S]::GetWindowLong($h,-20); $style=[W.S]::GetWindowLong($h,-16); $owner=[W.S]::GetWindow($h,4); "{0}|{1}|{2}" -f $style,$ex,$owner`
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 }).toString().trim()
}

app.whenReady().then(async () => {
  const r = {}
  const d = screen.getPrimaryDisplay()
  const s = d.scaleFactor || 1
  r.display = { workArea: d.workArea, scaleFactor: s }

  const target = { x: d.workArea.x + 300, y: d.workArea.y + 300, w: 520, h: 420 }
  const centerDip = { x: target.x + 260, y: target.y + 210 }
  const centerPhys = { x: Math.round(centerDip.x * s), y: Math.round(centerDip.y * s) }

  moveTo(centerPhys.x, centerPhys.y)
  await sleep(400)
  r.calibration = { sentPhysical: centerPhys, cursorPointDip: screen.getCursorScreenPoint(), expectedDip: centerDip }

  const under = new BrowserWindow({ x: target.x, y: target.y, width: target.w, height: target.h, show: false, frame: true, title: 'UNDER' })
  await under.loadURL(PAGE('UNDER', '#cde'))
  under.show(); under.focus()
  await sleep(700)
  await reset(under.webContents)
  clickAt(centerPhys.x, centerPhys.y)
  await sleep(500)
  r.baselineUnderOnly = await read(under.webContents)

  const over = new BrowserWindow({ x: target.x, y: target.y, width: target.w, height: target.h, show: false, frame: false, skipTaskbar: true, focusable: false, hasShadow: false })
  over.setOpacity(0)
  await over.loadURL(PAGE('OVER', '#000'))
  over.showInactive(); over.moveTop()
  await sleep(700)

  await reset(under.webContents); await reset(over.webContents)
  clickAt(centerPhys.x, centerPhys.y); await sleep(500)
  r.overNoIgnore = { under: await read(under.webContents), over: await read(over.webContents) }

  over.setIgnoreMouseEvents(true)
  await sleep(300)
  await reset(under.webContents); await reset(over.webContents)
  clickAt(centerPhys.x, centerPhys.y); await sleep(500)
  r.overIgnore = { under: await read(under.webContents), over: await read(over.webContents) }

  over.setIgnoreMouseEvents(false)
  await sleep(200)
  await reset(under.webContents); await reset(over.webContents)
  moveTo(centerPhys.x - 30, centerPhys.y - 30); await sleep(500)
  r.hoverNoIgnore = { under: await read(under.webContents), over: await read(over.webContents) }

  over.setIgnoreMouseEvents(true)
  await sleep(200)
  await reset(under.webContents); await reset(over.webContents)
  moveTo(centerPhys.x + 30, centerPhys.y + 30); await sleep(500)
  r.hoverIgnore = { under: await read(under.webContents), over: await read(over.webContents) }

  try {
    const hb = over.getNativeWindowHandle()
    const handle = hb.length === 8 ? hb.readBigInt64LE(0).toString() : String(hb.readUInt32LE(0))
    const [style, ex, owner] = windowStyles(handle).split('|')
    const e = Number(ex), st = Number(style)
    r.styles = {
      style: st, ex: e, owner,
      WS_EX_TRANSPARENT: !!(e & 0x20), WS_EX_LAYERED: !!(e & 0x80000),
      WS_EX_TOOLWINDOW: !!(e & 0x80), WS_EX_NOACTIVATE: !!(e & 0x08000000),
      WS_EX_APPWINDOW: !!(e & 0x40000), hasOwner: owner !== '0', WS_POPUP: !!(st & 0x80000000),
    }
  } catch (err) { r.styles = { error: String(err.message || err) } }

  write(r)
  app.exit(0)
}).catch((e) => { write({ fatal: String(e && e.stack || e) }); app.exit(1) })
