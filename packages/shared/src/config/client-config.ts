/**
 * Remote servers this app can open windows on.
 *
 * Like VS Code's remote hosts: the list belongs to the app, a window is what is connected to one
 * of them, and Server Mode keeps running locally either way. There is no "remote workspace" —
 * a remote window shows a workspace that lives on that server.
 */

export interface RemoteConnection {
  /** Stable identity; survives a rename or a new token. */
  id: string
  /** Display name — the person's label, or the URL's hostname. */
  name: string
  /** WebSocket URL of the hub server (ws:// or wss://) */
  url: string
  /** Bearer token for the hub server */
  token: string
  /** The workspace this app last opened on that server, offered next time. */
  lastWorkspaceId?: string
  /**
   * Whether this machine lets that server use it as a device (shell, files, browser).
   *
   * On by default. Turning it off keeps the saved connection — remote control (windows) still
   * works — and the folders above stay saved, so authorization can be turned back on later. The
   * app-level link then declares no device tools, and the hub shows the device as not authorized.
   */
  deviceUseEnabled?: boolean
  /**
   * Extra folders this server's agent may reach on this machine, beyond the per-hub working
   * directory used for calls without `cwd`. Empty means no additional folders. The list is kept
   * while `deviceUseEnabled` is off, so turning authorization back on restores it.
   */
  allowedRoots?: string[]
}

export interface ClientConfig {
  /** Servers this app knows how to reach. */
  connections: RemoteConnection[]
}

/** Every connection's identity is its id; a URL that is already saved is the same server. */
export function findConnectionByUrl(
  connections: readonly RemoteConnection[],
  url: string,
): RemoteConnection | undefined {
  return connections.find((connection) => connection.url === url)
}

/** A readable default name for a server the person has not named yet. */
export function connectionNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * The key browser state is filed under on the machine that runs the browser.
 *
 * Browser windows are per workspace, but this machine can host them for several servers at once —
 * and two servers may both own a workspace with the same id. So a server's workspace is filed
 * under the saved connection that names that server: `hub:<connectionId>:<workspaceId>`. A local
 * window passes no connection and keeps its workspace id unchanged.
 */
export function browserWorkspaceKey(
  connectionId: string | null | undefined,
  workspaceId: string | null,
): string | null {
  if (!connectionId) return workspaceId
  return `hub:${connectionId}:${workspaceId ?? ''}`
}
