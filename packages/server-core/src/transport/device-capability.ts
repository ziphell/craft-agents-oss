/**
 * Wire protocol for the `client:device:exec` / `client:device:fs` capabilities.
 *
 * An app-level link to a saved server advertises these next to `client:browser:invoke`.
 * Every request is validated on the client inside the directory it keeps for that hub's
 * workspace — the hub names a path, the device decides whether that path is its business.
 */

import type { DeviceExecArgs, DeviceExecResult, DeviceFsArgs, DeviceFsResult } from '@craft-agent/shared/agent/device-tool'

/**
 * Where a call works on the receiving machine.
 *
 * `hubDeviceId` names the hub, and `workspaceId` is **that hub's** workspace id (the session's,
 * not the connection's). The device uses the pair only to keep one default working directory per
 * (hub, workspace) apart, so two workspaces never share a scratch directory. It is not path
 * authorization: a request may only touch the folders that connection saved on the device.
 *
 * The hub always sends both, and a request without them is refused — a device link never falls
 * back to the device's own workspaces.
 */
export interface DeviceHubContext {
  /** Stable device id of the hub that is asking. */
  hubDeviceId?: string
  /** This hub's workspace — an isolation key for the default directory, never an authorization. */
  workspaceId?: string
}

export interface DeviceExecRequest extends DeviceExecArgs, DeviceHubContext {
  v: 1
}

export type DeviceExecResponse = DeviceExecResult

export interface DeviceFsRequest extends DeviceFsArgs, DeviceHubContext {
  v: 1
}

export type DeviceFsResponse = DeviceFsResult
