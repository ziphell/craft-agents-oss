import { describe, it, expect, mock } from 'bun:test'
import * as realConfig from '@craft-agent/shared/config'
import { ComputerUseManager } from '../computer-use-manager'

/**
 * The boundary between the manager and the desktop driver.
 *
 * Everything here is about **field names**: a `ToolResult` is `{ text, images, structuredJson,
 * isError, errorCode, action, verification, degraded, rawJson }` and nothing else, so a reply read
 * as if it were the payload (`answer.windows`, `answer.role`, `answer.delivered`) answers
 * `undefined` and says so nowhere. These tests hold the boundary at the two places that used to
 * read through it: the action verdict, and what `invoke` actually asks the driver to do.
 */

// The person's switch is the outer gate on `fnsForSession`; the desktop is what is under test.
mock.module('@craft-agent/shared/config', () => ({ ...realConfig, getComputerUseEnabled: () => true }))

const WINDOW = {
  windowId: '42',
  pid: 100,
  appName: 'TestApp',
  title: 'Test window',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  isOnScreen: true,
  minimized: false,
  zIndex: '1',
}

/** `click`'s own answer, measured against a live driver: snake_case names, no role, no label. */
const CLICK_REPLY = {
  text: '✅ Performed PostMessage click on [1] (screen (388,476)).',
  images: [],
  structuredJson: '{"delivery":{"mode":"background"},"effect":"unverifiable","route":"synthetic_events"}',
  isError: false,
  degraded: false,
  rawJson: '{}',
}

function harness(options: {
  reply?: Record<string, unknown>
  state?: Record<string, unknown>
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const reads: Array<Record<string, unknown>> = []
  const driver = {
    metadata: () => ({ driverVersion: 'test', contractVersion: 'test' }),
    isAvailable: () => true,
    startSession: async () => ({ state: {}, active: true, revived: false }),
    endSession: async () => ({}),
    shutdown: async () => {},
    listWindows: async () => ({ windows: [WINDOW], currentSpaceId: null }),
    getWindowState: async (input: Record<string, unknown>) => {
      reads.push(input)
      return {
      pid: WINDOW.pid,
      windowId: 42n,
      snapshotId: 's00000001',
      elements: [
        {
          elementToken: 's00000001:1',
          elementIndex: 1,
          role: 'Button',
          label: 'Submit',
          actions: ['invoke'],
          depth: 0,
        },
      ],
      elementCount: 1n,
      totalElementCount: 1n,
      degraded: false,
        images: [],
        ...options.state,
      }
    },
    callTool: async (name: string, argsJson: string) => {
      calls.push({ name, args: JSON.parse(argsJson) })
      if (name === 'get_cursor_position') {
        return { text: '1,2', images: [], structuredJson: null, isError: false, degraded: false, rawJson: '' }
      }
      return { ...CLICK_REPLY, ...options.reply }
    },
  }
  return { driver, calls, reads, manager: new ComputerUseManager({ loadDriver: async () => driver }) }
}

async function paneFor(harnessed: ReturnType<typeof harness>) {
  return await harnessed.manager.fnsForSession('session-1')
}

describe('computer-use manager > an action reply', () => {
  it('reports the node from the snapshot and the verdict from the reply', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)
    const snapshot = await fns.snapshot({ windowId: '42' })
    const token = snapshot.elements[0]!.token

    const outcome = await fns.invoke({ token }, 'invoke')

    expect(outcome.role).toBe('Button')
    expect(outcome.label).toBe('Submit')
    expect(outcome.effect).toBe('unverifiable')
    expect(outcome.delivered).toBe('background')
    expect(outcome.route).toBe('synthetic_events')
  })

  it('reads ordinals from the typed half when the structured half is absent', async () => {
    // `{ effect: 3 }` is SuspectedNoop and `{ delivery: { mode: 1 } }` is Foreground — the typed
    // `action` record spells the same fields as numbers, so both halves have to be understood.
    const harnessed = harness({
      reply: { structuredJson: null, action: { effect: 3, route: 1, delivery: { mode: 1 } } },
    })
    const fns = await paneFor(harnessed)
    const { elements } = await fns.snapshot({ windowId: '42' })

    const outcome = await fns.invoke({ token: elements[0]!.token }, 'invoke')

    expect(outcome.effect).toBe('suspected_noop')
    expect(outcome.delivered).toBe('foreground')
    expect(outcome.route).toBe('synthetic_events')
  })

  it('keeps the verdict absent rather than inventing one', async () => {
    const harnessed = harness({ reply: { structuredJson: null, action: null } })
    const fns = await paneFor(harnessed)
    const { elements } = await fns.snapshot({ windowId: '42' })

    const outcome = await fns.invoke({ token: elements[0]!.token })

    expect(outcome.effect).toBeUndefined()
    expect(outcome.delivered).toBe('background')
  })
})

describe('computer-use manager > invoke', () => {
  it('asks for a tool that exists, never for an `action` argument', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)
    const { elements } = await fns.snapshot({ windowId: '42' })

    await fns.invoke({ token: elements[0]!.token }, 'show_menu')

    const call = harnessed.calls.find((entry) => entry.name === 'right_click')
    expect(call).toBeDefined()
    // The field the driver drops in silence: its schema has no `action`, and its own description
    // says the Swift-only `action` field "isn't supported yet".
    expect(Object.keys(call!.args)).not.toContain('action')
    expect(call!.args.element_token).toBe('s00000001:1')
    expect(call!.args.pid).toBe(100)
    expect(call!.args.window_id).toBe('42')
  })

  it('maps the default and `select` onto a click', async () => {
    for (const action of [undefined, 'invoke', 'press', 'select', 'AXPress']) {
      const harnessed = harness()
      const fns = await paneFor(harnessed)
      const { elements } = await fns.snapshot({ windowId: '42' })
      await fns.invoke({ token: elements[0]!.token }, action)
      expect(harnessed.calls.some((entry) => entry.name === 'click')).toBe(true)
    }
  })

  it('refuses an action with no equivalent, naming what does work', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)
    const { elements } = await fns.snapshot({ windowId: '42' })
    const token = elements[0]!.token

    await expect(fns.invoke({ token }, 'expand')).rejects.toThrow(/no element action "expand"/)
    await expect(fns.invoke({ token }, 'confirm')).rejects.toThrow(/click it \(the default\)/)
  })

  it('points at the command that does the thing, instead of dropping the name', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)
    const { elements } = await fns.snapshot({ windowId: '42' })

    await expect(fns.invoke({ token: elements[0]!.token }, 'set_value')).rejects.toThrow(/set-value <ref> <text>/)
    await expect(fns.invoke({ token: elements[0]!.token }, 'scroll')).rejects.toThrow(/scroll <up\|down\|left\|right>/)
  })
})

describe('computer-use manager > snapshot', () => {
  it('clips a label that is a whole document', async () => {
    const long = 'x'.repeat(900)
    const harnessed = harness({
      state: {
        elements: [
          { elementToken: 's00000001:1', elementIndex: 1, role: 'Document', label: long, actions: [], depth: 0 },
        ],
      },
    })
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42' })

    expect(snapshot.elements[0]!.label.length).toBe(201)
    expect(snapshot.elements[0]!.label.endsWith('…')).toBe(true)
  })

  it('says how many elements the window holds when the read was capped', async () => {
    const harnessed = harness({ state: { elementCount: 1n, totalElementCount: 340n } })
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42' })

    expect(snapshot.total).toBe(340)
    expect(snapshot.elements.length).toBe(1)
  })

  it('passes a query through to the driver and marks the read', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42', query: 'Submit' })

    expect(harnessed.reads[0]).toMatchObject({ query: 'Submit' })
    // The cap cuts the walk itself, so a search must not carry one: measured on one window, the same
    // query finds 48 nodes uncapped and 20 under a 400 cap.
    expect('maxElements' in harnessed.reads[0]!).toBe(false)
    expect(snapshot.filtered).toBe('Submit')
  })

  it('keeps the tree as the source when a filter matched nothing', async () => {
    const harnessed = harness({ state: { elements: [], elementCount: 5n, totalElementCount: 5n } })
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42', query: 'zzz' })

    expect(snapshot.elements).toEqual([])
    expect(snapshot.source).toBe('accessibility')
    expect(snapshot.total).toBe(5)
    // A filtered read is not a capped one: nothing was withheld, nothing matched.
    expect(snapshot.note).toBeUndefined()
  })

  it('leaves the query off a full read', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42' })

    expect('query' in harnessed.reads[0]!).toBe(false)
    expect(snapshot.filtered).toBeUndefined()
    expect(harnessed.reads[0]).toMatchObject({ maxElements: 400 })
  })

  it('admits that a capped read may not be the whole window', async () => {
    // The driver sets neither `truncated` nor a total for a capped walk (measured: a 1412-element
    // window answers `element_count: 267` under a 400 cap), so the cap is ours to say out loud.
    const harnessed = harness()
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42' })

    expect(snapshot.note).toContain('read capped at 400 elements')
    expect(snapshot.note).toContain('may hold more')
  })

  it('leaves the total out when nothing was withheld', async () => {
    const harnessed = harness()
    const fns = await paneFor(harnessed)

    const snapshot = await fns.snapshot({ windowId: '42' })

    expect(snapshot.total).toBeUndefined()
  })
})
