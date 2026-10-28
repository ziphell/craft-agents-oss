/**
 * The wire contract for `client:computer:invoke` — one table, two ends.
 *
 * `RemoteComputerPaneManager` (the hub) turns a primitive call into
 * `{ v: 1, method, args }`; the device that answered turns it back into a primitive call on its own
 * desktop. Both read the argument order from here, so a change cannot be made on one side only —
 * which is the failure a hand-written switch on each end invites.
 *
 * Positional `args` (not a named object) so the far side can forward them straight through without
 * knowing the shapes: `['s00000001:12', { mode: 'auto' }]`.
 */

import type {
  ComputerActionMode,
  ComputerActionOutcome,
  ComputerPaneFns,
  ComputerSessionStatus,
  ComputerScreenshotResult,
  ComputerSnapshot,
  ComputerTarget,
  ComputerWindowInfo,
} from './computer-pane.ts'

export type ComputerCapabilityMethod =
  | 'status'
  | 'windows'
  | 'snapshot'
  | 'clickElement'
  | 'invoke'
  | 'setValue'
  | 'clickAt'
  | 'typeText'
  | 'sendKey'
  | 'scroll'
  | 'screenshot'
  | 'launchApp'
  | 'stop'

export interface ComputerCapabilityRequest {
  v: 1
  method: ComputerCapabilityMethod
  args: unknown[]
}

/**
 * Answer one request against a desktop.
 *
 * Every cast is a promise the table above makes about the order: the hub's `call()` always packs
 * arguments in this shape, and `ComputerCapabilityMethod` is the closed set of names it may use.
 */
export async function dispatchComputerCapability(
  fns: ComputerPaneFns,
  method: ComputerCapabilityMethod,
  args: unknown[],
): Promise<unknown> {
  switch (method) {
    case 'status':
      return (await fns.status()) satisfies ComputerSessionStatus
    case 'windows':
      return (await fns.windows()) satisfies ComputerWindowInfo[]
    case 'snapshot':
      return (await fns.snapshot(args[0] as { windowId?: string } | undefined)) satisfies ComputerSnapshot
    case 'clickElement':
      return (await fns.clickElement(
        args[0] as ComputerTarget,
        args[1] as { mode?: ComputerActionMode } | undefined,
      )) satisfies ComputerActionOutcome
    case 'invoke':
      return (await fns.invoke(args[0] as ComputerTarget, args[1] as string | undefined)) satisfies ComputerActionOutcome
    case 'setValue':
      return (await fns.setValue(args[0] as ComputerTarget, args[1] as string)) satisfies ComputerActionOutcome
    case 'clickAt':
      await fns.clickAt(
        args[0] as { x: number; y: number; windowId?: string },
        args[1] as { mode?: ComputerActionMode } | undefined,
      )
      return null
    case 'typeText':
      await fns.typeText(args[0] as string, args[1] as { windowId?: string; token?: string } | undefined)
      return null
    case 'sendKey':
      await fns.sendKey(args[0] as string, args[1] as { windowId?: string } | undefined)
      return null
    case 'scroll':
      await fns.scroll(
        args[0] as 'up' | 'down' | 'left' | 'right',
        args[1] as number | undefined,
        args[2] as { windowId?: string } | undefined,
      )
      return null
    case 'screenshot':
      return (await fns.screenshot(args[0] as { windowId?: string } | undefined)) satisfies ComputerScreenshotResult
    case 'launchApp':
      return await fns.launchApp(args[0] as string)
    case 'stop':
      await fns.stop()
      return null
    default: {
      const unknown: never = method
      throw new Error(`Unknown computer capability method: ${String(unknown)}`)
    }
  }
}
