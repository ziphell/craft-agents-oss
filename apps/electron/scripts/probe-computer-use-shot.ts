import { ComputerUseManager, loadDefaultCuaDriver } from '../src/main/computer-use-manager.ts'
import { executeComputerToolCommand } from '@craft-agent/shared/agent'

const manager = new ComputerUseManager({ log: () => {}, loadDriver: () => loadDefaultCuaDriver() })
if (!(await manager.available())) {
  console.log('driver unavailable')
  process.exit(0)
}
const fns = await manager.fnsForSession('shot')

try {
  const shot = await executeComputerToolCommand({ command: 'screenshot', fns })
  console.log('ok:', shot.output)
  console.log('image:', shot.image
    ? { mimeType: shot.image.mimeType, sizeBytes: shot.image.sizeBytes, b64head: shot.image.data.slice(0, 24) }
    : null)
} catch (error) {
  console.log('screenshot failed:', String(error).slice(0, 400))
}

await manager.release('shot')
process.exit(0)
