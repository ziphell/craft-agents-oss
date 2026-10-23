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
    workspaceRoots: ['/work'],
    hubRootBase: null,
    name: overrides.clientId,
    platform: 'test',
    mode: 'remote',
    workspaceId: 'ws-1',
    webContentsId: null,
    capabilities: [],
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
  const sm = new SessionManager()
  sm.setRpcServer(makeServer(clients, calls))
  // The browser surface is not under test here; a sentinel makes it obvious if a proxy call ever
  // reaches for the conversation's own browser instead of the named device's.
  const fns = (sm as unknown as {
    createDeviceToolFns: (workspaceId: string, getBrowserFns: (clientId: string) => unknown) => {
      list: () => Promise<Array<{ id: string; workspaceRoots: string[] }>>
      exec: (device: string, args: { command: string }) => Promise<unknown>
      fs: (device: string, args: { op: string; path: string }) => Promise<unknown>
      getBrowserFns: (device: string) => Promise<unknown>
    }
  }).createDeviceToolFns('ws-1', () => ({ sentinel: true }))
  return { sm, fns, calls }
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

    await expect(fns.exec('build', { command: 'ls' })).rejects.toThrow('does not allow shell')
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

  it('names the per-hub working directory as a remote device’s root', async () => {
    const { fns } = setup([
      client({
        clientId: 'c-1',
        deviceId: 'office',
        workspaceId: 'ws-1',
        hubRootBase: '/home/me/.craft-agent/.hub',
        capabilities: [CLIENT_DEVICE_EXEC],
      }),
    ])

    const devices = await fns.list()
    const office = devices.find((device) => device.id === 'office')
    expect(office?.workspaceRoots).toEqual([`/home/me/.craft-agent/.hub/${getDeviceId()}/ws-1`])
  })

  it('refuses a browser proxy for a device without browser capability', async () => {
    const { fns } = setup([
      client({ clientId: 'c-1', deviceId: 'office', name: 'office', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await expect(fns.getBrowserFns('office')).rejects.toThrow('does not allow browser')
  })

  it('requires an unambiguous name', async () => {
    const { fns } = setup([
      client({ clientId: 'c-1', deviceId: 'device-a', name: 'workstation', capabilities: [CLIENT_DEVICE_EXEC] }),
      client({ clientId: 'c-2', deviceId: 'device-b', name: 'workstation', capabilities: [CLIENT_DEVICE_EXEC] }),
    ])

    await expect(fns.exec('workstation', { command: 'ls' })).rejects.toThrow('more than one device')
  })
})
