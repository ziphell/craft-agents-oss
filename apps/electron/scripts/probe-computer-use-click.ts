/**
 * Click round: an element click that changes something observable, then the change is undone.
 *
 * Target: the navigation list in Windows Settings — clicking "系统" switches page, clicking "主页"
 * switches back. Nothing is toggled, saved, or closed.
 *
 *   cd apps/electron && bun scripts/probe-computer-use-click.ts
 */
import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { executeComputerToolCommand } from '@craft-agent/shared/agent'

const manager = new ComputerUseManager({ log: () => {}, loadDriver: () => loadDefaultCuaDriver() })
if (!(await manager.available())) {
  console.log('driver unavailable')
  process.exit(0)
}
const fns = await manager.fnsForSession('click')

const run = async (command: string): Promise<string> => {
  try {
    return (await executeComputerToolCommand({ command, fns })).output
  } catch (error) {
    return `FAILED: ${String((error as Error).message ?? error)}`
  }
}

const windows = await run('windows')
const match = /- w(\S+) · SystemSettings/i.exec(windows)
if (!match) {
  console.log('Settings is not open; nothing to click. Windows:\n' + windows.slice(0, 300))
  await manager.release('click')
  process.exit(0)
}
const windowId = match[1]!
console.log('window:', windowId)

/** Every nav destination currently listed, with its token. */
async function navItems() {
  const snap = await fns.snapshot({ windowId })
  return {
    snapshotId: snap.snapshotId,
    count: snap.elements.length,
    items: snap.elements
      .filter((e) => e.role === 'ListItem')
      .map((e) => ({ token: e.token, label: e.label })),
  }
}

const before = await navItems()
console.log('nav before:', before.items.slice(0, 6).map((i) => i.label).join(' | '), `(${before.count} elements)`)

const target = before.items.find((i) => i.label === '系统') ?? before.items[1]
if (!target) {
  console.log('no nav item to click')
  await manager.release('click')
  process.exit(0)
}
console.log('\nclicking:', target.label, target.token)

const clicked = await run(`click ${target.token}`)
console.log('[click]', clicked)

// Give the page a moment to render the new destination before reading it.
await new Promise((resolve) => setTimeout(resolve, 1200))
const after = await navItems()
console.log('nav after :', after.items.slice(0, 6).map((i) => i.label).join(' | '), `(${after.count} elements)`)
console.log('page changed:', before.count !== after.count || before.items.length !== after.items.length)

const home = after.items.find((i) => i.label === '主页') ?? after.items.find((i) => i.label.includes('Home'))
if (home) {
  console.log('\nrestoring: click 主页', home.token)
  console.log('[click]', await run(`click ${home.token}`))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const restored = await navItems()
  console.log('nav restored:', restored.items.slice(0, 6).map((i) => i.label).join(' | '), `(${restored.count} elements)`)
}

await manager.release('click')
process.exit(0)
