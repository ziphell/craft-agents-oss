/**
 * Web API adapter — browser-compatible ElectronAPI implementation.
 *
 * Reuses the same WsRpcClient + buildClientApi() + CHANNEL_MAP from the Electron app.
 * Overrides LOCAL_ONLY methods (window management, native dialogs, etc.) with web equivalents.
 *
 * Auth: the browser's session cookie (set by /api/auth) is automatically sent
 * on the WebSocket upgrade request — no bearer token needed.
 */

import i18n from 'i18next'
import { toast } from 'sonner'
import { openExternalUrl } from '@craft-agent/ui'
import { WsRpcClient } from '../../../electron/src/transport/client'
import { buildClientApi } from '../../../electron/src/transport/build-api'
import { CHANNEL_MAP } from '../../../electron/src/transport/channel-map'
import type { ElectronAPI, TransportConnectionState } from '../../../electron/src/shared/types'

// ---------------------------------------------------------------------------
// Web file picker (replaces native Electron dialog)
// ---------------------------------------------------------------------------

function webFilePicker(): Promise<string[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      const files = input.files
      if (!files || files.length === 0) {
        resolve([])
        return
      }
      // Return file names — actual file reading is handled elsewhere
      resolve(Array.from(files).map(f => f.name))
    }
    // If user cancels the dialog
    input.oncancel = () => resolve([])
    input.click()
  })
}

// ---------------------------------------------------------------------------
// System theme detection
// ---------------------------------------------------------------------------

const darkMediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

function getSystemTheme(): boolean {
  return darkMediaQuery?.matches ?? false
}

// ---------------------------------------------------------------------------
// Create web API
// ---------------------------------------------------------------------------

export interface WebApiOptions {
  /** WebSocket server URL (ws:// or wss://) */
  serverUrl: string
  /** Workspace ID to connect as. */
  workspaceId?: string
}

export function createWebApi(options: WebApiOptions): {
  api: ElectronAPI
  client: WsRpcClient
} {
  const { serverUrl, workspaceId } = options
  /** The workspace this tab speaks for now — `switchWorkspace` moves it with the connection. */
  let currentWorkspaceId = workspaceId

  const client = new WsRpcClient(serverUrl, {
    workspaceId,
    autoReconnect: true,
    mode: 'remote',
    clientInfo: {
      name: typeof navigator !== 'undefined' ? 'Web browser' : 'Web client',
      platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    },
    // No token — auth is via session cookie sent on WebSocket upgrade
  })

  // Build the API proxy from the same channel map the Electron app uses
  const baseApi = buildClientApi(
    client,
    CHANNEL_MAP,
    (ch) => client.isChannelAvailable(ch),
  )

  // Override LOCAL_ONLY methods with web-compatible implementations
  const webOverrides = {
    // Shell operations — use browser APIs
    openUrl: (url: string) => {
      const result = openExternalUrl(url)
      if (!result.opened) {
        if (result.reason === 'dangerous') {
          toast.error(`Blocked unsafe URL (${result.detail})`)
        } else if (result.reason === 'internal-deeplink') {
          console.warn('[openUrl] craftagents:// deep links require the desktop app')
        } else {
          console.warn('[openUrl] Malformed URL:', url)
        }
      }
      return Promise.resolve()
    },
    openFile: () => Promise.resolve(), // no-op in browser
    showInFolder: () => Promise.resolve(), // no-op in browser

    // File dialogs
    openFileDialog: webFilePicker,
    openFolderDialog: () => Promise.resolve(null), // not possible in browser
    /**
     * A hub-produced export: the browser fetches `/api/exports/<id>` itself, carrying its session
     * cookie, and the response's `Content-Disposition` names the file. Long downloads keep going
     * in the browser's own download UI — nothing is held in a JS buffer.
     */
    saveDesignExport: async (download) => {
      const link = document.createElement('a')
      link.href = `/api/exports/${encodeURIComponent(download.id)}`
      link.download = download.name
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      return { canceled: false as const, path: download.name }
    },

    // System info
    getVersions: () => ({ node: 'n/a', chrome: navigator.userAgent, electron: 'web' }),
    getRuntimeEnvironment: () => 'web',
    getSystemWarnings: () => Promise.resolve({ vcredistMissing: false }),
    isDebugMode: () => Promise.resolve(import.meta.env.DEV),

    // Theme
    getSystemTheme: () => Promise.resolve(getSystemTheme()),
    onSystemThemeChange: (cb: (isDark: boolean) => void) => {
      if (!darkMediaQuery) return () => {}
      const handler = (e: MediaQueryListEvent) => cb(e.matches)
      darkMediaQuery.addEventListener('change', handler)
      return () => darkMediaQuery.removeEventListener('change', handler)
    },

    // Window management — no-ops or browser equivalents
    setTrafficLightsVisible: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    confirmCloseWindow: () => Promise.resolve(),
    cancelCloseWindow: () => Promise.resolve(),
    onCloseRequested: () => () => {},
    getWindowFocusState: () => Promise.resolve(document.hasFocus()),
    // No window to maximize here — the caption buttons are the browser's own.
    getWindowMaximizedState: () => Promise.resolve(false),
    onWindowMaximizedChange: () => () => {},
    onWindowFocusChange: (cb: (focused: boolean) => void) => {
      const onFocus = () => cb(true)
      const onBlur = () => cb(false)
      window.addEventListener('focus', onFocus)
      window.addEventListener('blur', onBlur)
      return () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('blur', onBlur)
      }
    },

    // Workspace operations — web UI works with a single connection
    getWindowWorkspace: () => Promise.resolve(currentWorkspaceId ?? null),
    getWindowMode: () => Promise.resolve('main'),
    // switchWorkspace must call the server so it registers the client's
    // workspaceId — otherwise push events (session updates) won't arrive.
    switchWorkspace: async (wsId: string) => {
      await client.invoke('window:switchWorkspace', wsId)
      currentWorkspaceId = wsId
      // The server's record is not the client's identity: a reconnect after this would offer the
      // workspace this tab was opened on, fail the server's identity check, and come back as a
      // different client on the old workspace.
      client.setWorkspace(wsId)
    },
    openWorkspace: async () => {},
    openSessionInNewWindow: async (_wsId: string, sessionId: string) => {
      // Open in new tab
      window.open(`${window.location.origin}/?session=${sessionId}`, '_blank')
    },

    // Auto-update — not applicable to web (but expose server version for About page)
    checkForUpdates: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    getUpdateInfo: () => Promise.resolve({ available: false, currentVersion: client.getServerVersion() ?? '' } as any),
    installUpdate: () => Promise.resolve(),
    dismissUpdate: () => Promise.resolve(),
    getDismissedUpdateVersion: () => Promise.resolve(null),
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    // Release notes — serve from server via RPC (same content as Electron)
    getReleaseNotes: () => client.invoke('releaseNotes:get') as Promise<string>,
    getLatestReleaseVersion: () => client.invoke('releaseNotes:getLatestVersion') as Promise<string | undefined>,

    // Menu events — register as keyboard shortcuts
    onMenuNewChat: () => () => {},
    onMenuOpenSettings: () => () => {},
    onMenuKeyboardShortcuts: () => () => {},
    onMenuToggleFocusMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onDeepLinkNavigate: () => () => {},

    // Menu actions — no-ops (web has no native menu)
    menuQuit: () => Promise.resolve(),
    menuNewWindow: () => { window.open(window.location.href, '_blank'); return Promise.resolve() },
    menuMinimize: () => Promise.resolve(),
    menuMaximize: () => Promise.resolve(),
    menuZoomIn: () => Promise.resolve(),
    menuZoomOut: () => Promise.resolve(),
    menuZoomReset: () => Promise.resolve(),
    menuToggleDevTools: () => Promise.resolve(),
    menuUndo: () => { document.execCommand('undo'); return Promise.resolve() },
    menuRedo: () => { document.execCommand('redo'); return Promise.resolve() },
    menuCut: () => { document.execCommand('cut'); return Promise.resolve() },
    menuCopy: () => { document.execCommand('copy'); return Promise.resolve() },
    menuPaste: () => { document.execCommand('paste'); return Promise.resolve() },
    menuSelectAll: () => { document.execCommand('selectAll'); return Promise.resolve() },

    // Badge — use document title
    refreshBadge: () => Promise.resolve(),
    setDockIconWithBadge: () => Promise.resolve(),
    onBadgeDraw: () => () => {},
    onBadgeDrawWindows: () => () => {},

    // Notifications — Web Notifications API
    showNotification: async (title: string, body: string) => {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    },
    onNotificationNavigate: () => () => {},

    // Git bash (Windows-only) — not applicable
    checkGitBash: () => Promise.resolve({ available: true } as any),
    browseForGitBash: () => Promise.resolve(null),
    setGitBashPath: () => Promise.resolve({ success: true }),

    // Skills — open in browser not possible
    openSkillInEditor: () => Promise.resolve(),
    openSkillInFinder: () => Promise.resolve(),

    // Confirmation dialogs — use browser confirm()
    showLogoutConfirmation: () => Promise.resolve(window.confirm(i18n.t('dialog.logoutConfirmation'))),
    showDeleteSessionConfirmation: (name: string) => Promise.resolve(window.confirm(i18n.t('dialog.deleteSessionConfirmation', { name }))),

    // Power settings — not applicable
    getKeepAwakeWhileRunning: () => Promise.resolve(false),
    setKeepAwakeWhileRunning: () => Promise.resolve(),

    // Transport state
    getTransportConnectionState: () => Promise.resolve(client.getConnectionState() as TransportConnectionState),
    onTransportConnectionStateChanged: (cb: (state: TransportConnectionState) => void) => {
      return client.onConnectionStateChanged(cb as any)
    },
    reconnectTransport: () => { client.reconnectNow(); return Promise.resolve() },
    isChannelAvailable: (ch: string) => client.isChannelAvailable(ch),

    // Relaunch — reload page
    relaunchApp: () => { window.location.reload(); return Promise.resolve() },
    removeWorkspace: () => Promise.resolve(false), // not supported in web UI

    // Client connection management — these describe a *window's* transport and its hub config.
    // The browser tab is the client: it connected to one hub when the page loaded, and a tab
    // cannot open or re-point windows on that machine.
    getClientMode: () => Promise.resolve({
      connections: [],
      running: null,
      serverEnabled: false,
    }),
    saveRemoteConnection: () => Promise.reject(new Error('Connection settings are not available in the web UI')),
    removeRemoteConnection: () => Promise.reject(new Error('Connection settings are not available in the web UI')),
    setDefaultRemoteConnection: () => Promise.reject(new Error('Connection settings are not available in the web UI')),
    connectToRemoteConnection: () => Promise.reject(new Error('Connection settings are not available in the web UI')),
    testClientModeConnection: () => Promise.resolve({ ok: false, error: 'Not available in the web UI' }),
    openRemoteWindow: () => Promise.resolve(),
    switchRemoteWorkspace: () => Promise.resolve(),
    switchRemoteServer: () => Promise.reject(new Error('Connection settings are not available in the web UI')),
    switchLocalWorkspace: () => Promise.reject(new Error('Connection settings are not available in the web UI')),
    openLocalWindow: () => Promise.resolve(),
    getWebContentsId: () => -1,
    getClientIdentity: () => ({ deviceId: '', name: 'Web browser', platform: navigator.platform }),

    // Browsing / creating on some *other* saved server: there is no list of servers here, and no
    // window to re-point, so every one of these is answered as absent rather than as a no-op that
    // would look like it succeeded.
    listRemoteDirectories: () => Promise.reject(new Error('Browsing a remote server is not available in the web UI')),
    getRemoteHomeDir: () => Promise.reject(new Error('Browsing a remote server is not available in the web UI')),
    listRemoteWorkspaces: () => Promise.reject(new Error('Browsing a remote server is not available in the web UI')),
    checkRemoteWorkspaceSlug: () => Promise.reject(new Error('Remote workspaces are not available in the web UI')),
    createRemoteWorkspace: () => Promise.reject(new Error('Remote workspaces are not available in the web UI')),
    /** No saved servers, so no links to report on. */
    getRemoteConnectionStatuses: () => Promise.resolve([]),
    /** Nothing to rename: the browser tab's title is the page's. */
    setWindowTitle: () => Promise.resolve(),
    /** This tab is the target; it cannot be re-pointed from inside itself. */
    onRemoteTargetChanged: () => () => {},

    // Cross-machine session transfer and its progress stream — both need the desktop main process.
    transferSessionToWorkspace: () => Promise.reject(new Error('Session transfer is not available in the web UI')),
    onTransferProgress: () => () => {},

    // A browser `File` has no path; attachments are uploaded by content instead.
    getFilePath: () => null,
    // No main process i18n instance to sync — the renderer's own change is the whole change.
    changeLanguage: () => Promise.resolve(),
  } satisfies Partial<ElectronAPI>

  // OAuth overrides — web-compatible browser opening
  // The Electron preload uses shell.openExternal() which isn't available in browsers.
  const oauthOverrides = {
    // Generic source OAuth — server prepares the flow, we open the auth URL in a new tab.
    // The OAuth provider redirects through the relay to our server's /api/oauth/callback,
    // which completes the token exchange and pushes status via WebSocket.
    performOAuth: async (args: {
      sourceSlug: string
      sessionId?: string
      authRequestId?: string
    }) => {
      // iOS Safari (and any strict mobile pop-up blocker) requires
      // `window.open()` to be called *synchronously* inside the click event
      // — any preceding `await` loses the user-gesture and the call is
      // silently blocked. We pre-open a blank tab here as the first thing
      // in this async function (which still runs on the click tick, before
      // the first await) and rewrite its `location.href` once the auth URL
      // arrives. Same-window fallback covers users who blocked popups
      // entirely. NOTE: dropped `noopener` because the spec returns null
      // for `noopener` opens in some browsers, defeating the pre-open.
      const popup = window.open('about:blank', '_blank')

      try {
        const callbackUrl = `${window.location.origin}/api/oauth/callback`
        const result = await client.invoke('oauth:start', {
          sourceSlug: args.sourceSlug,
          callbackUrl,
          sessionId: args.sessionId,
          authRequestId: args.authRequestId,
        })

        if (popup && !popup.closed) {
          // Happy path — pre-opened popup is still open, redirect it.
          popup.location.href = result.authUrl
        } else if (popup === null) {
          // Popup blocked entirely (popup === null) — fall back to a
          // same-window redirect. The OAuth callback lands back on the
          // WebUI; cookie-based session means the user picks up where
          // they left off after auth.
          window.location.href = result.authUrl
        } else {
          // Popup was opened but the user closed it while we waited for
          // the RPC. Abort rather than redirecting their main tab.
          return {
            success: false,
            error: 'Sign-in window was closed before authentication started.',
          }
        }

        // The server completes the flow when the callback arrives and pushes
        // auth status via WebSocket — the AuthRequestCard updates automatically.
        return { success: true }
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'OAuth flow failed',
        }
      }
    },

    // Claude OAuth — server returns authUrl, we open it in a new tab.
    // Same iOS-safe pre-open pattern as `performOAuth` above.
    startClaudeOAuth: async () => {
      const popup = window.open('about:blank', '_blank')
      try {
        const result = await client.invoke('onboarding:startClaudeOAuth')
        if (result.success && result.authUrl) {
          if (popup && !popup.closed) {
            popup.location.href = result.authUrl
          } else {
            window.location.href = result.authUrl
          }
        } else if (popup && !popup.closed) {
          // No auth URL — close the placeholder we opened on the click.
          popup.close()
        }
        return result
      } catch (err) {
        if (popup && !popup.closed) popup.close()
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Claude OAuth failed',
        }
      }
    },

    // ChatGPT OAuth — requires localhost callback server, not possible in browser
    startChatGptOAuth: async () => {
      return {
        success: false,
        error: i18n.t('errors.chatGptOAuthNotAvailable'),
      }
    },
  } satisfies Partial<ElectronAPI>

  /**
   * Compile-time guardrail: every `ElectronAPI` function is answered either by the channel map (a
   * server call) or by an override here. Adding a method without either fails typecheck, instead
   * of surfacing as `undefined is not a function` at the one click that needs it.
   *
   * Namespaced APIs (browserPane, browserProfiles) are flattened into CHANNEL_MAP keys, so they
   * are counted through those rather than by their group name.
   */
  type AnyFn = (...args: any[]) => any
  type FunctionKeys<T> = {
    [K in keyof T]-?: Extract<T[K], AnyFn> extends never ? never : K
  }[keyof T] & string
  type UncoveredApi = Exclude<
    FunctionKeys<ElectronAPI>,
    keyof typeof CHANNEL_MAP | keyof typeof webOverrides | keyof typeof oauthOverrides
  >
  type AssertNever<T extends never> = true
  const _allApiCovered: AssertNever<UncoveredApi> = true
  void _allApiCovered

  const api = { ...baseApi, ...webOverrides, ...oauthOverrides } as ElectronAPI

  return { api, client }
}
