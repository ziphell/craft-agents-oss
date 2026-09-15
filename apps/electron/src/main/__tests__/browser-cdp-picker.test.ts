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

describe('BrowserCDP picker', () => {
  it('injects a syntactically valid picker script', async () => {
    const { webContents, expressions } = createFakeWebContents((params) => {
      if (params.returnByValue) {
        return { result: { value: JSON.stringify({ status: 'cancelled' }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    expect(await cdp.pickElement({ timeoutMs: 1_000 })).toBe(null)

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
        return { result: { value: JSON.stringify({ status: 'picked', result: PICKED }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    const picked = await cdp.pickElement({ timeoutMs: 1_000 })

    expect(picked).toEqual(PICKED)
    expect(expressions.every((expr) => typeof expr === 'string' && expr.length > 0)).toBe(true)
    cdp.detach()
  })

  it('keeps polling while the picker reports pending, then times out', async () => {
    let polls = 0
    const { webContents } = createFakeWebContents((params) => {
      if (params.returnByValue) {
        polls += 1
        return { result: { value: JSON.stringify({ status: 'pending', result: null }) } }
      }
      return {}
    })

    const cdp = new BrowserCDP(webContents)
    const picked = await cdp.pickElement({ timeoutMs: 1_000, pollMs: 50 })

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
    expect(await cdp.pickElement({ timeoutMs: 1_000 })).toBe(null)
    cdp.detach()
  })
})
