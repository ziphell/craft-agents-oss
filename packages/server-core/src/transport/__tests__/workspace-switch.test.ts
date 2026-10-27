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

async function startPair(workspaceId: string) {
  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (t) => (t === TEST_TOKEN ? { tokenId: 'test-token', scope: 'both' } : null),
    serverId: 'test',
  })
  await server.listen()
  teardown.push(() => server.close())

  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    token: TEST_TOKEN,
    workspaceId,
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
