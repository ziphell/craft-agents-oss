/**
 * The bridge process: connect out to the hub and answer its device calls.
 *
 * No listener is opened — only an outbound WebSocket — so a bridge behind NAT works without any
 * firewall change on this side.
 */

import { hostname } from 'node:os'
import {
  CLIENT_DEVICE_EXEC,
  CLIENT_DEVICE_FS,
  WsRpcClient,
  type DeviceExecRequest,
  type DeviceFsRequest,
} from '@craft-agent/server-core/transport'
import { runExec, runFs } from '@craft-agent/server-core/device'
import type { BridgeConfig } from './config'

export function log(message: string): void {
  console.log(`${new Date().toISOString()} [bridge] ${message}`)
}

function capabilitiesFor(config: BridgeConfig): string[] {
  return [
    ...(config.grants?.shell !== false ? [CLIENT_DEVICE_EXEC] : []),
    ...(config.grants?.files !== false ? [CLIENT_DEVICE_FS] : []),
  ]
}

/** Run until SIGINT/SIGTERM. Reconnects on its own otherwise. */
export async function startBridge(config: BridgeConfig): Promise<void> {
  const name = config.name || hostname()
  const allowedRoots = config.allowedRoots ?? []
  const shell = config.grants?.shell !== false
  const files = config.grants?.files !== false

  log(`device ${name} (${config.deviceId}) → ${config.hub}`)
  log(`roots: ${allowedRoots.length > 0 ? allowedRoots.join(', ') : '(scratch directory only)'}`)
  log(`grants: ${[shell && 'shell', files && 'files'].filter(Boolean).join(', ')}`)

  const client = new WsRpcClient(config.hub, {
    token: config.token,
    autoReconnect: true,
    // The hub restarting is routine for a service; keep retrying through its shutdown notice.
    reconnectAfterServerShutdown: true,
    mode: 'remote',
    clientInfo: {
      deviceId: config.deviceId,
      name,
      platform: process.platform,
      role: 'device',
      allowedRoots,
    },
    clientCapabilities: capabilitiesFor(config),
    tlsRejectUnauthorized: config.tlsRejectUnauthorized !== false,
  })

  // Grants are checked again per call: the handshake list is fixed, but the config can be edited
  // and a hub that kept the old list must still be refused.
  client.handleCapability(CLIENT_DEVICE_EXEC, async (req: DeviceExecRequest) => {
    if (!shell) throw new Error('This device does not offer shell access.')
    if (!req || req.v !== 1) throw new Error('Unsupported device exec request')
    return await runExec(req, allowedRoots)
  })
  client.handleCapability(CLIENT_DEVICE_FS, async (req: DeviceFsRequest) => {
    if (!files) throw new Error('This device does not offer file access.')
    if (!req || req.v !== 1) throw new Error('Unsupported device fs request')
    return await runFs(req, allowedRoots)
  })

  client.onConnectionStateChanged((state) => {
    if (state.status === 'connected') {
      log('connected')
    } else if (state.status === 'reconnecting' || state.status === 'disconnected') {
      const detail = state.lastError?.message ?? state.lastClose?.reason
      const retry = state.nextRetryInMs ? ` (retry in ${Math.round(state.nextRetryInMs / 1000)}s)` : ''
      log(`${state.status} after attempt ${state.attempt}${detail ? `: ${detail}` : ''}${retry}`)
    }
  })

  client.connect()

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log(`${signal} — disconnecting`)
      client.destroy()
      resolve()
    }
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.once('SIGTERM', () => shutdown('SIGTERM'))
  })
}

/**
 * Ask the hub whether this credential works, without claiming the device slot.
 *
 * The handshake's `probe` flag validates and returns the scope, then the server forgets the
 * connection; `doctor` therefore works before the first real connect.
 */
export async function probeHub(config: BridgeConfig): Promise<{ ok: boolean; scope?: string; error?: string }> {
  const client = new WsRpcClient(config.hub, {
    token: config.token,
    autoReconnect: false,
    mode: 'remote',
    connectTimeout: 8_000,
    // A device slot needs `deviceId` even for a probe (the server refuses a slot without a
    // machine), and `role: 'device'` because a device-scope credential cannot open windows.
    clientInfo: {
      deviceId: config.deviceId,
      name: config.name || hostname(),
      platform: process.platform,
      role: 'device',
      probe: true,
    },
    tlsRejectUnauthorized: config.tlsRejectUnauthorized !== false,
  })

  return await new Promise((resolve) => {
    let settled = false
    const finish = (result: { ok: boolean; scope?: string; error?: string }) => {
      if (settled) return
      settled = true
      client.destroy()
      resolve(result)
    }
    client.onConnectionStateChanged((state) => {
      if (state.status === 'connected') {
        finish({ ok: true, scope: client.getTokenScope() ?? undefined })
      } else if (state.status === 'failed' || state.status === 'disconnected') {
        finish({ ok: false, error: state.lastError?.message ?? state.lastClose?.reason ?? 'connection failed' })
      }
    })
    client.connect()
    setTimeout(() => finish({ ok: false, error: 'timeout after 8s' }), 10_000)
  })
}
