/**
 * Second action round: fresh token per step, and the driver's raw element values printed so a
 * rendering bug cannot masquerade as "the input did not land".
 *
 *   cd apps/electron && bun scripts/probe-computer-use-actions2.ts
 */
import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { executeComputerToolCommand } from '@craft-agent/shared/agent'

const SENTINEL = 'craftprobe123'
const manager = new ComputerUseManager({ log: () => {}, loadDriver: () => loadDefaultCuaDriver() })
if (!(await manager.available())) process.exit(0)
const fns = await manager.fnsForSession('actions2')

const run = async (command: string | string[]): Promise<string> => {
  try {
    return (await executeComputerToolCommand({ command, fns })).output
  } catch (error) {
    return `FAILED: ${String((error as Error).message ?? error)}`
  }
}

const windows = await run('windows')
const m = [...windows.matchAll(/- w(\S+) · ([^·]+)·/g)].map((x) => ({ id: x[1]!, app: x[2]!.trim() }))
const target = m.find((w) => /SystemSettings/i.test(w.app)) ?? m[0]!
console.log('window:', target)

/** Fresh snapshot → the raw element rows as the driver returned them. */
async function editRow(): Promise<{ token: string; line: string } | null> {
  const snap = await fns.snapshot({ windowId: target.id })
  const edit = snap.elements.find((e) => e.role === 'Edit')
  if (!edit) return null
  return { token: edit.token, line: JSON.stringify(edit) }
}

console.log('\nbefore:', (await editRow())?.line ?? '(no Edit)')

const first = await editRow()
if (!first) process.exit(0)

console.log('\n[type]', await run(`type ${SENTINEL} --window ${target.id}`))
console.log('after type:', (await editRow())?.line ?? '(no Edit)')

const second = await editRow()
if (second) {
  console.log('\n[set-value]', await run(`set-value ${second.token} "setbycraft"`))
  const third = await editRow()
  console.log('after set-value:', third?.line ?? '(no Edit)')

  if (third) {
    console.log('[clear]', await run(`set-value ${third.token} ""`))
    console.log('after clear:', (await editRow())?.line ?? '(no Edit)')
  }
}

await manager.release('actions2')
process.exit(0)
