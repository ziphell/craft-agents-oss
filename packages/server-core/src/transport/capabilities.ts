/**
 * Client capabilities — named actions a client can perform on behalf of the server.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import type { BrowserCapabilityRequest } from './browser-capability'
import type { RpcServer } from './types'
import type { TokenScope } from './tokens'

/** Capability: open a URL in the client's default browser. */
export const CLIENT_OPEN_EXTERNAL = 'client:openExternal'

/** Capability: open a file with the OS default application. */
export const CLIENT_OPEN_PATH = 'client:openPath'

/** Capability: reveal a file in Finder / Explorer. */
export const CLIENT_SHOW_IN_FOLDER = 'client:showItemInFolder'

/** Capability: show a confirmation dialog (message box) on the client. */
export const CLIENT_CONFIRM_DIALOG = 'client:confirmDialog'

/** Capability: show a native file/folder picker on the client. */
export const CLIENT_OPEN_FILE_DIALOG = 'client:openFileDialog'

/** Capability: show a native save-file picker on the client. */
export const CLIENT_SAVE_FILE_DIALOG = 'client:saveFileDialog'

/** Capability: drive a local `BrowserPaneManager` instance for a remote agent. */
export const CLIENT_BROWSER_INVOKE = 'client:browser:invoke'

/** Capability: run a shell command on this device for a remote agent. */
export const CLIENT_DEVICE_EXEC = 'client:device:exec'

/** Capability: read/write/list/search files on this device for a remote agent. */
export const CLIENT_DEVICE_FS = 'client:device:fs'

/**
 * The capabilities only a device link advertises — this machine lending itself to a server rather
 * than asking it for something.
 *
 * One list, two readers: the links in `apps/electron/src/main/hub-connection.ts` advertise exactly
 * these, and the handshake checks a credential's scope against the same list. Keeping them apart
 * would let "what a device is" and "what a device-scope credential permits" drift.
 */
export const DEVICE_CAPABILITIES = [
  CLIENT_DEVICE_EXEC,
  CLIENT_DEVICE_FS,
  CLIENT_BROWSER_INVOKE,
] as const

/** Whether these capabilities include any this machine lends to a server. */
export function hasDeviceCapability(capabilities: Iterable<string>): boolean {
  const declared = new Set(capabilities)
  return DEVICE_CAPABILITIES.some((capability) => declared.has(capability))
}

/**
 * What a connection is for, as the client declares it on the handshake.
 *
 * A **window** is a view of the hub (remote control). A **device** link is this machine lending
 * itself. The role is declared, never inferred from the capabilities a link advertises: a device
 * can turn its own authorization off and declare no tools at all while remaining a device link.
 */
export type ConnectionRole = 'window' | 'device'

/**
 * Whether a credential's scope permits a connection that plays `role`.
 *
 * A scope answers one question: **may this pairing open windows?** `device` says no, so a window
 * may not connect with it; a device link always may, whatever it declares. Device use is not a
 * scope question at all — the device alone decides it with its own authorization.
 *
 * A client that does not declare a role (older build) falls back to the previous inference: a
 * connection that declares a device tool is a device link, anything else is a window.
 */
export function scopePermits(
  scope: TokenScope,
  role: ConnectionRole | null | undefined,
  capabilities: Iterable<string>,
): boolean {
  if (scope !== 'device') return true
  if (role === 'window') return false
  if (role === 'device') return true
  return hasDeviceCapability(capabilities)
}

// ---------------------------------------------------------------------------
// Helper wrappers — thin error-handling around server.invokeClient()
// ---------------------------------------------------------------------------

/**
 * Ask a specific client to open a URL in its default browser.
 *
 * Returns `{ opened: true }` on success.
 * Returns `{ opened: false, error, authUrl }` on failure — caller can
 * show authUrl to user for manual "copy link / open" action.
 */
export async function requestClientOpenExternal(
  server: RpcServer,
  clientId: string,
  url: string,
): Promise<{ opened: boolean; error?: string; authUrl?: string }> {
  try {
    await server.invokeClient(clientId, CLIENT_OPEN_EXTERNAL, url)
    return { opened: true }
  } catch (err) {
    const code = (err as any)?.code
    const message = err instanceof Error ? err.message : String(err)
    return { opened: false, error: `${code ?? 'UNKNOWN'}: ${message}`, authUrl: url }
  }
}

/**
 * Ask the client to open a file with the OS default application.
 * Equivalent to Electron's `shell.openPath()`.
 */
export async function requestClientOpenPath(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<{ error?: string }> {
  try {
    const result = await server.invokeClient(clientId, CLIENT_OPEN_PATH, path)
    return result ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

/**
 * Ask the client to reveal a file in Finder / Explorer.
 * Equivalent to Electron's `shell.showItemInFolder()`.
 */
export async function requestClientShowInFolder(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<void> {
  await server.invokeClient(clientId, CLIENT_SHOW_IN_FOLDER, path)
}

/** Spec for a confirmation dialog (maps to Electron's MessageBoxOptions). */
export interface ConfirmDialogSpec {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * Ask the client to show a confirmation dialog.
 * Returns the index of the clicked button.
 */
export async function requestClientConfirmDialog(
  server: RpcServer,
  clientId: string,
  spec: ConfirmDialogSpec,
): Promise<{ response: number }> {
  return await server.invokeClient(clientId, CLIENT_CONFIRM_DIALOG, spec)
}

/** Spec for a file/folder picker dialog (maps to Electron's OpenDialogOptions). */
export interface FileDialogSpec {
  title?: string
  defaultPath?: string
  properties?: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * Ask the client to show a native file/folder picker.
 * Returns the selection result (canceled + filePaths).
 */
export async function requestClientOpenFileDialog(
  server: RpcServer,
  clientId: string,
  spec: FileDialogSpec,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  return await server.invokeClient(clientId, CLIENT_OPEN_FILE_DIALOG, spec)
}

/** Spec for a save-file picker dialog (maps to Electron's SaveDialogOptions). */
export interface SaveDialogSpec {
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * Ask the client to show a native save-file picker.
 * Returns the selection result (canceled + filePath).
 */
export async function requestClientSaveFileDialog(
  server: RpcServer,
  clientId: string,
  spec: SaveDialogSpec,
): Promise<{ canceled: boolean; filePath: string | null }> {
  return await server.invokeClient(clientId, CLIENT_SAVE_FILE_DIALOG, spec)
}

/**
 * Ask the client to invoke a `BrowserPaneManager` method.
 *
 * Errors propagate with `.code` preserved (see transport error-code preservation
 * in `client.ts` / `server.ts`). Callers can branch on `(err as any).code`.
 */
export async function requestClientBrowserInvoke<T>(
  server: RpcServer,
  clientId: string,
  req: BrowserCapabilityRequest,
): Promise<T> {
  return server.invokeClient(clientId, CLIENT_BROWSER_INVOKE, req) as Promise<T>
}
