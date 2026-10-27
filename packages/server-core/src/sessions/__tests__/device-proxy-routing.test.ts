/**
 * `device_tool` routing: meta vs proxy, and the no-fallback rule.
 *
 * The proxy side names a machine and must answer from **that** machine only. These tests pin the
 * two ways a call could otherwise drift: falling back to another connected device when the named
 * one cannot serve the capability, and picking a device from the caller/session context. Neither
 * happens — the failure is the answer.
 */

import { describe, it, expect } from 'bun:test'
import type { ConnectedClientInfo } from '@craft-agent/shared/protocol'
import { getDeviceId } from '@craft-agent/shared/config'
import { SessionManager } from '../SessionManager'
import { HubDeviceRegistry } from '../../domain/hub-device-registry'
import { CLIENT_BROWSER_INVOKE, CLIENT_DEVICE_EXEC, CLIENT_DEVICE_FS } from '../../transport/capabilities'
import type { RpcServer } from '../../transport/types'

interface InvokeRecord {
  clientId: string
  channel: string
  payload: Record<string, unknown>
}

function client(overrides: Partial<ConnectedClientInfo> & { clientId: string }): ConnectedClientInfo {
  return {
    deviceId: overrides.clientId,
    allowedRoots: ['/work'],
    hubRootBase: null,
    name: overrides.clientId,
    platform: 'test',
    version: null,
    mode: 'remote',
    workspaceId: 'ws-1',
    webContentsId: null,
    capabilities: [],
    scope: 'both',
    tokenKind: 'device',
    connectedAt: 0,
    ...overrides,
  }
}

function makeServer(clients: ConnectedClientInfo[], calls: InvokeRecord[]): RpcServer {
  const byId = new Map(clients.map((entry) => [entry.clientId, entry]))
  return {
    handle() {},
    push() {},
    async invokeClient(clientId, channel, ...args) {
      calls.push({ clientId, channel, payload: args[0] as Record<string, unknown> })
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 1, cwd: '/work' }
    },
    async invokeClientWithTimeout(clientId, channel, args) {
      calls.push({ clientId, channel, payload: args[0] as Record<string, unknown> })
      return { stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 1, cwd: '/work' }
    },
    hasClientCapability: (clientId, capability) => byId.get(clientId)?.capabilities.includes(capability) ?? false,
    findClientsWithCapability: (capability) =>
      clients.filter((entry) => entry.capabilities.includes(capability)).map((entry) => entry.clientId),
    getConnectedClients: () => clients,
    isLocalClient: (clientId) => byId.get(clientId)?.mode === 'local',
  }
}

function setup(clients: ConnectedClientInfo[]) {
  const calls: InvokeRecord[] = []
  const registry = new HubDeviceRegistry(null)
  const sm = new SessionManager()
  sm.setDeviceRegistry(registry)
  sm.setRpcServer(makeServer(clients, calls))
  // Records are written at connect time, not while listing. Mirror that here so the tests exercise
  // the same path: only a link that offers a device tool gets a record.
  for (const entry of clients) sm.onClientConnected(entry.clientId)
  // The browser surface is not under test here; a sentinel makes it obvious if a proxy call ever
  // reaches for the conversation's own browser instead of the named device's.
  const fns = (sm as unknown as {
    createDeviceToolFns: (workspaceId: string, getBrowserFns: (clientId: string) => unknown) => {
      list: () => Promise<Array<{ id: string; allowedRoots: string[]; defaultRoot?: string }>>
      exec: (device: string, args: { command: string }) => Promise<unknown>
      fs: (device: string, args: { op: string; path: string }) => Promise<unknown>
      getBrowserFns: (device: string) => Promise<unknown>
    }
  }).createDeviceToolFns('ws-1', () => ({ sentinel: true }))
  return { sm, fns, calls, registry }
}

describe('device_tool — explicit proxy routing', () => {
  it('lists one row per device, with the capabilities it advertises', async () => {
    const { fns } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC, CLIENT_DEVICE_FS] }),
      client({ clientId: 'c-2', deviceId: 'build', name: 'build', capabilities: [CLIENT_BROWSER_INVOKE] }),
    ])

    const devices = await fns.list()
    expect(devices.map((device) => device.id)).toEqual(['build', 'office'])
  })

  it('refuses an unknown device instead of using another one', async () => {
    const { fns, calls } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await expect(fns.exec('build', { command: 'ls' })).rejects.toThrow('No device "build"')
    expect(calls).toHaveLength(0)
  })

  it('refuses a device that does not allow shell, even when another device does', async () => {
    const { fns, calls } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
      client({ clientId: 'c-2', deviceId: 'build', name: 'build', capabilities: [CLIENT_DEVICE_FS] }),
    ])

    await expect(fns.exec('build', { command: 'ls' })).rejects.toThrow('does not offer shell')
    expect(calls).toHaveLength(0)
  })

  it('sends the call to the named device only', async () => {
    const { fns, calls } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
      client({ clientId: 'c-2', deviceId: 'build', name: 'build', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await fns.exec('office', { command: 'ls' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      clientId: 'c-1',
      channel: CLIENT_DEVICE_EXEC,
      payload: { hubDeviceId: getDeviceId(), workspaceId: 'ws-1', command: 'ls' },
    })
  })

  it('keeps the session hub and workspace even when args name another', async () => {
    const { fns, calls } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    // The hub and workspace are the caller's context, never something a nested argument supplies.
    const hostile = { command: 'ls', workspaceId: 'ws-other', hubDeviceId: 'other-hub' } as { command: string }
    await fns.exec('office', hostile)

    expect(calls[0]?.payload).toMatchObject({
      hubDeviceId: getDeviceId(),
      workspaceId: 'ws-1',
      command: 'ls',
    })
  })

  it('picks a connection of the named device that can serve the capability', async () => {
    const { fns, calls } = setup([
      client({ clientId: 'c-fs', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_FS] }),
      client({ clientId: 'c-shell', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await fns.exec('office', { command: 'ls' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.clientId).toBe('c-shell')
  })

  it('does not list this server’s own machine as a device', async () => {
    const { fns } = setup([
      client({ clientId: 'c-local', mode: 'local', deviceId: 'hub', capabilities: [CLIENT_DEVICE_EXEC, CLIENT_DEVICE_FS] }),
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    const devices = await fns.list()
    expect(devices.map((device) => device.id)).toEqual(['office'])
    await expect(fns.exec('hub', { command: 'ls' })).rejects.toThrow('No device "hub"')
  })

  it('lists the authorized folders, and the default directory separately', async () => {
    const { fns } = setup([
      client({
        clientId: 'c-1',
        deviceId: 'office',
        workspaceId: 'ws-1',
        allowedRoots: ['/work', '/shared'],
        hubRootBase: '/home/me/.craft-agent/.hub',
        capabilities: [CLIENT_DEVICE_EXEC],
      }),
    ])

    const devices = await fns.list()
    const office = devices.find((device) => device.id === 'office')
    // Only the folders saved on the device's connection are granted; the per-hub working
    // directory is reported apart, because it is a fixed starting point rather than a granted root.
    expect(office?.allowedRoots).toEqual(['/work', '/shared'])
    expect(office?.defaultRoot).toBe(`/home/me/.craft-agent/.hub/${getDeviceId()}/ws-1`)
  })

  it('refuses a browser proxy for a device without browser capability', async () => {
    const { fns } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await expect(fns.getBrowserFns('office')).rejects.toThrow('does not offer browser')
  })

  it('lists a device that turned its own authorization off, marked unauthorized', async () => {
    // The row is the pairing, not the offer: turning device use off hides nothing, it shows the
    // state — the hub can see the device and knows it cannot be used right now.
    const { fns, sm } = setup(
      [client({ clientId: 'c-view', deviceId: 'office', name: 'office', capabilities: [] })],
    )

    expect(sm.getConnectedDevices()).toMatchObject([
      { id: 'office', online: true, deviceAllows: false, available: false },
    ])
    expect(sm.getAgentDevices()).toEqual([])
    await expect(fns.exec('office', { command: 'ls' })).rejects.toThrow('does not offer shell access')
  })

  it('does not record a link that authenticated with the server token', () => {
    // The server token is the hub's own credential, not a one-to-one device pairing — so a
    // connection that used it is never a device row, even if it declares device tools.
    const { sm } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', tokenKind: 'server', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    expect(sm.getConnectedDevices()).toEqual([])
  })

  it('keeps a deleted device deleted while its link is still connected', () => {
    // Deleting is the hub's decision; a read must not recreate the record from the live link.
    const { sm } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    sm.forgetDevice('office')

    expect(sm.getConnectedDevices()).toEqual([])
  })

  it('reports a connected device as available without a second approval', () => {
    const { sm } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    // The pairing is the consent; there is nothing else for the person to switch on.
    expect(sm.getConnectedDevices()).toMatchObject([
      { id: 'office', online: true, deviceAllows: true, available: true },
    ])
    expect(sm.getAgentDevices()).toHaveLength(1)
    expect(sm.hasAvailableDevices()).toBe(true)
  })

  it('keeps an offline record in the settings list but out of the agent list', () => {
    const registry = new HubDeviceRegistry(null)
    registry.ensure({ deviceId: 'office', name: 'Office' })

    const sm = new SessionManager()
    sm.setDeviceRegistry(registry)
    sm.setRpcServer(makeServer([], []))

    expect(sm.getConnectedDevices()).toMatchObject([
      { id: 'office', online: false, available: false },
    ])
    expect(sm.getAgentDevices()).toEqual([])
  })

  it('requires an unambiguous name', async () => {
    const { fns } = setup([
      client({ clientId: 'c-1', deviceId: 'device-a', name: 'workstation', capabilities: [CLIENT_DEVICE_EXEC] }),
      client({ clientId: 'c-2', deviceId: 'device-b', name: 'workstation', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await expect(fns.exec('workstation', { command: 'ls' })).rejects.toThrow('more than one device')
  })
})
