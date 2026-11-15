/**
 * `status` round: what this session can do, and whether a refused action now fails loudly.
 *
 *   cd apps/electron && bun scripts/probe-computer-use-status.ts
 */
import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { executeComputerToolCommand } from '@craft-agent/shared/agent'

const manager = new ComputerUseManager({ log: () => {}, loadDriver: () => loadDefaultCuaDriver() })
if (!(await manager.available())) process.exit(0)
const fns = await manager.fnsForSession('status')

const run = async (command: string): Promise<string> => {
  try {
    return (await executeComputerToolCommand({ command, fns })).output
  } catch (error) {
    return `FAILED: ${String((error as Error).message ?? error).slice(0, 220)}`
  }
}

console.log('=== status ===')
console.log(await run('status'))

console.log('=== injected input (expected to fail loudly here) ===')
const windows = await run('windows')
const id = /- w(\S+) · SystemSettings/i.exec(windows)?.[1]
console.log(await run(id ? `key ctrl+a --window ${id}` : 'key ctrl+a'))

await manager.release('status')
process.exit(0)
