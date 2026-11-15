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
 * 1. **Stays out of the way, and can be moved.** The window is `focusable: false`, sized to what it
 *    draws (plus a small shadow margin), and not click-through: the badge expands on hover and can
 *    be dragged anywhere on screen. A large invisible click area would be worse than no badge, so
 *    the window shrinks and grows with the badge instead of staying at the expanded size.
 * 2. **Never survives the lease.** It is created when `onLeaseChange` fires with a session and
 *    destroyed when it fires with null — not hidden, destroyed, so a stale pill cannot claim a
 *    desktop nobody is driving. A dragged position is therefore temporary: the next lease starts
 *    at the top of the display the pointer is on.
 * 3. **The stop button releases the lease** in main, not in the renderer: one call to
 *    `ComputerUseManager.release()`, the same one `computer_tool stop` makes.
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/** The badge itself is 156×34 collapsed / 384×56 expanded; the window adds 8 px of shadow room. */
const COLLAPSED = { width: 172, height: 50 }
const EXPANDED = { width: 400, height: 72 }
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
  /* Two sizes in one window: a compact badge that grows on hover. Main resizes the window with it,
     so the interactive area is the badge plus an 8 px shadow margin — not a large empty rectangle. */
  .pill{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);box-sizing:border-box;
    display:flex;align-items:center;gap:8px;padding:0 11px;width:156px;height:34px;
    border-radius:11px;background:rgba(24,24,27,.94);color:#fafafa;overflow:hidden;
    box-shadow:0 6px 20px rgba(0,0,0,.32);border:1px solid rgba(255,255,255,.10);
    -webkit-app-region:drag;cursor:grab;
    transition:width .18s ease,height .18s ease,padding .18s ease,border-radius .18s ease,gap .18s ease}
  .pill.expanded{width:384px;height:56px;gap:10px;padding:0 10px 0 14px;border-radius:14px}
  .dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:#f97316;
    box-shadow:0 0 0 3px rgba(249,115,22,.22);animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center}
  .compact{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
  .full{display:none;flex-direction:column;justify-content:center;min-width:0}
  .pill.expanded .compact{display:none}
  .pill.expanded .full{display:flex}
  .title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
  .sub{color:#a1a1aa;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  button{flex:0 0 auto;height:28px;border:0;border-radius:14px;cursor:pointer;overflow:hidden;
    background:rgba(255,255,255,.14);color:#fff;font:inherit;font-size:12.5px;
    -webkit-app-region:no-drag;
    opacity:0;max-width:0;padding:0;pointer-events:none;
    transition:opacity .12s ease,max-width .18s ease,padding .18s ease}
  .pill.expanded button{opacity:1;max-width:80px;padding:0 12px;pointer-events:auto;
    transition:opacity .16s ease .05s,max-width .18s ease,padding .18s ease}
  button:hover{background:rgba(255,255,255,.24)}
  button:focus{outline:none}
</style></head>
<body><div class="pill" id="pill">
  <span class="dot"></span>
  <span class="text">
    <span class="compact">Craft 操作中</span>
    <span class="full">
      <span class="title">Craft 正在操作这台电脑</span>
      <span class="sub">AI 正在控制鼠标与键盘</span>
    </span>
  </span>
  <button id="stop" type="button">停止</button>
</div>
<script>
  const { ipcRenderer } = require('electron')
  const pill = document.getElementById('pill')
  let expanded = false
  const setExpanded = (next) => {
    if (next === expanded) return
    expanded = next
    pill.classList.toggle('expanded', next)
    // Main resizes the window with the badge, so the window never keeps a large empty hit area.
    ipcRenderer.send('${CHANNEL}:hover', next)
  }
  // The window is not click-through: entering it (badge + the 8 px shadow margin) expands,
  // leaving collapses. Dragging is the pill's app-region: drag.
  document.body.addEventListener('mouseenter', () => setExpanded(true))
  document.body.addEventListener('mouseleave', () => setExpanded(false))
  document.getElementById('stop').addEventListener('click', () => ipcRenderer.send('${CHANNEL}:stop'))
</script></body></html>`

export function createDesktopControlIndicator(
  options: DesktopControlIndicatorOptions,
): DesktopControlIndicator {
  const log = options.log ?? (() => {})
  let win: BrowserWindow | null = null
  let registered = false

  const position = () => {
    // The display the person is working on, not necessarily the primary one. On a multi-monitor
    // desk the driven window is often elsewhere; anchoring to the primary display could put the
    // one persistent signal out of sight. The pointer is the best hint available at lease start.
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return {
      x: Math.round(workArea.x + (workArea.width - COLLAPSED.width) / 2),
      y: Math.round(workArea.y + TOP_INSET),
      width: COLLAPSED.width,
      height: COLLAPSED.height,
    }
  }

  /**
   * Grow or shrink the window with the badge.
   *
   * The anchor is the current window's centre-x and top, so a pill the person dragged somewhere
   * else expands where they put it rather than snapping back to the display's centre. The badge is
   * 8 px inside the window on every side, which is why both sizes carry that margin.
   */
  const resize = (expanded: boolean) => {
    if (!win || win.isDestroyed()) return
    const current = win.getBounds()
    const size = expanded ? EXPANDED : COLLAPSED
    const centerX = current.x + current.width / 2
    const { workArea } = screen.getDisplayNearestPoint({
      x: Math.round(centerX),
      y: Math.round(current.y + current.height / 2),
    })
    const x = Math.min(
      Math.max(Math.round(centerX - size.width / 2), workArea.x),
      workArea.x + workArea.width - size.width,
    )
    const y = Math.min(
      Math.max(current.y, workArea.y),
      workArea.y + workArea.height - size.height,
    )
    win.setBounds({ x, y, width: size.width, height: size.height })
  }

  const register = () => {
    if (registered) return
    registered = true
    ipcMain.on(`${CHANNEL}:stop`, () => {
      log('indicator: stop pressed')
      void Promise.resolve(options.release()).catch(() => {})
    })
    ipcMain.on(`${CHANNEL}:hover`, (event, hovering: unknown) => {
      // Only the pill's own renderer may grow/shrink the window, and only for its own window.
      if (!win || event.sender !== win.webContents) return
      resize(hovering === true)
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
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      // Above ordinary always-on-top windows: the point is to survive whatever the agent raises.
      acceptFirstMouse: true,
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
    // Visible to the person, invisible to capture: macOS marks the window `NSWindowSharingNone`
    // and Windows excludes it from screen capture (`WDA_EXCLUDEFROMCAPTURE`). A screenshot of the
    // window underneath — or of the whole desktop — therefore never contains this pill, without
    // hiding and restoring it around each capture (which would flicker and can race).
    win.setContentProtection(true)
    // Not click-through: the badge is a draggable control now, and the window is sized to the
    // badge (plus its shadow margin), so there is no large invisible area to swallow clicks.
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
