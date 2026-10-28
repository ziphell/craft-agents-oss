// node_modules/electron/dist/electron.exe topmost-spike.js
const { app, BrowserWindow, WebContentsView, screen } = require('electron')
const fs = require('fs'), path = require('path')
const { execFileSync } = require('child_process')
const REPORT = path.join(__dirname, 'parking-topmost-onscreen.report.json')
const write = (o) => { try { fs.writeFileSync(REPORT, JSON.stringify(o, null, 1)) } catch (e) {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setName('Craft Agents')

const PAGE = (tag) => 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><title>${tag}</title>
<style>html,body{margin:0;height:100%;background:#39c;color:#fff;font:16px sans-serif}</style></head>
<body><h1>${tag}</h1><p>${'text '.repeat(150)}</p>
<script>
window.__log={down:0,up:0,move:0,lastXY:null}
addEventListener('mousedown',e=>{window.__log.down++;window.__log.lastXY=[e.clientX,e.clientY,e.isTrusted]},true)
addEventListener('mouseup',()=>window.__log.up++,true)
addEventListener('mousemove',()=>window.__log.move++,true)
window.__raf=0;requestAnimationFrame(function t(){window.__raf++;requestAnimationFrame(t)})
window.__st=()=>JSON.stringify({raf:window.__raf,visibility:document.visibilityState,hasFocus:document.hasFocus(),screenX:window.screenX,outer:[outerWidth,outerHeight],inner:[innerWidth,innerHeight]})
<\/script></body></html>`)

const PRELUDE = `Add-Type -Namespace W -Name A -MemberDefinition '
[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, System.UIntPtr e);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(System.Drawing.Point p);
' -ReferencedAssemblies System.Drawing; [void][W.A]::SetProcessDpiAwareness(2);`

function clickAt(x, y) {
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `${PRELUDE} [void][W.A]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 150; [W.A]::mouse_event(0x0002,0,0,0,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 80; [W.A]::mouse_event(0x0004,0,0,0,[System.UIntPtr]::Zero);`], { stdio: 'ignore', timeout: 20000 })
}
function windowFromPoint(x, y) {
  const ps = `${PRELUDE} $p = New-Object System.Drawing.Point(${x}, ${y}); [W.A]::WindowFromPoint($p).ToInt64()`
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 20000 }).toString().trim()
}
function listTopLevel() {
  const ps = `Add-Type -Namespace W -Name E -MemberDefinition '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l); public delegate bool EnumProc(System.IntPtr h, System.IntPtr l); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); [DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr h); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h, int i);'; $rows=@(); $cb=[W.E+EnumProc]{ param($h,$l) if([W.E]::IsWindowVisible($h)){ $len=[W.E]::GetWindowTextLength($h); $sb=New-Object System.Text.StringBuilder ($len+2); [void][W.E]::GetWindowText($h,$sb,$sb.Capacity); $ex=[W.E]::GetWindowLong($h,-20); $script:rows += ("{0}|{1}|{2}" -f $h.ToInt64(),$ex,$sb.ToString()) }; return $true }; [void][W.E]::EnumWindows($cb,[System.IntPtr]::Zero); $script:rows -join "\`n"`
  try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 25000 }).toString().trim().split('\n') } catch (e) { return ['err: ' + e.message] }
}

const handleOf = (win) => {
  const b = win.getNativeWindowHandle()
  return b.length === 8 ? b.readBigInt64LE(0) : BigInt(b.readUInt32LE(0))
}

app.whenReady().then(async () => {
  const r = {}
  const d = screen.getPrimaryDisplay()
  const wa = d.workArea
  const s = d.scaleFactor || 1
  const W = 900, H = 680
  const X = wa.x + Math.round((wa.width - W) / 2)
  const Y = wa.y + Math.round((wa.height - H) / 2)
  r.display = { workArea: wa, scaleFactor: s }
  r.rect = { x: X, y: Y, width: W, height: H }

  // 一个"用户的窗口"，正常层级
  const cover = new BrowserWindow({ x: X, y: Y, width: W, height: H, show: true, frame: true, title: 'USER-WINDOW' })
  const coverView = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  coverView.setBounds({ x: 0, y: 0, width: W - 16, height: H - 40 })
  cover.contentView.addChildView(coverView)
  await new Promise((res) => { coverView.webContents.once('did-finish-load', res); coverView.webContents.loadURL(PAGE('USER-WINDOW')) })
  cover.focus()
  await sleep(600)
  r.coverFocusedBefore = cover.isFocused()

  // 停车窗：主屏正中、透明、顶层、不抢焦点、穿透
  const park = new BrowserWindow({
    x: X, y: Y, width: W, height: H, show: false, frame: false,
    skipTaskbar: true, focusable: false, hasShadow: false, title: '',
  })
  park.setOpacity(0)
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } })
  view.setBounds({ x: 0, y: 0, width: W, height: H })
  park.contentView.addChildView(view)
  park.setIgnoreMouseEvents(true)
  park.showInactive()
  park.setAlwaysOnTop(true, 'floating')   // ← 你问的这一句
  park.moveTop()
  await new Promise((res) => { view.webContents.once('did-finish-load', res); view.webContents.loadURL(PAGE('PARK')) })
  await sleep(800)
  r.rightAfterRaise = {
    coverFocused: cover.isFocused(),
    parkFocused: park.isFocused(),
    coverStillVisible: cover.isVisible(),
    getFocusedWindow: BrowserWindow.getFocusedWindow() ? BrowserWindow.getFocusedWindow().getTitle() : null,
  }

  const st = async (wc) => { const a = JSON.parse(await wc.executeJavaScript('window.__st()')); await sleep(400); const b = JSON.parse(await wc.executeJavaScript('window.__st()')); return { ...b, rafTicks: b.raf - a.raf } }
  r.parkState = await st(view.webContents)
  r.coverState = await st(coverView.webContents)

  // 抓图能不能拿到
  try { const img = await view.webContents.capturePage(); r.parkCaptureBytes = img.toPNG().length } catch (e) { r.parkCaptureErr = String(e.message || e) }

  // 命中测试：屏幕正中的窗口应该是 USER-WINDOW，不是停车窗
  const cx = Math.round((X + W / 2) * s), cy = Math.round((Y + H / 2) * s)
  const parkHwnd = handleOf(park).toString()
  const coverHwnd = handleOf(cover).toString()
  r.hitTest = { parkHwnd, coverHwnd, windowFromPoint: windowFromPoint(cx, cy), point: [cx, cy] }

  // 真实点击：应该落在 USER-WINDOW
  const resetLog = async (wc) => { try { await wc.executeJavaScript('window.__log={down:0,up:0,move:0,lastXY:null}') } catch (e) {} }
  await resetLog(view.webContents); await resetLog(coverView.webContents)
  clickAt(cx, cy)
  await sleep(500)
  r.clickRouting = {
    park: JSON.parse(await view.webContents.executeJavaScript('JSON.stringify(window.__log)')),
    user: JSON.parse(await coverView.webContents.executeJavaScript('JSON.stringify(window.__log)')),
  }

  // 停车窗是否出现在"窗口列表"里（Alt-Tab / 共享选择器都会枚举到）
  const list = listTopLevel()
  r.parkInWindowEnumeration = list.filter((line) => line.startsWith(parkHwnd) || line.includes('PARK'))
  r.totalVisibleTitledWindows = list.filter((l) => { const p = l.split('|'); return p.length >= 3 && p[2].length > 0 }).length
  r.coverInEnumeration = list.filter((line) => line.includes('USER-WINDOW'))

  write(r)
  app.exit(0)
}).catch((e) => { write({ fatal: String(e && e.stack || e) }); app.exit(1) })
