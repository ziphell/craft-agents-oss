import { describe, it, expect } from 'bun:test'
import type { WebContents } from 'electron'
import { BrowserCDP, type OverlayLabels } from '../browser-cdp'

/**
 * The overlay ships as one large injected script string, so a typo would only
 * surface at runtime inside a real page. These tests compile that expression
 * (catching syntax errors) and pin the shape of the interaction as source text —
 * this package has no DOM harness to drive it with.
 *
 * One script covers two callers, and both are checked here: the window's own mode
 * (resident, with the bar) and the agent's one-shot `browser_tool pick` (no bar, gone
 * as soon as it answers). The `if (!true)` / `if (!false)` assertions below are how
 * that difference is read out of the injected source.
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

const ACCENT = '#8b5cf6'

/** The bar's word travels from the toolbar renderer, which is the side with i18n. */
const LABELS: OverlayLabels = { add: 'Add to conversation' }

const PICKED = {
  selector: '[data-testid="pay"]',
  tag: 'button',
  text: 'Pay now',
  rect: { x: 10, y: 20, width: 120, height: 40 },
}

describe('BrowserCDP overlay', () => {
  it('injects a syntactically valid script, in the window’s colour and language', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    expect(injectExpression).toContain('__craft_agent_overlay__')
    // Everything the app draws *about* the page wears the window's accent — the frame,
    // the name chip, and the one control — so the bar is filled with it too, in a pill
    // tight enough for one word on somebody else's page.
    expect(injectExpression).toContain(`border-radius:7px;background:${ACCENT}`)
    expect(injectExpression).toContain('height:20px;line-height:20px;padding:0 8px')
    // The bar is drawn inside the page, which has no i18n: the word has to come
    // down with the call or the button would be untitled.
    expect(injectExpression).toContain(JSON.stringify(LABELS.add))
    expect(() => new Function(injectExpression)).not.toThrow()
    cdp.detach()
  })

  it('hangs the bar off the selection’s bottom-left, and the name to the page’s', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // The one control sits at the selection frame's bottom-left corner — placed per
    // paint off the union of what is selected, so it follows the frame, and lifted
    // inside that frame when there is no room below it.
    expect(injectExpression).toContain('bar.style.left = Math.max(8, union.left)')
    expect(injectExpression).toContain('window.innerHeight')
    // Nothing pins it to the page's own top edge any more.
    expect(injectExpression).not.toContain('translateX(-50%)')
    // The name is one chip in one place — the page's bottom-left, fixed — rather than
    // hung off whatever it names: a chip that moves with the page covers the very thing
    // the person is looking at.
    expect(injectExpression).toContain('left:8px;bottom:8px;')
    expect(injectExpression).toContain("const nameLabel = document.createElement('div');")
    expect(injectExpression).toContain('const paintName = () => {')
    // Which is what the frame no longer carries: a frame per selected element, no label.
    expect(injectExpression).not.toContain('hoverLabel')
    expect(injectExpression).not.toContain('r.bottom + 4')
    cdp.detach()
  })

  it('boxes elements, and reads a click as the element under the cursor', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // A drag is tracked in viewport coordinates and hit-tested on release...
    expect(injectExpression).toContain('drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };')
    // ...a box takes the blocks it covers, and a click the element under the cursor —
    // inline included, so clicking a link inside a paragraph selects the link. A click
    // that lands on the document itself is "nothing here": it clears rather than
    // framing the whole page, which is what body would do.
    expect(injectExpression).toContain('selected = within(box);')
    expect(injectExpression).toContain('el !== document.body && el !== document.documentElement ? [el] : [];')
    // The chip answers "what am I choosing" while the hand is still down: the element the
    // press landed on, and — once the press has become a box — what the box is covering,
    // which is also outlined with the same dashed box the hover uses.
    expect(injectExpression).toContain('let preview = null;')
    expect(injectExpression).toContain('preview = within(rectOf(drag));')
    expect(injectExpression).toContain('const names = preview')
    expect(injectExpression).toContain("const previewLayer = document.createElement('div');")
    expect(injectExpression).toContain('const drawPreview = (elements) => {')
    // Pressing keeps the dashed box where the hover had it: the press is about that one
    // element, and a box that vanished on press would take away the only marker for it.
    expect(injectExpression).toContain('paintHover(current);')
    expect(injectExpression).toContain("if (display === 'inline' || display === 'contents') continue;")
    // Nothing the person pressed may activate the page under the mode.
    expect(injectExpression).toContain('const swallowClick = (e) => {')
    cdp.detach()
  })

  it('freezes the page against the mouse, in both spellings', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // A page listens to the mouse events as often as to the pointer ones, and they are
    // separate events: a press the pointer handler refuses is a press the page still
    // gets, and a double-click that reached it selects its text or follows its link.
    expect(injectExpression).toContain('const swallowMouse = (e) => {')
    // On `window` capture, so the mode sees a gesture before the page can — a page's own
    // `window`-capture handler runs ahead of anything on `document`, and one that stops
    // propagation there would swallow the press whole.
    expect(injectExpression).toContain("window.addEventListener('mousedown', swallowMouse, true);")
    expect(injectExpression).toContain("window.addEventListener('mouseup', swallowMouse, true);")
    expect(injectExpression).toContain("window.removeEventListener('mousedown', swallowMouse, true);")
    expect(injectExpression).toContain("window.removeEventListener('mouseup', swallowMouse, true);")
    expect(injectExpression).not.toContain('document.addEventListener(')
    // And a button that is held is never a hover: what the cursor passes over during a
    // press must not become the name the chip shows.
    expect(injectExpression).toContain('if (drag || e.buttons) return;')
    // One exception, and only one: the overlay's own chrome.
    expect(injectExpression).toContain('const browserOwnsIt = (e) => inOverlay(e.target);')
    expect(injectExpression).toContain('if (browserOwnsIt(e)) return;')
    cdp.detach()
  })

  it('keeps a one-shot pick separate: no bar, and gone as soon as it answers', async () => {
    const oneShot = createFakeWebContents(() => ({}))
    await new BrowserCDP(oneShot.webContents).armOverlay({ accent: ACCENT, bar: false, resident: false })

    const oneShotScript = oneShot.expressions[0]!
    expect(oneShotScript).toContain('const WITH_BAR = false;')
    // `!false` = the one-shot branch: report what is under the cursor and tear down.
    expect(oneShotScript).toContain('if (!false) {')
    expect(oneShotScript).toContain("state.picks.push(elementPayload(el));\n      finish('picked');")

    // The window's own mode is the other side of the same test: it keeps the
    // selection and draws the bar.
    const resident = createFakeWebContents(() => ({}))
    await new BrowserCDP(resident.webContents).armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const residentScript = resident.expressions[0]!
    expect(residentScript).toContain('const WITH_BAR = true;')
    expect(residentScript).toContain('if (!true) {')
  })

  it('hands the selection to the conversation, one pick each', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // The selection is the unit: every selected element is one pick, and nothing is
    // reported before the bar's button is pressed.
    expect(injectExpression).toContain('const addToConversation = () => {')
    expect(injectExpression).toContain('const elements = selected.filter((el) => el.isConnected);')
    expect(injectExpression).toContain('for (const el of elements) state.picks.push(elementPayload(el));')
    expect(injectExpression).toContain("addButton.addEventListener('click', (e) => {")
    // The bar is there exactly while there is a selection to hand over.
    expect(injectExpression).toContain("bar.style.display = WITH_BAR && selected.length > 0 ? 'flex' : 'none';")
    cdp.detach()
  })

  it('has one way out, and leaves nothing of its own on the page', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // Escape is the same "leave" the window's crosshair asks for.
    expect(injectExpression).toContain("if (e.key !== 'Escape') return;")
    expect(injectExpression).toContain("window.__craft_agent_overlay_cancel__ = () => finish('cancelled');")
    expect(injectExpression).toContain("const existing = document.getElementById('")
    cdp.detach()
  })

  it('returns a one-shot pick, polling until it answers and then tearing down', async () => {
    let reads = 0
    const { webContents, expressions } = createFakeWebContents((params) => {
      if (!params.returnByValue) return {}
      reads += 1
      if (reads === 1) return { result: { value: JSON.stringify({ status: 'pending', picks: [] }) } }
      return { result: { value: JSON.stringify({ status: 'picked', picks: [PICKED] }) } }
    })

    const cdp = new BrowserCDP(webContents)
    const picked = await cdp.pickElement({ timeoutMs: 1_000, pollMs: 50, accent: ACCENT })

    expect(picked).toEqual(PICKED)
    expect(reads).toBeGreaterThan(1)
    // Nothing left mounted: the one-shot pick is finished with the page.
    expect(expressions[expressions.length - 1]).toContain('__craft_agent_overlay_cancel__')
    cdp.detach()
  })

  it('reads picks once each, and reports a missing overlay as an answer', async () => {
    let reads = 0
    const { webContents } = createFakeWebContents((params) => {
      if (!params.returnByValue) return {}
      reads += 1
      if (reads <= 2) {
        return { result: { value: JSON.stringify({ status: 'pending', picks: [PICKED] }) } }
      }
      return { result: { value: JSON.stringify({ status: 'pending', picks: [] }) } }
    })

    const cdp = new BrowserCDP(webContents)
    expect(await cdp.drainOverlay()).toMatchObject({ picks: [PICKED] })
    expect(await cdp.drainOverlay()).toMatchObject({ picks: [PICKED] })
    expect(await cdp.drainOverlay()).toMatchObject({ picks: [] })
    cdp.detach()

    const missing = createFakeWebContents(() => ({ result: { value: undefined } }))
    expect(await new BrowserCDP(missing.webContents).drainOverlay())
      .toEqual({ status: 'missing', picks: [] })
  })

  it('tears the overlay down when asked', async () => {
    const torn = createFakeWebContents(() => ({}))
    await new BrowserCDP(torn.webContents).teardownOverlay()
    expect(torn.expressions[torn.expressions.length - 1]).toContain('__craft_agent_overlay_cancel__')
  })
})
