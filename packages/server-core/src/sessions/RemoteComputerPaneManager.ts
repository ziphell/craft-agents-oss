/**
 * RemoteComputerPaneManager — the **remote** half of desktop control.
 *
 * The local door is `computer_tool`, which drives this process's own desktop. This class is the
 * bridge for the other case: a device that is *not* this machine, reached through `device_tool`
 * (`{"device":"…","tool":"computer"}`), because a device is the only thing that answers "which
 * machine" — the two are orthogonal and neither is nested in the other.
 *
 * One channel, one request object, like the shell and file capabilities (`client:device:exec`,
 * `client:device:fs`): the browser door needed a method-per-call table because its surface is a
 * manager with a lifecycle; a desktop is twelve primitives over one shape, so the smaller contract
 * is the honest one.
 *
 * What the far side must implement: `client:computer:invoke`, answering
 * `{ v: 1, method, args }` with the primitive's return value or an error.
 */

import type { RpcServer } from '../transport/types'
import { CLIENT_COMPUTER_INVOKE } from '../transport/capabilities'
import type {
  ComputerActionMode,
  ComputerActionOutcome,
  ComputerPaneFns,
  ComputerSessionStatus,
  ComputerScreenshotArgs,
  ComputerScreenshotResult,
  ComputerSnapshot,
  ComputerSnapshotArgs,
  ComputerTarget,
  ComputerWindowInfo,
  ComputerWindowListArgs,
  ComputerCapabilityMethod,
  ComputerCapabilityRequest,
} from '@craft-agent/shared/agent'

export interface RemoteComputerPaneManagerDeps {
  readonly rpcServer: RpcServer
  /** The device connection that answers this desktop's calls. */
  readonly getHostClient: () => string | null
  /** Per-call ceiling: a snapshot of a large tree is slower than a keystroke. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export class RemoteComputerPaneManager implements ComputerPaneFns {
  private readonly rpcServer: RpcServer
  private readonly getHostClient: () => string | null
  private readonly timeoutMs: number

  constructor(deps: RemoteComputerPaneManagerDeps) {
    this.rpcServer = deps.rpcServer
    this.getHostClient = deps.getHostClient
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async call<T>(method: ComputerCapabilityMethod, ...args: unknown[]): Promise<T> {
    const clientId = this.getHostClient()
    if (!clientId) {
      throw new Error('The device holding this desktop is not connected.')
    }
    if (!this.rpcServer.hasClientCapability(clientId, CLIENT_COMPUTER_INVOKE)) {
      throw new Error(`Device ${clientId} does not offer a desktop.`)
    }
    const request: ComputerCapabilityRequest = { v: 1, method, args }
    const invoke = this.rpcServer.invokeClientWithTimeout
      ? this.rpcServer.invokeClientWithTimeout(clientId, CLIENT_COMPUTER_INVOKE, [request], this.timeoutMs)
      : this.rpcServer.invokeClient(clientId, CLIENT_COMPUTER_INVOKE, request)
    const answer = await invoke
    // The far side answers with the primitive's value; an error arrives as a thrown failure from
    // the transport, so a returned value is a value.
    return answer as T
  }

  status = (): Promise<ComputerSessionStatus> => this.call('status')
  windows = (args?: ComputerWindowListArgs): Promise<ComputerWindowInfo[]> => this.call('windows', args)
  snapshot = (args?: ComputerSnapshotArgs): Promise<ComputerSnapshot> => this.call('snapshot', args)
  clickElement = (target: ComputerTarget, options?: { mode?: ComputerActionMode }): Promise<ComputerActionOutcome> =>
    this.call('clickElement', target, options)
  invoke = (target: ComputerTarget, action?: string): Promise<ComputerActionOutcome> =>
    this.call('invoke', target, action)
  setValue = (target: ComputerTarget, value: string): Promise<ComputerActionOutcome> =>
    this.call('setValue', target, value)
  clickAt = (
    point: { x: number; y: number; windowId?: string },
    options?: { mode?: ComputerActionMode; excludeSelf?: boolean },
  ): Promise<void> => this.call('clickAt', point, options)
  typeText = (text: string, options?: { windowId?: string; token?: string }): Promise<void> =>
    this.call('typeText', text, options)
  sendKey = (keys: string, options?: { windowId?: string }): Promise<void> =>
    this.call('sendKey', keys, options)
  scroll = (
    direction: 'up' | 'down' | 'left' | 'right',
    amount?: number,
    options?: { windowId?: string },
  ): Promise<void> => this.call('scroll', direction, amount, options)
  screenshot = (args?: ComputerScreenshotArgs): Promise<ComputerScreenshotResult> =>
    this.call('screenshot', args)
  launchApp = (name: string): Promise<{ pid: number | null; windowId?: string }> => this.call('launchApp', name)
  stop = (): Promise<void> => this.call('stop')
}
