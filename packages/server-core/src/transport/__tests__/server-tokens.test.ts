/**
 * Credentials: every caller presents a token, and the token says what it may do.
 *
 * Two kinds share the registry. The server token works from anywhere. A device token is a slot
 * in the hub's device list: it binds to the first device that claims it, never expires, and
 * cannot be transferred.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { WsRpcServer } from '../server'
import { WsRpcClient } from '../client'
import { ServerTokenRegistry, bearerToken, generateDeviceToken, type PersistedToken } from '../tokens'
import { CLIENT_DEVICE_EXEC, CLIENT_OPEN_EXTERNAL, scopePermits } from '../capabilities'

const teardown: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) {
    try { await fn() } catch { /* best-effort */ }
  }
})

const noDevice = { deviceId: null }

describe('ServerTokenRegistry', () => {
  it('resolves a token to the scope it was registered with', () => {
    const tokens = new ServerTokenRegistry()
    const main = tokens.register({ token: 'main-token', label: 'Server token', scope: 'both', kind: 'server' })
    const device = tokens.register({ token: 'device-token', label: 'Laptop', scope: 'device', kind: 'device' })

    expect(tokens.validate('main-token')).toEqual(main)
    expect(tokens.validate('device-token')).toEqual(device)
  })

  it('refuses a token it never issued', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'main-token', label: 'Server token', scope: 'both', kind: 'server' })
    expect(tokens.validate('other-token')).toBeNull()
  })

  it('deletes a device token at once, and reports it once', () => {
    const tokens = new ServerTokenRegistry()
    const grant = tokens.register({ token: 'device-token', label: 'Laptop', scope: 'device', kind: 'device' })

    expect(tokens.remove(grant.tokenId)).toBe(true)
    expect(tokens.remove(grant.tokenId)).toBe(false)
    expect(tokens.validate('device-token')).toBeNull()
  })

  it('refuses to remove the server token', () => {
    const tokens = new ServerTokenRegistry()
    const grant = tokens.register({ token: 'main-token', label: 'Server token', scope: 'both', kind: 'server' })
    expect(tokens.remove(grant.tokenId)).toBe(false)
    expect(tokens.validate('main-token')).not.toBeNull()
  })

  it('never exposes the server token', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'main-token', label: 'Server token', scope: 'both', kind: 'server' })

    const [entry] = tokens.list()
    expect(entry?.label).toBe('Server token')
    expect(entry?.scope).toBe('both')
    expect(entry?.kind).toBe('server')
    expect(entry?.deviceId).toBeNull()
    expect(entry?.token).toBeNull()
    expect(Object.keys(entry ?? {})).not.toContain('hash')
  })

  it('keeps a pending device token copyable until it is claimed', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })

    expect(tokens.list()[0]?.token).toBe('device-token')
    tokens.authorize('device-token', { deviceId: 'device-a' })
    expect(tokens.list()[0]?.token).toBeNull()
  })
})

describe('ServerTokenRegistry — device slot claim', () => {
  it('binds a slot to the first device that connects, and keeps it there', () => {
    const tokens = new ServerTokenRegistry()
    const grant = tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })

    expect(tokens.authorize('device-token', { deviceId: 'device-a' })?.tokenId).toBe(grant.tokenId)
    expect(tokens.list()[0]?.deviceId).toBe('device-a')

    expect(tokens.authorize('device-token', { deviceId: 'device-b' })).toBeNull()
    expect(tokens.authorize('device-token', { deviceId: 'device-a' })?.tokenId).toBe(grant.tokenId)
  })

  it('refuses a slot when the handshake does not say which device it is', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })
    expect(tokens.authorize('device-token', noDevice)).toBeNull()
  })

  it('keeps the claim when the token is only validated over HTTP', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })

    expect(tokens.validate('device-token')).not.toBeNull()
    expect(tokens.list()[0]?.deviceId).toBeNull()
  })

  it('lets the server token connect from any device', () => {
    const tokens = new ServerTokenRegistry()
    const grant = tokens.register({ token: 'main-token', label: 'Server token', scope: 'both', kind: 'server' })

    expect(tokens.authorize('main-token', { deviceId: 'device-a' })?.tokenId).toBe(grant.tokenId)
    expect(tokens.authorize('main-token', noDevice)?.tokenId).toBe(grant.tokenId)
    expect(tokens.list()[0]?.deviceId).toBeNull()
  })

  it('survives a round trip through disk', () => {
    let saved: PersistedToken[] = []
    const tokens = new ServerTokenRegistry({ persist: (records) => { saved = records } })
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })

    expect(saved).toHaveLength(1)
    expect(saved[0]?.hash).not.toBe('device-token')
    // A pending slot keeps its plaintext so the device list can still offer a copy button.
    expect(saved[0]?.token).toBe('device-token')

    tokens.authorize('device-token', { deviceId: 'device-a' })
    expect(saved[0]?.token).toBeUndefined()

    const restored = new ServerTokenRegistry({ deviceTokens: saved })
    const [entry] = restored.list()
    expect(entry?.label).toBe('Laptop')
    expect(entry?.scope).toBe('both')
    expect(entry?.deviceId).toBe('device-a')
    expect(entry?.token).toBeNull()
    expect(restored.authorize('device-token', { deviceId: 'device-a' })).not.toBeNull()
    expect(restored.authorize('device-token', { deviceId: 'device-b' })).toBeNull()
  })

  it('restores a pending slot with its token still copyable', () => {
    let saved: PersistedToken[] = []
    const tokens = new ServerTokenRegistry({ persist: (records) => { saved = records } })
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })

    const restored = new ServerTokenRegistry({ deviceTokens: saved })
    expect(restored.list()[0]?.token).toBe('device-token')
    expect(restored.list()[0]?.deviceId).toBeNull()
  })

  it('drops a removed slot from the persisted records', () => {
    let saved: PersistedToken[] = []
    const tokens = new ServerTokenRegistry({ persist: (records) => { saved = records } })
    const grant = tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })
    expect(saved).toHaveLength(1)

    tokens.remove(grant.tokenId)
    expect(saved).toHaveLength(0)
  })

  it('validates a pending slot on a probe without claiming it', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })

    const grant = tokens.authorize('device-token', { deviceId: 'device-a', probe: true })
    expect(grant?.probe).toBe(true)
    expect(tokens.list()[0]?.deviceId).toBeNull()

    // The real connection that follows is still the one that claims it.
    expect(tokens.authorize('device-token', { deviceId: 'device-a' })?.tokenId).toBe(grant?.tokenId)
    expect(tokens.list()[0]?.deviceId).toBe('device-a')
  })

  it('refuses a probe from another device once the slot is bound', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'device-token', label: 'Laptop', scope: 'both', kind: 'device' })
    tokens.authorize('device-token', { deviceId: 'device-a' })

    expect(tokens.authorize('device-token', { deviceId: 'device-b', probe: true })).toBeNull()
    expect(tokens.authorize('device-token', { deviceId: 'device-a', probe: true })?.probe).toBe(true)
  })

  it('lets the server token probe from anywhere', () => {
    const tokens = new ServerTokenRegistry()
    tokens.register({ token: 'main-token', label: 'Server token', scope: 'both', kind: 'server' })
    expect(tokens.authorize('main-token', { deviceId: null, probe: true })?.scope).toBe('both')
  })

  it('generates distinct device tokens', () => {
    const a = generateDeviceToken()
    const b = generateDeviceToken()
    expect(a).toHaveLength(48)
    expect(a).not.toBe(b)
  })
})

describe('credential helpers', () => {
  it('reads a bearer header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Enforcement in the transport
// ---------------------------------------------------------------------------

async function startServer() {
  const tokens = new ServerTokenRegistry()
  const clientGrant = tokens.register({ token: 'client-token', label: 'Window', scope: 'client', kind: 'server' })
  tokens.register({ token: 'device-token', label: 'Laptop', scope: 'device', kind: 'device' })

  const server = new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    requireAuth: true,
    validateToken: async (token, context) => tokens.authorize(token, context),
    serverId: 'test',
  })
  await server.listen()
  teardown.push(() => server.close())
  server.handle('ping', async () => 'pong')

  return { server, tokens, clientGrant }
}

async function connect(
  port: number,
  token: string,
  deviceId?: string,
  probe = false,
  capabilities: string[] = [],
  role?: 'window' | 'device',
) {
  const client = new WsRpcClient(`ws://127.0.0.1:${port}`, {
    token,
    workspaceId: 'ws-a',
    clientCapabilities: capabilities.length > 0 ? capabilities : undefined,
    clientInfo: deviceId
      ? { deviceId, ...(probe ? { probe: true } : {}), ...(role ? { role } : {}) }
      : role ? { role } : undefined,
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

describe('transport — credential scope', () => {
  it('lets a client-scope token call server channels', async () => {
    const { server } = await startServer()
    const client = await connect(server.port, 'client-token')
    expect(await client.invoke('ping')).toBe('pong')
  })

  it('refuses server channels for a device-scope token', async () => {
    const { server } = await startServer()
    const client = await connect(server.port, 'device-token', 'device-a', false, [CLIENT_DEVICE_EXEC])

    let caught: unknown
    try {
      await client.invoke('ping')
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('SCOPE_FORBIDDEN')
  })

  it('applies a widened scope to the link that is already connected', async () => {
    const { server, tokens } = await startServer()
    const link = await connect(server.port, 'device-token', 'device-a', false, [CLIENT_DEVICE_EXEC], 'device')

    let caught: unknown
    try {
      await link.invoke('ping')
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('SCOPE_FORBIDDEN')

    // Turning remote control back on must reach the open socket: the link was allowed to stay (it
    // is a device link either way), but the scope it answers with is now wider.
    const slot = tokens.list().find((token) => token.kind === 'device')
    expect(slot).toBeDefined()
    tokens.setScope(slot!.id, 'both')
    server.applyTokenScope(slot!.id, 'both')

    // The link's own copy is told, so the client UI can stop saying "remote control off".
    for (let i = 0; i < 40 && link.getTokenScope() !== 'both'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(link.getTokenScope()).toBe('both')

    expect(await link.invoke('ping')).toBe('pong')
  })

  it('refuses a device token that does not name the bound device', async () => {
    const { server } = await startServer()
    await connect(server.port, 'device-token', 'device-a', false, [CLIENT_DEVICE_EXEC])

    let caught: unknown
    try {
      await connect(server.port, 'device-token', 'device-b', false, [CLIENT_DEVICE_EXEC])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
  })

  it('acknowledges a probe with its scope without claiming or registering', async () => {
    const { server, tokens } = await startServer()
    const probe = await connect(server.port, 'device-token', 'device-a', true)

    expect(probe.getTokenScope()).toBe('device')
    expect(probe.isChannelAvailable('ping')).toBe(false)
    expect(server.getConnectedClientCount()).toBe(0)
    expect(tokens.list().find((token) => token.kind === 'device')?.deviceId).toBeNull()
  })

  it('refuses a probe from another device once the slot is bound', async () => {
    const { server } = await startServer()
    await connect(server.port, 'device-token', 'device-a', false, [CLIENT_DEVICE_EXEC])

    let caught: unknown
    try {
      await connect(server.port, 'device-token', 'device-b', true)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
  })

  it('refuses a device-scope credential that would open a window', async () => {
    const { server } = await startServer()

    let caught: unknown
    try {
      // The connection says it is a window; this credential may only lend this machine.
      await connect(server.port, 'device-token', 'device-a', false, [CLIENT_OPEN_EXTERNAL], 'window')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(server.getConnectedClientCount()).toBe(0)
  })

  it('lets a device link connect with device use turned off, under a device-scope token', async () => {
    // The role is declared, not inferred: this link lends nothing (the person turned device use
    // off) but it is still a device, not a window. Scope must not refuse it for declaring no tools.
    const { server } = await startServer()
    const link = await connect(server.port, 'device-token', 'device-a', false, [], 'device')

    expect(link.isConnected).toBe(true)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('reports a refused window as a scope failure, not as an unreachable server', async () => {
    const { server } = await startServer()
    const client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'device-token',
      clientCapabilities: [CLIENT_OPEN_EXTERNAL],
      clientInfo: { deviceId: 'device-a', role: 'window' },
      autoReconnect: false,
    })
    teardown.push(() => client.destroy())

    client.connect()
    const failed = await new Promise<ReturnType<WsRpcClient['getConnectionState']>>((resolve) => {
      const off = client.onConnectionStateChanged((next) => {
        if (next.status === 'failed' || next.status === 'disconnected') {
          off()
          resolve(next)
        }
      })
    })

    // "The hub said no" is different from "the hub did not answer": the UI says which right is
    // missing instead of claiming the server is down.
    expect(failed.lastError?.kind).toBe('scope')
    expect(failed.lastError?.code).toBe('REMOTE_CONTROL_DENIED')
  })

  it('lets a client-scope credential lend this machine', async () => {
    // A scope answers "may this pairing open windows", not "may it lend": what a machine lends is
    // its own folder list, and whether the hub uses it is the hub's switch. Refusing here would
    // make borrowing look like an attribute of coming in.
    const { server } = await startServer()
    const link = await connect(server.port, 'client-token', 'device-a', false, [CLIENT_DEVICE_EXEC])
    expect(link.isConnected).toBe(true)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('closing remote access drops the window and leaves the device link connected', async () => {
    const { server, tokens } = await startServer()
    // One pairing, one credential, two jobs — exactly what a saved server produces.
    const pair = tokens.register({ token: 'pair-token', label: 'Paired machine', scope: 'both', kind: 'device' })

    const link = await connect(server.port, 'pair-token', 'device-a', false, [CLIENT_DEVICE_EXEC], 'device')
    const window = await connect(server.port, 'pair-token', 'device-a', false, [CLIENT_OPEN_EXTERNAL], 'window')
    expect(server.getConnectedClientCount()).toBe(2)

    tokens.setScope(pair.tokenId, 'device')
    const dropped = server.revalidateTokenClients(
      pair.tokenId,
      ({ capabilities, role }) => scopePermits('device', role, capabilities),
    )
    expect(dropped).toBe(1)

    await new Promise<void>((resolve) => {
      const off = window.onConnectionStateChanged((state) => {
        if (state.status === 'disconnected' || state.status === 'failed') { off(); resolve() }
      })
    })
    expect(window.isConnected).toBe(false)
    expect(link.isConnected).toBe(true)
    expect(server.getConnectedClientCount()).toBe(1)
  })

  it('narrowing a pairing to client touches no connection', async () => {
    // `client` only says "windows allowed". Lending is not a scope question, so nothing is dropped
    // — a paired device is always allowed to be used, and no switch touches a socket.
    const { server, tokens } = await startServer()
    const pair = tokens.register({ token: 'pair-token', label: 'Paired machine', scope: 'both', kind: 'device' })

    const link = await connect(server.port, 'pair-token', 'device-a', false, [CLIENT_DEVICE_EXEC], 'device')
    const window = await connect(server.port, 'pair-token', 'device-a', false, [CLIENT_OPEN_EXTERNAL], 'window')

    tokens.setScope(pair.tokenId, 'client')
    expect(server.revalidateTokenClients(
      pair.tokenId,
      ({ capabilities, role }) => scopePermits('client', role, capabilities),
    )).toBe(0)

    expect(link.isConnected).toBe(true)
    expect(window.isConnected).toBe(true)
    expect(server.getConnectedClientCount()).toBe(2)
  })

  it('drops the connections of a removed credential', async () => {
    const { server, tokens, clientGrant } = await startServer()
    const client = await connect(server.port, 'client-token')
    expect(server.getConnectedClientCount()).toBe(1)

    expect(tokens.remove(clientGrant.tokenId)).toBe(false)
    expect(server.disconnectTokenClients(clientGrant.tokenId)).toBe(1)

    await new Promise<void>((resolve) => {
      const off = client.onConnectionStateChanged((state) => {
        if (state.status === 'disconnected' || state.status === 'failed') { off(); resolve() }
      })
    })
    expect(client.isConnected).toBe(false)
  })
})
