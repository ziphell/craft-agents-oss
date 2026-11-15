/**
 * The `computer` door's command language: refs, rendering, and what an action reports back.
 *
 * Refs are the driver's own `elementToken` (`s00000001:12`), so these tests pin that a hand-written
 * index is refused and that a token is passed through untouched.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseComputerCommand,
  parseComputerRef,
  tokenizeComputerCommand,
  executeComputerToolCommand,
} from '../computer-commands.ts'
import type { ComputerActionOutcome, ComputerPaneFns, ComputerSnapshot } from '../computer-pane.ts'

function makeFns(
  calls: string[],
  options: { outcome?: Partial<ComputerActionOutcome>; snapshot?: Partial<ComputerSnapshot> } = {},
): ComputerPaneFns {
  const snapshot: ComputerSnapshot = {
    ...options.snapshot,
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
    snapshot: async (args) => {
      const query = args?.query
      calls.push(`snapshot:${args?.windowId ?? ''}:${query ?? ''}`)
      if (!query) return snapshot
      const matched = snapshot.elements.filter((element) => element.label.includes(query))
      return { ...snapshot, elements: matched, total: snapshot.elements.length, filtered: query }
    },
    clickElement: async (target) => {
      calls.push(`click:${target.token}`)
      return { role: 'Button', label: 'Submit', delivered: 'background', ...options.outcome }
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
      windowCapture: 'available',
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

  it('reads --exclude-self as a flag, not a positional', () => {
    expect(parseComputerCommand('windows --exclude-self')).toMatchObject({
      verb: 'windows',
      positional: [],
      excludeSelf: true,
    })
  })

  it('reads --query as text to match, not a positional', () => {
    expect(parseComputerCommand('snapshot --query "Save as"')).toMatchObject({
      verb: 'snapshot',
      query: 'Save as',
      positional: [],
    })
    expect(() => parseComputerCommand('snapshot --query')).toThrow(/--query needs text/)
  })

  it('reads --out with its path', () => {
    expect(parseComputerCommand('screenshot --out shots')).toMatchObject({
      verb: 'screenshot',
      positional: [],
      outRef: 'shots',
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
    expect(result.output).toContain('window capture: available')
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

  it('passes --exclude-self through to the primitives', async () => {
    const calls: string[] = []
    const fns: ComputerPaneFns = {
      ...makeFns(calls),
      windows: async (args) => {
        calls.push(`windows:${args?.excludeSelf === true}`)
        return []
      },
      snapshot: async (args) => {
        calls.push(`snapshot:${args?.excludeSelf === true}`)
        return {
          snapshotId: 's1',
          window: { id: '3', title: '', app: 'Craft', pid: 1, active: true },
          source: 'none',
          elements: [],
        }
      },
      screenshot: async (args) => {
        calls.push(`screenshot:${args?.excludeSelf === true}`)
        return { data: 'AAAA', mimeType: 'image/png', width: 1, height: 1 }
      },
      clickAt: async (_point, options) => {
        calls.push(`click-at:${options?.excludeSelf === true}`)
      },
    }
    await executeComputerToolCommand({ command: 'windows --exclude-self', fns })
    await executeComputerToolCommand({ command: 'snapshot --exclude-self', fns })
    await executeComputerToolCommand({ command: 'screenshot --exclude-self', fns })
    await executeComputerToolCommand({ command: 'click-at 10 20 --exclude-self', fns })
    expect(calls).toEqual(['windows:true', 'snapshot:true', 'screenshot:true', 'click-at:true'])
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

  it('passes the driver verdict through, whatever it is', async () => {
    const confirmed = await executeComputerToolCommand({
      command: 'click s00000001:12',
      fns: makeFns([], { outcome: { effect: 'confirmed', route: 'accessibility' } }),
    })
    expect(confirmed.output).toContain('effect=confirmed')
    expect(confirmed.output).toContain('route=accessibility')
  })

  it('does not call a click that may not have landed `Done`', async () => {
    // The two answers a caller must not read as success: the driver watched and saw no change, or
    // it declined to act at all. `unverifiable` stays a plain Done — a posted message leaves
    // nothing to observe, so it is the normal answer on Windows.
    const noop = await executeComputerToolCommand({
      command: 'click s00000001:12',
      fns: makeFns([], { outcome: { effect: 'suspected_noop' } }),
    })
    expect(noop.output.startsWith('Probably nothing happened:')).toBe(true)
    expect(noop.output).toContain('check with a fresh snapshot')

    const refused = await executeComputerToolCommand({
      command: 'click s00000001:12',
      fns: makeFns([], { outcome: { effect: 'refused', note: 'no route to the element' } }),
    })
    expect(refused.output.startsWith('Refused by the driver:')).toBe(true)
    expect(refused.output).toContain('no route to the element')

    const unverifiable = await executeComputerToolCommand({
      command: 'click s00000001:12',
      fns: makeFns([], { outcome: { effect: 'unverifiable' } }),
    })
    expect(unverifiable.output.startsWith('Done:')).toBe(true)
    expect(unverifiable.output).toContain('effect=unverifiable')
  })

  it('narrows a read to what matches, and says so', async () => {
    const calls: string[] = []
    const result = await executeComputerToolCommand({
      command: 'snapshot --window 3 --query Submit',
      fns: makeFns(calls),
    })
    expect(calls).toEqual(['snapshot:3:Submit'])
    expect(result.output).toContain('matching "Submit"')
    // One element of two: the header says how much the unfiltered tree holds, not that it was cut.
    expect(result.output).toContain('1 of 2 element(s)')
    expect(result.output).not.toContain('Settings" enabled')
  })

  it('does not mistake an empty filter for a window with no tree', async () => {
    const result = await executeComputerToolCommand({
      command: 'snapshot --query zzz-not-there',
      fns: makeFns([]),
    })
    expect(result.output).toContain('Nothing matched "zzz-not-there"')
    expect(result.output).toContain('the tree itself read fine')
    expect(result.output).not.toContain('exposes no accessible tree')
  })

  it('says how much of a window it did not show', async () => {
    const capped = await executeComputerToolCommand({
      command: 'snapshot',
      fns: makeFns([], { snapshot: { total: 340 } }),
    })
    expect(capped.output).toContain('2 of 340 element(s)')

    const whole = await executeComputerToolCommand({ command: 'snapshot', fns: makeFns([]) })
    expect(whole.output).toContain('2 element(s)')
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

  it('states the image scale only when the capture was downscaled', async () => {
    const scaled: ComputerPaneFns = {
      ...makeFns([]),
      screenshot: async () => ({ data: 'AAAA', mimeType: 'image/png', width: 500, height: 250, scale: 0.5 }),
    }
    const result = await executeComputerToolCommand({ command: 'screenshot', fns: scaled })
    expect(result.output).toContain('image scale 0.5 px per window unit')
  })

  it('writes --out screenshots into a directory with sequential names', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-computer-out-'))
    try {
      const first = await executeComputerToolCommand({
        command: `screenshot --out "${dir}"`,
        fns: makeFns([]),
      })
      await executeComputerToolCommand({ command: `screenshot --out "${dir}"`, fns: makeFns([]) })
      expect(first.output).toContain('Saved:')
      expect(existsSync(join(dir, 'screenshot-0001.png'))).toBe(true)
      expect(existsSync(join(dir, 'screenshot-0002.png'))).toBe(true)
      // Either/or: the file is the answer. A second copy of the same pixels would give the caller
      // two sources of truth for one capture.
      expect(first.image).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes an exact file path, resolving a relative --out from the workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-computer-out-'))
    try {
      const absolute = join(dir, 'shots', 'login.png')
      await executeComputerToolCommand({ command: `screenshot --out "${absolute}"`, fns: makeFns([]) })
      expect(existsSync(absolute)).toBe(true)

      await executeComputerToolCommand({
        command: 'screenshot --out frames',
        fns: makeFns([]),
        workspaceRootPath: dir,
      })
      expect(existsSync(join(dir, 'frames', 'screenshot-0001.png'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses --out on a command that produces no image', async () => {
    await expect(executeComputerToolCommand({
      command: 'windows --out shots',
      fns: makeFns([]),
    })).rejects.toThrow('--out only applies to screenshot.')
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
