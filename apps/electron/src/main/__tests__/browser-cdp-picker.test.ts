import { describe, it, expect } from 'bun:test'
import type { WebContents } from 'electron'
import type { BrowserEdit } from '@craft-agent/shared/protocol'
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

/** The bar's words travel from the toolbar renderer, which is the side with i18n. */
const LABELS: OverlayLabels = { add: 'Add to conversation', undo: 'Undo', save: 'Save {n}', discard: 'Discard' }

const PICKED = {
  selector: '[data-testid="pay"]',
  tag: 'button',
  text: 'Pay now',
  rect: { x: 10, y: 20, width: 120, height: 40 },
}

const SAVE: BrowserEdit[] = [
  { kind: 'style', targets: [{ selector: '.total', tag: 'span' }], declarations: { 'font-weight': '700' } },
]

describe('BrowserCDP overlay', () => {
  it('injects a syntactically valid script, in the window’s colour and language', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    expect(injectExpression).toContain('__craft_agent_overlay__')
    expect(injectExpression).toContain(ACCENT)
    // The bar is drawn inside the page, which has no i18n: the words have to come
    // down with the call or the buttons would be blank.
    expect(injectExpression).toContain(JSON.stringify(LABELS.add))
    expect(injectExpression).toContain(JSON.stringify(LABELS.save))
    expect(() => new Function(injectExpression)).not.toThrow()
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
    // inline included, so clicking a link inside a paragraph selects the link.
    expect(injectExpression).toContain('selected = moved ? within(box) : [document.elementFromPoint(e.clientX, e.clientY)]')
    expect(injectExpression).toContain("if (display === 'inline' || display === 'contents') continue;")
    // A form control is never made editable: it keeps its own editing, and reading
    // its textContent back would report an edit nobody made.
    expect(injectExpression).toContain("if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;")
    // Nothing the person pressed may activate the page under the mode.
    expect(injectExpression).toContain('const swallowClick = (e) => {')
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

  it('accumulates a draft, draws it, and takes it back without writing anything', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // An edit goes into the draft and is drawn from it — one stylesheet of ours,
    // generated in order, so a later edit wins exactly as it will once written.
    expect(injectExpression).toContain("draft.push({ kind: 'style', targets: elements.map(targetOf), declarations: declarations });")
    expect(injectExpression).toContain('const renderPreview = () => {')
    expect(injectExpression).toContain('preview.textContent = chunks.join(')
    // Undo is regenerating it, and a text edit goes back to what it said — which is
    // why the draft keeps the element and its original text.
    expect(injectExpression).toContain('const undo = () => {')
    expect(injectExpression).toContain('draft.pop()')
    expect(injectExpression).toContain('entry.el.textContent = entry.before')
    expect(injectExpression).toContain("draft.push({ kind: 'text', targets: [targetOf(inFlight.el)], text: text, el: inFlight.el, before: inFlight.before });")
    cdp.detach()
  })

  it('writes one save as one batch, and hands the selection to the conversation', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // What crosses to the caller is the moment they said keep it, not the edits.
    expect(injectExpression).toContain('const batch = draft.slice(savedCount).map(')
    expect(injectExpression).toContain('state.saves.push(batch);')
    expect(injectExpression).toContain('savedCount = draft.length;')
    // One bar carries both: the draft's own work, and the way out of it.
    expect(injectExpression).toContain('const addToConversation = () => {')
    expect(injectExpression).toContain('state.picks.push(elementPayload(el));')
    expect(injectExpression).toContain('for (const node of [boldButton, italicButton, styleSpacer, undoButton, saveButton, discardButton, addSpacer, addButton]) {')
    // The bar is what makes a draft honest: a count, and it stays reachable — an edit
    // nobody can press save on is worse than a bar with no selection under it.
    expect(injectExpression).toContain("saveButton.textContent = SAVE_LABEL.split('{n}').join(String(waiting));")
    expect(injectExpression).toContain('if (!WITH_BAR || (unsaved() === 0 && !confirming)) { bar.style.display = ')
    cdp.detach()
  })

  it('asks before leaving when there is a draft, and answers what Escape means', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // Leaving with a draft is a question, not a decision: the bar becomes save or
    // drop and the mode stays mounted until one of them is chosen.
    expect(injectExpression).toContain('const requestLeave = (immediate) => {')
    expect(injectExpression).toContain('if (!immediate && unsaved() > 0) {')
    expect(injectExpression).toContain('confirming = true;')
    expect(injectExpression).toContain("control.style.display = confirming ? 'none' : ''")
    // The toolbar's button asks, Escape asks, and a teardown does not (nobody is left
    // to ask: the tab is closing, or the overlay is being re-armed on another page).
    expect(injectExpression).toContain('window.__craft_agent_overlay_ask_leave__ = () => requestLeave(false);')
    expect(injectExpression).toContain('window.__craft_agent_overlay_cancel__ = () => requestLeave(true);')
    expect(injectExpression).toContain('if (WITH_BAR) { requestLeave(false); return; }')
    // A second Escape is the "no", and saving is the "yes" — both end the mode.
    expect(injectExpression).toContain("if (confirming) { confirming = false; discard(); finish('cancelled'); return; }")
    expect(injectExpression).toContain("if (confirming) { confirming = false; finish('cancelled'); return; }")
    // Teardown is a mode ending, not an edit being saved: nothing unsaved may be left.
    expect(injectExpression).toContain('    discard();\n    const existing = document.getElementById(')
    cdp.detach()
  })

  it('returns a one-shot pick, polling until it answers and then tearing down', async () => {
    let reads = 0
    const { webContents, expressions } = createFakeWebContents((params) => {
      if (!params.returnByValue) return {}
      reads += 1
      if (reads === 1) return { result: { value: JSON.stringify({ status: 'pending', picks: [], saves: [] }) } }
      return { result: { value: JSON.stringify({ status: 'picked', picks: [PICKED], saves: [] }) } }
    })

    const cdp = new BrowserCDP(webContents)
    const picked = await cdp.pickElement({ timeoutMs: 1_000, pollMs: 50, accent: ACCENT })

    expect(picked).toEqual(PICKED)
    expect(reads).toBeGreaterThan(1)
    // Nothing left mounted: the one-shot pick is finished with the page.
    expect(expressions[expressions.length - 1]).toContain('__craft_agent_overlay_cancel__')
    cdp.detach()
  })

  it('reads picks and saves once each, and reports a missing overlay as an answer', async () => {
    let reads = 0
    const { webContents } = createFakeWebContents((params) => {
      if (!params.returnByValue) return {}
      reads += 1
      if (reads <= 2) {
        return { result: { value: JSON.stringify({ status: 'pending', picks: [PICKED], saves: [SAVE] }) } }
      }
      return { result: { value: JSON.stringify({ status: 'pending', picks: [], saves: [] }) } }
    })

    const cdp = new BrowserCDP(webContents)
    expect(await cdp.drainOverlay()).toMatchObject({ picks: [PICKED], saves: [SAVE] })
    expect(await cdp.drainOverlay()).toMatchObject({ picks: [PICKED], saves: [SAVE] })
    expect(await cdp.drainOverlay()).toMatchObject({ picks: [], saves: [] })
    cdp.detach()

    const missing = createFakeWebContents(() => ({ result: { value: undefined } }))
    expect(await new BrowserCDP(missing.webContents).drainOverlay()).toEqual({ status: 'missing', picks: [], saves: [] })
  })

  it('has two ways out: an ask the page may refuse, and a teardown', async () => {
    const asked = createFakeWebContents(() => ({}))
    await new BrowserCDP(asked.webContents).askOverlayToLeave()
    expect(asked.expressions[asked.expressions.length - 1]).toContain('__craft_agent_overlay_ask_leave__')

    const torn = createFakeWebContents(() => ({}))
    await new BrowserCDP(torn.webContents).teardownOverlay()
    expect(torn.expressions[torn.expressions.length - 1]).toContain('__craft_agent_overlay_cancel__')
  })
})
