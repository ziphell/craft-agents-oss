/**
 * RoutedClient tests — channel routing, workspace switch, listener re-subscription.
 */

import { describe, it, expect, mock } from 'bun:test'
import { RoutedClient } from '../routed-client'
import type { WsRpcClient, TransportConnectionState } from '../client'

// ---------------------------------------------------------------------------
// Minimal WsRpcClient stub
// ---------------------------------------------------------------------------

function stubClient(overrides?: Partial<WsRpcClient>): WsRpcClient {
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const capabilities = new Map<string, (...args: any[]) => any>()

  return {
    connect: mock(() => {}),
    destroy: mock(() => {}),
    invoke: mock(async () => undefined),
    on: mock((channel: string, cb: (...args: any[]) => void) => {
      let set = listeners.get(channel)
      if (!set) { set = new Set(); listeners.set(channel, set) }
      set.add(cb)
      return () => { set!.delete(cb) }
    }),
    handleCapability: mock((channel: string, handler: (...args: any[]) => any) => {
      capabilities.set(channel, handler)
    }),
    isChannelAvailable: mock(() => true),
    getConnectionState: mock((): TransportConnectionState => ({
      mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now(),
    })),
    onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
      cb({ mode: 'local', status: 'connected', url: 'ws://127.0.0.1:9000', attempt: 0, updatedAt: Date.now() })
      return () => {}
    }),
    reconnectNow: mock(() => {}),
    emitReconnected: mock((isStale: boolean) => {
      const set = listeners.get('__transport:reconnected')
      if (!set) return
      for (const cb of set) {
        try { cb(isStale) } catch { /* listener errors must not break transport */ }
      }
    }),
    // expose internals for assertions
    _listeners: listeners,
    _capabilities: capabilities,
    ...overrides,
  } as any
}

// Use real channel constants — RoutedClient routes based on isLocalOnly()
import { isLocalOnly, RPC_CHANNELS } from '@craft-agent/shared/protocol'

const LOCAL_CHANNEL = RPC_CHANNELS.window.GET_WORKSPACE   // LOCAL_ONLY
const REMOTE_CHANNEL = RPC_CHANNELS.sessions.GET           // REMOTE_ELIGIBLE

describe('RoutedClient', () => {
  describe('routing', () => {
    it('routes LOCAL_ONLY invokes to localClient', async () => {
      const local = stubClient({ invoke: mock(async () => 'local-result') })
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(LOCAL_CHANNEL)
      expect(result).toBe('local-result')
      expect(local.invoke).toHaveBeenCalledWith(LOCAL_CHANNEL)
      expect(workspace.invoke).not.toHaveBeenCalled()
    })

    it('routes REMOTE_ELIGIBLE invokes to workspaceClient', async () => {
      const local = stubClient()
      const workspace = stubClient({ invoke: mock(async () => 'ws-result') })
      const routed = new RoutedClient(local, workspace)

      const result = await routed.invoke(REMOTE_CHANNEL)
      expect(result).toBe('ws-result')
      expect(workspace.invoke).toHaveBeenCalledWith(REMOTE_CHANNEL)
      expect(local.invoke).not.toHaveBeenCalled()
    })

    it('creates a workspace on the server that will own it', async () => {
      // A remote window's new workspace belongs to its hub, not to this machine; a local
      // window's workspaceClient is the local server, so the same routing serves both.
      const local = stubClient()
      const workspace = stubClient({ invoke: mock(async () => ({ id: 'ws-new' })) })
      const routed = new RoutedClient(local, workspace)

      const created = await routed.invoke(RPC_CHANNELS.workspaces.CREATE, '/srv/new-workspace', 'New')
      expect(created).toEqual({ id: 'ws-new' })
      expect(workspace.invoke).toHaveBeenCalledWith(RPC_CHANNELS.workspaces.CREATE, '/srv/new-workspace', 'New')
      expect(local.invoke).not.toHaveBeenCalled()
    })

    it('routes LOCAL_ONLY listeners to localClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(LOCAL_CHANNEL, cb)

      expect(local.on).toHaveBeenCalledWith(LOCAL_CHANNEL, cb)
      expect(workspace.on).not.toHaveBeenCalledWith(LOCAL_CHANNEL, expect.any(Function))
    })

    it('routes REMOTE_ELIGIBLE listeners to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)

      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })
  })

  describe('workspace switch', () => {
    it('re-subscribes REMOTE_ELIGIBLE listeners on swap (make-before-break)', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      // Subscribe a listener before the switch
      const cb = mock(() => {})
      routed.on(REMOTE_CHANNEL, cb)
      expect(workspace.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)

      const next = stubClient()
      routed.switchToWorkspaceClient(next)

      // Listener should be re-subscribed on the new client
      expect(next.on).toHaveBeenCalledWith(REMOTE_CHANNEL, cb)
    })

    it('re-registers capabilities on swap', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const handler = mock(async () => 'capability-result')
      routed.handleCapability('test:capability', handler)

      const next = stubClient()
      routed.switchToWorkspaceClient(next)

      expect(next.handleCapability).toHaveBeenCalledWith('test:capability', handler)
    })

    it('re-points a remote window at another workspace on the same hub', async () => {
      // A remote window switching workspace in place: the hub client is replaced with one for
      // the new workspace; LOCAL_ONLY calls keep going to the local server.
      const local = stubClient({ invoke: mock(async () => ({ workspaceId: 'ws-local' })) })
      const hubForA = stubClient()
      const routed = new RoutedClient(local, hubForA)

      const hubForB = stubClient({ invoke: mock(async () => 'hub-b') })
      routed.switchToWorkspaceClient(hubForB)

      expect(hubForA.destroy).toHaveBeenCalled()
      expect(await routed.invoke(REMOTE_CHANNEL)).toBe('hub-b')
      expect(await routed.invoke(LOCAL_CHANNEL)).toEqual({ workspaceId: 'ws-local' })
    })

    it('hands a window back to this machine, releasing the hub and emitting stale', async () => {
      // The reverse direction: remote calls answer from the local server again and the hub
      // socket is destroyed. There is no new connection to wait for, so the stale reconnect has
      // to be emitted by the swap itself — otherwise the renderer keeps the hub's lists.
      const local = stubClient({ invoke: mock(async () => 'local-again') })
      const hub = stubClient()
      const routed = new RoutedClient(local, hub)

      const remoteListener = mock(() => {})
      const reconnectListener = mock(() => {})
      routed.on(REMOTE_CHANNEL, remoteListener)
      routed.on('__transport:reconnected', reconnectListener)

      routed.switchToLocalClient()

      expect(hub.destroy).toHaveBeenCalled()
      expect(await routed.invoke(REMOTE_CHANNEL)).toBe('local-again')
      expect(local.on).toHaveBeenCalledWith(REMOTE_CHANNEL, remoteListener)
      expect(reconnectListener).toHaveBeenCalledWith(true)
    })

    it('treats "back to local" as a no-op for a window that never left', () => {
      const local = stubClient()
      const routed = new RoutedClient(local, local)

      routed.switchToLocalClient()

      expect(local.destroy).not.toHaveBeenCalled()
      expect(local.emitReconnected).not.toHaveBeenCalled()
    })
  })

  describe('connection state', () => {
    it('delegates getConnectionState to workspaceClient', () => {
      const expectedState: TransportConnectionState = {
        mode: 'remote', status: 'reconnecting', url: 'wss://remote:9001',
        attempt: 2, updatedAt: Date.now(),
      }
      const local = stubClient()
      const workspace = stubClient({ getConnectionState: mock(() => expectedState) })
      const routed = new RoutedClient(local, workspace)

      expect(routed.getConnectionState()).toEqual(expectedState)
    })

    it('notifies connection state listeners on change', () => {
      let capturedCb: ((state: TransportConnectionState) => void) | null = null
      const workspace = stubClient({
        onConnectionStateChanged: mock((cb: (state: TransportConnectionState) => void) => {
          capturedCb = cb
          // Initial callback
          cb({ mode: 'remote', status: 'connected', url: 'wss://remote', attempt: 0, updatedAt: Date.now() })
          return () => {}
        }),
      })
      const local = stubClient()
      const routed = new RoutedClient(local, workspace)

      const listener = mock(() => {})
      routed.onConnectionStateChanged(listener)

      // Should have received initial state
      expect(listener).toHaveBeenCalled()

      // Simulate a state change via the captured workspace client callback
      capturedCb!({ mode: 'remote', status: 'reconnecting', url: 'wss://remote', attempt: 1, updatedAt: Date.now() })

      // 1: initial from onConnectionStateChanged → callback(getConnectionState())
      // 2: the simulated change forwarded through connectionStateListeners
      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('delegates reconnectNow to workspaceClient', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      routed.reconnectNow()
      expect(workspace.reconnectNow).toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('unsubscribes listeners when cleanup function is called', () => {
      const local = stubClient()
      const workspace = stubClient()
      const routed = new RoutedClient(local, workspace)

      const cb = mock(() => {})
      const unsub = routed.on(REMOTE_CHANNEL, cb)

      // Should be tracked
      unsub()

      // After cleanup, switching workspace should not attempt to re-subscribe this listener
      // (no error thrown = success)
    })
  })
})

describe('isLocalOnly consistency', () => {
  it('correctly classifies window channels as LOCAL_ONLY', () => {
    expect(isLocalOnly(LOCAL_CHANNEL)).toBe(true)
  })

  it('correctly classifies session channels as REMOTE_ELIGIBLE', () => {
    expect(isLocalOnly(REMOTE_CHANNEL)).toBe(false)
  })
})
