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

/** The bar's colours: the app's menu surface and text, resolved by the caller. */
const MENU = { surface: 'oklch(0.2 0.01 270)', text: 'oklch(0.95 0.01 270)' }

/** The bar's words travel from the toolbar renderer, which is the side with i18n. */
const LABELS: OverlayLabels = {
  add: 'Add to conversation',
  undo: 'Undo',
  redo: 'Redo',
  save: 'Save',
  bold: 'Bold',
  italic: 'Italic',
}

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
    await cdp.armOverlay({ accent: ACCENT, menu: MENU, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    expect(injectExpression).toContain('__craft_agent_overlay__')
    // The marks the app draws *about* the page keep the accent...
    expect(injectExpression).toContain(ACCENT)
    // ...while the bar wears the app's menu colours, which the caller resolves.
    expect(injectExpression).toContain(MENU.surface)
    expect(injectExpression).toContain(MENU.text)
    // The bar is drawn inside the page, which has no i18n: the words have to come
    // down with the call or the buttons would be untitled.
    expect(injectExpression).toContain(JSON.stringify(LABELS.add))
    expect(injectExpression).toContain(JSON.stringify(LABELS.undo))
    expect(() => new Function(injectExpression)).not.toThrow()
    cdp.detach()
  })

  it('pins the bar out of the way, and puts the selection’s name below its corner', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, menu: MENU, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // Top of the page, centred: the one place that is never over the thing being
    // changed, and the same place whatever is selected.
    expect(injectExpression).toContain('left:50%;top:8px;transform:translateX(-50%)')
    // The name sits under the frame's bottom-left corner rather than on it.
    expect(injectExpression).toContain("+ 'display:block;left:' + r.left + 'px;top:' + Math.min(window.innerHeight - 24, r.bottom + 4) + 'px;'")
    cdp.detach()
  })

  it('keeps back and forward at the page’s top-left, on the keyboard too', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, menu: MENU, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // The two the person reaches for constantly live on their own — with save beside
    // them, which is about the draft as a whole rather than about the selection — so
    // the rest of the bar can change with the selection while these stay put.
    expect(injectExpression).toContain('left:8px;top:8px;')
    expect(injectExpression).toContain("const undoButton = makeButton('\\u21b6'")
    expect(injectExpression).toContain("const redoButton = makeButton('\\u21b7'")
    expect(injectExpression).toContain("const saveButton = makeButton('\\u2713'")
    expect(injectExpression).toContain('for (const node of [undoButton, redoButton, saveButton]) {')
    expect(injectExpression).toContain('undoBar.appendChild(node);')
    expect(injectExpression).toContain('undoBar.style.display = WITH_BAR && working ?')
    expect(injectExpression).toContain('const working = selected.length > 0 || unsaved() > 0 || undone.length > 0;')
    // ...and answers to the shortcuts every editor uses: Ctrl/Cmd+Z back, and either
    // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y forward.
    expect(injectExpression).toContain('if ((e.ctrlKey || e.metaKey) && !e.altKey && !editing) {')
    expect(injectExpression).toContain("if (key === 'z' && !e.shiftKey) {")
    expect(injectExpression).toContain("if ((key === 'z' && e.shiftKey) || key === 'y') {")
    // Enter finishes a retype; Shift+Enter stays a line break for the page.
    expect(injectExpression).toContain("if (editing && e.key === 'Enter' && !e.shiftKey) {")
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

  it('freezes the page against the mouse, in both spellings', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, menu: MENU, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // A page listens to the mouse events as often as to the pointer ones, and they are
    // separate events: a press the pointer handler refuses is a press the page still
    // gets, and a double-click that reached it selects its text or follows its link.
    expect(injectExpression).toContain('const swallowMouse = (e) => {')
    expect(injectExpression).toContain("document.addEventListener('mousedown', swallowMouse, true);")
    expect(injectExpression).toContain("document.addEventListener('mouseup', swallowMouse, true);")
    expect(injectExpression).toContain("document.removeEventListener('mousedown', swallowMouse, true);")
    expect(injectExpression).toContain("document.removeEventListener('mouseup', swallowMouse, true);")
    // Two exceptions, and only two: the overlay's own chrome, and the element being
    // typed into — where the caret and the word selection belong to the browser.
    expect(injectExpression).toContain('const browserOwnsIt = (e) => inOverlay(e.target) || !!(editing && editing.el.contains(e.target));')
    expect(injectExpression).toContain('if (!WITH_BAR || browserOwnsIt(e)) return;')
    expect(injectExpression).toContain('if (browserOwnsIt(e)) return;')
    // A press outside what is being typed into is still the mode's: the edit is
    // committed by us rather than by a blur the page's own focus handling caused.
    expect(injectExpression).toContain('if (editing && !editing.el.contains(e.target)) endText(true);')
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
    // Undo and redo are the same move in both directions, and a text edit is the one
    // that has to touch the page — which is why the draft keeps the element and its
    // original text.
    expect(injectExpression).toContain('const applyEntry = (entry, forward) => {')
    expect(injectExpression).toContain('entry.el.textContent = forward ? entry.text : entry.before;')
    expect(injectExpression).toContain('const undo = () => {')
    expect(injectExpression).toContain('undone.unshift(entry);')
    expect(injectExpression).toContain('const redo = () => {')
    expect(injectExpression).toContain('const entry = undone.shift();')
    // A new edit forks the draft: what was taken back is no longer ahead of us — and
    // it is the person working on rather than answering, so any leave question drops.
    expect(injectExpression).toContain('    undone = [];\n    confirming = false;\n    draft.push({ kind: \'style\'')
    expect(injectExpression).toContain("draft.push({ kind: 'text', targets: [targetOf(inFlight.el)], text: text, el: inFlight.el, before: inFlight.before });")
    cdp.detach()
  })

  it('writes one save as one batch, and hands the selection to the conversation', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, menu: MENU, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // What crosses to the caller is the moment they said keep it, not the edits.
    expect(injectExpression).toContain('const batch = draft.slice(savedCount).map(')
    expect(injectExpression).toContain('state.saves.push(batch);')
    expect(injectExpression).toContain('savedCount = draft.length;')
    // One bar carries the draft's own work and the way out of it.
    expect(injectExpression).toContain('const addToConversation = () => {')
    expect(injectExpression).toContain('state.picks.push(elementPayload(el));')
    // Glyphs for the draft's own actions, and words only for the odd one out.
    expect(injectExpression).toContain("const undoButton = makeButton('\\u21b6'")
    expect(injectExpression).toContain("const redoButton = makeButton('\\u21b7'")
    expect(injectExpression).toContain("const saveButton = makeButton('\\u2713'")
    expect(injectExpression).toContain('for (const node of [undoButton, redoButton, saveButton]) {')
    expect(injectExpression).toContain('for (const node of [boldButton, italicButton, addSpacer, addButton]) {')
    // No discard button and no count: the bar says what it can do by dimming, and the
    // way to drop a draft is to leave the mode (which asks first).
    expect(injectExpression).not.toContain('discardButton')
    expect(injectExpression).toContain("undoButton.style.opacity = unsaved() === 0 ? '0.45' : '1';")
    expect(injectExpression).toContain("redoButton.style.opacity = undone.length === 0 ? '0.45' : '1';")
    expect(injectExpression).toContain("saveButton.style.opacity = unsaved() === 0 ? '0.45' : '1';")
    // Both clusters are where the draft lives, so they stay while there is something to
    // decide or something to take back.
    expect(injectExpression).toContain('bar.style.display = WITH_BAR && working ?')
    // The ✓ writes the draft down, and it is the same save as any other: one batch.
    expect(injectExpression).toContain("saveButton.addEventListener('click', (e) => {")
    // What the window's chip is told: whether that draft is what holds the mode open.
    expect(injectExpression).toContain('get leavingWithEdits() { return confirming; },')
    cdp.detach()
  })

  it('asks before leaving when there is a draft, and answers what Escape means', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armOverlay({ accent: ACCENT, menu: MENU, labels: LABELS, bar: true, resident: true })

    const injectExpression = expressions[0]!
    // Leaving with a draft is a question, not a decision: the mode stays mounted and
    // the toolbar is told to ask — that is what `leavingWithEdits` is for.
    expect(injectExpression).toContain('const requestLeave = (immediate) => {')
    expect(injectExpression).toContain('if (!immediate && unsaved() > 0) {')
    expect(injectExpression).toContain('confirming = true;')
    // The toolbar's button asks, Escape asks, and a teardown does not (nobody is left
    // to ask: the tab is closing, or the overlay is being re-armed on another page).
    expect(injectExpression).toContain('window.__craft_agent_overlay_ask_leave__ = () => requestLeave(false);')
    expect(injectExpression).toContain('window.__craft_agent_overlay_cancel__ = () => requestLeave(true);')
    expect(injectExpression).toContain('if (WITH_BAR) { requestLeave(false); return; }')
    // Escape is the "no" — the bar has no discard button — and the toolbar's save is
    // the "yes"; both end the mode.
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

    // Whether the draft is what holds the mode open comes from the same read.
    const waiting = createFakeWebContents(() => ({
      result: { value: JSON.stringify({ status: 'pending', picks: [], saves: [], leavingWithEdits: true }) },
    }))
    expect(await new BrowserCDP(waiting.webContents).drainOverlay()).toMatchObject({ leavingWithEdits: true })

    const missing = createFakeWebContents(() => ({ result: { value: undefined } }))
    expect(await new BrowserCDP(missing.webContents).drainOverlay())
      .toEqual({ status: 'missing', picks: [], saves: [], leavingWithEdits: false })
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
