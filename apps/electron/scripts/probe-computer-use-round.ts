/**
 * End-to-end read-only round through the code that ships: `ComputerUseManager` → `ComputerPaneFns`
 * → the `computer` command layer. Nothing clicks, types or moves the pointer.
 *
 *   cd apps/electron && bun scripts/probe-computer-use-round.ts
 */
import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { executeComputerToolCommand } from '@craft-agent/shared/agent'

const manager = new ComputerUseManager({
  log: (message, details) => console.log(`[mgr] ${message}`, details ?? ''),
  loadDriver: () => loadDefaultCuaDriver((message) => console.log(`[drv] ${message}`)),
})

console.log('available:', await manager.available())

const fns = await manager.fnsForSession('probe')
console.log('lease held by:', manager.activeSession())

const windows = await executeComputerToolCommand({ command: 'windows', fns })
console.log('\n=== windows (first 8) ===')
console.log(windows.output.split('\n').slice(0, 8).join('\n'))

const snapshot = await executeComputerToolCommand({ command: 'snapshot', fns })
console.log('\n=== snapshot (first 12 lines) ===')
console.log(snapshot.output.split('\n').slice(0, 12).join('\n'))

// One manager = one desktop. A second SESSION must be refused, immediately.
const refused = await manager.fnsForSession('other').then(
  () => 'ALLOWED (wrong)',
  (error: unknown) => `${(error as { code?: string }).code ?? 'ERROR'}: ${(error as Error).message}`,
)
console.log('\nsecond session →', refused)

await manager.release('probe')
console.log('after release, lease:', manager.activeSession())
process.exit(0)
