/**
 * The directory a hub's workspace gets on this machine.
 *
 * The path is built from ids the hub sends, so the one thing worth pinning is that an id cannot
 * walk out of the base: this is a boundary, not just a name.
 */
import { describe, it, expect } from 'bun:test'
import { join } from 'node:path'
import { CONFIG_DIR } from '../paths.ts'
import { HUB_ROOT_BASE, hubWorkspaceRoot } from '../device.ts'

describe('hub workspace root', () => {
  it('keeps one directory per (hub, workspace) under the config dir', () => {
    expect(HUB_ROOT_BASE).toBe(join(CONFIG_DIR, '.hub'))
    expect(hubWorkspaceRoot('hub-device', 'workspace-1')).toBe(
      join(CONFIG_DIR, '.hub', 'hub-device', 'workspace-1'),
    )
  })

  it('refuses ids that could leave the base', () => {
    expect(() => hubWorkspaceRoot('../other', 'ws')).toThrow('Invalid hub or workspace id')
    expect(() => hubWorkspaceRoot('hub', '..')).toThrow('Invalid hub or workspace id')
    expect(() => hubWorkspaceRoot('hub', 'a/b')).toThrow('Invalid hub or workspace id')
    expect(() => hubWorkspaceRoot('hub', '  ')).toThrow('Invalid hub or workspace id')
  })
})
