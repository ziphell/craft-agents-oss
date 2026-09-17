import { describe, it, expect } from 'bun:test'
import type { WebContents } from 'electron'
import { BrowserCDP } from '../browser-cdp'

/**
 * The picker ships as one large injected script string, so a typo would only
 * surface at runtime inside a real page. These tests compile the injected
 * expression (catching syntax errors) and drive the poll/cancel protocol
 * against a stub `webContents.debugger`.
 */
function createFakeWebContents(respond: (params: any) => unknown) {
  const expressions: string[] = []
  const fake = {
    debugger: {
      attach: () => {},
      detach: () => {},
      on: () => {},
      sendCommand: async (_method: string, params: any) => {
        expressions.push(params?.expression ?? '')
        return respond(params)
      },
    },
  }
  return { webContents: fake as unknown as WebContents, expressions }
}

const PICKED = {
  selector: '[data-testid="pay"]',
  tag: 'button',
  text: 'Pay now',
  rect: { x: 10, y: 20, width: 120, height: 40 },
}

/**
 * The app's accent, as the pane manager resolves it for the picker.
 *
 * A page cannot see the app's variables, so the colour travels down as a concrete
 * value — which is why every arming in these tests has to pass one.
 */
const ACCENT = '#8b5cf6'

describe('BrowserCDP picker', () => {
  it('injects a syntactically valid picker script', async () => {
    const { webContents, expressions } = createFakeWebContents((params) => {
      if (params.returnByValue) {
        return { result: { value: JSON.stringify({ status: 'cancelled' }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    expect(await cdp.pickElement({ timeoutMs: 1_000, accent: ACCENT })).toBe(null)

    const injectExpression = expressions[0]
    expect(injectExpression).toContain('__craft_agent_picker_overlay__')
    expect(() => new Function(injectExpression)).not.toThrow()

    // The picker must be torn down even on the cancel path.
    expect(expressions[expressions.length - 1]).toContain('__craft_agent_picker_cancel__')
    cdp.detach()
  })

  it('returns the picked element parsed from the polled state', async () => {
    const { webContents, expressions } = createFakeWebContents((params) => {
      if (params.returnByValue) {
        return { result: { value: JSON.stringify({ status: 'picked', picks: [PICKED] }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    const picked = await cdp.pickElement({ timeoutMs: 1_000, accent: ACCENT })

    expect(picked).toEqual(PICKED)
    expect(expressions.every((expr) => typeof expr === 'string' && expr.length > 0)).toBe(true)
    cdp.detach()
  })

  it('keeps polling while the picker reports pending, then times out', async () => {
    let polls = 0
    const { webContents } = createFakeWebContents((params) => {
      if (params.returnByValue) {
        polls += 1
        return { result: { value: JSON.stringify({ status: 'pending', picks: [] }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    const picked = await cdp.pickElement({ timeoutMs: 1_000, pollMs: 50, accent: ACCENT })

    expect(picked).toBe(null)
    expect(polls).toBeGreaterThan(1)
    cdp.detach()
  })

  it('treats a missing picker state as cancelled', async () => {
    const { webContents } = createFakeWebContents((params) => {
      if (params.returnByValue) {
        return { result: { value: JSON.stringify({ status: 'missing' }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    expect(await cdp.pickElement({ timeoutMs: 1_000, accent: ACCENT })).toBe(null)
    cdp.detach()
  })

  it('arms a resident picker without tearing it down, and hands back each pick once', async () => {
    let reads = 0
    const { webContents, expressions } = createFakeWebContents((params) => {
      if (!params.returnByValue) return {}
      reads += 1
      // The page keeps picking: the same element twice, then nothing new.
      return {
        result: {
          value: JSON.stringify({
            status: 'pending',
            picks: reads <= 2 ? [PICKED] : [],
          }),
        },
      }
    })

    const cdp = new BrowserCDP(webContents)
    await cdp.armPicker({ addToConversation: true, addLabel: 'Add', accent: ACCENT, resident: true })

    // The injected script must carry the resident flag through, or the page would
    // tear its own overlay down after the first pick.
    const injectExpression = expressions[0]!
    expect(injectExpression).toContain('if (true) return;')
    // And the app's own colour with it: a page cannot see the app's variables, so
    // this is the only way the overlay can be drawn in the window's colour.
    expect(injectExpression).toContain(ACCENT)
    expect(() => new Function(injectExpression)).not.toThrow()

    expect((await cdp.drainPicker()).picks).toEqual([PICKED])
    expect((await cdp.drainPicker()).picks).toEqual([PICKED])
    expect((await cdp.drainPicker()).picks).toEqual([])

    // Arming is not a pick: one injection, then one call per read, and nothing
    // tearing the page's overlay down in between.
    expect(expressions.length).toBe(4)
    cdp.detach()
  })

  it('makes a click select, with adding left to the bar', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armPicker({ addToConversation: true, addLabel: 'Add to conversation', accent: ACCENT, resident: true })

    // The shape of the interaction, guarded as source text: the script only runs
    // inside a real page, and this package has no DOM harness to drive it with
    // (the same reason the resident flag above is checked this way).
    const injectExpression = expressions[0]!
    // The click is the selection...
    expect(injectExpression).toContain('selected = el;')
    // ...and a resident picker stops there: the click's own report sits behind the
    // resident early-return, so clicking an element cannot add it on its own.
    expect(injectExpression).toContain('if (true) return;\n    report(elementPayload(el));')
    // The add is the bar's own click, and it acts on what was selected.
    expect(injectExpression).toContain("const el = selected;")
    cdp.detach()
  })
})
