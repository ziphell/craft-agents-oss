/**
 * The remote-bridge loop, both ends in one process: `RemoteComputerPaneManager` (hub) →
 * `client:computer:invoke` → `dispatchComputerCapability` → this machine's desktop.
 *
 * The rpcServer below is the only fake: it routes the request straight to the dispatcher, which is
 * exactly what the device side does. Read-only — windows, status, snapshot.
 *
 *   cd apps/electron && bun scripts/probe-computer-use-bridge.ts
 */
import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { RemoteComputerPaneManager } from '@craft-agent/server-core/sessions'
import { dispatchComputerCapability } from '@craft-agent/shared/agent'

const guest = new ComputerUseManager({ log: () => {}, loadDriver: () => loadDefaultCuaDriver() })
if (!(await guest.available())) {
  console.log('driver unavailable')
  process.exit(0)
}

// The device side of the wire: same session naming as device-access.ts (`remote:<connectionId>`).
const fakeRpc = {
  hasClientCapability: () => true,
  invokeClient: async (clientId: string, _channel: string, req: any) => {
    const fns = await guest.fnsForSession(`remote:${clientId}`)
    return await dispatchComputerCapability(fns, req.method, req.args ?? [])
  },
} as any

const hub = new RemoteComputerPaneManager({ rpcServer: fakeRpc, getHostClient: () => 'conn-1' })

const status = await hub.status()
console.log('status via bridge:', JSON.stringify({
  driver: status.driver,
  windows: status.windows,
  capture: status.desktopCapture.slice(0, 40),
  cursor: status.agentCursor,
}))

const windows = await hub.windows()
console.log('windows via bridge:', windows.length, '·', windows.slice(0, 3).map((w) => `${w.app}:${w.title}`.slice(0, 28)))

const snap = await hub.snapshot({ windowId: windows.find((w) => /SystemSettings/i.test(w.app))?.id })
console.log('snapshot via bridge:', snap.snapshotId, '·', snap.elements.length, 'elements · source', snap.source)

await hub.stop()
console.log('lease after stop:', guest.activeSession())
process.exit(0)
