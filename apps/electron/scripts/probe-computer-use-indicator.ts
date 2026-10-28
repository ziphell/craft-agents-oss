/**
 * The "this desktop is being driven" indicator: the driver's own cursor, tied to the lease.
 *
 *   cd apps/electron && bun scripts/probe-computer-use-indicator.ts
 */
import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { executeComputerToolCommand } from '@craft-agent/shared/agent'

const manager = new ComputerUseManager({
  log: (message, details) => console.log(`[mgr] ${message}`, details ?? ''),
  loadDriver: () => loadDefaultCuaDriver(),
})
if (!(await manager.available())) process.exit(0)

const fns = await manager.fnsForSession('indicator')
const status = await executeComputerToolCommand({ command: 'status', fns })
console.log('\n=== while holding the desktop ===')
console.log(status.output.split('\n').filter((l) => /agent cursor|capture|injected/.test(l)).join('\n'))

await manager.release('indicator')
console.log('\nlease after release:', manager.activeSession())

const again = await manager.fnsForSession('indicator-2')
const second = await executeComputerToolCommand({ command: 'status', fns: again })
console.log('\n=== taken again ===')
console.log(second.output.split('\n').filter((l) => /agent cursor/.test(l)).join('\n'))

await manager.release('indicator-2')
process.exit(0)
