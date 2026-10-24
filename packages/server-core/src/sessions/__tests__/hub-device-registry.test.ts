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
  it('creates a record on first connect and keeps hubUses across reloads', () => {
    const file = tempFile()
    const first = new HubDeviceRegistry(file)
    const created = first.ensure({
      deviceId: 'd1',
      name: 'Office',
      platform: 'darwin',
      version: '1.0.0',
    })
    expect(created.hubUses).toBe(false)
    first.setUse('d1', true)
    first.flush()

    const reloaded = new HubDeviceRegistry(file).get('d1')
    expect(reloaded).toMatchObject({
      deviceId: 'd1',
      name: 'Office',
      platform: 'darwin',
      version: '1.0.0',
      hubUses: true,
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

  it('does not reset hubUses when the same device connects again', () => {
    const registry = new HubDeviceRegistry(null)
    registry.ensure({ deviceId: 'd1', name: 'Office' })
    registry.setUse('d1', true)

    const again = registry.ensure({ deviceId: 'd1', name: 'Office renamed', version: '1.1.0' })
    expect(again.hubUses).toBe(true)
    expect(again.name).toBe('Office renamed')
  })
})
