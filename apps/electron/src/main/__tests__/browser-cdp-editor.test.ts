import { describe, it, expect } from 'bun:test'
import type { WebContents } from 'electron'
import type { BrowserEdit } from '@craft-agent/shared/protocol'
import { BrowserCDP, type EditorLabels } from '../browser-cdp'

/**
 * The editor ships as one large injected script string, so a typo would only
 * surface at runtime inside a real page. These tests compile that expression
 * (catching syntax errors) and pin the shape of the interaction as source text —
 * this package has no DOM harness to drive it with, which is the same reason the
 * picker's own gestures are guarded this way.
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
const LABELS: EditorLabels = { undo: 'Undo', save: 'Save {n}', discard: 'Discard' }

const SAVE: BrowserEdit[] = [
  { kind: 'style', targets: [{ selector: '.total', tag: 'span' }], declarations: { 'font-weight': '700' } },
]

describe('BrowserCDP editor', () => {
  it('injects a syntactically valid editor script, in the window’s colour and language', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armEditor({ accent: ACCENT, labels: LABELS })

    const injectExpression = expressions[0]!
    expect(injectExpression).toContain('__craft_agent_editor_overlay__')
    expect(injectExpression).toContain(ACCENT)
    // The bar is drawn inside the page, which has no i18n: the words have to come
    // down with the call or the buttons would be blank.
    expect(injectExpression).toContain(JSON.stringify(LABELS.undo))
    expect(injectExpression).toContain(JSON.stringify(LABELS.save))
    expect(() => new Function(injectExpression)).not.toThrow()
    cdp.detach()
  })

  it('boxes elements, and reads a click as a box with no area', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armEditor({ accent: ACCENT, labels: LABELS })

    const injectExpression = expressions[0]!
    // The drag is tracked in viewport coordinates and hit-tested on release...
    expect(injectExpression).toContain('drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };')
    expect(injectExpression).toContain('selected = moved ? within(box) : within(')
    // ...and inline boxes are skipped so boxing a paragraph means the paragraph.
    expect(injectExpression).toContain("if (display === 'inline' || display === 'contents') continue;")
    // A form control is never made editable: it keeps its own editing, and reading
    // its textContent back would report an edit nobody made.
    expect(injectExpression).toContain("if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;")
    // Nothing the person pressed may activate the page under the mode.
    expect(injectExpression).toContain('const swallowClick = (e) => {')
    cdp.detach()
  })

  it('accumulates a draft, draws it, and takes it back without writing anything', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armEditor({ accent: ACCENT, labels: LABELS })

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
    expect(injectExpression).toContain("entry.el.textContent = entry.before")
    expect(injectExpression).toContain("draft.push({ kind: 'text', targets: [targetOf(current.el)], text: text, el: current.el, before: current.before });")
    cdp.detach()
  })

  it('writes one save as one batch, and keeps a draft reachable', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armEditor({ accent: ACCENT, labels: LABELS })

    const injectExpression = expressions[0]!
    // What crosses to the caller is the moment they said keep it, not the edits.
    expect(injectExpression).toContain('const batch = draft.slice(savedCount).map(')
    expect(injectExpression).toContain('state.saves.push(batch);')
    expect(injectExpression).toContain('savedCount = draft.length;')
    // The bar is what makes a draft honest: a count, and it stays reachable — an edit
    // nobody can press save on is worse than a bar with no selection under it.
    expect(injectExpression).toContain("saveButton.textContent = SAVE_LABEL.split('{n}').join(String(waiting));")
    expect(injectExpression).toContain('if (unsaved() === 0 && !confirming) { bar.style.display = ')
    cdp.detach()
  })

  it('asks before leaving when there is a draft, and answers what Escape means', async () => {
    const { webContents, expressions } = createFakeWebContents(() => ({}))
    const cdp = new BrowserCDP(webContents)
    await cdp.armEditor({ accent: ACCENT, labels: LABELS })

    const injectExpression = expressions[0]!
    // Leaving with a draft is a question, not a decision: the bar becomes save or
    // drop and the mode stays mounted until one of them is chosen.
    expect(injectExpression).toContain('const requestLeave = (immediate) => {')
    expect(injectExpression).toContain('if (!immediate && unsaved() > 0) {')
    expect(injectExpression).toContain('confirming = true;')
    expect(injectExpression).toContain("control.style.display = confirming ? 'none' : ''")
    // The button asks, Escape asks, and a teardown does not (nobody is left to ask).
    expect(injectExpression).toContain('window.__craft_agent_editor_ask_leave__ = () => requestLeave(false);')
    expect(injectExpression).toContain('window.__craft_agent_editor_cancel__ = () => requestLeave(true);')
    expect(injectExpression).toContain('      requestLeave(false);\n      return;')
    // A second Escape is the "no", and saving is the "yes" — both end the mode.
    expect(injectExpression).toContain("if (confirming) { confirming = false; discard(); finish('cancelled'); return; }")
    expect(injectExpression).toContain("if (confirming) { confirming = false; finish('cancelled'); return; }")
    cdp.detach()
  })

  it('reads saves once each, and reports a missing editor as an answer', async () => {
    let reads = 0
    const { webContents } = createFakeWebContents((params) => {
      if (!params.returnByValue) return {}
      reads += 1
      return {
        result: { value: JSON.stringify({ status: 'pending', saves: reads <= 1 ? [SAVE] : [] }) },
      }
    })

    const cdp = new BrowserCDP(webContents)
    expect((await cdp.drainEditor()).saves).toEqual([SAVE])
    expect((await cdp.drainEditor()).saves).toEqual([])
    cdp.detach()

    const missing = createFakeWebContents(() => ({ result: { value: undefined } }))
    expect(await new BrowserCDP(missing.webContents).drainEditor()).toEqual({ status: 'missing', saves: [] })
  })

  it('has two ways out: an ask the page may refuse, and a teardown', async () => {
    const asked = createFakeWebContents(() => ({}))
    await new BrowserCDP(asked.webContents).askEditorToLeave()
    expect(asked.expressions[asked.expressions.length - 1]).toContain('__craft_agent_editor_ask_leave__')

    const torn = createFakeWebContents(() => ({}))
    await new BrowserCDP(torn.webContents).teardownEditor()
    expect(torn.expressions[torn.expressions.length - 1]).toContain('__craft_agent_editor_cancel__')
  })
})
