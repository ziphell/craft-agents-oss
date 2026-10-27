import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubDeviceRegistry } from '../../domain/hub-device-registry'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-devices-'))
  dirs.push(dir)
  return join(dir, 'devices.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('HubDeviceRegistry', () => {
  it('creates a record on first connect and keeps it across reloads', () => {
    const file = tempFile()
    const first = new HubDeviceRegistry(file)
    first.ensure({
      deviceId: 'd1',
      name: 'Office',
      platform: 'darwin',
      version: '1.0.0',
    })
    first.flush()

    const reloaded = new HubDeviceRegistry(file).get('d1')
    expect(reloaded).toMatchObject({
      deviceId: 'd1',
      name: 'Office',
      platform: 'darwin',
      version: '1.0.0',
    })
  })

  it('keeps an offline record and removes it only when forgotten', () => {
    const file = tempFile()
    const first = new HubDeviceRegistry(file)
    first.ensure({ deviceId: 'd1', name: 'Office' })
    first.flush()

    // Reading a fresh registry models a hub restart: the row survives without a connection.
    const second = new HubDeviceRegistry(file)
    expect(second.list().map((record) => record.deviceId)).toEqual(['d1'])
    second.forget('d1')

    expect(new HubDeviceRegistry(file).list()).toEqual([])
  })

  it('refreshes metadata when the same device connects again', () => {
    const registry = new HubDeviceRegistry(null)
    registry.ensure({ deviceId: 'd1', name: 'Office' })

    const again = registry.ensure({ deviceId: 'd1', name: 'Office renamed', version: '1.1.0' })
    expect(again.name).toBe('Office renamed')
  })

  it('persists an alias across reloads and keeps it when the device reconnects', () => {
    const file = tempFile()
    const first = new HubDeviceRegistry(file)
    first.ensure({ deviceId: 'd1', name: 'Office' })
    first.setAlias('d1', '  Studio Mac  ')
    first.flush()

    const reloaded = new HubDeviceRegistry(file)
    expect(reloaded.get('d1')?.alias).toBe('Studio Mac')
    // A reconnect refreshes the advertised metadata, never the person's own name.
    expect(reloaded.ensure({ deviceId: 'd1', name: 'Office-2' }).alias).toBe('Studio Mac')
  })

  it('clears an alias when set to blank', () => {
    const registry = new HubDeviceRegistry(null)
    registry.ensure({ deviceId: 'd1', name: 'Office' })
    registry.setAlias('d1', 'Studio')
    expect(registry.setAlias('d1', '   ')?.alias).toBeUndefined()
  })
})
