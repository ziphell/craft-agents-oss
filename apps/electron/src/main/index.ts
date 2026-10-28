// Load user's shell environment first (before other imports that may use env)
// This ensures tools like Homebrew, nvm, etc. are available to the agent
import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, net, session, shell } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { hostname, homedir } from 'os'
import * as Sentry from '@sentry/electron/main'
import { redactSensitiveHeadersInPlace, redactSensitiveKeysInPlace } from '@craft-agent/shared/utils'

// Initialize Sentry error tracking as early as possible after app import.
// Only enabled in production (packaged) builds to avoid noise during development.
// DSN is baked in at build time via esbuild --define (same pattern as OAuth secrets).
//
// NOTE: Source map upload is intentionally disabled. Stack traces in Sentry will show
// bundled/minified code. To enable source map upload in the future:
//   1. Add SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT to CI secrets
//   2. Re-enable the @sentry/vite-plugin in vite.config.ts (handles renderer maps)
//   3. Add @sentry/esbuild-plugin to scripts/electron-build-main.ts (handles main process maps)
Sentry.init({
  dsn: process.env.SENTRY_ELECTRON_INGEST_URL,
  environment: app.isPackaged ? 'production' : 'development',
  release: app.getVersion(),
  // TEMPORARILY DISABLED — no events leave the app. The main-process client is the
  // single egress point: renderer and preload events are forwarded here over IPC and
  // dropped by the disabled client. To restore, replace `false` with:
  //   !!process.env.SENTRY_ELECTRON_INGEST_URL
  enabled: false,

  // Scrub sensitive data before sending to Sentry.
  // Shared logic in @craft-agent/shared/utils redaction.ts (also used by the
  // renderer hook) — keep semantics there.
  beforeSend(event) {
    // Scrub request headers (authorization, cookies)
    if (event.request?.headers) {
      redactSensitiveHeadersInPlace(event.request.headers)
    }

    // Scrub breadcrumb data that may contain sensitive values
    if (event.breadcrumbs) {
      for (const breadcrumb of event.breadcrumbs) {
        if (breadcrumb.data) {
          redactSensitiveKeysInPlace(breadcrumb.data)
        }
      }
    }

    return event
  },
})

// Initialize i18n for main process (menus, dialogs, etc.)
//
// The main-process i18n instance has no detection plugin (no localStorage in Node)
// — it always starts at `fallbackLng: 'en'`. We hydrate it here from the persisted
// `uiLanguage` preference, which is maintained by the `i18n:changeLanguage` IPC
// handler whenever the user changes Appearance → Language. Without this, the
// renderer would restore its language from localStorage on every restart while
// the main process silently stayed at English — breaking session title language,
// the system prompt's "Preferred language" line, and the native menu.
import { setupI18n, i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@craft-agent/shared/i18n'
import { getPersistedUiLanguage, setPersistedUiLanguage } from '@craft-agent/shared/config'
import { CONFIG_DIR } from '@craft-agent/shared/config/paths'
setupI18n()
const persistedUiLanguage = getPersistedUiLanguage()
if (persistedUiLanguage) {
  void i18n.changeLanguage(persistedUiLanguage)
}
// Note: deferred startup log lives below where mainLog is available (after log.initialize()).

// Set anonymous machine ID for Sentry user tracking (no PII — just a hash).
// Uses hostname + homedir to produce a stable per-machine identifier.
const machineId = createHash('sha256').update(hostname() + homedir()).digest('hex').slice(0, 16)
Sentry.setUser({ id: machineId })

import { join, delimiter, isAbsolute } from 'path'
import { createWriteStream, existsSync, readFileSync } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@craft-agent/server-core/sessions'
import { DesignThumbnailer } from './design-thumbnailer'
import { pushDesignSnapshotsToTabs } from './design-tab-pusher'
import { DesignExporter } from './design-exporter'
import { registerAllRpcHandlers } from './handlers/index'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient, cleanupProjectFilesWatchForClient } from '@craft-agent/server-core/handlers/rpc'
import type { PlatformServices } from '../runtime/platform'
import { createElectronPlatform } from './platform'
import type { HandlerDeps } from './handlers/handler-deps'
import { bootstrapServer, releaseServerLock } from '@craft-agent/server-core/bootstrap'
import { createMessagingBootstrap, type MessagingBootstrapHandle } from '@craft-agent/messaging-gateway'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { initModelRefreshService, getModelRefreshService, setFetcherPlatform } from '@craft-agent/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@craft-agent/server-core/services'
import { createApplicationMenu } from './menu'
import { WindowManager } from './window-manager'
import { loadWindowState, saveWindowState } from './window-state'
import { syncHubConnections, stopHubConnections, getHubConnectionClient, getHubConnectionStatus, type HubClientIdentity } from './hub-connection'
import type { RemoteWindowTarget } from '../shared/types'
import { getWorkspaces, getWorkspaceByNameOrId, loadStoredConfig, addWorkspace, saveConfig, resolveConversationBrowserProfileId, getRemoteConnections, getRemoteConnection, saveRemoteConnection, removeRemoteConnection, rememberRemoteWorkspace, migrateLegacyRemoteWorkspaces, getClientConfig, getDeviceId, HUB_ROOT_BASE } from '@craft-agent/shared/config'
import { connectionNameFromUrl, type RemoteConnection } from '@craft-agent/shared/config/client-config'
import { getDefaultWorkspacesDir, getWorkspaceBrowserProfile } from '@craft-agent/shared/workspaces'
import { loadSessionHeader } from '@craft-agent/shared/sessions'
import { loadProjectById } from '@craft-agent/shared/projects'
import { initializeDocs } from '@craft-agent/shared/docs'
import { getDesignConfigRelativePath } from '@craft-agent/shared/designs'
import { initializeReleaseNotes } from '@craft-agent/shared/release-notes'
import { ensureDefaultPermissions } from '@craft-agent/shared/agent/permissions-config'
import { ensureToolIcons, ensurePresetThemes } from '@craft-agent/shared/config'
import { setBundledAssetsRoot, getBundledAssetsDir } from '@craft-agent/shared/utils'
import { initializeBackendHostRuntime } from '@craft-agent/shared/agent/backend'
import { setPowerShellValidatorRoot } from '@craft-agent/shared/agent'
import { handleDeepLink } from './deep-link'
import { BrowserPaneManager } from './browser-pane-manager'
import { ComputerUseManager, loadDefaultCuaDriver, setComputerUseAdvertised } from './computer-use-manager'
import { createDesktopControlIndicator, type DesktopControlIndicator } from './desktop-control-indicator'
import { OAuthFlowStore } from '@craft-agent/shared/auth'
import { registerPrivilegedSchemes, registerThumbnailHandler } from './thumbnail-protocol'
import { drawioOriginUrl } from './drawio-host'
import { registerLocalOriginHandler } from './local-origin-router'
import { requestTweaksForWorkspace } from './tweaks-injector'
import log, { isDebugMode, mainLog, getLogFilePath, getMessagingGatewayLogFilePath, messagingGatewayLog, autoUpdateLog } from './logger'
import { setPerfEnabled, enableDebug } from '@craft-agent/shared/utils'
import { isBrowserUrl } from '@craft-agent/shared/utils/url-safety'
import { registerPiModelResolver } from '@craft-agent/shared/config'
import { getPiModelsForAuthProvider, getAllPiModels } from '@craft-agent/shared/config'
import { initNotificationService, initBadgeIcon, initInstanceBadge, updateBadgeCount } from './notifications'
import { createTray, destroyTray } from './tray'
import { checkForUpdatesOnLaunch, setAutoUpdateEventSink, isUpdating, setBeforeUpdateQuitHook, setBeforeUpdateInstallHook, setInstallQuitFailedHook } from './auto-update'
import type { EventSink } from '@craft-agent/server-core/transport'
import { bearerToken } from '@craft-agent/server-core/transport'
import { validateGitBashPath, checkVCRedistInstalled } from '@craft-agent/server-core/services'
import { createWebuiHandler, nodeHttpAdapter, validateSession, deriveWebuiSessionKey, type WebuiHandler } from '@craft-agent/server-core/webui'

// Initialize electron-log for renderer process support — for the app's own window only.
//
// The second option is what keeps `__electronLog` out of other people's pages. It defaults to
// true, and it is the switch that registers electron-log's preload on **every** session the app
// creates. The browser panes create one session per profile (`browserPanePartition`), and that
// preload ends with `contextBridge.exposeInMainWorld('__electronLog', …)` — which put an
// enumerable `window.__electronLog` on whatever site a tab loaded. A risk-control script does
// not have to guess the name: listing window's own properties is enough, and the name says
// "electron" out loud.
//
// Nothing is lost by turning it off. Only `renderer/lib/logger.ts` and `renderer/lib/perf.ts`
// import `electron-log/renderer`, and both are reachable only from `App.tsx` — the app window,
// which lives in the default session and still gets the preload.
//
// Both spellings are passed on purpose: the implementation destructures `includeFutureSession`
// (singular) while the shipped typings declare `includeFutureSessions` (plural), so whichever
// one a future version honours, the answer is the same.
log.initialize({
  includeFutureSession: false,
  includeFutureSessions: false,
} as unknown as Parameters<typeof log.initialize>[0])

// Diagnostic: report main-process i18n hydration result. We log here (not inline
// at the hydration site above) because mainLog is only available after this point.
mainLog.info('[i18n] startup hydration', {
  persistedUiLanguage: persistedUiLanguage ?? null,
  resolvedLanguageAfterHydration: i18n.resolvedLanguage ?? null,
})

// Enable debug/perf in dev mode (running from source)
if (isDebugMode) {
  process.env.CRAFT_DEBUG = '1'
  enableDebug()
  setPerfEnabled(true)
}

// Bundle CLI tools: resolve platform-specific uv binary and wrapper scripts.
// These are available to all agent Bash sessions via CRAFT_UV, CRAFT_SCRIPTS env vars
// and PATH prepend. uv auto-downloads Python 3.12 on first use (~5s, then cached).
{
  // In packaged app: resources are at process.resourcesPath/app/resources/
  // In dev: resources are at __dirname/../resources/ (sibling of dist/)
  const resourcesBase = app.isPackaged
    ? join(process.resourcesPath, 'app')
    : join(__dirname, '..')
  const platformKey = `${process.platform}-${process.arch}`
  const uvPlatformDir = join(resourcesBase, 'resources', 'bin', platformKey)
  const uvBinary = join(uvPlatformDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const binDir = join(resourcesBase, 'resources', 'bin')
  const scriptsDir = join(resourcesBase, 'resources', 'scripts')

  const bundledUvExists = existsSync(uvBinary)
  const fallbackUv = bundledUvExists ? null : 'uv'

  // Runtime resolver hints for shared session tools
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.CRAFT_RESOURCES_BASE = resourcesBase
  process.env.CRAFT_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()

  process.env.CRAFT_UV = bundledUvExists ? uvBinary : (fallbackUv ?? uvBinary)

  // Bun runtime (packaged builds should prefer bundled runtime over PATH)
  const bunBinary = join(resourcesBase, 'vendor', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (existsSync(bunBinary)) {
    process.env.CRAFT_BUN = bunBinary
  }

  process.env.CRAFT_SCRIPTS = scriptsDir
  // The `craft-agent` config CLI (labels, sources, skills, automations, permissions, theme) is an
  // optional part of the build — this checkout does not carry its packages at all. Advertise it only
  // when the entry is really on disk: an env var pointing at a file that is not there turns every
  // `craft-agent …` into a bun module error, which reads as a broken install rather than as a CLI
  // this build does not have. With neither entry set, the wrapper says so in one line.
  const commandsEntry = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
    : join(process.cwd(), 'packages', 'craft-agents-commands', 'src', 'main.ts')
  const cliEntry = app.isPackaged
    ? join(app.getAppPath(), 'packages', 'craft-cli', 'src', 'cli.ts')
    : join(process.cwd(), 'packages', 'craft-cli', 'src', 'cli.ts')
  if (existsSync(commandsEntry)) process.env.CRAFT_COMMANDS_ENTRY = commandsEntry
  if (existsSync(cliEntry)) process.env.CRAFT_CLI_ENTRY = cliEntry
  process.env.CRAFT_COMMANDS_DOC_PATH = app.isPackaged
    ? join(resourcesBase, 'resources', 'docs', 'craft-cli.md')
    : join(process.cwd(), 'apps', 'electron', 'resources', 'docs', 'craft-cli.md')
  process.env.CRAFT_CLI_DOC_PATH = process.env.CRAFT_COMMANDS_DOC_PATH
  process.env.CRAFT_AGENT_VERSION = app.getVersion()
  // Prepend both generic wrappers dir and platform uv dir:
  // - binDir exposes wrapper commands (pdf-tool, docx-tool, ...)
  // - uvPlatformDir exposes raw `uv` for direct shell usage / debugging
  process.env.PATH = `${binDir}${delimiter}${uvPlatformDir}${delimiter}${process.env.PATH}`

  if (!bundledUvExists) {
    mainLog.warn('Bundled uv binary missing, CLI document tools may fail unless uv is available on PATH.', {
      expectedUvPath: uvBinary,
      usingCraftUv: process.env.CRAFT_UV,
    })
  }

  if (isDebugMode) {
    mainLog.info('CLI tools configured:', { uvBinary: process.env.CRAFT_UV, binDir, scriptsDir, bundledUvExists })
  }
}

// Register Pi model resolver so llm-connections.ts can resolve Pi models
// without importing @earendil-works/pi-ai (which breaks the Vite renderer build)
registerPiModelResolver((piAuthProvider) =>
  piAuthProvider ? getPiModelsForAuthProvider(piAuthProvider) : getAllPiModels()
)

// Custom URL scheme for deeplinks (e.g., craftagents://auth-complete)
// Supports multi-instance dev: CRAFT_DEEPLINK_SCHEME env var (craftagents1, craftagents2, etc.)
const DEEPLINK_SCHEME = process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'

let windowManager: WindowManager | null = null
let sessionManager: SessionManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let computerUseManager: ComputerUseManager | null = null
let desktopControlIndicator: DesktopControlIndicator | null = null
let oauthFlowStore: OAuthFlowStore | null = null
let moduleSink: EventSink | null = null
let moduleClientResolver: ((webContentsId: number) => string | undefined) | null = null

// Messaging gateway: the bootstrap handle is created once sessionManager is
// available (inside createHandlerDeps) and populated with the WS publisher
// after bootstrapServer resolves. Both hosts (Electron + standalone) wire
// through createMessagingBootstrap — do not construct MessagingGatewayRegistry
// directly.
let messagingHandle: MessagingBootstrapHandle | null = null

// Store pending deep link if app not ready yet (cold start)
let pendingDeepLink: string | null = null

// Set app name early (before app.whenReady) to ensure correct macOS menu bar title
// Supports multi-instance dev: CRAFT_APP_NAME env var (e.g., "Craft Agents [1]")
app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')

// Register as default protocol client for craftagents:// URLs
// This must be done before app.whenReady() on some platforms
if (process.defaultApp) {
  // Development mode: need to pass the app path
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [process.argv[1]])
  }
} else {
  // Production mode
  app.setAsDefaultProtocolClient(DEEPLINK_SCHEME)
}

// Chromium stops producing frames for a window it judges to be fully covered by other windows,
// and `capturePage` then fails with "current display surface not available for capture" — the
// agent would have to raise the browser window (stealing the user's view) before every shot it
// takes in the background. Turning that judgement off keeps a covered window painting; the cost
// is the power it would have saved while hidden behind something.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

// Apply network proxy settings early (Node-level only — Electron sessions require app.whenReady)
import { applyConfiguredProxySettings, applyConfiguredProxyToSession } from './network-proxy'
void applyConfiguredProxySettings()

// Accept self-signed / untrusted certificates when connecting to a user-configured remote server.
// Only bypasses cert validation for configured hub origins (saved connection and every remote
// window) — all other
// connections use standard certificate verification. Without this, wss:// to self-signed servers
// fails with ERR_CERT_AUTHORITY_INVALID because Chromium's WebSocket rejects untrusted certs.
//
// Electron's certificate-error always reports URLs with https:// scheme, so we normalize
// wss:// → https:// (and ws:// → http://) to ensure origins compare correctly.
function normalizeOriginForCert(urlStr: string): string {
  const u = new URL(urlStr)
  if (u.protocol === 'wss:') u.protocol = 'https:'
  else if (u.protocol === 'ws:') u.protocol = 'http:'
  return u.origin
}

// ---------------------------------------------------------------------------
// Remote connections — a property of a window, not of this install
// ---------------------------------------------------------------------------
//
// One window can be local while another talks to a hub (the way VS Code has local and
// Remote-SSH windows side by side). The saved client config is the **default remote
// connection**: what "open a remote window" uses, and what new windows open when
// `enabled` says so. A running window carries its own target, read synchronously by
// the preload through `__get-client-mode`.
//
// The answer comes from Connect to Server… and nowhere else. A desktop app is
// configured by the person using it, not by environment variables they would
// have to discover and set.
/** A saved connection as a window target, with the credentials it holds now. */
function remoteTarget(connection: RemoteConnection, workspaceId?: string): RemoteWindowTarget {
  const targetWorkspaceId = workspaceId ?? connection.lastWorkspaceId
  return {
    connectionId: connection.id,
    url: connection.url,
    token: connection.token,
    name: connection.name,
    ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
  }
}

/**
 * Which workspaces that server has, asked of its own app-level link.
 *
 * `null` means the question could not be answered (link down, older server, transient error).
 * Callers must treat that as "unknown", never as "none": an unanswerable question must not
 * discard the workspace a window was on.
 */
async function workspaceIdsOn(connectionId: string): Promise<Set<string> | null> {
  const link = getHubConnectionClient(connectionId)
  if (!link) return null
  try {
    const workspaces = await link.invoke(RPC_CHANNELS.server.GET_WORKSPACES) as Array<{ id: string }>
    return new Set((workspaces ?? []).map((workspace) => workspace.id))
  } catch {
    return null
  }
}

/**
 * The first of `candidates` that still exists on that server.
 *
 * Used when a window is restored or re-pointed with a workspace remembered from an earlier
 * session: the workspace may have been removed on the server since. When the server cannot be
 * asked, the first candidate is kept — the connection's own failure is the honest answer then.
 */
async function firstExistingWorkspace(
  connectionId: string,
  candidates: Array<string | undefined>,
): Promise<string | undefined> {
  const wanted = candidates.filter((id): id is string => !!id)
  if (wanted.length === 0) return undefined
  const ids = await workspaceIdsOn(connectionId)
  return ids ? wanted.find((id) => ids.has(id)) : wanted[0]
}

/**
 * This install's identity as a hub sees it — advertised on every WS handshake, by a window's
 * connection and by the app-level hub link alike, so both answer as one device.
 */
function clientIdentity(): HubClientIdentity {
  return {
    deviceId: getDeviceId(),
    name: hostname(),
    platform: process.platform,
    // Diagnostics only: the hub shows it beside this device. Compatibility is negotiated per
    // channel, never by comparing app versions.
    version: app.getVersion(),
    // Folders a hub may reach are saved **per connection** and advertised by that device link
    // (`hub-connection.ts`). A local workspace is only a shortcut in the picker, not an
    // authorization, so the shared identity offers none.
    allowedRoots: [],
    hubRootBase: HUB_ROOT_BASE,
  }
}

/**
 * The hub a window's calls go to, as an HTTP base URL plus the token to present.
 *
 * A remote window names its hub outright; `null` means the window's server is this machine —
 * its exports are written here, so nothing has to be downloaded.
 */
function hubHttpForWindow(webContentsId: number): { baseUrl: string; token: string } | null {
  const target = windowManager?.getRemoteForWindow(webContentsId) ?? null
  return target ? { baseUrl: wsToHttpBase(target.url), token: target.token } : null
}

/** `ws://host:port` → `http://host:port` (the hub serves both on one port). */
function wsToHttpBase(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  return url.toString().replace(/\/$/, '')
}

/** Origins whose (possibly self-signed) certificate is accepted — configured hubs only. */
const trustedServerOrigins = new Set<string>()

function trustServerOrigin(url: string): void {
  try {
    trustedServerOrigins.add(normalizeOriginForCert(url))
  } catch {
    // Invalid URL — the connection will fail on its own terms.
  }
}

// Fold any legacy per-workspace remote entries into the saved-server list before anything reads
// it, so the device links and the trust list below already include those servers.
migrateLegacyRemoteWorkspaces()
for (const connection of getRemoteConnections()) trustServerOrigin(connection.url)

/**
 * Probe whether a TCP port is free on the given host by attempting a bind and
 * releasing it. Used at startup so a taken configured port degrades to a random
 * one instead of failing to launch. Startup-only by design — the settings page
 * does not pre-probe ports.
 */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  const { createServer } = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

/**
 * Ranges virtual adapters commonly hold and other devices cannot reach:
 * link-local (169.254/16), CGNAT (100.64/10, e.g. Tailscale), and the
 * benchmarking block (198.18/15) that TUN proxies hand out.
 */
function isVirtualOrReservedIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true
  return false
}

/** RFC 1918 private ranges — the ones a phone/laptop on the same LAN can reach. */
function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10
    || (a === 192 && b === 168)
    || (a === 172 && b !== undefined && b >= 16 && b <= 31)
}

// A user-configured hub often uses a self-signed certificate. Accept it **only** for origins the
// person configured (the saved connection and any window target); everything else keeps the
// standard verification. Without this, wss:// to a self-signed hub fails with
// ERR_CERT_AUTHORITY_INVALID because Chromium's WebSocket rejects untrusted certs.
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  try {
    if (trustedServerOrigins.has(normalizeOriginForCert(url))) {
      event.preventDefault()
      callback(true)
      return
    }
  } catch {
    // URL parse failure — fall through to default rejection
  }
  callback(false)
})

// Register the app's privileged schemes (thumbnail://, and the app's own origin scheme).
// Must happen before app.whenReady() — Electron allows one registration, and only early.
registerPrivilegedSchemes()

// Handle deeplink on macOS (when app is already running)
app.on('open-url', (event, url) => {
  event.preventDefault()
  mainLog.info('Received deeplink:', url)

  if (windowManager) {
    handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
      mainLog.error('Failed to handle deep link:', err)
    })
  } else {
    // App not ready - store for later
    pendingDeepLink = url
  }
})

// Handle deeplink on Windows/Linux (single instance check)
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // On Windows/Linux, the deeplink is in commandLine
    const url = commandLine.find(arg => arg.startsWith(`${DEEPLINK_SCHEME}://`))
    if (url && windowManager) {
      mainLog.info('Received deeplink from second instance:', url)
      handleDeepLink(url, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined).catch(err => {
        mainLog.error('Failed to handle deep link:', err)
      })
    } else if (windowManager) {
      // No deep link: bring the app back. The window may have been put away (hidden,
      // not destroyed) — `focus()` would not show it — or none may be left, in which
      // case one is made.
      const workspaceId = windowManager.getLastActiveWorkspaceId() ?? getWorkspaces()[0]?.id
      if (workspaceId) windowManager.raiseOrCreateWindow(workspaceId)
    }
  })
}

/** Open a window connected to a hub. The target is trusted for TLS and persisted with the window. */
function openRemoteWindow(target: RemoteWindowTarget): void {
  if (!windowManager) return
  trustServerOrigin(target.url)
  windowManager.createWindow({
    workspaceId: target.workspaceId ?? '',
    remote: target,
  })
}

/** Open a window on this machine's own server. */
function openLocalWindow(): void {
  if (!windowManager) return
  const workspaceId = windowManager.getLastActiveWorkspaceId() ?? getWorkspaces()[0]?.id
  if (workspaceId) windowManager.createWindow({ workspaceId })
}

// Helper to create initial windows on startup
async function createInitialWindows(): Promise<void> {
  if (!windowManager) return

  // Load saved window state
  const savedState = loadWindowState()
  let workspaces = getWorkspaces()

  // If no workspaces exist, create default "My Workspace" on first run
  if (workspaces.length === 0) {
    // Ensure config file exists (addWorkspace requires it)
    if (!loadStoredConfig()) {
      saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null })
    }
    const defaultPath = join(getDefaultWorkspacesDir(), 'my-workspace')
    addWorkspace({ rootPath: defaultPath, name: 'My Workspace' })
    workspaces = getWorkspaces() // Refresh after creation
    mainLog.info('Created default workspace on first run')
  }

  const validWorkspaceIds = workspaces.map(ws => ws.id)
  // A remote window's workspace belongs to its hub, not to this machine's list — but the saved
  // connection it names must still exist, or there is nowhere to reconnect it.
  const restorable = (w: { workspaceId: string; remote?: { connectionId: string } }): boolean =>
    w.remote ? !!getRemoteConnection(w.remote.connectionId) : validWorkspaceIds.includes(w.workspaceId)

  // Every window that was not destroyed at quit reopens one-to-one — a local window
  // and a remote window come back side by side. The last window closed is hidden, not
  // destroyed, so it is here too and reopens as "the last closed workspace window".
  const openWindows = (savedState?.windows ?? []).filter(restorable)

  if (openWindows.length) {
    // Stacking: the window focused last is restored last, so it comes back on top;
    // the rest sit beneath it in recorded order. This keeps "back where you left
    // off" even when several windows return at once. (sort is stable, so ties keep
    // their recorded order.)
    const focusedWorkspaceId = savedState?.lastFocusedWorkspaceId
    const ordered = [...openWindows].sort(
      (a, b) =>
        Number(a.workspaceId === focusedWorkspaceId) -
        Number(b.workspaceId === focusedWorkspaceId),
    )
    for (const saved of ordered) {
      const connection = saved.remote ? getRemoteConnection(saved.remote.connectionId) : null
      // A workspace remembered from an earlier session may be gone on the server by now. Ask
      // before naming it: a window pointed at a missing workspace comes up empty with a title it
      // cannot resolve. If it is gone, open on the server with **no** workspace — the picker,
      // which is what VS Code shows for a remote window without a folder.
      const workspaceId = connection
        ? await firstExistingWorkspace(connection.id, [saved.remote?.workspaceId, connection.lastWorkspaceId])
        : saved.workspaceId || undefined
      const target = connection ? remoteTarget(connection, workspaceId ?? '') : null
      mainLog.info(`Restoring window: workspaceId=${saved.workspaceId}, resolved=${workspaceId ?? 'none'}, remote=${target?.url ?? 'none'}, focused=${saved.focused ?? false}, url=${saved.url ?? 'none'}`)
      if (target) trustServerOrigin(target.url)
      const win = windowManager.createWindow({
        workspaceId: workspaceId ?? '',
        ...(target ? { remote: target } : {}),
        focused: saved.focused,
        restoreUrl: saved.url,
      })
      win.setBounds(saved.bounds)
    }
    return
  }

  // Nothing to restore: the first workspace.
  windowManager.createWindow({ workspaceId: workspaces[0].id })
  mainLog.info(`Created window for first workspace: ${workspaces[0].name}`)
}

app.whenReady().then(async () => {
  // A losing second instance called app.quit() at the top of this file, but that quit
  // is asynchronous — this callback can still run. Nothing may be created here: above
  // all not a second tray (see docs/tray-plan.md §3.6).
  if (!gotTheLock) return

  // Export packaged state as env var so logger.ts (and headless Bun) don't need 'electron'
  process.env.CRAFT_IS_PACKAGED = app.isPackaged ? 'true' : 'false'

  // Register bundled assets root so all seeding functions can find their files
  // (docs, permissions, themes, tool-icons resolve via getBundledAssetsDir)
  setBundledAssetsRoot(__dirname)

  // Initialize backend runtime bootstrapping (Codex vendor root, Claude SDK runtime paths).
  initializeBackendHostRuntime({
    hostRuntime: {
      appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    },
  })

  // Register PowerShell validator root so it can find the bundled parser script
  // (Windows only: validates PowerShell commands in Explore mode using AST analysis)
  setPowerShellValidatorRoot(join(__dirname, 'resources'))

  // Initialize bundled docs
  initializeDocs()

  // Initialize bundled release notes
  initializeReleaseNotes()

  // Ensure default permissions file exists (copies bundled default.json on first run)
  ensureDefaultPermissions()

  // Seed tool icons to ~/.craft-agent/tool-icons/ (copies bundled SVGs on first run)
  ensureToolIcons()

  // Seed preset themes to ~/.craft-agent/themes/ (copies bundled theme JSONs on first run)
  ensurePresetThemes()

  // Register thumbnail:// protocol handler (scheme was registered earlier, before app.whenReady)
  registerThumbnailHandler()

  // The drawio editor needs a real origin: file:// is opaque, which costs relative fetch
  // and ES modules. It gets a scheme of the app's own, registered earlier, so its
  // addresses are stable across launches and no port is involved.
  //
  // Registered on the app's own session — where the embedded viewer and the hidden engine
  // window live — and on nothing else. Deliberately **no** handler on `http` or `https`:
  // a handler there is per session and comes down on every request that session makes,
  // real designs included, which is what broke them.
  // One handler for the app's own scheme, routing every feature that lives on it
  // (the diagram editor, and now a design's own folder).
  registerLocalOriginHandler(session.defaultSession)

  // Re-apply proxy settings now that Electron sessions are available
  // (first call before app.whenReady only configured Node-level proxy)
  await applyConfiguredProxySettings()

  // Note: electron-updater handles pending updates internally via autoInstallOnAppQuit

  // Application menu is created after windowManager initialization (see below)

  // Set dock icon on macOS (required for dev mode, bundled apps use Info.plist)
  if (process.platform === 'darwin' && app.dock) {
    // In packaged app, resources are at dist/resources/ (same level as __dirname)
    // In dev, resources are at ../resources/ (sibling of dist/)
    const dockIconPath = [
      join(__dirname, 'resources/icon.png'),
      join(__dirname, '../resources/icon.png'),
    ].find(p => existsSync(p))

    if (dockIconPath) {
      app.dock.setIcon(dockIconPath)
      // Initialize badge icon for canvas-based badge overlay
      initBadgeIcon(dockIconPath)
    }

    // Multi-instance dev: show instance number badge on dock icon
    // CRAFT_INSTANCE_NUMBER is set by detect-instance.sh for numbered folders
    const instanceNum = process.env.CRAFT_INSTANCE_NUMBER
    if (instanceNum) {
      const num = parseInt(instanceNum, 10)
      if (!isNaN(num) && num > 0) {
        initInstanceBadge(num)
      }
    }
  }

  try {
    // Initialize window manager
    windowManager = new WindowManager()

    // A link React never saw — a sandboxed preview navigates the top frame — belongs to the
    // workspace's browser in a remote window. Main only asks the renderer; the ordinary open
    // path decides between the server's browser and the system browser.
    windowManager.setInAppLinkOpener((url, win) => {
      if (!windowManager?.getRemoteForWindow(win.webContents.id)) return false
      if (!isBrowserUrl(url)) return false
      win.webContents.send('browser:open-link', url)
      return true
    })

    // Create the application menu (needs windowManager for New Window action)
    createApplicationMenu(windowManager)

    // Windows are independent: a window can be local while another talks to a hub, so the local
    // runtime below always starts. `savedRemoteConnection` only decides what a *new* window opens.
    const isHeadless = !!process.env.CRAFT_HEADLESS

    // Initialize notification service (always — triggered by server push events)
    initNotificationService(windowManager)

    // The tray: the app's always-there surface. No GUI (headless) means no tray.
    // The app only stays alive between windows where there is a way back to one —
    // the tray, or the macOS dock. Everywhere else a close stays a real close, so a
    // tray that failed to appear can never leave the app invisible (see §3.6).
    const trayReady = !isHeadless && createTray(windowManager, {
      getConnections: () => getRemoteConnections(),
      openRemote: (connectionId) => {
        const connection = getRemoteConnection(connectionId)
        if (!connection) return
        const target = remoteTarget(connection)
        trustServerOrigin(target.url)
        openRemoteWindow(target)
      },
    })
    residentMode = trayReady || process.platform === 'darwin'
    windowManager.setResident(residentMode)

    // Initialize browser pane manager (always — even in headless, for deps wiring)
    browserPaneManager = new BrowserPaneManager()
    browserPaneManager.setWindowManager(windowManager)
    // The desktop driver is optional and probed lazily; until it resolves, no device link
    // announces `computer` (see isComputerUseAdvertised).
    // The pill that cannot be missed: shown while a session holds the desktop, and the one way out
    // that works even when the agent's cursor is on another monitor.
    desktopControlIndicator = createDesktopControlIndicator({
      release: () => computerUseManager?.release(),
      log: (message) => console.log(`[computer-use] ${message}`),
    })
    computerUseManager = new ComputerUseManager({
      log: (message, details) => console.log(`[computer-use] ${message}`, details ?? ''),
      loadDriver: () => loadDefaultCuaDriver((message, details) =>
        console.log(`[computer-use] ${message}`, details ?? '')),
      onLeaseChange: (sessionId) => {
        if (sessionId) desktopControlIndicator?.show(sessionId)
        else desktopControlIndicator?.hide()
      },
    })
    void computerUseManager.available().then(setComputerUseAdvertised)
    // A browser partition is created per workspace, on first use — after the proxy settings were
    // applied. This is how such a partition still gets them.
    browserPaneManager.setProxyApplier(applyConfiguredProxyToSession)
    // A tab's profile is a fact about the conversation (or, with no conversation, the workspace).
    // Resolved here because this is the side that can read both — and asked per tab, so a
    // conversation that switches profiles lands on the new one with its next tab.
    browserPaneManager.setProfileResolver((sessionId, workspaceId) => {
      const workspace = workspaceId ? getWorkspaces().find((w) => w.id === workspaceId) : undefined
      if (!workspace) return resolveConversationBrowserProfileId(undefined, undefined, undefined)
      const session = sessionId ? loadSessionHeader(workspace.rootPath, sessionId) : undefined
      const projectProfile = session?.projectId
        ? loadProjectById(workspace.rootPath, session.projectId)?.config.browserProfile
        : undefined
      return resolveConversationBrowserProfileId(
        session?.browserProfile,
        projectProfile,
        getWorkspaceBrowserProfile(workspace.rootPath),
      )
    })
    browserPaneManager.registerToolbarIpc()
    browserPaneManager.registerCapabilityIpc()

    // A browser window outlives the workspace's main window. It is not tied to a window
    // on screen: a device with no main window must still have a browser the hub can
    // drive, and closing one main window must not throw away another workspace's tabs.
    // Its lifetime is the process's — closing a browser window only hides it, and
    // `performQuitCleanup()` destroys them. The tray's "Browser Windows" entry is the
    // manual way to free one before that.

    // Build real PlatformServices from Electron APIs
    const platform: PlatformServices = createElectronPlatform({
      app,
      nativeImage,
      shell,
      nativeTheme,
      logger: log,
      isDebugMode,
      getLogFilePath,
      captureError: (err) => Sentry.captureException(err),
    })

    // Bootstrap IPC handlers — preload uses sendSync for window-local details
    ipcMain.on('__get-web-contents-id', (e) => {
      e.returnValue = e.sender.id
    })
    ipcMain.on('__get-workspace-id', (e) => {
      e.returnValue = windowManager?.getWorkspaceForWindow(e.sender.id) ?? ''
    })

    // This window's connection target. Each window may point at a different server (or none),
    // so it is resolved per webContents rather than once per process. Preload reads this
    // synchronously during evaluation, before the first renderer tick.
    ipcMain.on('__get-client-mode', (e) => {
      e.returnValue = windowManager?.getRemoteForWindow(e.sender.id) ?? null
    })

    // This install's identity — advertised on the WS handshake so another
    // machine can name it as a session's browser device.
    ipcMain.on('__get-client-identity', (e) => {
      e.returnValue = clientIdentity()
    })

    // One app-level link per saved server: shell, files and this machine's browser, offered by
    // the **process** rather than by a window — so a hub can drive this device with nothing on
    // screen, and no call lands on a window that happens to be closing. Windows keep their own
    // connections for the workspace they show.
    syncHubConnections(getRemoteConnections(), {
      identity: clientIdentity,
      browserPaneManager: () => browserPaneManager,
      computerUseManager: () => computerUseManager,
    })

    // Transport diagnostics bridge — preload reports remote WS connection state changes
    // so failures are visible in terminal/main.log (not only renderer console).
    ipcMain.on('__transport:status', (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const p = payload as {
        level?: 'info' | 'warn' | 'error'
        message?: string
        status?: string
        attempt?: number
        nextRetryInMs?: number
        error?: unknown
        close?: unknown
        url?: string
      }

      const level = p.level ?? 'info'
      const message = p.message ?? '[transport] status update'
      const context = {
        status: p.status,
        attempt: p.attempt,
        nextRetryInMs: p.nextRetryInMs,
        error: p.error,
        close: p.close,
        url: p.url,
      }

      if (level === 'error') {
        mainLog.error(message, context)
      } else if (level === 'warn') {
        mainLog.warn(message, context)
      } else {
        mainLog.info(message, context)
      }
    })

    // Dialog bridge — preload capability handlers use ipcRenderer.invoke to
    // call main-process-only dialog APIs (dialog, BrowserWindow).
    ipcMain.handle('__dialog:showMessageBox', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(win, spec)
      return { response: result.response }
    })
    ipcMain.handle('__dialog:showOpenDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, spec)
      return { canceled: result.canceled, filePaths: result.filePaths }
    })
    ipcMain.handle('__dialog:showSaveDialog', async (event, spec) => {
      const win = BrowserWindow.fromWebContents(event.sender)
        || BrowserWindow.getFocusedWindow()
        || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showSaveDialog(win, spec)
      return { canceled: result.canceled, filePath: result.filePath ?? null }
    })

    // The local runtime (server, SessionManager, model refresh) is always started: every window,
    // local or remote, uses it for its window-local channels, and other devices may connect to it
    // while this machine also has a window on someone else's hub.
    if (windowManager || isHeadless) {
      // Restore persisted Git Bash path on Windows (must happen before any SDK subprocess spawn)
      if (process.platform === 'win32') {
        const { getGitBashPath, clearGitBashPath } = await import('@craft-agent/shared/config')
        const gitBashPath = getGitBashPath()
        if (gitBashPath) {
          const validation = await validateGitBashPath(gitBashPath)
          if (validation.valid) {
            process.env.CLAUDE_CODE_GIT_BASH_PATH = validation.path
          } else {
            clearGitBashPath()
            delete process.env.CLAUDE_CODE_GIT_BASH_PATH
            mainLog.warn(`Cleared invalid persisted Git Bash path: ${gitBashPath}`)
          }
        }
      }

      // Check for VC++ Redistributable on Windows (required by onnxruntime / markitdown).
      // Without it, document conversion tools (PDF, PPTX, DOCX, XLSX) crash with DLL errors.
      // Sets env var so renderer can show an actionable toast with install button.
      if (process.platform === 'win32') {
        const vcCheck = checkVCRedistInstalled()
        if (!vcCheck.installed) {
          mainLog.warn('[vcredist]', vcCheck.message)
          process.env.CRAFT_VCREDIST_MISSING = '1'
          if (vcCheck.downloadUrl) {
            process.env.CRAFT_VCREDIST_URL = vcCheck.downloadUrl
          }
        } else if (isDebugMode) {
          mainLog.info('[vcredist]', vcCheck.message)
        }
      }

      // Pre-import power manager (async import needed for applyPlatformToSubsystems)
      const { onSessionStarted, onSessionStopped } = await import('./power-manager')

      // Client ID tracking for Electron IPC bridge (webContentsId → clientId)
      const clientMap = new Map<number, string>()
      const resolveClientId = (wcId: number) => clientMap.get(wcId)

      // Read embedded server config (Server settings design)
      const { getServerConfig } = await import('@craft-agent/shared/config')
      const embeddedServerConfig = getServerConfig()
      const serverModeEnabled = embeddedServerConfig.enabled

      // Derive host/port/token from server config (or env overrides)
      const serverToken = serverModeEnabled && embeddedServerConfig.token
        ? embeddedServerConfig.token
        : randomUUID()
      // The Web UI follows Server Mode — it is always on while the server is. Its password is
      // still its own credential, minted on first enable and kept in the config so the settings
      // page can show (and reset) it. Session cookies are signed with a key derived from that
      // password and the server token, so changing either one ends browser sessions.
      let webuiPassword = embeddedServerConfig.webuiPassword ?? ''
      if (serverModeEnabled && !webuiPassword) {
        webuiPassword = randomUUID()
        const { setServerConfig: setConfig } = await import('@craft-agent/shared/config')
        setConfig({ ...embeddedServerConfig, webuiPassword })
        mainLog.info('[server-mode] Web UI password generated')
      }
      const webuiSessionKey = deriveWebuiSessionKey(serverToken, webuiPassword)
      // External binding is its own switch: server mode on + allowExternal (default true).
      const allowExternal = serverModeEnabled && embeddedServerConfig.allowExternal !== false
      const rpcHost = process.env.CRAFT_RPC_HOST
        ?? (allowExternal ? '0.0.0.0' : '127.0.0.1')
      const configuredPort = process.env.CRAFT_RPC_PORT
        ? parseInt(process.env.CRAFT_RPC_PORT, 10)
        : (serverModeEnabled ? embeddedServerConfig.port : 0)

      // Port conflict handling (startup only): a taken configured port degrades to
      // a random one instead of failing startup, and is surfaced in ServerStatus.
      let rpcPort = configuredPort
      let bindError: string | undefined
      if (serverModeEnabled && !process.env.CRAFT_RPC_PORT && configuredPort > 0
        && !(await isPortAvailable(configuredPort, rpcHost))) {
        rpcPort = 0
        bindError = `Port ${configuredPort} is in use`
        mainLog.warn(`[server-mode] Port ${configuredPort} is in use — falling back to a random port`)
      }

      // Load TLS certificates if configured
      let tls: import('@craft-agent/server-core/transport').WsRpcTlsOptions | undefined
      if (serverModeEnabled && embeddedServerConfig.tlsCertPath && embeddedServerConfig.tlsKeyPath) {
        try {
          tls = {
            cert: readFileSync(embeddedServerConfig.tlsCertPath),
            key: readFileSync(embeddedServerConfig.tlsKeyPath),
          }
          mainLog.info('[server-mode] TLS enabled')
        } catch (err) {
          mainLog.error('[server-mode] Failed to load TLS certificates:', err)
        }
      }

      if (serverModeEnabled) {
        mainLog.info(`[server-mode] Enabled — binding ${rpcHost}:${rpcPort}${tls ? ' (TLS)' : ''}`)
      }

      // ---------------------------------------------------------------------
      // WebUI static serving — the Electron server also serves the browser UI on
      // the RPC port so a browser/mobile client can connect without the desktop
      // app. Mirrors the headless server (packages/server/src/index.ts).
      // ---------------------------------------------------------------------
      let webuiDir: string | undefined
      if (serverModeEnabled) {
        const webuiCandidates = [
          process.env.CRAFT_WEBUI_DIR,
          getBundledAssetsDir('webui'),
          // Dev: running from the repo root without a built dist/resources tree.
          join(process.cwd(), 'apps', 'webui', 'dist'),
        ].filter((p): p is string => !!p)
        webuiDir = webuiCandidates.find((p) => existsSync(join(p, 'index.html')))
        if (!webuiDir) {
          mainLog.warn('[server-mode] WebUI assets not found — browser clients will have no UI (run `bun run webui:build`); protocol routes are still served')
        }
      }

      // The HTTP handler exists whenever this instance is a hub: it serves the Web UI and the
      // protocol routes (export downloads) on the RPC port.
      let serverWebuiHandler: WebuiHandler | null = null
      let serverWebuiHttpHandler: ((req: any, res: any) => void) | undefined
      let webuiHealthCheck: (() => { status: string }) | null = null
      const webuiHttpDispatcher = serverModeEnabled
        ? (req: any, res: any) => {
            if (serverWebuiHttpHandler) serverWebuiHttpHandler(req, res)
            else { res.statusCode = 404; res.end() }
          }
        : undefined

      // Bootstrap the WS RPC server via shared bootstrap function.
      const instance = await bootstrapServer<SessionManager, HandlerDeps>({
        serverToken,
        rpcHost,
        rpcPort,
        tls,
        httpHandler: webuiHttpDispatcher,
        // Accept a Web UI session cookie on the WebSocket upgrade — verified with the key derived
        // from this hub's token and Web UI password.
        validateSessionCookie: serverModeEnabled
          ? async (cookieHeader: string | null) => (await validateSession(cookieHeader, webuiSessionKey)) !== null
          : undefined,
        bundledAssetsRoot: __dirname,
        serverId: 'local',
        serverVersion: app.getVersion(),
        platformFactory: () => platform,
        applyPlatformToSubsystems: (p) => {
          setFetcherPlatform(p)
          setSessionPlatform(p)
          setSessionRuntimeHooks({
            updateBadgeCount,
            onSessionStarted,
            onSessionStopped,
            captureException: (error, context) => {
              Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
                tags: {
                  ...(context?.errorSource ? { errorSource: context.errorSource } : {}),
                  ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                },
              })
            },
          })
          setSearchPlatform(p)
          setImageProcessor(p.imageProcessor)
        },
        createSessionManager: () => {
          const sm = new SessionManager()
          sm.setBrowserPaneManager(browserPaneManager!)
          sm.setComputerPaneFns((sessionId) => {
            if (!computerUseManager) throw new Error('The desktop driver is not initialised.')
            return computerUseManager.fnsForSession(sessionId)
          })
          // Tweaks are installed from here too: the browser window that runs them belongs to
          // this process, and the injector lives beside it (see tweaks-injector.ts). The
          // watcher calls this on every tweak write, so the registration a new document is
          // given follows the folder rather than whatever was installed last.
          sm.setTweaksInstaller(requestTweaksForWorkspace)
          // Design preview posters: offscreen capture is Electron-main-only. On
          // capture, nudge the watcher so the designs:changed push carries the
          // fresh thumbnail pointer to open grids. The poke names the design's
          // design.json — the one path the watcher treats as a designs trigger.
          const designThumbnailer = new DesignThumbnailer({
            log: (m) => mainLog.info(m),
            onCaptured: ({ workspaceRootPath, slug }) => {
              sm.notifyConfigFileChange(workspaceRootPath, getDesignConfigRelativePath(slug))
            },
          })
          sm.setDesignThumbnailer((req) => designThumbnailer.enqueue(req))
          // A design opened in a browser tab has no host bridge, so a fresh snapshot is
          // pushed into any tab that is showing it (see design-tab-pusher).
          sm.setDesignsChangedNotifier((workspaceId) => {
            void pushDesignSnapshotsToTabs(browserPaneManager!, workspaceId)
          })
          return sm
        },
        bindRpcServer: (sm, server) => sm.setRpcServer(server),
        createHandlerDeps: ({ sessionManager: sm, platform: p, oauthFlowStore: ofs }) => {
          // PDF / per-slide PNG exports render in a hidden window, which lives
          // in this process — so the renderer is injected here (see design-exporter.ts).
          const designExporter = new DesignExporter({ log: (m) => mainLog.info(m) })
          // The messaging handle is built here because it needs sessionManager.
          // The WS publisher is attached after bootstrapServer resolves (via
          // handle.setPublisher) because wsServer isn't available yet.
          messagingHandle = createMessagingBootstrap({
            sessionManager: sm,
            credentialManager: getCredentialManager(),
            getMessagingDir: (wsId: string) =>
              join(CONFIG_DIR, 'workspaces', wsId, 'messaging'),
            getLegacyMessagingDir: (wsId: string) => {
              const ws = getWorkspaces().find((w) => w.id === wsId)
              return ws ? join(ws.rootPath, 'messaging') : undefined
            },
            // Route messaging diagnostics through the dedicated messaging log
            // at ~/.craft-agent/logs/messaging-gateway.log.
            logger: messagingGatewayLog,
            // WhatsApp worker runs under Electron's embedded Node via
            // ELECTRON_RUN_AS_NODE (WhatsAppAdapter defaults nodeBin to
            // process.execPath). In dev we resolve worker.cjs from the
            // monorepo; in packaged builds it's shipped via extraResources
            // (see apps/electron/electron-builder.yml).
            whatsapp: {
              workerEntry: app.isPackaged
                ? join(process.resourcesPath, 'messaging-whatsapp-worker', 'worker.cjs')
                : join(process.cwd(), 'packages', 'messaging-whatsapp-worker', 'dist', 'worker.cjs'),
              pairingMode: 'qr',
            },
          })
          return {
            sessionManager: sm,
            platform: p,
            windowManager: windowManager ?? undefined,
            browserPaneManager: browserPaneManager ?? undefined,
            // The editor is a vendored dependency of the app, not of a workspace, so
            // this answer is install-wide and needs no arguments.
            drawioOrigin: drawioOriginUrl,
            oauthFlowStore: ofs,
            messagingRegistry: messagingHandle.registry,
            designExportRender: (req) => designExporter.export(req),
          }
        },
        // Headless: register only core handlers (no GUI handlers for browser, settings, etc.)
        // GUI: register all handlers (core + GUI)
        registerAllRpcHandlers: isHeadless
          ? (server, deps, serverCtx) => registerCoreRpcHandlers(server, deps, serverCtx)
          : registerAllRpcHandlers,
        setSessionEventSink: (sm, sink) => sm.setEventSink(sink),
        initializeSessionManager: (sm) => sm.initialize(),
        initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
          const { getCredentialManager } = await import('@craft-agent/shared/credentials')
          const manager = getCredentialManager()
          const [apiKey, oauth] = await Promise.all([
            manager.getLlmApiKey(slug).catch(() => null),
            manager.getLlmOAuth(slug).catch(() => null),
          ])
          return {
            apiKey: apiKey ?? undefined,
            oauthAccessToken: oauth?.accessToken,
            oauthRefreshToken: oauth?.refreshToken,
            oauthIdToken: oauth?.idToken,
          }
        }),
        onClientConnected: ({ clientId, webContentsId }) => {
          // Only this machine's windows are addressed by webContentsId here. A thin
          // client's ids belong to its own process and must not overwrite ours.
          if (webContentsId != null && windowManager?.getWindowByWebContentsId(webContentsId)) {
            clientMap.set(webContentsId, clientId)
          }
        },
        cleanupClientResources: (clientId) => {
          for (const [wcId, cId] of clientMap) {
            if (cId === clientId) { clientMap.delete(wcId); break }
          }
          cleanupSessionFileWatchForClient(clientId)
          cleanupProjectFilesWatchForClient(clientId)
          // A browser stream is a viewer, not a background job: the connection that asked for
          // it is gone, so the capture it holds has no one to show.
          browserPaneManager?.endViewStreamsForClient(clientId)
        },
      })

      // Capture module-level references for before-quit cleanup and deep-link handlers
      sessionManager = instance.sessionManager
      oauthFlowStore = instance.oauthFlowStore
      moduleSink = instance.wsServer.push.bind(instance.wsServer)
      moduleClientResolver = resolveClientId

      // -----------------------------------------------------------------------
      // Hub HTTP — the Web UI and protocol routes, on the RPC port.
      // -----------------------------------------------------------------------
      if (serverModeEnabled) {
        serverWebuiHandler = createWebuiHandler({
          webuiDir,
          // The same vendored editor the desktop windows use, at `/drawio/` on this origin.
          drawioDir: getBundledAssetsDir('drawio') ?? undefined,
          // The hub token logs a browser in and is half of the session signing key.
          serverToken,
          password: webuiPassword,
          // Export downloads also accept a hub credential, for a native client with no cookie.
          // Checked the way the socket checks it — bound to this machine, and not a credential
          // that may only answer capability calls — because an HTTP GET is not a way around the
          // device binding that stops a slot from being transferred to another machine.
          // `probe` on purpose: a download must not be what claims a pending slot.
          authorizeBearer: (header) => {
            const token = bearerToken(header)
            if (!token) return false
            const grant = instance.tokens.authorize(token, { deviceId: clientIdentity().deviceId, probe: true })
            return grant !== null && grant.scope !== 'device'
          },
          // Reverse-proxy / port-mapping support comes from config, not env vars.
          publicWsUrl: embeddedServerConfig.publicWsUrl || undefined,
          wsProtocol: tls ? 'wss' : 'ws',
          wsPort: instance.port,
          getHealthCheck: () => webuiHealthCheck?.() ?? { status: 'starting' },
          logger: {
            info: (m: string) => mainLog.info(m),
            warn: (m: string) => mainLog.warn(m),
            error: (m: string) => mainLog.error(m),
          } as any,
        })
        serverWebuiHttpHandler = nodeHttpAdapter(serverWebuiHandler.fetch)

        const { getHealthCheck } = await import('@craft-agent/server-core/handlers/rpc/server')
        webuiHealthCheck = () => getHealthCheck({ sessionManager: instance.sessionManager } as any)

        const { getSourceCredentialManager, loadWorkspaceSources } = await import('@craft-agent/shared/sources')
        const { pushTyped } = await import('@craft-agent/server-core/transport')
        const { RPC_CHANNELS } = await import('@craft-agent/shared/protocol')
        serverWebuiHandler.setOAuthCallbackDeps({
          flowStore: instance.oauthFlowStore,
          credManager: getSourceCredentialManager(),
          sessionManager: instance.sessionManager,
          pushSourcesChanged: (workspaceId: string) => {
            const ws = getWorkspaceByNameOrId(workspaceId)
            const sources = ws ? loadWorkspaceSources(ws.rootPath) : []
            pushTyped(instance.wsServer, RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources)
          },
        })
        mainLog.info(webuiDir
          ? `[server-mode] WebUI serving from ${webuiDir}`
          : '[server-mode] Web UI bundle not found — serving protocol routes only')
      }

      // What to write on the tab rail's group headers. A tab says whose work it is, and the
      // window is one window for the whole workspace — so the rail
      // is where several conversations' tabs sit side by side, and a session id is
      // not a name a person can read. Late-bound on purpose: windows can be created
      // before (and after) this assignment, and it is only a name — whose tab it is
      // stays `belongsTo`'s answer. (A task's section needs no resolver — it is named
      // by its own slug.)
      browserPaneManager?.setSessionLabelResolver((sessionId) => sessionManager?.getSessionName(sessionId) ?? null)
      // Files a conversation works with can live outside its workspace (the working
      // directory is settable), so the browser upload path needs the conversation list
      // to allow them. The manager is built before the session manager, hence the setter.
      if (sessionManager) browserPaneManager?.setSessionManager(sessionManager)

      // -----------------------------------------------------------------------
      // Messaging Gateway — attach the WS publisher, init local workspaces,
      // install the fan-out event sink. The handle was created inside
      // createHandlerDeps so the registry could be wired into HandlerDeps.
      // -----------------------------------------------------------------------
      try {
        if (!messagingHandle) {
          throw new Error('Messaging handle was not constructed in createHandlerDeps')
        }

        messagingHandle.setPublisher(instance.wsServer.push.bind(instance.wsServer))

        // Messaging runs on the server that owns the workspace — every workspace here is local.
        const localWorkspaceIds = getWorkspaces().map((ws) => ws.id)
        await messagingHandle.initializeWorkspaces(localWorkspaceIds)

        // Compose fan-out event sink: RPC push + messaging gateway dispatch.
        // Always install — this lets workspaces enable messaging at runtime
        // without a process restart.
        const baseSink = instance.wsServer.push.bind(instance.wsServer)
        instance.sessionManager.setEventSink(messagingHandle.wrapSink(baseSink))
        if (messagingHandle.registry.size > 0) {
          mainLog.info(`[messaging] Fan-out sink active for ${messagingHandle.registry.size} workspace(s)`)
        }
      } catch (err) {
        mainLog.error('[messaging] Gateway initialization failed:', err)
      }

      // IPC handlers — preload uses sendSync to get WS connection details

      // Transfer a session to another workspace **of this window's server**. A remote window
      // does the same over its hub connection (see preload), so this path is this machine's own.
      ipcMain.handle('session:transferToWorkspace', async (event, sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
        const idx = sessionIndex ?? 0
        const count = sessionCount ?? 1
        if (!sessionManager) throw new Error('Session manager not initialized')

        const sourceWorkspaceId = windowManager?.getWorkspaceForWindow(event.sender.id)
        if (!sourceWorkspaceId) throw new Error('Unable to resolve source workspace for transfer')
        const targetWorkspace = getWorkspaceByNameOrId(targetWorkspaceId)
        if (!targetWorkspace) throw new Error(`Workspace ${targetWorkspaceId} not found`)

        const emitProgress = (chunkSent: number, chunkTotal: number) => {
          try { event.sender.send('transfer:progress', { sessionIndex: idx, sessionCount: count, chunkSent, chunkTotal }) } catch { /* renderer may be gone */ }
        }

        emitProgress(0, 1)
        const bundle = await sessionManager.exportSession(sessionId, sourceWorkspaceId)
        if (!bundle) throw new Error(`Failed to export session ${sessionId}`)

        try {
          const transferPayload = await sessionManager.exportRemoteSessionTransfer(sessionId, sourceWorkspaceId)
          if (transferPayload?.summary && bundle.session?.header) {
            ;(bundle.session.header as any).transferredSessionSummary = transferPayload.summary
            ;(bundle.session.header as any).transferredSessionSummaryApplied = false
          }
        } catch (err) {
          console.warn('[Transfer] Summary generation failed:', err)
        }

        const result = await sessionManager.importSession(targetWorkspace.id, bundle, 'fork')
        emitProgress(1, 1)
        return result
      })

      // Language change: sync from renderer to main process, persist, and rebuild native menu.
      // Persistence here is what lets the next app launch hydrate main's i18n correctly —
      // see the `getPersistedUiLanguage()` block at the top of this file.
      ipcMain.handle('i18n:changeLanguage', async (_event, lang: unknown) => {
        const previousResolved = i18n.resolvedLanguage ?? null
        if (typeof lang !== 'string' || !SUPPORTED_LANGUAGE_CODES.includes(lang as LanguageCode)) {
          // Defense-in-depth: renderer guarantees a supported code, but if a renegade
          // caller hands us garbage we drop it silently rather than poison i18n state.
          mainLog.warn('[i18n] changeLanguage IPC rejected — unsupported code', {
            incoming: lang,
            previousResolved,
          })
          return
        }
        const code = lang as LanguageCode
        await i18n.changeLanguage(code)
        setPersistedUiLanguage(code)
        mainLog.info('[i18n] changeLanguage IPC applied', {
          incoming: code,
          previousResolved,
          newResolved: i18n.resolvedLanguage ?? null,
        })
        const { rebuildMenu } = await import('./menu')
        await rebuildMenu()
      })

      ipcMain.on('__get-ws-port', (e) => {
        e.returnValue = instance.port
      })
      ipcMain.on('__get-ws-token', (e) => {
        // This machine's own windows present the hub's token, exactly like any other client.
        e.returnValue = instance.token
      })

      // Server config RPC handlers (LOCAL_ONLY — Electron-specific)
      const runningServerState = {
        host: rpcHost,
        port: instance.port,
        tls: !!tls,
        token: serverToken,
        enabled: serverModeEnabled,
        allowExternal,
        bindError,
        publicWsUrl: embeddedServerConfig.publicWsUrl || undefined,
      }

      // Server settings are part of the app's surface: whoever holds a valid credential is already
      // at the app's top level (it can drive sessions and shell), so refusing a remote caller here
      // would be a UI preference dressed up as a boundary. The settings page hides this section
      // in a window connected to a hub so nobody edits the host's identity by accident; that is
      // the guard this
      // deserves. If a real admin role ever exists, it belongs with the credential model, not here.
      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_CONFIG, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        // The server token is not a settings value any more: no window — local, remote or browser —
        // needs it, and this channel is reachable from a remote window. The main process keeps it.
        const view = { ...getConfig() }
        delete view.token
        return view
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.SET_SERVER_CONFIG, async (_ctx: unknown, config: unknown) => {
        const { setServerConfig: setConfig } = await import('@craft-agent/shared/config')
        const cfg = config as import('@craft-agent/shared/config/server-config').ServerConfig
        // Validate port range
        if (cfg.port < 1024 || cfg.port > 65535) {
          throw new Error(`Port must be between 1024 and 65535, got ${cfg.port}`)
        }
        // The external address is a browser address as often as a socket one — they are the same
        // endpoint — so both spellings are stored as typed and normalised where they are used.
        if (cfg.publicWsUrl && !/^(wss?|https?):\/\//i.test(cfg.publicWsUrl)) {
          throw new Error('External address must start with https://, wss://, http:// or ws://')
        }
        // Validate cert/key files exist if provided
        if (cfg.tlsCertPath && !existsSync(cfg.tlsCertPath)) {
          throw new Error(`Certificate file not found: ${cfg.tlsCertPath}`)
        }
        if (cfg.tlsKeyPath && !existsSync(cfg.tlsKeyPath)) {
          throw new Error(`Private key file not found: ${cfg.tlsKeyPath}`)
        }
        setConfig(cfg)
      })

      instance.wsServer.handle(RPC_CHANNELS.settings.GET_SERVER_STATUS, async () => {
        const { getServerConfig: getConfig } = await import('@craft-agent/shared/config')
        const saved = getConfig()
        const protocol = runningServerState.tls ? 'wss' : 'ws'

        // Determine display host (LAN IP if bound to 0.0.0.0). Skip loopback and
        // virtual adapters, and prefer a private-range address — the one other
        // devices on the network can actually reach.
        //
        // Computed even when the listener is loopback-only: the settings page previews the URL of
        // a config that has not been applied yet, and needs to know the address that config would
        // expose. Binding to loopback is just "not exposed yet", not "no such address".
        const lanHost = await (async () => {
          const os = await import('os')
          const candidates: string[] = []
          for (const nets of Object.values(os.networkInterfaces())) {
            for (const net of nets ?? []) {
              if (net.family !== 'IPv4' || net.internal) continue
              if (isVirtualOrReservedIpv4(net.address)) continue
              candidates.push(net.address)
            }
          }
          return candidates.find(isPrivateIpv4) ?? candidates[0] ?? '127.0.0.1'
        })()
        const displayHost = runningServerState.host === '0.0.0.0' || runningServerState.host === '::'
          ? lanHost
          : runningServerState.host

        // Only compare port/tls/token when at least one side has server mode enabled.
        // When both are disabled, the running port is random — comparing it to the
        // saved default (9100) would always produce a false "restart required" banner.
        // A port fallback (bindError) is intentional, so it does not imply a restart.
        const portChanged = !runningServerState.bindError && saved.port !== runningServerState.port
        const allowExternalChanged = (saved.allowExternal ?? true) !== runningServerState.allowExternal
        const publicWsUrlChanged = (saved.publicWsUrl ?? '') !== (runningServerState.publicWsUrl ?? '')
        const needsRestart = saved.enabled !== runningServerState.enabled
          || ((saved.enabled || runningServerState.enabled) && (
            portChanged
            || allowExternalChanged
            || publicWsUrlChanged
            || (!!saved.tlsCertPath) !== runningServerState.tls
            // An empty saved token means "mint one at startup", not "a change is pending" —
            // comparing it to the minted token would flag a restart that never converges.
            || (!!saved.token && saved.token !== runningServerState.token)
          ))

        return {
          running: true,
          host: runningServerState.host,
          port: runningServerState.port,
          tls: runningServerState.tls,
          url: `${protocol}://${displayHost}:${runningServerState.port}`,
          needsRestart,
          insecureWarning: isInsecureBind,
          allowExternal: runningServerState.allowExternal,
          lanHost,
          bindError: runningServerState.bindError,
          publicWsUrl: runningServerState.publicWsUrl,
        }
      })

      /**
       * Restart this server's process — the one thing a client connected to the hub cannot do on
       * its own machine. A remote window calls it after saving listener settings that only a fresh
       * process reads (port, TLS, token).
       *
       * The answer goes out first and the process exits a beat later: cutting the socket inside
       * the handler would turn a successful restart into a transport error for the caller.
       */
      instance.wsServer.handle(RPC_CHANNELS.server.RESTART, async (ctx) => {
        mainLog.info(`[server-mode] restart requested by client ${ctx.clientId}`)
        setTimeout(() => {
          app.relaunch()
          app.exit(0)
        }, 250)
        return { ok: true }
      })

      // TLS enforcement — warn when server mode binds to a network address without TLS
      // Mirrors the hard guard in packages/server/src/index.ts but warns instead of blocking,
      // since the user explicitly enabled server mode via UI (may be on a trusted LAN).
      const isInsecureBind = serverModeEnabled && !tls
        && !['127.0.0.1', 'localhost', '::1'].includes(rpcHost)
      if (isInsecureBind) {
        mainLog.warn(
          '[server-mode] WARNING: Listening on a network address without TLS. ' +
          'Auth tokens will be sent in cleartext. ' +
          'Configure TLS certificates in Settings > Server.'
        )
      }

      // Wire EventSink to Electron-specific services
      // Must happen BEFORE createInitialWindows() so event handlers use WS from the start
      windowManager.setRpcEventSink(moduleSink!, resolveClientId)
      const { setMenuEventSink } = await import('./menu')
      setMenuEventSink(moduleSink!, resolveClientId)
      const { setNotificationEventSink } = await import('./notifications')
      setNotificationEventSink(moduleSink!, resolveClientId)

      // Headless: print connection details
      if (isHeadless) {
        console.log(`CRAFT_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
        console.log(`CRAFT_SERVER_TOKEN=${instance.token}`)
      }
    }

    // -----------------------------------------------------------------------
    // Remote connections (per window)
    // -----------------------------------------------------------------------
    // Direct IPC (not WS RPC): these describe *this machine's* configuration and this window's
    // connection, so they must work even when the window's WS connection points at another hub.
    ipcMain.handle('client-mode:get', async (event) => {
      const { getServerConfig } = await import('@craft-agent/shared/config')
      const config = getClientConfig()
      return {
        connections: config.connections,
        // What **this window** is connected to — not an install-wide mode.
        running: windowManager?.getRemoteForWindow(event.sender.id) ?? null,
        serverEnabled: getServerConfig().enabled,
      }
    })

    // Saving a server is what makes this machine a device for it — with or without a window open.
    ipcMain.handle('client-mode:save-connection', async (_event, raw: unknown) => {
      const input = (raw ?? {}) as Partial<RemoteConnection>
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      const token = typeof input.token === 'string' ? input.token.trim() : ''
      if (!url) throw new Error('Server URL is required')
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error('Server URL is not a valid URL')
      }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        throw new Error('Server URL must start with ws:// or wss://')
      }
      // Plain ws:// to another machine is a real setup (LAN, VPN, SSH tunnel, container
      // network), and the hub itself supports running without TLS. The choice is the
      // person's; the dialog warns, this does not refuse.
      if (!token) throw new Error('Token is required')

      // Folders this server may reach on this machine. The dialog picks local paths; this is the
      // process that owns the device link, so it refuses anything that is not absolute here.
      let allowedRoots: string[] | undefined
      if (input.allowedRoots !== undefined) {
        if (!Array.isArray(input.allowedRoots)) {
          throw new Error('Allowed folders must be a list of paths')
        }
        allowedRoots = input.allowedRoots.map((root) => {
          if (typeof root !== 'string' || !root.trim()) {
            throw new Error('Allowed folder paths must not be empty')
          }
          if (!isAbsolute(root.trim())) {
            throw new Error(`Allowed folder must be an absolute path: ${root}`)
          }
          return root.trim()
        })
      }

      const existing = typeof input.id === 'string' ? getRemoteConnection(input.id) : null
      const saved = saveRemoteConnection({
        id: existing?.id ?? randomUUID(),
        name: (typeof input.name === 'string' && input.name.trim()) || connectionNameFromUrl(url),
        url,
        token,
        ...(existing?.lastWorkspaceId ? { lastWorkspaceId: existing.lastWorkspaceId } : {}),
        ...(allowedRoots !== undefined ? { allowedRoots } : {}),
        // The client-side switch that lets this server use this machine. Omitted keeps it as saved.
        ...(typeof input.deviceUseEnabled === 'boolean'
          ? { deviceUseEnabled: input.deviceUseEnabled }
          : {}),
      })
      trustServerOrigin(saved.url)
      syncHubConnections(getRemoteConnections(), {
        identity: clientIdentity,
        browserPaneManager: () => browserPaneManager,
      computerUseManager: () => computerUseManager,
      })

      // Windows opened before the edit hold the target they loaded with. Hand them the new one
      // and let each preload rebuild its socket — otherwise a rotated token would only take
      // effect the next time that window was opened.
      const changed = !!existing && (
        existing.url !== saved.url || existing.token !== saved.token || existing.name !== saved.name
      )
      if (changed) {
        const affected = windowManager?.updateRemoteTargetForConnection(saved.id, saved) ?? []
        for (const webContentsId of affected) {
          const target = windowManager?.getRemoteForWindow(webContentsId)
          if (target) windowManager?.getWindowByWebContentsId(webContentsId)?.webContents.send('client-mode:target-changed', target)
        }
      }
      return saved
    })

    ipcMain.handle('client-mode:remove-connection', async (_event, connectionId: string) => {
      removeRemoteConnection(connectionId)
      syncHubConnections(getRemoteConnections(), {
        identity: clientIdentity,
        browserPaneManager: () => browserPaneManager,
      computerUseManager: () => computerUseManager,
      })
    })

    /**
     * Refuse to open a window on a pairing whose credential may never open one.
     *
     * A new window has no handshake to fail fast: it would come up only to show the hub's refusal
     * in the window itself. The app-level link is already handshaken and its scope is kept current,
     * so the answer is known before a window exists. An unknown scope (link down) is not a refusal:
     * the window may then show its own reconnect screen, which is what an offline server deserves.
     */
    const assertWindowAllowed = (connectionId: string) => {
      if (getHubConnectionClient(connectionId)?.getTokenScope() === 'device') {
        throw new Error('This server does not allow remote control for this credential.')
      }
    }

    /** Open a window on a saved server. */
    ipcMain.handle('client-mode:connect', async (_event, connectionId: string, workspaceId?: string) => {
      const connection = getRemoteConnection(connectionId)
      if (!connection) throw new Error('Unknown remote connection')
      assertWindowAllowed(connectionId)
      const target = remoteTarget(connection, workspaceId)
      trustServerOrigin(target.url)
      // A workspace opened here is the one that server should offer next time — including one
      // just created on it, which is how "create on server" hands over to the new window.
      if (workspaceId) rememberRemoteWorkspace(connectionId, workspaceId)
      openRemoteWindow(target)
    })

    /**
     * Open **another** window on the hub this window is on. `workspaceId` names the workspace,
     * and without it this window's own is used (the hub shows its picker when there is none).
     * Switching the current window is `client-mode:switch-workspace`.
     */
    ipcMain.handle('client-mode:open-window', async (event, workspaceId?: string) => {
      const current = windowManager?.getRemoteForWindow(event.sender.id) ?? null
      const connection = current ? getRemoteConnection(current.connectionId) : null
      if (!current || !connection) throw new Error('This window is not connected to a remote server')
      assertWindowAllowed(connection.id)
      const target = remoteTarget(connection, workspaceId ?? current.workspaceId)
      trustServerOrigin(target.url)
      openRemoteWindow(target)
    })

    /** Open a window on this machine's own server. */
    ipcMain.handle('client-mode:open-local', async () => {
      openLocalWindow()
    })

    /**
     * Let a remote window name itself (`<workspace> — <server>`).
     *
     * Its workspace is on the hub, so the main process's title rule — which looks the workspace up
     * in this machine's config — cannot name it. The renderer can, and a title is worth keeping.
     */
    ipcMain.handle('window:set-title', async (event, title: string | null) => {
      windowManager?.setWindowTitle(event.sender.id, typeof title === 'string' ? title : null)
    })

    /** Reachability of every saved server, for the saved-servers list. */
    ipcMain.handle('client-mode:remote-status', async () => {
      return getRemoteConnections().map((connection) => ({
        id: connection.id,
        status: getHubConnectionStatus(connection.id) ?? 'unknown',
        // A device-only credential can lend this machine but never open a window here.
        scope: getHubConnectionClient(connection.id)?.getTokenScope() ?? null,
      }))
    })

    /**
     * Re-point **this** remote window at another workspace on its hub — an in-window switch,
     * the way a remote folder is re-opened in VS Code. The socket is the preload's to rebuild;
     * main only keeps the window's record in step, so launch restores the workspace actually on
     * screen and `client-mode:get` reports it.
     */
    ipcMain.handle('client-mode:switch-workspace', async (event, workspaceId: string) => {
      if (!workspaceId) throw new Error('A workspace is required')
      const remote = windowManager?.getRemoteForWindow(event.sender.id)
      if (remote) {
        windowManager?.setRemoteWorkspaceForWindow(event.sender.id, workspaceId)
        rememberRemoteWorkspace(remote.connectionId, workspaceId)
      } else {
        // A local window told main where it is; the transport side already moved with it.
        windowManager?.updateWindowWorkspace(event.sender.id, workspaceId)
      }
      captureAndSaveWindowState('window-change')
    })

    /**
     * Resolve where a switch would go — **without moving anything**.
     *
     * The preload connects and handshakes before committing, so this is the read half: validate
     * the workspace on that server (a pick from a menu fetched a moment ago can name one removed
     * since) and hand back the target to dial. A refused resolve leaves the window untouched,
     * which is what VS Code does for a folder that no longer exists.
     */
    ipcMain.handle('client-mode:resolve-switch', async (_event, connectionId: string, workspaceId?: string) => {
      const connection = getRemoteConnection(connectionId)
      if (!connection) throw new Error('Unknown remote connection')
      if (workspaceId) {
        const ids = await workspaceIdsOn(connectionId)
        if (ids && !ids.has(workspaceId)) {
          throw new Error(`That workspace no longer exists on ${connection.name}`)
        }
      }
      const target = remoteTarget(connection, workspaceId)
      trustServerOrigin(target.url)
      return target
    })

    /**
     * File an already-reached target as **this** window's, and persist that.
     *
     * Called by the preload *after* its new socket has handshaken, so a server that never answers
     * leaves both the window record and the saved state alone. Nothing else moves: the server
     * being left keeps its own app-level link (other windows on it, and its device capabilities,
     * are untouched), and the server being joined already has one.
     */
    ipcMain.handle('client-mode:switch-server', async (event, connectionId: string, workspaceId?: string) => {
      const connection = getRemoteConnection(connectionId)
      if (!connection) throw new Error('Unknown remote connection')
      const target = remoteTarget(connection, workspaceId)
      trustServerOrigin(target.url)
      const applied = windowManager?.switchWindowServer(event.sender.id, target) ?? null
      if (!applied) throw new Error('This window is unknown to the app')
      if (workspaceId) rememberRemoteWorkspace(connectionId, workspaceId)
      captureAndSaveWindowState('window-change')
      return applied
    })

    /**
     * Bring **this** window back to this machine's server, in place.
     *
     * The workspace is validated here because the window is about to answer for it in this
     * machine's config. The preload then releases the hub socket and routes through the local one,
     * which it has kept open all along.
     */
    ipcMain.handle('client-mode:switch-local', async (event, workspaceId: string) => {
      if (!workspaceId) throw new Error('A workspace is required')
      if (!getWorkspaceByNameOrId(workspaceId)) throw new Error('Unknown workspace')
      const released = windowManager?.switchWindowToLocal(event.sender.id, workspaceId) ?? false
      if (!released) throw new Error('This window is not connected to a remote server')
      // Same reason as switch-server: the saved mode must follow the window, so a restart does
      // not bring back a remote window the person had already taken back to this machine.
      captureAndSaveWindowState('window-change')
    })

    /**
     * Fetch a hub-produced export and put it where the person asks.
     *
     * The renderer never sees the hub token: the download happens here, with the credential this
     * window already holds, and the file streams straight to the chosen path.
     */
    ipcMain.handle('design-export:save', async (event, download: { id?: unknown; name?: unknown }) => {
      const id = typeof download?.id === 'string' ? download.id : ''
      const name = typeof download?.name === 'string' && download.name ? download.name : 'design-export'
      if (!id) throw new Error('Missing export id')

      const hub = hubHttpForWindow(event.sender.id)
      if (!hub) throw new Error('This window is not connected to a hub')

      const win = BrowserWindow.fromWebContents(event.sender)
      const picked = win
        ? await dialog.showSaveDialog(win, { defaultPath: name })
        : await dialog.showSaveDialog({ defaultPath: name })
      if (picked.canceled || !picked.filePath) return { canceled: true }

      const response = await net.fetch(`${hub.baseUrl}/api/exports/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${hub.token}` },
      })
      if (!response.ok || !response.body) {
        throw new Error(`Export download failed (${response.status})`)
      }
      await pipeline(Readable.fromWeb(response.body as any), createWriteStream(picked.filePath))
      shell.showItemInFolder(picked.filePath)
      return { canceled: false, path: picked.filePath }
    })

    ipcMain.handle('client-mode:test', async (_event, serverUrl: string, token: string) => {
      const { connectToRemote } = await import('./handlers/workspace')
      // A probe: it validates the address and the credential, and is answered with the token's
      // scope. It never claims a device slot — that happens on the saved connection's first real
      // handshake, which also carries device access and the allowed folders.
      const { client, error } = await connectToRemote(serverUrl, token, undefined, {
        clientInfo: { ...clientIdentity(), probe: true },
      })
      if (!client) return { ok: false, error: error ?? 'Connection failed' }
      try {
        return {
          ok: true,
          serverVersion: client.getServerVersion() ?? undefined,
          scope: client.getTokenScope() ?? undefined,
        }
      } finally {
        client.destroy()
      }
    })

    /**
     * Workspace creation can target a **saved server this window is not on** — the two-level
     * "host, then folder" the person picks in the dialog. These run on that server's app-level
     * link, never on this window's client, and are deliberately one channel each rather than a
     * generic proxy: the renderer can browse and create, nothing else.
     */
    const hubClientFor = (connectionId: string) => {
      if (!connectionId || !getRemoteConnection(connectionId)) throw new Error('Unknown remote connection')
      const client = getHubConnectionClient(connectionId)
      if (!client) throw new Error('This server is not connected')
      return client
    }

    ipcMain.handle('client-mode:remote-list-directory', async (_event, connectionId: string, dirPath: string, options?: { includeFiles?: boolean }) => {
      return await hubClientFor(connectionId).invoke(RPC_CHANNELS.fs.LIST_DIRECTORY, dirPath, options)
    })

    ipcMain.handle('client-mode:remote-home-dir', async (_event, connectionId: string) => {
      return await hubClientFor(connectionId).invoke(RPC_CHANNELS.server.HOME_DIR)
    })

    /** The workspaces a saved server has, for the workspace dropdown's remote section. */
    ipcMain.handle('client-mode:remote-workspaces', async (_event, connectionId: string) => {
      const client = hubClientFor(connectionId)
      try {
        return { workspaces: await client.invoke(RPC_CHANNELS.server.GET_WORKSPACES), denied: false }
      } catch (error) {
        // A live link that refuses the read is not an unreachable server: its credential may only
        // lend this machine, so the hub allows it to serve device calls and nothing else.
        if ((error as { code?: string } | null)?.code === 'SCOPE_FORBIDDEN') {
          return { workspaces: [], denied: true }
        }
        throw error
      }
    })

    ipcMain.handle('client-mode:remote-check-slug', async (_event, connectionId: string, slug: string) => {
      return await hubClientFor(connectionId).invoke(RPC_CHANNELS.workspaces.CHECK_SLUG, slug)
    })

    ipcMain.handle('client-mode:remote-create-workspace', async (_event, connectionId: string, folderPath: string, name: string) => {
      return await hubClientFor(connectionId).invoke(RPC_CHANNELS.workspaces.CREATE, folderPath, name)
    })

    // App relaunch — needed in both modes (server config changes, client mode changes)
    ipcMain.handle('app:relaunch', () => {
      app.relaunch()
      app.exit(0)
    })

    // Create initial windows (restores from saved state or opens first workspace)
    // In headless mode the server runs without any UI — skip window creation.
    if (!isHeadless) {
      await createInitialWindows()
    }

    // Run credential health check at startup to detect issues early
    // (corruption, machine migration, missing credentials for default connection).
    // The local runtime always exists now, even when a window is on another hub.
    try {
      const { getCredentialManager } = await import('@craft-agent/shared/credentials')
      const credentialManager = getCredentialManager()
      const health = await credentialManager.checkHealth()
      if (!health.healthy) {
        mainLog.warn('Credential health check failed:', health.issues)
        // Issues will be displayed in Settings → AI when user navigates there
      }
    } catch (err) {
      mainLog.error('Credential health check error:', err)
    }

    // Initialize power manager (loads setting, must happen after config is available)
    // Non-critical — powerSaveBlocker may not work on headless/xvfb setups
    try {
      const { initPowerManager } = await import('./power-manager')
      await initPowerManager()
    } catch (err) {
      mainLog.warn('[power] Power manager init failed (non-critical):', err instanceof Error ? err.message : err)
    }

    // Set Sentry context tags for error grouping (no PII — just config classification).
    // Runs after init so config and auth state are available.
    // Derives values from the default LLM connection instead of legacy config fields.
    try {
      const { getLlmConnection, getDefaultLlmConnection } = await import('@craft-agent/shared/config')
      const workspaces = getWorkspaces()
      const defaultConnSlug = getDefaultLlmConnection()
      const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null
      Sentry.setTag('authType', defaultConn?.authType ?? 'unknown')
      Sentry.setTag('providerType', defaultConn?.providerType ?? 'unknown')
      Sentry.setTag('hasCustomEndpoint', String(!!defaultConn?.baseUrl))
      Sentry.setTag('model', defaultConn?.defaultModel ?? 'default')
      Sentry.setTag('workspaceCount', String(workspaces.length))
    } catch (err) {
      mainLog.warn('Failed to set Sentry context tags:', err)
    }

    // Initialize auto-update (check immediately on launch)
    // Skip in dev mode to avoid replacing /Applications app and launching it instead
    if (moduleSink) setAutoUpdateEventSink(moduleSink)
    // Snapshot multi-window state BEFORE quitAndInstall. electron-updater
    // (Squirrel.Mac) destroys BrowserWindows between quitAndInstall and
    // before-quit firing; saving from before-quit alone would overwrite
    // window-state.json with an empty array.
    setBeforeUpdateQuitHook(() => captureAndSaveWindowState('pre-update'))
    // Before the installer hands off, run the full quit cleanup and mark the app
    // as quitting so before-quit's guard returns early instead of cancelling
    // Squirrel.Mac's quit with preventDefault (#891).
    setBeforeUpdateInstallHook(async () => {
      isQuitting = true
      windowManager?.setAppQuitting(true)
      await performQuitCleanup()
    })
    // If quitAndInstall throws after the cleanup above already ran, the process
    // is a zombie: sessions flushed but no watchers/messaging/lock, and isQuitting
    // makes the next quit skip the flush. The only honest recovery is a controlled
    // relaunch into a fresh process (#891).
    setInstallQuitFailedHook(() => {
      mainLog.error('[auto-update] quitAndInstall failed after cleanup — relaunching')
      dialog.showMessageBoxSync({
        type: 'error',
        title: 'Update failed',
        message: 'The update could not be installed.',
        detail: 'Craft Agents will restart now. The update will be retried on the next launch.',
      })
      app.relaunch()
      app.exit(0)
    })
    if (app.isPackaged) {
      checkForUpdatesOnLaunch().catch(err => {
        mainLog.error('[auto-update] Launch check failed:', err)
      })
    } else {
      mainLog.info('[auto-update] Skipping auto-update in dev mode')
    }

    // Process pending deep link from cold start
    if (pendingDeepLink) {
      mainLog.info('Processing pending deep link:', pendingDeepLink)
      await handleDeepLink(pendingDeepLink, windowManager, moduleSink ?? undefined, moduleClientResolver ?? undefined)
      pendingDeepLink = null
    }

    mainLog.info('App initialized successfully')
    if (isDebugMode) {
      mainLog.info('Debug mode enabled - logs at:', getLogFilePath())
    }
    mainLog.info('Messaging gateway log path:', getMessagingGatewayLogFilePath())
  } catch (error) {
    mainLog.error('Failed to initialize app:', error instanceof Error ? error.message : error, (error as any)?.stack)
    // Continue anyway - the app will show errors in the UI
  }

  // macOS: clicking the dock icon brings the app back. A window that was put away
  // (hidden) is shown again, and one is made if none exists — what the tray does.
  app.on('activate', () => {
    if (!windowManager) return
    const workspaceId = windowManager.getLastActiveWorkspaceId() ?? getWorkspaces()[0]?.id
    if (workspaceId) windowManager.raiseOrCreateWindow(workspaceId)
  })
})

// Whether the app stays alive between windows (set at startup, see below).
let residentMode = false

// Closing every window does not quit the app **where it is resident**: it lives in
// the tray, and a close only puts a window away (see the `close` handler in
// window-manager). Quitting is then an explicit action — the tray's Quit, or
// Cmd/Ctrl+Q. Where the app is not resident, the old behavior stands. Subscribing at
// all is required either way: it stops Electron's default "quit when the last window
// closes" on Windows/Linux from running behind our back.
app.on('window-all-closed', () => {
  if (residentMode) return
  if (process.env.CRAFT_HEADLESS) return
  app.quit()
})

// Track if we're in the process of quitting (to avoid re-entry)
let isQuitting = false

/**
 * Capture the current multi-window state and persist it to disk.
 * Called from three sites:
 *   - before-quit (normal quit path, reason='before-quit')
 *   - installUpdate hook (auto-update path, reason='pre-update'), because
 *     electron-updater destroys BrowserWindows between quitAndInstall and
 *     before-quit firing — by the time before-quit runs, getWindowStates()
 *     returns an empty array and would clobber the on-disk state.
 *   - a window changing where it points (reason='window-change'), so the mode on
 *     disk is the mode on screen even if the process never reaches before-quit.
 * Returns the number of windows saved, or -1 if windowManager isn't ready.
 */
function captureAndSaveWindowState(reason: 'before-quit' | 'pre-update' | 'window-change'): number {
  if (!windowManager) return -1
  const windows = windowManager.getWindowStates()
  const focusedWindow = BrowserWindow.getFocusedWindow()
  // A switch can be triggered from an unfocused window (a dialog, a tray activation); falling
  // back keeps the previous answer instead of blanking the stacking preference.
  const lastFocusedWorkspaceId = focusedWindow
    ? windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
    : windowManager.getLastActiveWorkspaceId() ?? undefined
  saveWindowState({ windows, lastFocusedWorkspaceId })
  mainLog.info('[window-state] saved', { windowCount: windows.length, reason })
  return windows.length
}

// Flush sessions and release all quit-time resources. Shared by the normal quit
// path (before-quit) and the update-install handoff (beforeUpdateInstallHook), so
// the two cleanup sequences can't drift (#891).
let quitCleanupRan = false
async function performQuitCleanup(): Promise<void> {
  // Idempotent: a failed update install may retry, and the update path plus a
  // subsequent quit must not dispose already-disposed services.
  if (quitCleanupRan) {
    mainLog.info('Quit cleanup already ran, skipping')
    return
  }
  quitCleanupRan = true

  if (sessionManager) {
    try {
      await sessionManager.flushAllSessions()
      mainLog.info('Flushed all pending session writes')
    } catch (error) {
      mainLog.error('Failed to flush sessions:', error)
    }
    // Clean up SessionManager resources (file watchers, timers, etc.)
    sessionManager.cleanup()
  }

  // Clean up browser pane instances (each one remembers its pages as it is destroyed)
  if (browserPaneManager) {
    browserPaneManager.destroyAll()
  }

  // Close the app-level hub link (window connections die with their windows)
  stopHubConnections()

  // Take the tray icon down (Windows leaves it behind until the mouse passes over it otherwise)
  destroyTray()

  // Clean up OAuth flow store (stop periodic cleanup timer)
  if (oauthFlowStore) {
    oauthFlowStore.dispose()
  }

  // Stop all model refresh timers
  getModelRefreshService().stopAll()

  // Stop messaging gateways so the WhatsApp worker subprocess exits cleanly.
  if (messagingHandle) {
    try {
      await messagingHandle.dispose()
    } catch (err) {
      mainLog.error('[messaging] dispose failed:', err)
    }
  }

  // Clean up power manager (release power blocker)
  const { cleanup: cleanupPowerManager } = await import('./power-manager')
  cleanupPowerManager()

  // Release the server lock file so the next launch doesn't see a stale PID.
  releaseServerLock()
}

// Save window state and clean up resources before quitting
app.on('before-quit', async (event) => {
  // Avoid re-entry when we call app.exit()
  if (isQuitting) return
  isQuitting = true

  // Ensure Cmd+Q/app quit bypasses layered window close interception (Cmd+W behavior).
  windowManager?.setAppQuitting(true)

  if (windowManager) {
    const windows = windowManager.getWindowStates()
    // Empty-snapshot guard: during update-quit, electron-updater has already
    // destroyed all BrowserWindows by the time before-quit fires. The pre-update
    // hook already saved the real state — don't let this late save overwrite it.
    if (windows.length === 0 && isUpdating()) {
      mainLog.warn('[window-state] skip save: empty snapshot during update-quit (pre-update snapshot wins)')
    } else {
      captureAndSaveWindowState('before-quit')
    }
    // Diagnostic correlation with installUpdate's [update-flow] log. During an
    // update-quit, record it to the dedicated always-on auto-update log (#891)
    // so the install/quit handoff is diagnosable in production; normal quits
    // stay on the debug-only main log.
    const isUpdateQuit = isUpdating()
    const beforeQuitSave = {
      windowCount: windows.length,
      electronWindowCount: BrowserWindow.getAllWindows().length,
      isUpdating: isUpdateQuit,
      reason: isUpdateQuit ? 'update-quit' : 'user-quit',
    }
    if (isUpdateQuit) {
      autoUpdateLog.info('before-quit save', beforeQuitSave)
    } else {
      mainLog.info('[update-flow] before-quit save', beforeQuitSave)
    }
  }

  // Normal quit: flush + clean up, then exit. The update-install path does NOT
  // reach here — installUpdate's beforeUpdateInstallHook already ran
  // performQuitCleanup and set isQuitting, so the guard at the top returns early
  // and Squirrel.Mac's quit proceeds uninterrupted so the update installs (#891).
  if (sessionManager) {
    event.preventDefault()
    await performQuitCleanup()
    app.exit(0)
  }
})

// Handle uncaught exceptions — forward to Sentry explicitly since registering
// a custom handler can interfere with @sentry/electron's automatic capture.
process.on('uncaughtException', (error) => {
  mainLog.error('Uncaught exception:', error)
  Sentry.captureException(error)
})

process.on('unhandledRejection', (reason, promise) => {
  mainLog.error('Unhandled rejection at:', promise, 'reason:', reason)
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)))
})
