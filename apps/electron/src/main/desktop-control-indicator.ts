/**
 * The standing half of "this desktop is being driven".
 *
 * The driver draws its own cursor, but a cursor is only visible where it happens to be: it can be on
 * another monitor, behind a window, or not drawn at all in a session without an interactive desktop.
 * This is the indicator that cannot be missed — a small always-on-top pill at the top of the screen
 * for as long as a session holds the desktop, with one way out that always works.
 *
 * Design rules, each of which costs something if broken:
 *
 * 1. **Never steals input.** The window is `focusable: false`, and it is click-through except over
 *    its own button (the renderer reports hover; main toggles `setIgnoreMouseEvents`). A badge that
 *    eats a click is worse than no badge.
 * 2. **Never survives the lease.** It is created when `onLeaseChange` fires with a session and
 *    destroyed when it fires with null — not hidden, destroyed, so a stale pill cannot claim a
 *    desktop nobody is driving.
 * 3. **The stop button releases the lease** in main, not in the renderer: one call to
 *    `ComputerUseManager.release()`, the same one `computer_tool stop` makes.
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const WIDTH = 392
const HEIGHT = 64
const TOP_INSET = 14
const CHANNEL = 'desktop-control-indicator'

export interface DesktopControlIndicatorOptions {
  /** Release the desktop. Called from the stop button. */
  release: () => void | Promise<void>
  log?: (message: string, details?: Record<string, unknown>) => void
}

export interface DesktopControlIndicator {
  /** A session took the desktop. */
  show: (label?: string) => void
  hide: () => void
  dispose: () => void
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent;
    font:13px/1.4 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;-webkit-user-select:none}
  /* Fills the window it is given: window bounds are DIP, so a fixed pixel height clips under
     display scaling. */
  .pill{position:absolute;inset:4px;display:flex;align-items:center;gap:10px;padding:0 10px 0 14px;
    border-radius:14px;background:rgba(24,24,27,.94);color:#fafafa;overflow:hidden;
    box-shadow:0 6px 20px rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.10)}
  .dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:#f97316;
    box-shadow:0 0 0 3px rgba(249,115,22,.22);animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center}
  .title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
  .sub{color:#a1a1aa;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  button{flex:0 0 auto;height:28px;padding:0 12px;border:0;border-radius:14px;cursor:pointer;
    background:rgba(255,255,255,.14);color:#fff;font:inherit;font-size:12.5px}
  button:hover{background:rgba(255,255,255,.24)}
  button:focus{outline:none}
</style></head>
<body><div class="pill">
  <span class="dot"></span>
  <span class="text">
    <span class="title">Craft 正在操作这台电脑</span>
    <span class="sub">AI 正在控制鼠标与键盘</span>
  </span>
  <button id="stop" type="button">停止</button>
</div>
<script>
  const { ipcRenderer } = require('electron')
  document.getElementById('stop').addEventListener('click', () => ipcRenderer.send('${CHANNEL}:stop'))
  document.body.addEventListener('mouseenter', () => ipcRenderer.send('${CHANNEL}:hover', true))
  document.body.addEventListener('mouseleave', () => ipcRenderer.send('${CHANNEL}:hover', false))
</script></body></html>`

export function createDesktopControlIndicator(
  options: DesktopControlIndicatorOptions,
): DesktopControlIndicator {
  const log = options.log ?? (() => {})
  let win: BrowserWindow | null = null
  let registered = false

  const position = () => {
    const { workArea } = screen.getPrimaryDisplay()
    return {
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + TOP_INSET),
      width: WIDTH,
      height: HEIGHT,
    }
  }

  const register = () => {
    if (registered) return
    registered = true
    ipcMain.on(`${CHANNEL}:stop`, () => {
      log('indicator: stop pressed')
      void Promise.resolve(options.release()).catch(() => {})
    })
    ipcMain.on(`${CHANNEL}:hover`, (event, hovering: unknown) => {
      // Only the pill's own renderer may toggle this, and only for the window that asked.
      if (!win || event.sender !== win.webContents) return
      win.setIgnoreMouseEvents(hovering !== true, { forward: true })
    })
  }

  const show = (label?: string) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(`${CHANNEL}:label`, label ?? '')
      win.showInactive()
      return
    }
    register()
    win = new BrowserWindow({
      ...position(),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      // Above ordinary always-on-top windows: the point is to survive whatever the agent raises.
      acceptFirstMouse: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
        devTools: false,
        backgroundThrottling: false,
      },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Click-through by default; the pill reports hover to become clickable for its stop button.
    win.setIgnoreMouseEvents(true, { forward: true })
    const page = join(__dirname, 'desktop-control-indicator.html')
    if (existsSync(page)) {
      void win.loadFile(page)
    } else {
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`)
    }
    win.once('ready-to-show', () => win?.showInactive())
    win.once('closed', () => {
      win = null
    })
    log('indicator: shown')
  }

  const hide = () => {
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }

  const dispose = () => {
    hide()
    if (registered) {
      ipcMain.removeAllListeners(`${CHANNEL}:stop`)
      ipcMain.removeAllListeners(`${CHANNEL}:hover`)
      registered = false
    }
  }

  return { show, hide, dispose }
}

/** The page the indicator loads when the build copies it next to the main bundle. */
export const DESKTOP_CONTROL_INDICATOR_PAGE = 'desktop-control-indicator.html'
export const DESKTOP_CONTROL_INDICATOR_HTML_URL = (file: string): string => pathToFileURL(file).href
