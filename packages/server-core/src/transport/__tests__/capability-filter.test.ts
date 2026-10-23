/**
 * `findClientsWithCapability` filters.
 *
 * A workspace client (a window) and an app-level device link are both "a client", but they are
 * matched differently: the window belongs to one workspace, the link serves every workspace of its
 * machine and names one per request. These tests pin that down, because the browser host and the
 * device calls both resolve through this method.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { WsRpcServer } from '../server'
import { WsRpcClient } from '../client'
import { CLIENT_BROWSER_INVOKE } from '../capabilities'

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
    validateToken: async (t) => t === TEST_TOKEN,
    serverId: 'test',
  })
  await server.listen()
  teardown.push(() => server.close())
  return server
}

async function connectClient(
  server: WsRpcServer,
  opts: { workspaceId?: string; deviceId: string },
): Promise<WsRpcClient> {
  const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    token: TEST_TOKEN,
    workspaceId: opts.workspaceId,
    clientCapabilities: [CLIENT_BROWSER_INVOKE],
    clientInfo: { deviceId: opts.deviceId, name: opts.deviceId, platform: 'test' },
    autoReconnect: false,
  })
  client.connect()
  teardown.push(() => client.destroy())

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('client never connected')), 2000)
    const off = client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        clearTimeout(timer); off(); resolve()
      } else if (state.status === 'failed' || state.status === 'disconnected') {
        clearTimeout(timer); off(); reject(new Error(`status=${state.status}`))
      }
    })
  })
  return client
}

describe('WsRpcServer.findClientsWithCapability', () => {
  it('separates a window client from the machine’s workspace-agnostic device link', async () => {
    const server = await startHub()
    await connectClient(server, { workspaceId: 'ws-1', deviceId: 'device-A' })
    await connectClient(server, { deviceId: 'device-A' })

    const inWorkspace = server.findClientsWithCapability(CLIENT_BROWSER_INVOKE, { workspaceId: 'ws-1' })
    expect(inWorkspace).toHaveLength(1)
    expect(server.getClientDeviceId(inWorkspace[0]!)).toBe('device-A')

    const withLinks = server.findClientsWithCapability(CLIENT_BROWSER_INVOKE, {
      workspaceId: 'ws-1',
      includeWorkspaceAgnostic: true,
    })
    expect(withLinks).toHaveLength(2)

    // The two ids are different clients of the same machine; the link is the one without a workspace.
    const link = server.getConnectedClients().find(client =>
      client.deviceId === 'device-A' && client.workspaceId === null)
    expect(link).toBeDefined()
    expect(withLinks).toContain(link!.clientId)
    expect(server.getClientDeviceId(link!.clientId)).toBe('device-A')
  })

  it('narrows to one machine by deviceId', async () => {
    const server = await startHub()
    await connectClient(server, { workspaceId: 'ws-1', deviceId: 'device-A' })
    await connectClient(server, { workspaceId: 'ws-1', deviceId: 'device-B' })

    const other = server.getConnectedClients().find(client => client.deviceId === 'device-B')!
    const onlyOther = server.findClientsWithCapability(CLIENT_BROWSER_INVOKE, { deviceId: 'device-B' })
    expect(onlyOther).toEqual([other.clientId])
    expect(server.findClientsWithCapability(CLIENT_BROWSER_INVOKE, { deviceId: 'device-missing' })).toEqual([])
  })

  it('excludes device links from a workspace query unless asked for them', async () => {
    const server = await startHub()
    await connectClient(server, { deviceId: 'device-A' })

    expect(server.findClientsWithCapability(CLIENT_BROWSER_INVOKE, { workspaceId: 'ws-1' })).toEqual([])
    expect(server.findClientsWithCapability(CLIENT_BROWSER_INVOKE, {
      workspaceId: 'ws-1',
      includeWorkspaceAgnostic: true,
    })).toHaveLength(1)
  })
})
