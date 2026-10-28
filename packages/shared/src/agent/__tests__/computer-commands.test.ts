/**
 * The `computer` door's command language: refs, rendering, and what an action reports back.
 *
 * Refs are the driver's own `elementToken` (`s00000001:12`), so these tests pin that a hand-written
 * index is refused and that a token is passed through untouched.
 */
import { describe, it, expect } from 'bun:test'
import {
  parseComputerCommand,
  parseComputerRef,
  tokenizeComputerCommand,
  executeComputerToolCommand,
} from '../computer-commands.ts'
import type { ComputerPaneFns, ComputerSnapshot } from '../computer-pane.ts'

function makeFns(calls: string[]): ComputerPaneFns {
  const snapshot: ComputerSnapshot = {
    snapshotId: 's00000001',
    window: { id: '3', title: 'Settings', app: 'SystemSettings.exe', pid: 42, active: true },
    source: 'accessibility',
    elements: [
      { index: 0, token: 's00000001:0', role: 'Window', label: 'Settings', enabled: true, actions: [], depth: 0 },
      { index: 12, token: 's00000001:12', role: 'Button', label: 'Submit', enabled: true, actions: ['invoke'], depth: 2 },
    ],
  }
  return {
    windows: async () => [
      { id: '3', title: 'Settings', app: 'SystemSettings.exe', pid: 42, active: true },
    ],
    snapshot: async () => snapshot,
    clickElement: async (target) => {
      calls.push(`click:${target.token}`)
      return { role: 'Button', label: 'Submit', delivered: 'background' }
    },
    clickAt: async (point) => {
      calls.push(`click-at:${point.x},${point.y}`)
    },
    invoke: async (target, action) => {
      calls.push(`invoke:${target.token}:${action ?? 'invoke'}`)
      return { role: 'Button', label: 'Submit', delivered: 'background' }
    },
    setValue: async (target, value) => {
      calls.push(`set-value:${target.token}:${value}`)
      return { role: 'Edit', label: 'Name', delivered: 'background' }
    },
    typeText: async (text) => {
      calls.push(`type:${text}`)
    },
    sendKey: async (keys) => {
      calls.push(`key:${keys}`)
    },
    scroll: async (direction, amount) => {
      calls.push(`scroll:${direction}:${amount ?? ''}`)
    },
    status: async () => ({
      driver: { version: '0.28.1', contractVersion: '0.8.0' },
      permissions: ['UIA accessibility: available'],
      desktopCapture: 'unavailable: BitBlt failed',
      injectedInput: 'unavailable (use element actions)',
      agentCursor: 'on',
      windows: 22,
    }),
    screenshot: async () => ({ data: 'AAAA', mimeType: 'image/png', width: 100, height: 50 }),
    launchApp: async (name) => {
      calls.push(`launch:${name}`)
      return { pid: 99, windowId: '7' }
    },
    stop: async () => {
      calls.push('stop')
    },
  }
}

describe('computer command parsing', () => {
  it('keeps quoted text together', () => {
    expect(tokenizeComputerCommand('type "hello world"')).toEqual(['type', 'hello world'])
  })

  it('reads --window without swallowing positionals', () => {
    expect(parseComputerCommand('snapshot --window 3')).toMatchObject({
      verb: 'snapshot',
      windowRef: '3',
      positional: [],
    })
  })

  it('refuses an unknown verb by name', () => {
    expect(() => parseComputerCommand('double-click s00000001:1')).toThrow(/Unknown command "double-click"/)
  })

  it('passes the driver token through untouched', () => {
    expect(parseComputerRef('s00000001:12')).toEqual({ token: 's00000001:12' })
  })

  it('refuses a bare index with advice', () => {
    expect(() => parseComputerRef('12')).toThrow(/not an element token/)
  })
})

describe('computer command execution', () => {
  it('reports what the session can do, including a capture that is refused', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({ command: 'status', fns: makeFns(calls) })
    expect(result.output).toContain('driver 0.28.1')
    expect(result.output).toContain('windows 22')
    expect(result.output).toContain('unavailable: BitBlt failed')
    expect(result.output).toContain('injected input: unavailable')
    expect(result.output).toContain('agent cursor: on')
    expect(result.output).toContain('UIA accessibility: available')
    expect(calls).toEqual([])
  })

  it('lists windows', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({ command: 'windows', fns: makeFns(calls) })
    expect(result.output).toContain('w3')
    expect(result.output).toContain('Settings')
    expect(calls).toEqual([])
  })

  it('renders a snapshot with tokens and advertised actions', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({ command: 'snapshot', fns: makeFns(calls) })
    expect(result.output).toContain('s00000001:12')
    expect(result.output).toContain('Button')
    expect(result.output).toContain('[invoke]')
  })

  it('says what an action reported, including how it was delivered', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({ command: 'click s00000001:12', fns: makeFns(calls) })
    expect(calls).toEqual(['click:s00000001:12'])
    expect(result.output).toContain('Button "Submit"')
    expect(result.output).toContain('delivered=background')
    expect(result.appendReleaseHint).toBeUndefined()
  })

  it('flags pixel-level actions so the reader knows the pointer moved', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({
      command: ['click-at 10 20', 'type hi'],
      fns: makeFns(calls),
    })
    expect(calls).toEqual(['click-at:10,20', 'type:hi'])
    expect(result.appendReleaseHint).toBe(true)
  })

  it('carries a screenshot as an image and nothing else', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({ command: 'screenshot', fns: makeFns(calls) })
    expect(result.image?.mimeType).toBe('image/png')
    expect(result.image?.sizeBytes).toBe(3)
  })

  it('stops the batch on the first failure', async () => {
    const calls: string[] = []
    await expect(executeComputerToolCommand({
      command: ['click s00000001:12', 'click 12', 'type never'],
      fns: makeFns(calls),
    })).rejects.toThrow(/not an element token/)
    expect(calls).toEqual(['click:s00000001:12'])
  })

  it('releases the desktop on stop', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({ command: 'stop', fns: makeFns(calls) })
    expect(calls).toEqual(['stop'])
    expect(result.output).toContain('released')
  })
})
