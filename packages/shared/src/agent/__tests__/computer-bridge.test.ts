/**
 * The wire contract between a hub and the device whose desktop it drives.
 *
 * What is worth pinning here is the **order** of the positional arguments: the hub packs them, the
 * device unpacks them, and nothing else checks that the two agree.
 */
import { describe, it, expect } from 'bun:test'
import { dispatchComputerCapability } from '../computer-bridge.ts'
import type { ComputerPaneFns } from '../computer-pane.ts'

function recordingFns(calls: unknown[][]): ComputerPaneFns {
  const record = (name: string, args: unknown[]) => {
    calls.push([name, ...args])
  }
  return {
    status: async () => {
      record('status', [])
      return {
        driver: { version: '0.28.1', contractVersion: '0.8.0' },
        permissions: [],
        desktopCapture: 'available',
        injectedInput: 'available',
        agentCursor: 'off',
        windows: 1,
      }
    },
    windows: async () => {
      record('windows', [])
      return []
    },
    snapshot: async (args) => {
      record('snapshot', [args])
      return {
        snapshotId: 's1',
        window: { id: '3', title: 't', app: 'a', pid: 1, active: true },
        source: 'none',
        elements: [],
      }
    },
    clickElement: async (target, options) => {
      record('clickElement', [target, options])
      return { role: 'Button', label: 'b', delivered: 'background' }
    },
    invoke: async (target, action) => {
      record('invoke', [target, action])
      return { role: 'Button', label: 'b', delivered: 'background' }
    },
    setValue: async (target, value) => {
      record('setValue', [target, value])
      return { role: 'Edit', label: 'e', delivered: 'background' }
    },
    clickAt: async (point, options) => {
      record('clickAt', [point, options])
    },
    typeText: async (text, options) => {
      record('typeText', [text, options])
    },
    sendKey: async (keys, options) => {
      record('sendKey', [keys, options])
    },
    scroll: async (direction, amount, options) => {
      record('scroll', [direction, amount, options])
    },
    screenshot: async (args) => {
      record('screenshot', [args])
      return { data: 'AA', mimeType: 'image/png', width: 1, height: 1 }
    },
    launchApp: async (name) => {
      record('launchApp', [name])
      return { pid: 7 }
    },
    stop: async () => {
      record('stop', [])
    },
  }
}

describe('computer capability dispatch', () => {
  it('forwards element actions in hub order', async () => {
    const calls: unknown[][] = []
    await dispatchComputerCapability(recordingFns(calls), 'clickElement', [{ token: 's1:2' }, { mode: 'auto' }])
    await dispatchComputerCapability(recordingFns(calls), 'setValue', [{ token: 's1:3' }, 'hi'])
    await dispatchComputerCapability(recordingFns(calls), 'invoke', [{ token: 's1:4' }, 'expand'])
    expect(calls).toEqual([
      ['clickElement', { token: 's1:2' }, { mode: 'auto' }],
      ['setValue', { token: 's1:3' }, 'hi'],
      ['invoke', { token: 's1:4' }, 'expand'],
    ])
  })

  it('forwards input verbs with their optional target last', async () => {
    const calls: unknown[][] = []
    const fns = recordingFns(calls)
    await dispatchComputerCapability(fns, 'typeText', ['hello', { windowId: '3', token: 's1:5' }])
    await dispatchComputerCapability(fns, 'sendKey', ['ctrl+a', { windowId: '3' }])
    await dispatchComputerCapability(fns, 'scroll', ['down', 3, { windowId: '3' }])
    expect(calls).toEqual([
      ['typeText', 'hello', { windowId: '3', token: 's1:5' }],
      ['sendKey', 'ctrl+a', { windowId: '3' }],
      ['scroll', 'down', 3, { windowId: '3' }],
    ])
  })

  it('returns the primitive answer unchanged', async () => {
    const calls: unknown[][] = []
    const status = await dispatchComputerCapability(recordingFns(calls), 'status', [])
    expect(status).toMatchObject({ driver: { version: '0.28.1' }, windows: 1 })
    expect(await dispatchComputerCapability(recordingFns(calls), 'stop', [])).toBeNull()
  })
})
