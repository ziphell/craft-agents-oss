/**
 * The app-level connections to saved hubs.
 *
 * One link per saved server. It exists for two independent reasons: it is how this machine makes
 * requests on its own behalf (workspace creation, directory browsing), and it is how a hub reaches
 * this machine as a device.
 *
 * Connecting is offering: every link advertises this machine's tools. The folder list only bounds
 * where those tools may work — an empty list means the per-hub working directory the device keeps
 * for calls without `cwd` — and whether the hub actually uses them is decided there. Which
 * direction a pairing is for is the invite's business (the token's scope).
 *
 * A link exists exactly while its server is in the saved list, and reconnects on its own.
 */

import { CLIENT_COMPUTER_INVOKE, DEVICE_CAPABILITIES } from '@craft-agent/server-core/transport'
import type { ComputerPaneFns } from '@craft-agent/shared/agent'
import { isComputerUseAdvertised } from './computer-use-manager'
import type { RemoteConnection } from '@craft-agent/shared/config/client-config'
import type { TransportConnectionStatus } from '../shared/types'
import { WsRpcClient } from '../transport/client'
import { attachDeviceCapabilities } from './device-access'
import type { BrowserPaneManager } from './browser-pane-manager'
import { mainLog } from './logger'

/** This install's identity, as the hub sees it (the handshake's `clientInfo`). */
export interface HubClientIdentity {
  deviceId: string
  name: string
  platform: string
  /** App version, shown beside this device on the hub; never used to gate compatibility. */
  version?: string
  /** Base identity sends none; each device link replaces this with its connection's authorized folders. */
  allowedRoots: string[]
  hubRootBase?: string
}

export interface HubConnectionDeps {
  /** This install's identity, as advertised on the handshake (same as `__get-client-identity`). */
  identity: () => HubClientIdentity
  /** The browser this process runs, if one exists yet. */
  browserPaneManager: () => BrowserPaneManager | null
  /** This machine's desktop, offered to hubs only once a driver actually answered. */
  computerUseManager: () => { fnsForSession(sessionId: string): Promise<ComputerPaneFns> } | null
}

interface Link {
  client: WsRpcClient
  url: string
  token: string
  allowedRoots: string[]
  /** Whether this link offers the machine at all (`deviceUseEnabled`, default on). */
  deviceUseEnabled: boolean
}

/** Same folders, in the same order — used to decide whether a saved edit needs a new handshake. */
function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((root, index) => root === b[index])
}

/** Folders are irrelevant while the machine is not offered, so compare the effective value. */
function offersDevice(connection: RemoteConnection): boolean {
  return connection.deviceUseEnabled !== false
}

/** One live link per saved connection id. */
const links = new Map<string, Link>()

/**
 * Make the app-level links match `connections` — one link per saved server.
 *
 * Idempotent per connection: an unchanged URL and token keep the socket they already have, so
 * editing an unrelated server never drops the others. A changed URL or token replaces that one
 * link, because the token is part of the handshake and cannot be swapped on a live socket.
 */
/**
 * Rebuild every live link, so the handshake offers what this machine offers **now**.
 *
 * `clientCapabilities` is fixed when a client is constructed, so a capability cannot be withdrawn
 * from a socket that is already open — the link has to be torn down and made again. The last
 * `syncHubConnections` call is remembered here for exactly that: refresh is a sync with the same
 * connections and the same dependencies, after dropping the old sockets.
 */
export function refreshHubLinks(): void {
  for (const link of links.values()) {
    try {
      link.client.destroy()
    } catch { /* already gone */ }
  }
  links.clear()
  if (!lastSync) return
  syncHubConnections(lastSync.connections, lastSync.deps)
}

let lastSync: { connections: readonly RemoteConnection[]; deps: HubConnectionDeps } | null = null

export function syncHubConnections(
  connections: readonly RemoteConnection[],
  connectionDeps: HubConnectionDeps,
): void {
  lastSync = { connections, deps: connectionDeps }
  const wanted = new Map(
    connections
      .filter((connection) => connection.url.trim() && connection.token.trim())
      .map((connection) => [connection.id, connection]),
  )

  for (const [id, link] of links) {
    const next = wanted.get(id)
    if (
      next
      && next.url === link.url
      && next.token === link.token
      && offersDevice(next) === link.deviceUseEnabled
      && sameRoots(next.allowedRoots ?? [], link.allowedRoots)
    ) continue
    stopLink(link)
    links.delete(id)
  }

  for (const [id, connection] of wanted) {
    if (links.has(id)) continue

    // Capabilities are fixed at handshake. The person can turn this machine's use off without
    // dropping the connection: the link stays up (remote control, workspace browsing) but declares
    // no device tools, and the hub shows the device as not authorized. The folder list is still
    // kept — it says where the tools may work once authorization is back on.
    const allowedRoots = connection.allowedRoots ?? []
    const deviceUseEnabled = offersDevice(connection)
    const identity = connectionDeps.identity()
    // Never this install's whole workspace list: only the folders saved on this connection.
    // `role` is declared, not inferred: this link is this machine lending itself, whether or not
    // the person has turned device use off.
    const clientInfo = { ...identity, allowedRoots, role: 'device' as const }
    const client = new WsRpcClient(connection.url, {
      token: connection.token,
      autoReconnect: true,
      mode: 'remote',
      // Fail-closed: a desktop is offered only when this build has a driver that answered. Listing
      // it without one advertises a door whose every command fails.
      clientCapabilities: deviceUseEnabled
        ? DEVICE_CAPABILITIES.filter(
            (capability) => capability !== CLIENT_COMPUTER_INVOKE || isComputerUseAdvertised(),
          )
        : [],
      clientInfo,
      // The person typed this URL, so a hub with a self-signed certificate is accepted — the same
      // policy a window's hub connection uses.
      tlsRejectUnauthorized: false,
    })
    if (deviceUseEnabled) {
      attachDeviceCapabilities(
        client,
        connectionDeps.browserPaneManager,
        connectionDeps.computerUseManager,
        connection.id,
        allowedRoots,
      )
    }
    client.connect()
    links.set(id, { client, url: connection.url, token: connection.token, allowedRoots, deviceUseEnabled })
    mainLog.info(`[hub] link opened to ${connection.url} (${connection.name}, ${deviceUseEnabled ? `${allowedRoots.length} extra folders` : 'device use off'})`)
  }
}

/** Drop every app-level link (quit, or when the saved list is cleared). */
export function stopHubConnections(): void {
  for (const link of links.values()) stopLink(link)
  links.clear()
}

/**
 * The live link to one saved server, for requests this machine makes **on its own behalf**.
 *
 * Narrow on purpose: the only caller is workspace creation, which has to ask a server the person
 * picked in a dialog — not the server this window happens to be showing. `invoke` waits for the
 * link to be connected, so a freshly saved server answers as soon as its socket is up.
 */
export function getHubConnectionClient(connectionId: string): WsRpcClient | null {
  return links.get(connectionId)?.client ?? null
}

/**
 * Whether this machine is currently able to reach one saved server.
 *
 * `null` when no link exists (nothing saved under that id, or no token yet). The saved-server list
 * shows this so "saved" and "reachable right now" are not confused.
 */
export function getHubConnectionStatus(connectionId: string): TransportConnectionStatus | null {
  return links.get(connectionId)?.client.getConnectionState().status ?? null
}

function stopLink(link: Link): void {
  try {
    link.client.destroy()
  } catch (error) {
    mainLog.warn('[hub] failed to close the device connection:', error)
  }
}
