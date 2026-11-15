/**
 * In-place workspace switch (what a remote window does instead of rebuilding its socket).
 *
 * The window keeps its connection; the server re-points that client's workspace, which is also
 * what `to: 'workspace'` pushes are matched against. This is the contract the preload relies on:
 * no handshake, no replay, and events for the old workspace stop arriving immediately.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { WsRpcServer } from '../server'
import { WsRpcClient } from '../client'

const TEST_TOKEN = 'test-token-with-enough-entropy-to-pass'
const teardown: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best-effort */ }
  }
})

async function startHub() {
  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (t) => (t === TEST_TOKEN ? { tokenId: 'test-token', scope: 'both' } : null),
    serverId: 'test',
  })
  await server.listen()
  teardown.push(() => server.close())
  return server
}

async function connectClient(
  server: WsRpcServer,
  opts: { workspaceId?: string; role?: 'window' | 'device' },
): Promise<WsRpcClient> {
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    token: TEST_TOKEN,
    workspaceId: opts.workspaceId,
    clientInfo: opts.role ? { role: opts.role } : undefined,
    autoReconnect: false,
  })
  client.connect()
  teardown.push(() => client.destroy())

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client never connected')), 2000)
    const off = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') { clearTimeout(timer); off(); resolve() }
      else if (state.status === 'failed' || state.status === 'disconnected') {
        clearTimeout(timer); off(); reject(new Error(`status=${state.status}`))
      }
    })
  })

  return client
}

async function startPair(workspaceId: string) {
  const server = await startHub()
  const client = await connectClient(server, { workspaceId })
  const clientId = server.getConnectedClients()[0]!.clientId
  return { server, client, clientId }
}

describe('in-place workspace switch', () => {
  it('re-points a connection at another workspace without a reconnect', async () => {
    const { server, client, clientId } = await startPair('ws-a')
    const received: string[] = []
    client.on('test:event', (value: string) => received.push(value))

    server.updateClientWorkspace(clientId, 'ws-b')

    // Same connection, same client id — only the workspace it speaks for changed.
    expect(server.getConnectedClients()).toHaveLength(1)
    expect(server.getConnectedClients()[0]!.workspaceId).toBe('ws-b')

    server.push('test:event', { to: 'workspace', workspaceId: 'ws-a' }, 'old')
    server.push('test:event', { to: 'workspace', workspaceId: 'ws-b' }, 'new')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(received).toEqual(['new'])
  })
})

describe('workspace event routing', () => {
  it('never delivers workspace or hub-wide events to a device link', async () => {
    // A desktop client that connected to the hub as a device holds no remote-window permission.
    // Workspace events are what a window turns into completion notifications, and the hub's own
    // broadcasts (unread summary, badge counts) are its state — the link is not a view of it.
    const server = await startHub()
    const windowClient = await connectClient(server, { workspaceId: 'ws-a', role: 'window' })
    const deviceClient = await connectClient(server, { workspaceId: 'ws-a', role: 'device' })

    const windowEvents: string[] = []
    const deviceEvents: string[] = []
    windowClient.on('test:event', (value: string) => windowEvents.push(value))
    deviceClient.on('test:event', (value: string) => deviceEvents.push(value))

    server.push('test:event', { to: 'workspace', workspaceId: 'ws-a' }, 'done')
    server.push('test:event', { to: 'all' }, 'state')
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(windowEvents).toEqual(['done', 'state'])
    expect(deviceEvents).toEqual([])
  })

  it('still tells a device link when the hub is shutting down', async () => {
    // The one push a link keeps: it is about the connection, not the hub's view state, and it is
    // what stops the link from reconnecting to a server that has gone away.
    const server = await startHub()
    const deviceClient = await connectClient(server, { role: 'device' })
    const received: unknown[] = []
    deviceClient.on('server:shuttingDown', (payload: unknown) => received.push(payload))

    server.push('server:shuttingDown', { to: 'all' }, { reason: 'quit' })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(received).toEqual([{ reason: 'quit' }])
  })
})
