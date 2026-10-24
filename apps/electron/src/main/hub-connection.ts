/**
 * The app-level connections to saved hubs.
 *
 * One link per saved server. It exists for two independent reasons: it is how this machine makes
 * requests on its own behalf (workspace creation, directory browsing), and it is how a hub reaches
 * this machine as a device. The second reason is opt-in: `deviceAccess` must be true on the saved
 * connection, otherwise the link carries no device capabilities at all. Connecting a window to a
 * hub never grants it shell/files/browser access by itself.
 *
 * A link exists exactly while its server is in the saved list, and reconnects on its own.
 */

import {
  CLIENT_BROWSER_INVOKE,
  CLIENT_DEVICE_EXEC,
  CLIENT_DEVICE_FS,
} from '@craft-agent/server-core/transport'
import type { RemoteConnection } from '@craft-agent/shared/config/client-config'
import type { TransportConnectionStatus } from '../shared/types'
import { WsRpcClient } from '../transport/client'
import { attachDeviceCapabilities } from './device-access'
import type { BrowserPaneManager } from './browser-pane-manager'
import { mainLog } from './logger'

/** The capabilities this connection advertises — exactly the three it can answer. */
const DEVICE_CAPABILITIES = [CLIENT_DEVICE_EXEC, CLIENT_DEVICE_FS, CLIENT_BROWSER_INVOKE] as const

/** This install's identity, as the hub sees it (the handshake's `clientInfo`). */
export interface HubClientIdentity {
  deviceId: string
  name: string
  platform: string
  /** App version, shown beside this device on the hub; never used to gate compatibility. */
  version?: string
  workspaceRoots: string[]
  hubRootBase?: string
}

export interface HubConnectionDeps {
  /** This install's identity, as advertised on the handshake (same as `__get-client-identity`). */
  identity: () => HubClientIdentity
  /** The browser this process runs, if one exists yet. */
  browserPaneManager: () => BrowserPaneManager | null
}

interface Link {
  client: WsRpcClient
  url: string
  token: string
  deviceAccess: boolean
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
export function syncHubConnections(
  connections: readonly RemoteConnection[],
  connectionDeps: HubConnectionDeps,
): void {
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
      && (next.deviceAccess === true) === link.deviceAccess
    ) continue
    stopLink(link)
    links.delete(id)
  }

  for (const [id, connection] of wanted) {
    if (links.has(id)) continue

    // Capabilities are fixed at handshake. A link that is not allowed to use this machine still
    // connects — workspace creation and other control-plane requests ride it — but advertises
    // nothing, so the hub cannot list this machine as a drivable device.
    const deviceAccess = connection.deviceAccess === true
    const client = new WsRpcClient(connection.url, {
      token: connection.token,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: deviceAccess ? [...DEVICE_CAPABILITIES] : [],
      clientInfo: connectionDeps.identity(),
      // The person typed this URL, so a hub with a self-signed certificate is accepted — the same
      // policy a window's hub connection uses.
      tlsRejectUnauthorized: false,
    })
    if (deviceAccess) {
      attachDeviceCapabilities(client, connectionDeps.browserPaneManager, connection.id)
    }
    client.connect()
    links.set(id, { client, url: connection.url, token: connection.token, deviceAccess })
    mainLog.info(`[hub] link opened to ${connection.url} (${connection.name}, device access: ${deviceAccess})`)
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
