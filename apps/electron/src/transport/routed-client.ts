/**
 * RoutedClient — client-side channel router.
 *
 * Wraps two WsRpcClient instances: localClient (always the embedded Electron
 * server) and workspaceClient (the hub a remote window is bound to, or the
 * local server for a local window).
 *
 * - LOCAL_ONLY channels always route to localClient
 * - Everything else routes to workspaceClient
 * - A remote window's workspace switch swaps workspaceClient and re-subscribes
 *   REMOTE_ELIGIBLE listeners transparently (make-before-break)
 */

import type { WsRpcClient, TransportConnectionState } from './client'
import type { RpcClient } from '@craft-agent/server-core/transport'
import { isLocalOnly } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListenerEntry {
  callback: (...args: any[]) => void
  unsub: () => void
}

// ---------------------------------------------------------------------------
// RoutedClient
// ---------------------------------------------------------------------------

export class RoutedClient implements RpcClient {
  private workspaceClient: WsRpcClient

  /** REMOTE_ELIGIBLE listener registry — survives workspace switches. */
  private remoteListeners = new Map<string, Set<ListenerEntry>>()

  /** Capability handlers — re-registered on workspace switch. */
  private capabilities = new Map<string, (...args: any[]) => Promise<any> | any>()

  /** Connection state listeners (delegates to workspaceClient). */
  private connectionStateListeners = new Set<(state: TransportConnectionState) => void>()
  private connectionStateUnsub: (() => void) | null = null

  constructor(
    private readonly localClient: WsRpcClient,
    initialWorkspaceClient: WsRpcClient,
  ) {
    this.workspaceClient = initialWorkspaceClient
    this.bindConnectionState()
  }

  /**
   * Re-point a window that is bound to one hub at **another workspace on that same hub**.
   *
   * A remote window's workspace switch is this, not a new window: the window, its hub and
   * the connection policy stay, and only the workspace the connection speaks for changes
   * (VS Code's "Open Folder" in a remote window). Pinning still holds — the workspace client
   * remains a hub client, never the local one. The caller creates and connects `next`;
   * swapping after it connects keeps the make-before-break discipline.
   */
  switchToWorkspaceClient(next: WsRpcClient): void {
    this.swapWorkspaceClient(next)
  }

  /**
   * Release the hub and route through this machine's server again.
   *
   * The inverse of {@link switchToWorkspaceClient}, for a window that moves back from a hub. There
   * is no new connection to wait for — the local client has been open the whole time — so the swap
   * is immediate and the stale reconnect has to be emitted here rather than from a connect
   * listener. Skipping it would leave the renderer holding the hub workspace's lists.
   */
  switchToLocalClient(): void {
    if (this.workspaceClient === this.localClient) return
    this.swapWorkspaceClient(this.localClient)
    this.localClient.emitReconnected(true)
  }

  // -------------------------------------------------------------------------
  // RpcClient interface
  // -------------------------------------------------------------------------

  async invoke(channel: string, ...args: any[]): Promise<any> {
    const target = isLocalOnly(channel) ? this.localClient : this.workspaceClient
    return await target.invoke(channel, ...args)
  }

  on(channel: string, callback: (...args: any[]) => void): () => void {
    if (isLocalOnly(channel)) {
      return this.localClient.on(channel, callback)
    }

    // REMOTE_ELIGIBLE — subscribe on workspaceClient and track for re-subscription
    const unsub = this.workspaceClient.on(channel, callback)

    let set = this.remoteListeners.get(channel)
    if (!set) {
      set = new Set()
      this.remoteListeners.set(channel, set)
    }
    const entry: ListenerEntry = { callback, unsub }
    set.add(entry)

    return () => {
      entry.unsub()
      set!.delete(entry)
      if (set!.size === 0) this.remoteListeners.delete(channel)
    }
  }

  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    this.capabilities.set(channel, handler)
    // Register on both clients — either server can invoke capabilities
    this.localClient.handleCapability(channel, handler)
    if (this.workspaceClient !== this.localClient) {
      this.workspaceClient.handleCapability(channel, handler)
    }
  }

  // -------------------------------------------------------------------------
  // Extended interface (used by bootstrap / build-api)
  // -------------------------------------------------------------------------

  isChannelAvailable(channel: string): boolean {
    const target = isLocalOnly(channel) ? this.localClient : this.workspaceClient
    return target.isChannelAvailable(channel)
  }

  getConnectionState(): TransportConnectionState {
    return this.workspaceClient.getConnectionState()
  }

  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(callback)
    callback(this.getConnectionState())
    return () => { this.connectionStateListeners.delete(callback) }
  }

  reconnectNow(): void {
    this.workspaceClient.reconnectNow()
  }

  // -------------------------------------------------------------------------
  // Workspace switch
  // -------------------------------------------------------------------------

  private swapWorkspaceClient(newClient: WsRpcClient): void {
    const old = this.workspaceClient
    this.workspaceClient = newClient

    // Re-register capabilities on new client
    for (const [channel, handler] of this.capabilities) {
      newClient.handleCapability(channel, handler)
    }

    // Re-subscribe REMOTE_ELIGIBLE listeners (make-before-break:
    // subscribe on new first, then unsubscribe from old)
    for (const [channel, entries] of this.remoteListeners) {
      for (const entry of entries) {
        const oldUnsub = entry.unsub
        entry.unsub = newClient.on(channel, entry.callback)
        oldUnsub()
      }
    }

    // Rebind connection state delegation
    this.bindConnectionState()

    // Destroy old client (unless it's the local client or same as new)
    if (old !== this.localClient && old !== newClient) {
      old.destroy()
    }

    // Emit synthetic stale reconnect once the new client connects.
    // Workspace switches create a brand-new client (not a reconnect), so
    // __transport:reconnected never fires naturally. This triggers the App's
    // stale recovery logic to refresh sessions that changed while no client
    // was watching this workspace.
    if (newClient !== this.localClient) {
      // `let` + optional-chaining: onConnectionStateChanged can fire its
      // callback synchronously when the new client is already connected, which
      // would put `unsub` in the TDZ if declared `const`.
      let unsub: (() => void) | undefined
      unsub = newClient.onConnectionStateChanged((state) => {
        if (state.status === 'connected') {
          unsub?.()
          newClient.emitReconnected(true)
        }
      })
    }
  }

  private bindConnectionState(): void {
    this.connectionStateUnsub?.()
    this.connectionStateUnsub = this.workspaceClient.onConnectionStateChanged((state) => {
      const snapshot = { ...state }
      for (const cb of this.connectionStateListeners) {
        try { cb(snapshot) } catch { /* listener errors must not break transport */ }
      }
    })
  }
}
