/**
 * The app-level connections to saved hubs.
 *
 * One link per saved server, each carrying shell, file and browser access for this machine.
 * They belong to the **app**, not to a window: a hub has to be able to drive this machine while
 * nothing is on screen, and one connection that outlives every window also means the hub is never
 * talking to a window that happens to be closing. Windows keep their own connections for the
 * workspace they show (see `preload/bootstrap.ts`); these carry no workspace and no UI, only the
 * capabilities that make this machine a device.
 *
 * A link exists exactly while its server is in the saved list, and reconnects on its own. Saving a
 * server is the whole of "this device can be driven by it"; nothing here depends on a window.
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
    if (next && next.url === link.url && next.token === link.token) continue
    stopLink(link)
    links.delete(id)
  }

  for (const [id, connection] of wanted) {
    if (links.has(id)) continue

    const client = new WsRpcClient(connection.url, {
      token: connection.token,
      autoReconnect: true,
      mode: 'remote',
      clientCapabilities: [...DEVICE_CAPABILITIES],
      clientInfo: connectionDeps.identity(),
      // The person typed this URL, so a hub with a self-signed certificate is accepted — the same
      // policy a window's hub connection uses.
      tlsRejectUnauthorized: false,
    })
    attachDeviceCapabilities(client, connectionDeps.browserPaneManager, connection.id)
    client.connect()
    links.set(id, { client, url: connection.url, token: connection.token })
    mainLog.info(`[hub] device connection opened to ${connection.url} (${connection.name})`)
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
