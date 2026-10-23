import { BrowserWindow, shell, nativeTheme, Menu, app } from 'electron'
import { windowLog } from './logger'
import { join, resolve, sep } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadDesignConfig } from '@craft-agent/shared/designs'
import { classifyExternalUrl, formatBlockedUrlError } from '@craft-agent/shared/utils/url-safety'
import { RPC_CHANNELS, type WindowCloseRequestSource, type RemoteWindowTarget } from '../shared/types'
import { routes } from '../shared/routes'
import { getWindowsBackgroundMaterial } from './window-material'
import type { SavedWindow } from './window-state'

// Vite dev server URL for hot reload
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

/**
 * Where the macOS traffic lights sit, in window coordinates. The window opens with this position,
 * and `setWindowButtonVisibility` drops the buttons at the OS default when they are shown again, so
 * the restore path has to re-apply it. One constant for both, because the two had drifted: the
 * window opened at y 16, and the first fullscreen overlay to close put them at y 19 — 3px low, and
 * that is where they stayed for the rest of the session.
 */
const MAC_TRAFFIC_LIGHT_POSITION = { x: 18, y: 16 }

interface ManagedWindow {
  window: BrowserWindow
  workspaceId: string
  /**
   * The remote hub this window is connected to. Absent for a local window. The preload reads it
   * during evaluation (`__get-client-mode`), so it is stored **before** loadURL.
   */
  remote?: RemoteWindowTarget
  /**
   * The design this window belongs to, when it is a design's own window (a
   * temporary view opened from the tray — docs/design-plan.md §2.7). Absent for
   * ordinary workspace windows. Its presence is what makes the window temporary:
   * see the close handler, getWindowStates, getWindowByWorkspace.
   */
  designSlug?: string
  /**
   * A title the renderer chose, for a window whose subject this process cannot name.
   *
   * A remote window's workspace lives on the hub, so `getWorkspaceByNameOrId` (this machine's
   * config) cannot resolve it. The renderer knows both halves — the workspace on screen and the
   * server — and sets "<workspace> — <server>" through `window:set-title`.
   */
  customTitle?: string
}

export interface CreateWindowOptions {
  /** The workspace to open (empty string for onboarding) */
  workspaceId: string
  /** The hub this window connects to; omitted means this machine's own server. */
  remote?: RemoteWindowTarget
  /** Whether to open in focused mode (smaller window, no sidebars) */
  focused?: boolean
  /** Deep link URL to navigate to after window loads (without ?window= param) */
  initialDeepLink?: string
  /** Full URL to restore from saved state (preserves route/query params) */
  restoreUrl?: string
  /**
   * Route to land on, written straight into the window's query (`?route=`) — the
   * renderer reconciles its first panel from it. No deep link is parsed, so this
   * does not require the route's prefix to be a known deep-link host.
   */
  initialRoute?: string
  /**
   * The design this window is for. Marks it a **temporary window** (see
   * docs/tray-plan.md §3.7): it closes for real, is never restored on relaunch,
   * never stands in for the workspace's home window, titles itself after the
   * design, and lands on the design's route. What `openDesignWindow` passes.
   */
  designSlug?: string
}

export class WindowManager {
  private windows: Map<number, ManagedWindow> = new Map()  // webContents.id → ManagedWindow
  private focusedModeWindows: Set<number> = new Set()  // webContents.id of windows in focused mode
  private pendingCloseTimeouts: Map<number, NodeJS.Timeout> = new Map()  // Fallback timeouts for window close
  private eventSink: ((channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null = null
  private clientResolver: ((wcId: number) => string | undefined) | null = null
  /**
   * Answers "send this address to the workspace's browser instead" for links React never saw —
   * a sandboxed preview navigates the top frame, so only main is in the way. Returning true
   * means it was taken care of and nothing should go to `shell.openExternal`.
   */
  private inAppLinkOpener: ((url: string, window: BrowserWindow) => boolean) | null = null
  private keyboardCloseIntents: Set<number> = new Set()  // webContents.id flagged by Cmd/Ctrl+W before close
  private keyboardCloseIntentTimeouts: Map<number, NodeJS.Timeout> = new Map()  // Auto-clear stale keyboard-close intents
  private isAppQuitting = false  // Skip layered close interception during app quit
  /**
   * Whether the app stays alive between windows. It is only true when there is a
   * way back to a window — the tray (or, on macOS, the dock). Without one, a close
   * stays a real close, or the app would sit invisible with nothing to bring back.
   */
  private resident = false
  /**
   * The window the person used most recently, and the workspace it was on. A
   * window close hides rather than destroys, so this is what the tray brings
   * back; it also answers "which workspace" when nothing is open any more and a
   * new window has to be made. Updated on focus.
   */
  private lastActiveWebContentsId: number | null = null
  private lastActiveWorkspaceId: string | null = null
  /**
   * When each window was last used, as a monotonically increasing count. A workspace can have
   * more than one window, and "that workspace's window" — what the tray and a notification
   * click bring back — is the one used most recently, not the one created first.
   */
  private useCount = 0
  private lastUsedAt: Map<number, number> = new Map()

  /**
   * Set the event sink and client resolver for pushing events via the RPC server
   * instead of webContents.send. Called after server creation.
   */
  setRpcEventSink(
    sink: (channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void,
    resolver: (wcId: number) => string | undefined
  ): void {
    this.eventSink = sink
    this.clientResolver = resolver
  }

  /** See `inAppLinkOpener` — set once, by the app, when the browser handlers are registered. */
  setInAppLinkOpener(opener: (url: string, window: BrowserWindow) => boolean): void {
    this.inAppLinkOpener = opener
  }

  /** Return current RPC event sink, if transport has been initialized. */
  getRpcEventSink(): ((channel: string, target: import('@craft-agent/shared/protocol').PushTarget, ...args: any[]) => void) | null {
    return this.eventSink
  }

  /** Resolve a window's current clientId from transport handshake state. */
  getClientIdForWindow(webContentsId: number): string | undefined {
    return this.clientResolver?.(webContentsId)
  }

  /** Push an event to a specific window via the RPC event sink. Falls back to webContents.send. */
  private pushToWindow(window: BrowserWindow, channel: string, ...args: any[]): void {
    if (this.eventSink && this.clientResolver) {
      const clientId = this.clientResolver(window.webContents.id)
      if (clientId) {
        this.eventSink(channel, { to: 'client', clientId }, ...args)
        return
      }
    }
    // Fallback: direct webContents.send (used before WS handshake completes)
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
      window.webContents.send(channel, ...args)
    }
  }

  private isRendererAppUrl(url: string): boolean {
    if (VITE_DEV_SERVER_URL) {
      try {
        const parsed = new URL(url)
        const devServer = new URL(VITE_DEV_SERVER_URL)
        if (parsed.origin === devServer.origin) return true
      } catch {
        // Fall through to file:// handling below.
      }
    }

    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'file:') return false

      const filePath = resolve(fileURLToPath(parsed))
      const rendererRoot = resolve(join(__dirname, 'renderer'))
      return filePath === join(rendererRoot, 'index.html') || filePath.startsWith(rendererRoot + sep)
    } catch {
      return false
    }
  }

  private openExternalFromRenderer(url: string, context: string, sourceWindow?: BrowserWindow): void {
    const classification = classifyExternalUrl(url)

    if (classification.kind === 'dangerous') {
      windowLog.warn(`[url-safety] Blocked ${context}: ${formatBlockedUrlError(classification)} url=${url}`)
      return
    }

    if (classification.kind === 'internal-deeplink') {
      if (!sourceWindow) {
        windowLog.warn(`[url-safety] Blocked ${context}: internal deep link has no target window url=${url}`)
        return
      }

      void import('./deep-link').then(async ({ handleDeepLink }) => {
        const result = await handleDeepLink(
          url,
          this,
          this.eventSink ?? undefined,
          this.clientResolver ?? undefined,
          this.clientResolver?.(sourceWindow.webContents.id),
        )
        if (!result.success) {
          windowLog.warn(`[url-safety] Blocked ${context}: unsupported internal deep link url=${url} error=${result.error ?? 'unknown'}`)
        }
      }).catch((error) => {
        windowLog.warn(`[url-safety] Failed to route internal deep link from ${context}: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }

    // A remote window's browser is on its server. The renderer decides where the address goes
    // (the workspace's browser, or the system browser when that is what the person chose), so
    // main only hands it over; a local window has nothing to hand it over to.
    if (sourceWindow && this.inAppLinkOpener?.(url, sourceWindow)) return

    void shell.openExternal(url).catch((error) => {
      windowLog.warn(`[url-safety] Failed to open external URL from ${context}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Apply the window-title policy across all managed windows:
   *   1 window  → app name ("Craft Agents") on the lone window
   *   ≥2 windows → workspace name on each window, app-name fallback when the
   *                workspace can't be resolved (e.g. onboarding window).
   *
   * Called after createWindow() registers a new window and after the closed
   * handler removes one, so titles always reflect the current window count.
   * Renderer-driven page-title-updated events are suppressed in createWindow
   * so these setTitle() calls aren't clobbered by the static <title> tag.
   */
  private refreshWindowTitles(): void {
    const defaultTitle = app.getName()
    // Design windows title themselves (set in createWindow) and are skipped here;
    // they also do not count towards the "≥2 windows → workspace name" rule, which
    // is about disambiguating ordinary workspace windows.
    const showWorkspaceName = [...this.windows.values()].filter(m => !m.designSlug).length > 1
    for (const { window, workspaceId, designSlug, customTitle } of this.windows.values()) {
      if (window.isDestroyed()) continue
      if (designSlug) continue
      let title = customTitle ?? defaultTitle
      if (!customTitle && showWorkspaceName && workspaceId) {
        try {
          const ws = getWorkspaceByNameOrId(workspaceId)
          if (ws?.name) title = ws.name
        } catch (err) {
          windowLog.warn('refreshWindowTitles: workspace lookup failed', { workspaceId, err })
        }
      }
      window.setTitle(title)
    }
  }

  /**
   * Let a window name itself. Passing an empty title hands the title back to `refreshWindowTitles`.
   *
   * Only used by remote windows: their workspace is not in this machine's config, so the
   * workspace-name rule above would fall back to the app name and leave several remote windows
   * indistinguishable.
   */
  setWindowTitle(webContentsId: number, title: string | null): void {
    const managed = this.windows.get(webContentsId)
    if (!managed) return
    const trimmed = title?.trim()
    if (trimmed) managed.customTitle = trimmed
    else delete managed.customTitle
    this.refreshWindowTitles()
  }

  /**
   * A saved server was edited: every window bound to it takes the new address, token and name.
   *
   * Returns the windows affected so the caller can tell each one to rebuild its socket — the
   * preload builds that socket from the target when it loads, not on every call.
   */
  updateRemoteTargetForConnection(
    connectionId: string,
    next: { url: string; token: string; name?: string },
  ): number[] {
    const affected: number[] = []
    for (const [webContentsId, managed] of this.windows) {
      if (!managed.remote || managed.remote.connectionId !== connectionId) continue
      managed.remote.url = next.url
      managed.remote.token = next.token
      if (next.name) managed.remote.name = next.name
      affected.push(webContentsId)
    }
    return affected
  }

  /**
   * Create a new window for a workspace
   * @param options - Window creation options
   */
  createWindow(options: CreateWindowOptions): BrowserWindow {
    const { workspaceId, focused = false, initialDeepLink, restoreUrl, initialRoute, designSlug, remote } = options

    // Load platform-specific app icon
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const getIconPath = () => {
      const iconName = process.platform === 'darwin' ? 'icon.icns'
        : process.platform === 'win32' ? 'icon.ico'
        : 'icon.png'
      return [
        join(__dirname, 'resources', iconName),
        join(__dirname, '../resources', iconName),
      ].find(p => existsSync(p)) ?? join(__dirname, '../resources', iconName)
    }

    const iconPath = getIconPath()
    const iconExists = existsSync(iconPath)

    if (!iconExists) {
      windowLog.warn('App icon not found at:', iconPath)
    }

    // Use smaller window size for focused mode (single session view)
    const windowWidth = focused ? 900 : 1400
    const windowHeight = focused ? 700 : 900

    // Platform-specific window options
    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowsBackgroundMaterial = getWindowsBackgroundMaterial()

    const window = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      minWidth: 800,
      minHeight: 600,
      show: false, // Don't show until ready-to-show event (faster perceived startup)
      title: '',
      icon: iconExists ? iconPath : undefined,
      // macOS-specific: hidden title bar with inset traffic lights. A design
      // window keeps the standard title bar instead — it has no in-app header, and
      // the system title bar is what the window is dragged by (docs/design-plan.md §2.7).
      ...(isMac && !designSlug && {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
        vibrancy: 'under-window',
        visualEffectState: 'active',
      }),
      // Windows: a self-drawn bar with self-drawn caption buttons.
      // `titleBarStyle: 'hidden'` takes the native title bar away and leaves the top strip to the
      // app's own header (TopBar); the minimize/maximize/close buttons are drawn by the app too
      // (`WindowControls`), so they belong to the bar rather than sitting on it in the OS's own
      // style. The trade is Snap Layouts — the hover-the-maximize-button layout flyout is the OS's,
      // and there is no API for a button we draw ourselves — while dragging to a screen edge,
      // Win+arrows, double-click-to-maximize and the resize borders are all unaffected. A design
      // window keeps the standard title bar: it has no in-app header, and the system title bar is
      // what the window is dragged by (docs/design-plan.md §2.7).
      ...(isWindows && !designSlug && {
        titleBarStyle: 'hidden',
        autoHideMenuBar: true, // Menu is null on Windows, this is just for safety
        // Note: Don't use transparent:true with backgroundMaterial - it hides the window frame
        ...(windowsBackgroundMaterial && {
          backgroundMaterial: windowsBackgroundMaterial,
        }),
      }),
      // Windows design window: the standard title bar, as above.
      ...(isWindows && designSlug && {
        frame: true,
        autoHideMenuBar: true,
        ...(windowsBackgroundMaterial && {
          backgroundMaterial: windowsBackgroundMaterial,
        }),
      }),
      // Linux: use native frame
      ...(!isMac && !isWindows && {
        frame: true,
        autoHideMenuBar: true,
      }),
      webPreferences: {
        preload: join(__dirname, 'bootstrap-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: false // Browser integration uses WebContentsView, not <webview>
      }
    })

    // Show window when first paint is ready (faster perceived startup). A restored
    // window is shown too: opening the app means seeing it (see docs/tray-plan.md §3.4).
    window.once('ready-to-show', () => {
      window.show()
    })

    // Open external links in default browser, but never hand known-dangerous
    // schemes directly to shell.openExternal. Markdown normal-clicks go through
    // OPEN_URL; middle-clicks/window.open/top-navigation land here.
    window.webContents.setWindowOpenHandler((details) => {
      this.openExternalFromRenderer(details.url, 'window-open', window)
      return { action: 'deny' }
    })

    // Handle external navigation attempts from renderer WebContents
    window.webContents.on('will-navigate', (event, url) => {
      // Allow only the actual app shell (file:// in prod, Vite dev server in dev).
      // Any other navigation is treated as an external URL and goes through the
      // same URL-safety classifier used by OPEN_URL.
      if (this.isRendererAppUrl(url)) return

      event.preventDefault()
      this.openExternalFromRenderer(url, 'will-navigate', window)
    })

    // Enable right-click context menu in development
    if (!app.isPackaged) {
      window.webContents.on('context-menu', (_event, params) => {
        Menu.buildFromTemplate([
          { label: 'Inspect Element', click: () => window.webContents.inspectElement(params.x, params.y) },
          { type: 'separator' },
          { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
          { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
          { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        ]).popup()
      })
    }

    // The renderer's index.html ships with `<title>Craft Agents</title>`, so
    // without this Electron auto-syncs every window's title back to that on
    // load — clobbering the workspace-name policy applied below. Suppress the
    // default sync so setTitle() calls from refreshWindowTitles() stick.
    window.on('page-title-updated', (event) => {
      event.preventDefault()
    })

    // Store the window mapping BEFORE loadURL — bootstrap preload uses
    // __get-workspace-id (via sendSync) which reads this map during eval.
    const webContentsId = window.webContents.id
    this.windows.set(webContentsId, { window, workspaceId, ...(remote ? { remote } : {}), ...(designSlug ? { designSlug } : {}) })

    // Apply window-title policy now that the map size reflects this window —
    // covers both the new window and any existing windows that should switch
    // from app name → workspace name as the count crosses 1 → 2.
    this.refreshWindowTitles()

    // A design window titles itself after the design, not the workspace
    // (refreshWindowTitles skips it). Falls back to the slug if the config can't
    // be read — better a slug than the workspace name.
    if (designSlug) {
      window.setTitle(this.designTitleFor(workspaceId, designSlug) ?? designSlug)
    }

    // Track focused mode state for persistence
    if (focused) {
      this.focusedModeWindows.add(webContentsId)
    }

    // Load the renderer - use restoreUrl if provided, otherwise build from options
    if (restoreUrl) {
      // Restore from saved URL - need to adapt for dev vs prod
      if (VITE_DEV_SERVER_URL) {
        // In dev mode, replace the base URL but keep the path and query
        try {
          const savedUrl = new URL(restoreUrl)
          const devUrl = new URL(VITE_DEV_SERVER_URL)
          // Preserve pathname and search from saved URL, use dev server host
          devUrl.pathname = savedUrl.pathname
          devUrl.search = savedUrl.search
          window.loadURL(devUrl.toString())
        } catch {
          // Fallback if URL parsing fails
          windowLog.warn('Failed to parse restoreUrl, using default:', restoreUrl)
          const params = new URLSearchParams({ workspaceId, ...(focused && { focused: 'true' }) }).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }
      } else {
        // In prod, always extract query params and load from current __dirname.
        // Never load file:// URLs directly — the path may be stale (e.g. Linux AppImage
        // mounts to a different /tmp dir on each launch). See #13.
        try {
          const savedUrl = new URL(restoreUrl)
          const query: Record<string, string> = {}
          savedUrl.searchParams.forEach((value, key) => { query[key] = value })
          window.loadFile(join(__dirname, 'renderer/index.html'), { query })
        } catch {
          window.loadFile(join(__dirname, 'renderer/index.html'), { query: { workspaceId } })
        }
      }
    } else {
      // Build URL from options
      const query: Record<string, string> = { workspaceId }
      if (focused) {
        query.focused = 'true' // Open in focused mode (no sidebars)
      }
      // The renderer reconciles its first panel from `?route=` (see
      // NavigationContext), so this lands the window on a route with no deep link.
      if (initialRoute) {
        query.route = initialRoute
      }
      // Marks the window so the renderer drops the "back to Designs" chrome (§2.7).
      if (designSlug) {
        query.designWindow = 'true'
      }

      if (VITE_DEV_SERVER_URL) {
        const params = new URLSearchParams(query).toString()
        window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query })
      }
    }

    // Fallback: if the renderer fails to load (e.g. stale path, disk error),
    // recover gracefully by loading the default state instead of showing a white screen. See #13.
    // In dev mode, retry the Vite dev server (it may not be ready yet) instead of falling back
    // to file:// which doesn't exist during development.
    let failLoadRetries = 0
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      windowLog.warn('Failed to load renderer:', errorCode, errorDescription)
      if (VITE_DEV_SERVER_URL && failLoadRetries < 5) {
        failLoadRetries++
        windowLog.info(`Retrying Vite dev server (attempt ${failLoadRetries}/5)...`)
        setTimeout(() => {
          const params = new URLSearchParams({ workspaceId }).toString()
          window.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
        }, 1000)
      } else {
        window.loadFile(join(__dirname, 'renderer/index.html'), { query: { workspaceId } })
      }
    })

    // If an initial deep link was provided, navigate to it after the window is ready
    if (initialDeepLink) {
      window.once('ready-to-show', () => {
        // Import parseDeepLink dynamically to avoid circular dependency
        import('./deep-link').then(({ parseDeepLink }) => {
          const target = parseDeepLink(initialDeepLink)
          if (target && (target.view || target.action)) {
            // Wait a bit for React to mount and register IPC listeners
            setTimeout(() => {
              this.pushToWindow(window, RPC_CHANNELS.deeplink.NAVIGATE, {
                view: target.view,
                action: target.action,
                actionParams: target.actionParams,
              })
            }, 100)
          }
        })
      })
    }

    // Listen for system theme changes and notify this window's renderer. The Windows caption
    // buttons are the app's own now (`WindowControls`), so there is no OS overlay left to
    // re-theme here — the buttons follow the app's colours with the rest of the bar.
    const themeHandler = () => {
      this.pushToWindow(window, RPC_CHANNELS.theme.SYSTEM_CHANGED, nativeTheme.shouldUseDarkColors)
    }
    nativeTheme.on('updated', themeHandler)

    // Handle focus/blur to broadcast window focus state
    window.on('focus', () => {
      // Remember what was used last — the tray brings this one back (see raiseOrCreateWindow).
      this.lastActiveWebContentsId = webContentsId
      this.markUsed(webContentsId)
      const managed = this.windows.get(webContentsId)
      // A remote window's workspace belongs to a hub, not to this machine's workspace list.
      // Remembering it would point "open local window" and the tray fallback at an unknown id.
      if (!managed?.remote) {
        this.lastActiveWorkspaceId = managed?.workspaceId ?? workspaceId
      }
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, true)
    })
    window.on('blur', () => {
      this.pushToWindow(window, RPC_CHANNELS.window.FOCUS_STATE, false)
      releasePointer()
    })

    /**
     * Tell the page the pointer has left, on every way the window goes away or comes back.
     *
     * Chromium keeps the pointer where it last saw it and never delivers the `mouseleave` that
     * the window going away would have caused, so the control under it keeps its `:hover` — a
     * window minimised from its own minimise button shows that button hovered again on restore —
     * and an open tooltip stays open. A synthetic DOM event from the renderer does not clear
     * `:hover`; an input event does, which is why it is sent from here.
     */
    const releasePointer = () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
    }
    window.on('minimize', releasePointer)
    window.on('hide', releasePointer)
    window.on('restore', releasePointer)
    window.on('show', releasePointer)

    // Whether the window is maximized, for the app's own maximize/restore button (`WindowControls`).
    // Pushed on the two events that change it; a window that mounts after the last change asks
    // (`window:getMaximizedState`) rather than relying on a push it may have missed.
    const pushMaximized = () => {
      this.pushToWindow(window, RPC_CHANNELS.window.MAXIMIZED_STATE, window.isMaximized())
    }
    window.on('maximize', pushMaximized)
    window.on('unmaximize', pushMaximized)

    // Detect Cmd/Ctrl+W before close events so renderer can distinguish close source.
    // Intent is short-lived to avoid stale classification.
    window.webContents.on('before-input-event', (event, input) => {
      if (!input || input.type !== 'keyDown') return
      const key = input.key?.toLowerCase?.()

      // A design's own window is meant to be shown like the page itself, so F11
      // puts it fullscreen (docs/design-plan.md §2.7) — and on macOS, where F11 is
      // not a fullscreen key, the convention ⌃⌘F does the same. Other windows keep both.
      const wantsFullscreen = designSlug && (
        input.key === 'F11'
        || (process.platform === 'darwin' && key === 'f' && !!input.control && !!input.meta)
      )
      if (wantsFullscreen) {
        event.preventDefault()
        window.setFullScreen(!window.isFullScreen())
        return
      }

      if (key !== 'w') return

      const isCloseShortcut = process.platform === 'darwin'
        ? !!input.meta
        : !!input.control

      if (!isCloseShortcut) return

      const wcId = window.webContents.id
      this.keyboardCloseIntents.add(wcId)
      const existingTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
      if (existingTimeout) clearTimeout(existingTimeout)

      this.keyboardCloseIntentTimeouts.set(wcId, setTimeout(() => {
        this.keyboardCloseIntentTimeouts.delete(wcId)
        this.keyboardCloseIntents.delete(wcId)
      }, 500))
    })

    // Handle window close request (traffic-light button, menu close, Cmd/Ctrl+W).
    //
    // Only the **last** main window is put away (hidden) — the app lives in the tray,
    // and that window keeps its state for when it is brought back. Every other main
    // window really closes (is destroyed) one by one: a workspace no longer keeps a
    // hidden window (see docs/tray-plan.md §3.7).
    window.on('close', (event) => {
      // During app quit, let the native close flow run (Cmd+Q means quit, not hide).
      // This preserves expected Cmd+Q semantics (quit app instead of closing overlays/panels first).
      if (this.isAppQuitting) {
        return
      }

      // Without a way back to a window (the tray), a close is a real close — the
      // app must not outlive its last window with nothing left on screen.
      if (!this.resident) {
        return
      }

      // A design window is a temporary view (docs/design-plan.md §2.7): it closes
      // for real even when it is the only window of its workspace — a mini-app
      // opened from the tray must not linger hidden with nothing to bring it back.
      if (this.windows.get(webContentsId)?.designSlug) {
        return
      }

      // Only the last main window is put away; every other main window is a real close
      // (destroyed). The count is across all workspaces — a workspace no longer keeps a
      // window.
      const aliveMainWindows = [...this.windows.values()].filter(
        managed => !managed.designSlug && !managed.window.isDestroyed(),
      ).length
      if (aliveMainWindows > 1) {
        return
      }

      // The last main window: put it away, never destroy it here.
      event.preventDefault()

      if (!window.webContents.isDestroyed() && window.webContents.mainFrame) {
        const wcId = window.webContents.id
        let source: WindowCloseRequestSource = 'window-button'
        if (this.keyboardCloseIntents.has(wcId)) {
          source = 'keyboard-shortcut'
          this.keyboardCloseIntents.delete(wcId)
          const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(wcId)
          if (keyboardIntentTimeout) {
            clearTimeout(keyboardIntentTimeout)
            this.keyboardCloseIntentTimeouts.delete(wcId)
          }
        }

        // Send close request to renderer - it will either close a modal/panel or confirm close.
        this.pushToWindow(window, RPC_CHANNELS.window.CLOSE_REQUESTED, { source })

        // Fallback timeout: if IPC fails (e.g., on Hyprland/Wayland), put the window away
        // after 3s. Reset timeout on each attempt so active users closing modals aren't interrupted.
        const existingTimeout = this.pendingCloseTimeouts.get(wcId)
        if (existingTimeout) clearTimeout(existingTimeout)

        this.pendingCloseTimeouts.set(wcId, setTimeout(() => {
          this.pendingCloseTimeouts.delete(wcId)
          if (!window.isDestroyed()) window.hide()
        }, 3000))
      } else {
        // No live renderer: nothing to dismiss and nobody to ask — put it away.
        if (!window.isDestroyed()) window.hide()
      }
    })

    // Handle window closed - clean up theme listener and internal state
    window.on('closed', () => {
      // Clean up any pending close timeout to prevent memory leaks
      const timeout = this.pendingCloseTimeouts.get(webContentsId)
      if (timeout) {
        clearTimeout(timeout)
        this.pendingCloseTimeouts.delete(webContentsId)
      }

      // Clean up short-lived keyboard-close intent tracking.
      const keyboardIntentTimeout = this.keyboardCloseIntentTimeouts.get(webContentsId)
      if (keyboardIntentTimeout) {
        clearTimeout(keyboardIntentTimeout)
        this.keyboardCloseIntentTimeouts.delete(webContentsId)
      }
      this.keyboardCloseIntents.delete(webContentsId)

      nativeTheme.removeListener('updated', themeHandler)
      this.windows.delete(webContentsId)
      this.focusedModeWindows.delete(webContentsId)
      this.lastUsedAt.delete(webContentsId)
      // Re-apply window-title policy — surviving windows revert from workspace
      // name back to app name when the count drops from 2 → 1.
      this.refreshWindowTitles()
      windowLog.info(`Window closed for workspace ${workspaceId}`)
    })

    windowLog.info(`Created window for workspace ${workspaceId} (focused: ${focused})`)
    return window
  }

  /**
   * Get window by webContents.id (used by IPC handlers instead of BrowserWindow.fromId)
   */
  getWindowByWebContentsId(wcId: number): BrowserWindow | null {
    const managed = this.windows.get(wcId)
    return managed?.window ?? null
  }

  /**
   * The window that stands for a workspace — the one used most recently among its windows.
   *
   * A workspace may have more than one window (File → New Window, a session opened in its own
   * window). "That workspace's window" — what the tray entry and a notification click bring
   * back, and what close-for-workspace closes — is therefore the most recently used one, not
   * whichever was created first. Ties (a window never focused, e.g. created in the background)
   * keep creation order.
   *
   * Design windows are skipped: they are temporary views, never the workspace's
   * home window, so the tray's workspace entry and close-for-workspace keep
   * targeting the real one (docs/design-plan.md §2.7).
   */
  getWindowByWorkspace(workspaceId: string): BrowserWindow | null {
    let best: ManagedWindow | null = null
    let bestUsedAt = -1
    for (const managed of this.windows.values()) {
      if (managed.designSlug) continue
      if (managed.workspaceId !== workspaceId || managed.window.isDestroyed()) continue
      const usedAt = this.lastUsedAt.get(managed.window.webContents.id) ?? 0
      if (usedAt > bestUsedAt) {
        best = managed
        bestUsedAt = usedAt
      }
    }
    return best?.window ?? null
  }

  /**
   * Get ALL windows for a workspace (main window + tab content windows)
   * Used for broadcasting events to all windows showing the same workspace
   */
  getAllWindowsForWorkspace(workspaceId: string): BrowserWindow[] {
    const windows: BrowserWindow[] = []
    for (const managed of this.windows.values()) {
      if (managed.workspaceId === workspaceId && !managed.window.isDestroyed()) {
        windows.push(managed.window)
      }
    }
    // Debug: log registered workspaces when lookup fails
    if (windows.length === 0 && this.windows.size > 0) {
      const registered = Array.from(this.windows.values()).map(m => m.workspaceId)
      windowLog.warn(`No windows for workspace '${workspaceId}', have: [${registered.join(', ')}]`)
    }
    return windows
  }

  /**
   * Get workspace ID for a window (by webContents.id)
   */
  getWorkspaceForWindow(webContentsId: number): string | null {
    const managed = this.windows.get(webContentsId)
    return managed?.workspaceId ?? null
  }

  /** The remote hub this window is connected to, or null when it is a local window. */
  getRemoteForWindow(webContentsId: number): RemoteWindowTarget | null {
    return this.windows.get(webContentsId)?.remote ?? null
  }

  /**
   * Re-point a remote window at another workspace on the same hub.
   *
   * This is an in-window workspace switch (VS Code's "Open Folder" in a remote window): the
   * window and its hub stay, the workspace changes. The record is the window's, so the new
   * workspace is what launch restores and what `client-mode:get` reports. Returns false when
   * the window is not a remote one — the caller then has nothing to re-point.
   */
  setRemoteWorkspaceForWindow(webContentsId: number, workspaceId: string): boolean {
    const managed = this.windows.get(webContentsId)
    if (!managed?.remote) return false
    managed.remote = { ...managed.remote, workspaceId }
    managed.workspaceId = workspaceId
    this.markUsed(webContentsId)
    return true
  }

  /**
   * Point a window at a hub, in place.
   *
   * Works from a local window too: that is how "this window moves to a server" starts. The window
   * keeps its identity and its renderer; what changes is the server it speaks for — the same thing
   * VS Code does when it reconnects a window to another host, minus the reload. The preload owns
   * the socket and rebuilds it from the returned target.
   */
  switchWindowServer(webContentsId: number, target: RemoteWindowTarget): RemoteWindowTarget | null {
    const managed = this.windows.get(webContentsId)
    if (!managed) return null
    managed.remote = { ...target }
    managed.workspaceId = target.workspaceId ?? ''
    this.markUsed(webContentsId)
    return managed.remote
  }

  /**
   * Bring a window back to this machine's server, in place.
   *
   * The inverse of {@link switchWindowServer}: the hub record goes away, so launch restores a
   * local window, and the custom `<workspace> — <server>` title is dropped with it. Returns false
   * when the window is not on a hub — there is nothing to release.
   */
  switchWindowToLocal(webContentsId: number, workspaceId: string): boolean {
    const managed = this.windows.get(webContentsId)
    if (!managed?.remote) return false
    delete managed.remote
    delete managed.customTitle
    managed.workspaceId = workspaceId
    this.markUsed(webContentsId)
    this.refreshWindowTitles()
    return true
  }

  /**
   * Mark whether the app stays alive between windows (see `resident`). Set once at
   * startup, after the tray exists — nothing toggles it at runtime.
   */
  setResident(value: boolean): void {
    this.resident = value
  }

  /**
   * Mark whether the app is in quit flow.
   * When true, window close events bypass layered close interception.
   */
  setAppQuitting(isQuitting: boolean): void {
    this.isAppQuitting = isQuitting
  }

  /**
   * Close window by webContents.id (triggers close event which may be intercepted)
   */
  closeWindow(webContentsId: number): void {
    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.close()
    }
  }

  /**
   * Put a window away by webContents.id.
   *
   * This is what the renderer's "confirm close" means once the app lives in the
   * tray (see the `close` handler): the window is **hidden, not destroyed**, so it
   * keeps its state for the tray to bring back. Only a real quit destroys windows.
   */
  hideWindow(webContentsId: number): void {
    // Clear any pending close timeout — the renderer answered.
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed() && managed.window.isVisible()) {
      managed.window.hide()
    }
  }

  /**
   * Cancel a pending close request (renderer handled it by closing a modal/panel).
   * Clears the fallback timeout so the window stays open.
   */
  cancelPendingClose(webContentsId: number): void {
    const timeout = this.pendingCloseTimeouts.get(webContentsId)
    if (timeout) {
      clearTimeout(timeout)
      this.pendingCloseTimeouts.delete(webContentsId)
    }
  }

  /**
   * Close window for a specific workspace
   */
  closeWindowForWorkspace(workspaceId: string): void {
    const window = this.getWindowByWorkspace(workspaceId)
    if (window && !window.isDestroyed()) {
      window.close()
    }
  }

  /**
   * Update the workspace ID for an existing window (for in-window switching)
   * @param webContentsId - The webContents.id of the window
   * @param workspaceId - The new workspace ID
   * @returns true if window was found and updated, false otherwise
   */
  updateWindowWorkspace(webContentsId: number, workspaceId: string): boolean {
    const managed = this.windows.get(webContentsId)
    if (managed) {
      const oldWorkspaceId = managed.workspaceId
      managed.workspaceId = workspaceId
      // The remembered workspace follows the window that was last used. An in-window
      // switch does not re-fire `focus`, so it has to be kept in step here — else
      // `getLastActiveWorkspaceId()` keeps naming the workspace the window left. A remote
      // window's workspace belongs to its hub and must not become this machine's answer.
      this.markUsed(webContentsId)
      if (!managed.remote && this.lastActiveWebContentsId === webContentsId) {
        this.lastActiveWorkspaceId = workspaceId
      }
      // Re-apply window-title policy so in-window workspace switches update
      // the titlebar immediately (relevant when ≥2 windows are open).
      this.refreshWindowTitles()
      windowLog.info(`Updated window ${webContentsId} from workspace ${oldWorkspaceId} to ${workspaceId}`)
      return true
    }
    // Window not found - log for debugging
    windowLog.warn(`Cannot update workspace for unknown window ${webContentsId}, registered: [${Array.from(this.windows.keys()).join(', ')}]`)
    return false
  }

  /**
   * Register an existing window with a workspace ID
   * Used for re-registration when window mapping is lost (e.g., after refresh)
   * @param window - The BrowserWindow to register
   * @param workspaceId - The workspace ID to associate with
   */
  registerWindow(window: BrowserWindow, workspaceId: string): void {
    const webContentsId = window.webContents.id
    const existing = this.windows.get(webContentsId)
    this.windows.set(webContentsId, {
      window,
      workspaceId,
      ...(existing?.remote ? { remote: existing.remote } : {}),
    })
    // Re-apply window-title policy after re-registration (e.g. post-refresh).
    this.refreshWindowTitles()
    windowLog.info(`Registered window ${webContentsId} for workspace ${workspaceId}`)
  }

  /**
   * Get all managed windows
   */
  getAllWindows(): ManagedWindow[] {
    return Array.from(this.windows.values()).filter(m => !m.window.isDestroyed())
  }

  /**
   * Focus an existing window for a workspace, or create one.
   *
   * A window that was *put away* (hidden) is shown again: `focus()` alone does not
   * show a window, and hidden is neither minimized nor destroyed.
   */
  focusOrCreateWindow(workspaceId: string): BrowserWindow {
    const existing = this.getWindowByWorkspace(workspaceId)
    if (existing) {
      return this.bringToFront(existing)
    }
    return this.createWindow({ workspaceId })
  }

  /**
   * Open a design in its own window, or bring its window back if one is already
   * open. This is the tray's Designs menu entry (docs/design-plan.md §2.7).
   *
   * The window is a **temporary view** of the design's workspace: at most one
   * exists per design (clicking again focuses it), it never stands in for the
   * workspace's home window, and it closes for real.
   */
  openDesignWindow(workspaceId: string, designSlug: string): BrowserWindow {
    const existing = [...this.windows.values()].find(
      managed =>
        managed.designSlug === designSlug &&
        managed.workspaceId === workspaceId &&
        !managed.window.isDestroyed(),
    )
    if (existing) return this.bringToFront(existing.window)

    return this.createWindow({
      workspaceId,
      focused: true,
      designSlug,
      initialRoute: routes.view.designs(designSlug),
    })
  }

  /** The design's display name for a design window's title (null when unreadable). */
  private designTitleFor(workspaceId: string, designSlug: string): string | null {
    try {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) return null
      return loadDesignConfig(workspace.rootPath, designSlug)?.name ?? null
    } catch (err) {
      windowLog.warn(`Failed to read the title of design ${designSlug}:`, err)
      return null
    }
  }

  /**
   * Bring a window back: the one used most recently, or a new one when none is
   * left. This is what the tray is for — where a hidden window returns from.
   */
  raiseOrCreateWindow(fallbackWorkspaceId: string): BrowserWindow {
    const remembered = this.lastUsedWindow()
    if (remembered) {
      return this.bringToFront(remembered)
    }
    return this.createWindow({ workspaceId: fallbackWorkspaceId })
  }

  /** Record that a window was just used, for "that workspace's window" lookups. */
  private markUsed(webContentsId: number): void {
    this.useCount += 1
    this.lastUsedAt.set(webContentsId, this.useCount)
  }

  /** The window the person used most recently, if it is still alive. */
  private lastUsedWindow(): BrowserWindow | null {
    const remembered = this.lastActiveWebContentsId !== null
      ? this.windows.get(this.lastActiveWebContentsId)
      : undefined
    if (remembered && !remembered.window.isDestroyed()) return remembered.window

    const focused = this.getFocusedWindow()
    if (focused) return focused

    const all = this.getAllWindows()
    return all.length > 0 ? all[0].window : null
  }

  /** Show it if it was put away, restore it if minimized, then focus it. */
  private bringToFront(window: BrowserWindow): BrowserWindow {
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    return window
  }

  /** The workspace of the window used most recently — where a new window opens. */
  getLastActiveWorkspaceId(): string | null {
    return this.lastActiveWorkspaceId
  }

  /**
   * Get window states for persistence (includes bounds and focused mode)
   * Used by window-state.ts to save/restore windows
   */
  getWindowStates(): SavedWindow[] {
    // Design windows are temporary (docs/design-plan.md §2.7) and deliberately not
    // persisted: a relaunch restores your workspace window, not a mini-app that was
    // open at the time.
    return this.getAllWindows().filter(managed => !managed.designSlug).map(managed => {
      const webContentsId = managed.window.webContents.id
      const isFocused = this.focusedModeWindows.has(webContentsId)
      const url = managed.window.webContents.getURL()
      return {
        type: 'main' as const,
        workspaceId: managed.workspaceId,
        ...(managed.remote
          ? {
              remote: {
                connectionId: managed.remote.connectionId,
                ...(managed.remote.workspaceId ? { workspaceId: managed.remote.workspaceId } : {}),
                ...(managed.remote.name ? { name: managed.remote.name } : {}),
              },
            }
          : {}),
        bounds: managed.window.getBounds(),
        ...(isFocused && { focused: true }),
        ...(url && { url }),
      }
    })
  }

  /**
   * Check if any windows are open
   */
  hasWindows(): boolean {
    return this.getAllWindows().length > 0
  }

  /**
   * Get the currently focused window
   */
  getFocusedWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && !focused.isDestroyed()) {
      return focused
    }
    return null
  }

  /**
   * Get the last active window (most recently used)
   * Falls back to any available window if none focused
   */
  getLastActiveWindow(): BrowserWindow | null {
    // First try focused window
    const focused = this.getFocusedWindow()
    if (focused) {
      return focused
    }

    // Fall back to any available window
    const allWindows = this.getAllWindows()
    if (allWindows.length > 0) {
      return allWindows[0].window
    }

    return null
  }

  /**
   * Show or hide macOS traffic light buttons (close/minimize/maximize).
   * Used to hide them when fullscreen overlays are open to prevent accidental clicks.
   * No-op on non-macOS platforms.
   */
  setTrafficLightsVisible(webContentsId: number, visible: boolean): void {
    if (process.platform !== 'darwin') return

    const managed = this.windows.get(webContentsId)
    if (managed && !managed.window.isDestroyed()) {
      managed.window.setWindowButtonVisibility(visible)
      // Showing them again drops them at the OS's default position, so the custom one has to be put
      // back — via the modern setWindowButtonPosition API, which is also what keeps it custom once
      // the OS has reset it.
      if (visible) {
        managed.window.setWindowButtonPosition(MAC_TRAFFIC_LIGHT_POSITION)
      }
    }
  }
}
