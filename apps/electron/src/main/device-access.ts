/**
 * Device access — this machine's contribution to a hub's device links.
 *
 * The shell and file operations live in `@craft-agent/server-core/device`, shared with the
 * standalone bridge. This file only teaches one connection to answer them, next to the
 * Electron-only browser and desktop doors.
 *
 * Advertised as `client:device:exec` / `client:device:fs` on the app-level links to saved
 * servers (`hub-connection.ts`); windows no longer answer these.
 */

import { getComputerUseEnabled } from '@craft-agent/shared/config'
import type {
  BrowserCapabilityRequest,
  DeviceExecRequest,
  DeviceExecResponse,
  DeviceFsRequest,
  DeviceFsResponse,
} from '@craft-agent/server-core/transport'
import {
  CLIENT_BROWSER_INVOKE,
  CLIENT_COMPUTER_INVOKE,
  CLIENT_DEVICE_EXEC,
  CLIENT_DEVICE_FS,
} from '@craft-agent/server-core/transport'
import { runExec, runFs } from '@craft-agent/server-core/device'
import type { LinkGrants } from './hub-connection'
import { dispatchComputerCapability, type ComputerCapabilityRequest, type ComputerPaneFns } from '@craft-agent/shared/agent'
import type { WsRpcClient } from '../transport/client'

/**
 * Teach one connection to answer as this machine: shell, files, browser.
 *
 * Used by the app-level link to a saved hub (`hub-connection.ts`), so another machine reaches this
 * one without depending on a window. The browser is read per call: it is created after these.
 *
 * `connectionId` is the saved server this link belongs to. Browser windows are filed under it, so
 * two servers that happen to use the same workspace id never share one (`browserWorkspaceKey`).
 * `allowedRoots` is that saved server's folder list, captured when the link was built: the link is
 * rebuilt whenever the list changes, so a request never re-reads the config.
 */
export function attachDeviceCapabilities(
  client: WsRpcClient,
  browserPaneManager: () => { dispatchCapability(req: BrowserCapabilityRequest, connectionId?: string | null): Promise<unknown> } | null,
  computerUseManager: () => { fnsForSession(sessionId: string): Promise<ComputerPaneFns> } | null,
  connectionId: string,
  allowedRoots: readonly string[],
  grants: LinkGrants,
): void {
  // Each door checks its own grant. The capability list already keeps an ungranted door out of
  // the handshake; this is the second half — a server that kept an older list still gets refused.
  client.handleCapability(CLIENT_DEVICE_EXEC, async (req: DeviceExecRequest): Promise<DeviceExecResponse> => {
    if (!grants.shell) throw new Error('This server is not allowed to run commands on this machine.')
    if (!req || req.v !== 1) throw new Error('Unsupported device exec request')
    return await runExec(req, allowedRoots)
  })
  client.handleCapability(CLIENT_DEVICE_FS, async (req: DeviceFsRequest): Promise<DeviceFsResponse> => {
    if (!grants.files) throw new Error('This server is not allowed to read or write files on this machine.')
    if (!req || req.v !== 1) throw new Error('Unsupported device fs request')
    return await runFs(req, allowedRoots)
  })
  client.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest): Promise<unknown> => {
    if (!grants.browser) throw new Error("This server is not allowed to use this machine's browser.")
    const manager = browserPaneManager()
    if (!manager) throw new Error('This app has no browser to drive')
    return await manager.dispatchCapability(req, connectionId)
  })
  // This machine's desktop, for a hub that asked for it. The session id is the **connection**, so a
  // remote hub holds the same 90 s lease a local conversation does — and two hubs cannot both drive
  // this pointer, which is the whole point of the lease.
  client.handleCapability(CLIENT_COMPUTER_INVOKE, async (req: ComputerCapabilityRequest): Promise<unknown> => {
    if (!grants.computer) throw new Error("This server is not allowed to drive this machine's desktop.")
    if (!req || req.v !== 1) throw new Error('Unsupported computer request')
    // Capabilities are fixed at handshake, so a link opened while the switch was on can outlive it.
    // Re-reading the switch here is what makes turning it off effective immediately, rather than
    // at the next reconnect.
    // This request came from a **server**, so both levels are checked: the machine-level switch
    // (driver + OS grants), and the per-connection grant in `grants.computer` below.
    if (!getComputerUseEnabled()) throw new Error('Desktop control is turned off in Settings.')
    const manager = computerUseManager()
    if (!manager) throw new Error('This app has no desktop to drive')
    const fns = await manager.fnsForSession(`remote:${connectionId}`)
    return await dispatchComputerCapability(fns, req.method, req.args ?? [])
  })
}
