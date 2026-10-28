/**
 * Device tool — a meta-tool that runs an ordinary tool on a named device.
 *
 * The device is a **parameter of the meta-tool**, not a flag hidden inside each
 * operation: one call names the machine and the nested tool, so several devices
 * can be used in the same turn (including in parallel) and adding a new tool
 * does not mean adding another `--device` spelling.
 */

import type { BrowserPaneFns } from './browser-pane.ts'
import type { ComputerPaneFns } from './computer-pane.ts'

/** One connected device, as `device_tool {"tool":"devices"}` reports it. */
export interface DeviceToolInfo {
  /** Stable id (preferred in calls) — survives reconnects. */
  id: string
  /** Display name (hostname), also accepted when unique. */
  name: string
  /** The person's own name for this device, set on the hub. Accepted like `name` in calls. */
  alias?: string
  platform: string | null
  /** App version the device advertised, when it sent one. Diagnostics only — never a gate. */
  version: string | null
  /** Folders this connection authorized for this server. */
  allowedRoots: string[]
  /** Where a call that omits `cwd` starts — a fixed, always-usable directory (not a granted extra). */
  defaultRoot?: string
  /** A client from this device is connected right now. */
  online: boolean
  /** The device-side switch: it has allowed this server to use its capabilities. */
  deviceAllows: boolean
  /** `online && deviceAllows` — the only state that makes the device usable. */
  available: boolean
  /** Last time a client from this device connected. Useful for offline rows. */
  lastSeenAt?: number
  /**
   * What the device can technically serve. Authorization is one switch covering all of them;
   * these stay separate so a device without a browser does not claim one.
   */
  offered: {
    shell: boolean
    files: boolean
    browser: boolean
    /** This device offers **its own** desktop to a hub. Served by the remote bridge. */
    computer: boolean
  }
  /** Offered capabilities that are usable right now (`available ? offered : false`). */
  capabilities: {
    shell: boolean
    files: boolean
    browser: boolean
    computer: boolean
  }
}

export interface DeviceExecArgs {
  command: string
  /** Must be inside one of the folders the device authorized for this hub when given. */
  cwd?: string
  /** Default 60s, capped by the device. */
  timeoutMs?: number
}

export interface DeviceExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  cwd: string
  /** True when stdout/stderr hit the output cap. */
  truncated?: boolean
}

export type DeviceFsOp = 'read' | 'write' | 'edit' | 'list' | 'stat' | 'glob' | 'grep'

export interface DeviceFsArgs {
  op: DeviceFsOp
  /** Absolute path on the device (must be inside a folder it authorized for this hub). */
  path?: string
  /** `write` */
  content?: string
  /** `edit` */
  oldString?: string
  newString?: string
  replaceAll?: boolean
  /** `glob` / `grep` */
  pattern?: string
  /** `grep` — only files matching this glob (e.g. `*.ts`). */
  glob?: string
  ignoreCase?: boolean
  maxResults?: number
  /** `read` — 1-based line offset and line count. */
  offset?: number
  limit?: number
}

export interface DeviceFsEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface DeviceFsMatch {
  path: string
  line: number
  text: string
}

export interface DeviceFsResult {
  op: DeviceFsOp
  path?: string
  content?: string
  bytesWritten?: number
  replacements?: number
  entries?: DeviceFsEntry[]
  files?: string[]
  matches?: DeviceFsMatch[]
  stat?: { type: 'file' | 'directory' | 'other'; size: number; mtimeMs: number }
  truncated?: boolean
}

/** The runtime the session backs `device_tool` with. */
export interface DeviceToolFns {
  list(): Promise<DeviceToolInfo[]>
  exec(device: string, args: DeviceExecArgs): Promise<DeviceExecResult>
  fs(device: string, args: DeviceFsArgs): Promise<DeviceFsResult>
  /**
   * Browser functions bound to one device, for the nested `browser` tool.
   * The device must advertise browser capability.
   */
  getBrowserFns(device: string): Promise<BrowserPaneFns>
  /**
   * That device's desktop, through the remote bridge.
   *
   * Not this process's: the local desktop is `computer_tool`, and the two doors stay orthogonal —
   * a device is only ever asked about its own machine.
   */
  getComputerFns(device: string): Promise<ComputerPaneFns>
}
