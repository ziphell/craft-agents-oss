/**
 * WS-mode preload — replaces the full IPC preload (index.ts).
 *
 * Every window keeps a client for this machine's own server. Window-local channels
 * (theme, window controls, local settings, dialogs) always go there.
 *
 * Local window:
 *   Routes REMOTE_ELIGIBLE channels to this machine's server. Workspace switches change what
 *   the connection speaks for; the client stays the local one.
 *
 * Remote window (Connect to Server…):
 *   Its workspace belongs to a hub, so REMOTE_ELIGIBLE channels go to a client bound to that
 *   hub. An in-window workspace switch rebuilds that hub client for the new workspace — the way
 *   a remote folder is re-opened in VS Code. "Open in new window" still opens another window.
 *
 * On localhost the WS handshake completes in <1ms. The React app takes >100ms
 * to initialise, so by the time any component calls an API method, the
 * connection is established.
 */

import '@sentry/electron/preload'
import { hostname } from 'os'
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
import { WsRpcClient, type TransportConnectionState } from '../transport/client'
import { RoutedClient } from '../transport/routed-client'
import { buildClientApi } from '../transport/build-api'
import { CHANNEL_MAP } from '../transport/channel-map'
import { createCallbackServer } from '@craft-agent/shared/auth/callback-server'
import { CHATGPT_OAUTH_CONFIG } from '@craft-agent/shared/auth/chatgpt-oauth-config'
import {
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_SAVE_FILE_DIALOG,
} from '@craft-agent/server-core/transport'
import type { ConfirmDialogSpec, FileDialogSpec, SaveDialogSpec } from '@craft-agent/server-core/transport'
import type { RpcClient } from '@craft-agent/server-core/transport'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { ElectronAPI } from '../shared/types'

// ---------------------------------------------------------------------------
// Client interface — common surface for both RoutedClient and WsRpcClient
// ---------------------------------------------------------------------------

interface TransportClient extends RpcClient {
  isChannelAvailable(channel: string): boolean
  getConnectionState(): TransportConnectionState
  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectNow(): void
}

// ---------------------------------------------------------------------------
// Connection setup
// ---------------------------------------------------------------------------

const webContentsId: number = ipcRenderer.sendSync('__get-web-contents-id')

/**
 * The hub **this window** is connected to, resolved by the main process (Connect to Server…).
 *
 * Mutable: a window can move between this machine and a hub, and between hubs, without reloading,
 * so the target is whatever main resolved last (`client-mode:switch-server` / `switch-local`).
 */
interface ResolvedWindowTarget {
  url: string
  token: string
  workspaceId?: string
  name?: string
}
let windowTarget = ipcRenderer.sendSync('__get-client-mode') as ResolvedWindowTarget | null

/** Shown in the hub's connected-client list and used to name this device. */
interface ClientIdentity {
  deviceId: string
  name: string
  platform: string
  /** App version advertised for diagnostics; the hub never gates on it. */
  version?: string
  allowedRoots: string[]
  /** Where this install keeps `<base>/<hub device id>/<workspace id>` working directories. */
  hubRootBase?: string
}
const clientIdentity = (ipcRenderer.sendSync('__get-client-identity') as ClientIdentity | null)
  ?? { deviceId: '', name: hostname(), platform: process.platform, allowedRoots: [] }

const wsPort: number = ipcRenderer.sendSync('__get-ws-port')
const wsToken: string = ipcRenderer.sendSync('__get-ws-token')
const windowWorkspaceId: string = ipcRenderer.sendSync('__get-workspace-id')

let client: TransportClient

/**
 * What every window's connections advertise.
 *
 * Device capabilities (shell, files, browser) belong to the app-level links in
 * `main/hub-connection.ts`, one per saved server: a hub reaches this machine once, not once per
 * window. A window advertises only what a window can answer — open a URL, reveal a file, show a
 * native dialog.
 */
const WINDOW_CAPABILITIES = [
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_SAVE_FILE_DIALOG,
] as const

/**
 * Every window keeps a client for this machine's own server: window-local channels (theme,
 * window controls, local settings, dialogs) always run here, even when the window's work happens
 * on another hub. This is what lets a local window and a remote window coexist in one process.
 */
const localClient = new WsRpcClient(`ws://127.0.0.1:${wsPort}`, {
  token: wsToken,
  workspaceId: windowWorkspaceId,
  webContentsId,
  autoReconnect: true,
  mode: 'local',
  clientCapabilities: [...WINDOW_CAPABILITIES],
  clientInfo: { ...clientIdentity, role: 'window' },
})

let workspaceClient: WsRpcClient = localClient
/** The hub workspace this window currently speaks for (remote windows only). */
let remoteWorkspaceId: string | undefined

if (windowTarget) {
  // ── Remote window ──────────────────────────────────────────────────────
  // This window's work happens on the hub named by its target. LOCAL_ONLY channels still go to
  // the local server above; everything else goes here. The URL was accepted by the person
  // (the dialog warns about plain ws://), so it is used as given.
  workspaceClient = new WsRpcClient(windowTarget.url, {
    token: windowTarget.token,
    // The target's workspace wins; empty lets the hub show its picker.
    workspaceId: windowTarget.workspaceId || windowWorkspaceId || undefined,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...WINDOW_CAPABILITIES],
    clientInfo: { ...clientIdentity, role: 'window' },
    // The URL came from the person, so a hub with a self-signed certificate is accepted — the
    // same policy the app-level device links use.
    tlsRejectUnauthorized: false,
  })
  remoteWorkspaceId = windowTarget.workspaceId || windowWorkspaceId || undefined
  workspaceClient.connect()
}

const routedClient = new RoutedClient(localClient, workspaceClient)

localClient.connect()
client = routedClient

// ---------------------------------------------------------------------------
// Register client-side capability handlers (server can invoke these)
// ---------------------------------------------------------------------------

client.handleCapability(CLIENT_OPEN_EXTERNAL, (url: string) => shell.openExternal(url))

client.handleCapability(CLIENT_OPEN_PATH, async (path: string) => {
  const error = await shell.openPath(path)
  return { error: error || undefined }
})

client.handleCapability(CLIENT_SHOW_IN_FOLDER, (path: string) => {
  shell.showItemInFolder(path)
})

client.handleCapability(CLIENT_CONFIRM_DIALOG, async (spec: ConfirmDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showMessageBox', spec)
})

client.handleCapability(CLIENT_OPEN_FILE_DIALOG, async (spec: FileDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showOpenDialog', spec)
})

client.handleCapability(CLIENT_SAVE_FILE_DIALOG, async (spec: SaveDialogSpec) => {
  return await ipcRenderer.invoke('__dialog:showSaveDialog', spec)
})

// Device capabilities (shell, files, browser) are **not** advertised by windows: they belong to
// the app-level links in `main/hub-connection.ts`, one per saved server, so a hub has one device
// to call rather than a copy per window. A window only answers what a window can (dialogs, shell
// shortcuts), which is what `WINDOW_CAPABILITIES` above contains.

// ---------------------------------------------------------------------------
// Build ElectronAPI proxy
// ---------------------------------------------------------------------------

const api = buildClientApi(client, CHANNEL_MAP, (ch) => client.isChannelAvailable(ch))

;(api as any).getRuntimeEnvironment = (): 'electron' | 'web' => 'electron'

// A window on a hub lists **the hub's** workspaces; a local one lists this machine's. Read from
// the current target, not from the one this window was created with — a window can move between
// the two without reloading.
;(api as ElectronAPI).getWorkspaces = () =>
  (windowTarget
    ? routedClient.invoke(RPC_CHANNELS.server.GET_WORKSPACES)
    : routedClient.invoke(RPC_CHANNELS.workspaces.GET)) as ReturnType<ElectronAPI['getWorkspaces']>

/**
 * A workspace switch also changes what this window's **own-server** connection speaks for.
 *
 * The server records the new workspace, but the client's handshake still carries the old one, so
 * a reconnect would present the workspace this window was opened on — failing the server's
 * identity check and coming back as a different client on the old workspace.
 */
;(api as ElectronAPI).switchWorkspace = async (workspaceId: string) => {
  await routedClient.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, workspaceId)
  localClient.setWorkspace(workspaceId)
  // Main keeps this window's record (and the saved window state) in step; a local switch has no
  // transport swap to tell it otherwise.
  await ipcRenderer.invoke('client-mode:switch-workspace', workspaceId).catch(() => {})
}

/**
 * Desktop control is a switch about **this machine**, so main has to hear it too: a held lease
 * must be released the moment the person turns it off, and the device link must stop advertising
 * `computer`. The preference itself is stored by the server the window is talking to, like every
 * other tool setting. A remote window edits the hub's policy, so it does not touch this machine.
 */
;(api as ElectronAPI).setComputerUseEnabled = async (enabled: boolean) => {
  await client.invoke(RPC_CHANNELS.tools.SET_COMPUTER_USE_ENABLED, enabled)
  if (!windowTarget) {
    await ipcRenderer.invoke('computer-use:set-enabled', enabled).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Transport connection state logging (for remote connections)
// ---------------------------------------------------------------------------

function formatTransportReason(state: TransportConnectionState): string {
  const err = state.lastError
  if (err) {
    const codePart = err.code ? ` [${err.code}]` : ''
    return `${err.kind}${codePart}: ${err.message}`
  }

  if (state.lastClose?.code != null) {
    const reason = state.lastClose.reason ? ` (${state.lastClose.reason})` : ''
    return `close ${state.lastClose.code}${reason}`
  }

  return 'no additional details'
}

// Log remote connection state changes to main process (visible in terminal + main.log).
// Activates whenever the workspace connection is remote (a remote window).
client.onConnectionStateChanged((state) => {
  if (state.mode !== 'remote') return

  const emitToMain = (level: 'info' | 'warn' | 'error', message: string) => {
    ipcRenderer.send('__transport:status', {
      level,
      message,
      status: state.status,
      attempt: state.attempt,
      nextRetryInMs: state.nextRetryInMs,
      error: state.lastError,
      close: state.lastClose,
      url: state.url,
    })
  }

  if (state.status === 'connected') {
    const message = `[transport] connected to ${state.url}`
    console.info(message)
    emitToMain('info', message)
    return
  }

  if (state.status === 'reconnecting') {
    const retry = state.nextRetryInMs != null ? ` retry in ${state.nextRetryInMs}ms` : ''
    const message = `[transport] reconnecting (attempt ${state.attempt})${retry} — ${formatTransportReason(state)}`
    console.warn(message)
    emitToMain('warn', message)
    return
  }

  if (state.status === 'failed' || state.status === 'disconnected') {
    const message = `[transport] ${state.status} — ${formatTransportReason(state)}`
    console.error(message)
    emitToMain('error', message)
  }
})

// ---------------------------------------------------------------------------
// Transport state API (exposed to renderer)
// ---------------------------------------------------------------------------

;(api as any).getTransportConnectionState = async () => client.getConnectionState()
;(api as any).onTransportConnectionStateChanged = (callback: (state: TransportConnectionState) => void) => {
  return client.onConnectionStateChanged(callback)
}
;(api as any).reconnectTransport = async () => {
  client.reconnectNow()
}

// ── performOAuth ─────────────────────────────────────────────────────────
// Multi-step orchestration: callback server (local) → oauth:start (server) →
// open browser → wait for callback → oauth:complete (server).
// Runs client-side because the callback server must receive the redirect.
;(api as any).performOAuth = async (args: {
  sourceSlug: string
  sessionId?: string
  authRequestId?: string
}): Promise<{ success: boolean; error?: string; email?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. Start local callback server to receive OAuth redirect
    callbackServer = await createCallbackServer({ appType: 'electron' })
    const callbackUrl = `${callbackServer.url}/callback`

    // 2. Ask server to prepare the flow (PKCE, auth URL, store in flow store)
    const startResult = await client.invoke('oauth:start', {
      sourceSlug: args.sourceSlug,
      callbackUrl,
      sessionId: args.sessionId,
      authRequestId: args.authRequestId,
    })
    flowId = startResult.flowId
    state = startResult.state

    // 3. Open browser for user consent (local — must open on the user's machine, not remote server)
    await shell.openExternal(startResult.authUrl)

    // 4. Wait for OAuth provider to redirect to our callback server
    const callback = await callbackServer.promise

    // 5. Check for errors from the provider
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('oauth:cancel', { flowId, state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke('oauth:cancel', { flowId, state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. Send code to server for token exchange + credential storage
    const result = await client.invoke('oauth:complete', { flowId, code, state })
    return { success: result.success, error: result.error, email: result.email }
  } catch (err) {
    // Clean up server-side flow on error
    if (flowId && state) {
      client.invoke('oauth:cancel', { flowId, state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

// ── startClaudeOAuth ─────────────────────────────────────────────────────
// Override the channel-map stub: the server now returns authUrl without opening
// the browser. We open it locally so it works in remote mode.
// Claude OAuth is two-step: browser opens → user copies code → pastes in UI.
;(api as any).startClaudeOAuth = async (): Promise<{
  success: boolean
  authUrl?: string
  error?: string
}> => {
  try {
    const result = await client.invoke('onboarding:startClaudeOAuth')
    if (result.success && result.authUrl) {
      await shell.openExternal(result.authUrl)
    }
    return result
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Claude OAuth failed',
    }
  }
}

// ── performChatGptOAuth ──────────────────────────────────────────────────
// Same shape as performOAuth: callback server (port 1455) → chatgpt:startOAuth →
// browser → callback → chatgpt:completeOAuth.
// Overrides the startChatGptOAuth API method so the renderer call is unchanged.
;(api as any).startChatGptOAuth = async (
  connectionSlug: string,
): Promise<{ success: boolean; error?: string }> => {
  let callbackServer: Awaited<ReturnType<typeof createCallbackServer>> | null = null
  let flowId: string | undefined
  let state: string | undefined

  try {
    // 1. Start callback server on ChatGPT's fixed port with /auth/callback path
    callbackServer = await createCallbackServer({
      appType: 'electron',
      port: CHATGPT_OAUTH_CONFIG.CALLBACK_PORT,
      callbackPaths: ['/auth/callback'],
    })

    // 2. Ask server to prepare the flow (PKCE, auth URL, store pending flow)
    const startResult = await client.invoke('chatgpt:startOAuth', connectionSlug)
    flowId = startResult.flowId
    state = startResult.state

    // 3. Open browser for user consent
    await shell.openExternal(startResult.authUrl)

    // 4. Wait for OpenAI to redirect to our callback server
    const callback = await callbackServer.promise

    // 5. Check for errors from the provider
    if (callback.query.error) {
      const error = callback.query.error_description || callback.query.error
      await client.invoke('chatgpt:cancelOAuth', { state })
      return { success: false, error }
    }

    const code = callback.query.code
    if (!code) {
      await client.invoke('chatgpt:cancelOAuth', { state })
      return { success: false, error: 'No authorization code received' }
    }

    // 6. Send code to server for token exchange + credential storage
    const result = await client.invoke('chatgpt:completeOAuth', { flowId, code, state })
    return { success: result.success, error: result.error }
  } catch (err) {
    if (state) {
      client.invoke('chatgpt:cancelOAuth', { state }).catch(() => {})
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'ChatGPT OAuth flow failed',
    }
  } finally {
    callbackServer?.close()
  }
}

// App lifecycle — direct IPC (not WS RPC) since it restarts the server itself
;(api as ElectronAPI).relaunchApp = () => ipcRenderer.invoke('app:relaunch')

// Connections are an **app** property — the saved list and opening a window on one are local
// config operations. Direct IPC: these must not be routed through the (possibly remote) WS server.
;(api as ElectronAPI).getClientMode = () => ipcRenderer.invoke('client-mode:get')
;(api as ElectronAPI).saveRemoteConnection = (connection) =>
  ipcRenderer.invoke('client-mode:save-connection', connection)
// Device folders are this install's own, so the picker is a direct IPC even in a remote window —
// the routed `openFolderDialog` would ask the hub the window is showing.
;(api as ElectronAPI).openLocalFolderDialog = async () => {
  const result = await ipcRenderer.invoke('__dialog:showOpenDialog', {
    properties: ['openDirectory'],
  }) as { canceled: boolean; filePaths: string[] }
  return result.canceled ? null : result.filePaths[0] ?? null
}
;(api as ElectronAPI).removeRemoteConnection = (connectionId) =>
  ipcRenderer.invoke('client-mode:remove-connection', connectionId)
;(api as ElectronAPI).connectToRemoteConnection = (connectionId, workspaceId) =>
  ipcRenderer.invoke('client-mode:connect', connectionId, workspaceId)
;(api as ElectronAPI).testClientModeConnection = (serverUrl, token) =>
  ipcRenderer.invoke('client-mode:test', serverUrl, token)
// Workspace creation targets a server picked in the dialog, which may not be this window's.
// Direct IPC for the same reason the connection list is: the window's WS client is the wrong one.
;(api as ElectronAPI).listRemoteDirectories = (connectionId, dirPath, options) =>
  ipcRenderer.invoke('client-mode:remote-list-directory', connectionId, dirPath, options)
;(api as ElectronAPI).getRemoteHomeDir = (connectionId) =>
  ipcRenderer.invoke('client-mode:remote-home-dir', connectionId)
;(api as ElectronAPI).listRemoteWorkspaces = (connectionId) =>
  ipcRenderer.invoke('client-mode:remote-workspaces', connectionId)
;(api as ElectronAPI).getRemoteConnectionStatuses = () =>
  ipcRenderer.invoke('client-mode:remote-status')
// A remote window names itself: the workspace it shows is on the hub, so main cannot look it up.
;(api as ElectronAPI).setWindowTitle = (title) =>
  ipcRenderer.invoke('window:set-title', title)
;(api as ElectronAPI).checkRemoteWorkspaceSlug = (connectionId, slug) =>
  ipcRenderer.invoke('client-mode:remote-check-slug', connectionId, slug)
;(api as ElectronAPI).createRemoteWorkspace = (connectionId, folderPath, name) =>
  ipcRenderer.invoke('client-mode:remote-create-workspace', connectionId, folderPath, name)
;(api as ElectronAPI).openRemoteWindow = (workspaceId?: string) =>
  ipcRenderer.invoke('client-mode:open-window', workspaceId)
;(api as ElectronAPI).openLocalWindow = () => ipcRenderer.invoke('client-mode:open-local')
/**
 * Refuse a workspace the hub no longer has.
 *
 * The dropdown is filled when it opens, so a pick can name a workspace removed since. A list
 * that cannot be read proves nothing, so in that case the switch is allowed and the server's own
 * failure speaks instead.
 */
async function assertWorkspaceOnHub(client: WsRpcClient, workspaceId: string): Promise<void> {
  const workspaces = await client
    .invoke(RPC_CHANNELS.server.GET_WORKSPACES)
    .catch(() => null) as Array<{ id: string }> | null
  if (workspaces && !workspaces.some((workspace) => workspace.id === workspaceId)) {
    throw new Error('That workspace no longer exists on this server')
  }
}

/**
 * Switch this remote window to another workspace on its hub, in place.
 *
 * No new socket: the hub keeps this connection and re-points it at the new workspace, which is
 * what `window.SWITCH_WORKSPACE` does server-side (it also re-targets `to: 'workspace'` pushes).
 * Nothing above the transport has to re-subscribe, and there is no handshake or replay — the
 * first thing the new workspace sees is a request, not a connection setup.
 *
 * The server is told before the local bookkeeping, so a rejected switch leaves the window where
 * it was. The synthetic stale reconnect at the end stands in for the one the old make-before-break
 * swap used to emit from the new client; without it the UI would hold the old workspace's lists.
 */
;(api as ElectronAPI).switchRemoteWorkspace = async (workspaceId: string) => {
  if (!windowTarget) throw new Error('This window is not connected to a remote server')
  if (!workspaceId || workspaceId === remoteWorkspaceId) return

  await assertWorkspaceOnHub(workspaceClient, workspaceId)

  // The hub's registration is the authority for this connection's workspace.
  await workspaceClient.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, workspaceId)
  workspaceClient.setWorkspace(workspaceId)
  remoteWorkspaceId = workspaceId

  // Main remembers the window's workspace so launch restores what was on screen.
  await ipcRenderer.invoke('client-mode:switch-workspace', workspaceId)

  // This window's LOCAL connection answers LOCAL_ONLY channels that read the connection's
  // workspace instead of taking one as an argument. Awaited (but best-effort) so those channels
  // are already answering for the new workspace when the UI hears about the switch below.
  await syncLocalWorkspace(workspaceId)

  // No reconnect happened, so nothing else would tell the UI that the workspace under it changed.
  workspaceClient.emitReconnected(true)
}
/**
 * Point this window at a saved server, in place — from a local window too.
 *
 * **Connect before switching.** Main resolves and validates the target; this process builds the
 * socket and waits for the handshake; only then is the target committed and adopted. If the
 * server does not answer, nothing moves — the window keeps its workspace, its connection and its
 * lists. Tearing the current workspace down first would leave an unreachable server with an empty
 * window and nothing to go back to but the reconnect banner.
 */
;(api as ElectronAPI).switchRemoteServer = async (connectionId: string, workspaceId?: string) => {
  const target = await ipcRenderer.invoke('client-mode:resolve-switch', connectionId, workspaceId) as RemoteTargetUpdate
  const sameSocket = !!windowTarget
    && windowTarget.url === target.url
    && windowTarget.token === target.token

  if (sameSocket) {
    // The same server saved twice: no handshake to wait for, the workspace is the only change.
    await ipcRenderer.invoke('client-mode:switch-server', connectionId, workspaceId)
    adoptHubTarget(target)
    return
  }

  // Nothing to fall back to: this socket belongs to the server being joined, and a workspace id
  // from the one being left would name something that isn't there.
  const rebuilt = createHubClient(target, target.workspaceId)
  try {
    await waitForConnected(rebuilt)
    // Reachable. Main files it as this window's (and persists that), then the swap releases the
    // socket being left — make-before-break across the whole switch, not just the transport.
    await ipcRenderer.invoke('client-mode:switch-server', connectionId, workspaceId)
  } catch (err) {
    // Leave nothing behind: an auto-reconnecting client would keep dialling a server the person
    // never reached.
    rebuilt.destroy()
    throw err
  }
  adoptHubTarget(target, rebuilt)
}
/**
 * Bring this window back to this machine's server, in place.
 *
 * The hub socket is released and the local one — open the whole time — becomes the workspace
 * client again, so this direction has no handshake at all. The renderer hears `null`, which is
 * what "this window is local now" looks like from its side.
 */
;(api as ElectronAPI).switchLocalWorkspace = async (workspaceId: string) => {
  await ipcRenderer.invoke('client-mode:switch-local', workspaceId)
  await syncLocalWorkspace(workspaceId)
  windowTarget = null
  remoteWorkspaceId = undefined
  routedClient.switchToLocalClient()
  notifyRemoteTarget(null)
}
;(api as ElectronAPI).getWebContentsId = () => webContentsId
/** This install's stable identity — used to mark "this device" in browser-host pickers. */
;(api as ElectronAPI).getClientIdentity = () => clientIdentity

/**
 * Where this window should be, as main resolved it.
 *
 * Two things produce one: an edit to the saved server (address, token or name) and a switch to a
 * saved server, from a local window or another hub. Both end up here, because both may need a new
 * socket — the same make-before-break swap, which re-subscribes listeners and emits the stale
 * reconnect the app already handles. The renderer hears about either through
 * `onRemoteTargetChanged`, so the host badge and the window title follow without a reload.
 */
interface RemoteTargetUpdate {
  connectionId: string
  url: string
  token: string
  workspaceId?: string
  name?: string
}
/** `null` means "this window is on this machine again". */
const remoteTargetListeners = new Set<(target: RemoteTargetUpdate | null) => void>()
;(api as ElectronAPI).onRemoteTargetChanged = (callback) => {
  remoteTargetListeners.add(callback)
  return () => { remoteTargetListeners.delete(callback) }
}

function notifyRemoteTarget(target: RemoteTargetUpdate | null): void {
  for (const listener of remoteTargetListeners) {
    try { listener(target) } catch { /* renderer listeners must not break the transport */ }
  }
}

/** This window's LOCAL connection answers LOCAL_ONLY channels that read its workspace. */
async function syncLocalWorkspace(workspaceId: string | undefined): Promise<void> {
  if (!workspaceId) return
  localClient.setWorkspace(workspaceId)
  await localClient.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, workspaceId).catch(() => {})
}

/** A hub socket for `target`, handshaking as the given workspace. Not connected yet. */
function createHubClient(target: RemoteTargetUpdate, workspaceId: string | undefined): WsRpcClient {
  return new WsRpcClient(target.url, {
    token: target.token,
    workspaceId,
    webContentsId,
    autoReconnect: true,
    mode: 'remote',
    clientCapabilities: [...WINDOW_CAPABILITIES],
    clientInfo: { ...clientIdentity, role: 'window' },
    tlsRejectUnauthorized: false,
  })
}

/**
 * Resolve once the handshake has happened; reject when it fails or takes too long.
 *
 * `connect()` is fire-and-forget — the state listener is the only signal, and it reports the
 * current state synchronously, so an already-connected client resolves immediately.
 */
function waitForConnected(client: WsRpcClient, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsub: (() => void) | undefined
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsub?.()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('Timed out connecting to the server'))),
      timeoutMs,
    )
    unsub = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') finish(resolve)
      else if (state.status === 'failed') {
        finish(() => reject(new Error(state.lastError?.message ?? 'Connection failed')))
      }
    })
    client.connect()
  })
}

/**
 * Adopt a target this window has already reached: point the window record at it, hand the
 * workspace client over (`rebuilt`, when the socket changed), and tell the renderer.
 *
 * `rebuilt` is swapped in only here — after it is connected — so the socket being left is
 * released at the last possible moment. Without it the target is the same socket, and only the
 * workspace it speaks for moves.
 */
function adoptHubTarget(target: RemoteTargetUpdate, rebuilt?: WsRpcClient): void {
  // A new socket means a different server (or a fresh handshake): the workspace this window was
  // on there means nothing, so no fallback. A same-socket adopt is only about the workspace.
  const nextWorkspaceId = rebuilt
    ? target.workspaceId
    : (target.workspaceId ?? remoteWorkspaceId)

  if (windowTarget) {
    windowTarget.url = target.url
    windowTarget.token = target.token
    windowTarget.workspaceId = nextWorkspaceId
    if (target.name) windowTarget.name = target.name
  } else {
    // A local window adopting a hub: this is the first target it has ever had.
    windowTarget = {
      url: target.url,
      token: target.token,
      workspaceId: nextWorkspaceId,
      ...(target.name ? { name: target.name } : {}),
    }
  }

  if (rebuilt) {
    remoteWorkspaceId = nextWorkspaceId
    // Emits the synthetic stale reconnect once the new socket is up, which is what makes the
    // renderer drop the previous server's lists.
    routedClient.switchToWorkspaceClient(rebuilt)
    void syncLocalWorkspace(nextWorkspaceId)
  } else if (nextWorkspaceId && nextWorkspaceId !== remoteWorkspaceId) {
    remoteWorkspaceId = nextWorkspaceId
    workspaceClient.setWorkspace(nextWorkspaceId)
    void workspaceClient.invoke(RPC_CHANNELS.window.SWITCH_WORKSPACE, nextWorkspaceId).catch(() => {})
    void syncLocalWorkspace(nextWorkspaceId)
    workspaceClient.emitReconnected(true)
  }

  notifyRemoteTarget(target)
}

/**
 * Apply a target main pushed for this window: an edit to the saved server.
 *
 * Applied at once — an edit is the person changing where this window already looks, and the
 * connection banner is the right place to report a bad address. A switch (see
 * `switchRemoteServer`) is the opposite case and waits for the new server to answer first.
 */
function applyRemoteTarget(payload: RemoteTargetUpdate): void {
  if (!payload?.url || !payload.token) return

  const needsRebuild = !windowTarget
    || windowTarget.url !== payload.url
    || windowTarget.token !== payload.token
  if (!needsRebuild) {
    adoptHubTarget(payload)
    return
  }

  const rebuilt = createHubClient(payload, payload.workspaceId ?? remoteWorkspaceId)
  rebuilt.connect()
  adoptHubTarget(payload, rebuilt)
}

ipcRenderer.on('client-mode:target-changed', (_event, payload: RemoteTargetUpdate | null) => {
  if (payload) applyRemoteTarget(payload)
})
/**
 * A hub-produced export is fetched by main, not here: it holds the hub token, asks where to save,
 * and streams the file. The renderer only ever sees an id and a name.
 */
;(api as ElectronAPI).saveDesignExport = (download) => ipcRenderer.invoke('design-export:save', download)
;(api as ElectronAPI).transferSessionToWorkspace = async (sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number) => {
  if (windowTarget) {
    // Both workspaces live on this window's hub — the transfer is a call on that connection,
    // not something the local main process could do for it.
    const bundle = await workspaceClient.invoke(RPC_CHANNELS.sessions.EXPORT, sessionId)
    return await workspaceClient.invoke(RPC_CHANNELS.sessions.IMPORT, targetWorkspaceId, bundle, 'fork')
  }
  return ipcRenderer.invoke('session:transferToWorkspace', sessionId, targetWorkspaceId, sessionIndex, sessionCount)
}
;(api as ElectronAPI).onTransferProgress = (cb: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void) => {
  const handler = (_e: any, progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => cb(progress)
  ipcRenderer.on('transfer:progress', handler)
  return () => { ipcRenderer.removeListener('transfer:progress', handler) }
}

/**
 * A link that navigated a sandboxed preview's top frame — main caught it and asks this window
 * where it should go. The renderer runs the ordinary open path, so the person's setting and the
 * window's mode decide (the workspace's browser by default, the system browser when asked).
 */
;(api as ElectronAPI).onBrowserOpenLink = (cb: (url: string) => void) => {
  const handler = (_e: any, url: string) => cb(url)
  ipcRenderer.on('browser:open-link', handler)
  return () => { ipcRenderer.removeListener('browser:open-link', handler) }
}

// System warnings — expose env-based flags set during main process startup
// (preload-only: reads env var directly, no IPC round-trip needed)
;(api as ElectronAPI).getSystemWarnings = async () => ({
  vcredistMissing: process.env.CRAFT_VCREDIST_MISSING === '1',
  downloadUrl: process.env.CRAFT_VCREDIST_URL,
})

// i18n: sync language changes to main process (for native menus/dialogs)
;(api as ElectronAPI).changeLanguage = (lang: string) => ipcRenderer.invoke('i18n:changeLanguage', lang)

// webUtils.getPathForFile: returns the absolute OS path of a File object obtained
// from <input type="file"> or OS drag-drop. Returns null for Files fabricated from
// Blobs (clipboard paste, web-drag) — those are content-only, no filesystem path.
;(api as ElectronAPI).getFilePath = (file: File) => {
  try {
    return webUtils.getPathForFile(file) || null
  } catch {
    return null
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
