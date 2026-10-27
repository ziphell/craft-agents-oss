import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { WsRpcClientOptions } from '../../transport/client'
import type { HandlerDeps } from './handler-deps'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.OPEN_DESIGN_WINDOW,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
] as const

/**
 * Connect to a remote server and wait for handshake.
 * When workspaceId is provided, the handshake is scoped to that workspace so
 * workspace-context RPC handlers (for example sessions:export) can resolve it.
 * opts.requestTimeout overrides the 30s default — session transfers pull whole
 * bundles as one response frame and need more headroom over WAN.
 * opts.clientInfo identifies this install, which a device token's first use needs: the hub binds
 * the slot to that `deviceId`.
 * Returns the connected client or null + error message.
 */
export async function connectToRemote(
  url: string,
  token: string,
  workspaceId?: string,
  opts?: { requestTimeout?: number; clientInfo?: WsRpcClientOptions['clientInfo'] },
) {
  const { WsRpcClient } = await import('../../transport/client')
  const client = new WsRpcClient(url, {
    token,
    workspaceId,
    clientInfo: opts?.clientInfo,
    autoReconnect: false,
    tlsRejectUnauthorized: false,
    requestTimeout: opts?.requestTimeout,
  })

  const connected = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000)
    const unsub = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        clearTimeout(timeout)
        unsub()
        resolve(true)
      } else if (state.status === 'failed') {
        clearTimeout(timeout)
        unsub()
        resolve(false)
      }
    })
    client.connect()
  })

  if (!connected) {
    const error = client.getConnectionState().lastError?.message ?? 'Connection failed'
    client.destroy()
    return { client: null, error }
  }

  return { client, error: null }
}

export function registerWorkspaceGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  const windowManager = deps.windowManager

  // Open workspace in new window (or focus existing)
  server.handle(RPC_CHANNELS.window.OPEN_WORKSPACE, async (_ctx, workspaceId: string) => {
    if (!windowManager) return
    windowManager.focusOrCreateWindow(workspaceId)
  })

  // Open a session in a new window
  server.handle(RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW, async (ctx, workspaceId: string, sessionId: string) => {
    if (!windowManager) return
    const deepLink = `craftagents://allSessions/session/${sessionId}`
    // A remote window opens another window on **its** hub; a local one opens a local window.
    const remote = ctx.webContentsId ? windowManager.getRemoteForWindow(ctx.webContentsId) : null
    windowManager.createWindow({
      workspaceId,
      ...(remote ? { remote: { ...remote, workspaceId } } : {}),
      focused: true,
      initialDeepLink: deepLink,
    })
  })

  // Open a design in its own window (or focus the one already open on it)
  server.handle(RPC_CHANNELS.window.OPEN_DESIGN_WINDOW, async (ctx, workspaceId: string, designSlug: string) => {
    if (!windowManager) return
    // A remote window opens the design's window on **its** hub; a local one stays local.
    const remote = ctx.webContentsId ? windowManager.getRemoteForWindow(ctx.webContentsId) : null
    windowManager.openDesignWindow(workspaceId, designSlug, remote ?? undefined)
  })

  // Close the calling window (triggers close event which may be intercepted)
  server.handle(RPC_CHANNELS.window.CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.closeWindow(ctx.webContentsId!)
  })

  // Confirm close - the renderer answered the close request, so put the window away.
  // (A close hides rather than destroys — the app lives in the tray.)
  server.handle(RPC_CHANNELS.window.CONFIRM_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.hideWindow(ctx.webContentsId!)
  })

  // Cancel close - renderer handled the request (closed a modal/panel).
  server.handle(RPC_CHANNELS.window.CANCEL_CLOSE, (ctx) => {
    if (!windowManager) return
    windowManager.cancelPendingClose(ctx.webContentsId!)
  })

  // Show/hide macOS traffic light buttons (for fullscreen overlays)
  server.handle(RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS, (ctx, visible: boolean) => {
    if (!windowManager) return
    windowManager.setTrafficLightsVisible(ctx.webContentsId!, visible)
  })
}
