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
 * Both fields together say "run this inside the directory this device keeps for that hub's
 * workspace" (`<hub root base>/<hub device id>/<workspace id>`). The hub always sends them, and a
 * request without them is refused — a device link never falls back to the device's own workspaces.
 */
export interface DeviceHubContext {
  /** Stable device id of the hub that is asking. */
  hubDeviceId?: string
  /** The workspace the call works in — the session's workspace, not the connection's. */
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
