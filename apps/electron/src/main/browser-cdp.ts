/**
 * Browser CDP Helpers
 *
 * Uses Electron's webContents.debugger API (Chrome DevTools Protocol) for:
 * - Accessibility tree snapshots with ref-based element identification
 * - Element interaction (click, fill, select) via CDP commands
 *
 * This is the same approach used by Playwright/Stagehand — deterministic,
 * no fragile CSS selectors needed.
 */

import type { WebContents } from 'electron'
import type { BrowserEdit, PickedElement } from '@craft-agent/shared/protocol'
import {
  applyMockRequest,
  matchMockRoute,
  parseMockRequestBody,
  type MockMatch,
  type MockProgram,
  type MockRoute,
  type MockStore,
} from '@craft-agent/shared/prototypes'
import { mainLog } from './logger'

export interface AccessibilityNode {
  ref: string           // "@e1", "@e2", etc.
  role: string          // "button", "link", "textbox", etc.
  name: string          // Accessible name
  value?: string        // Current value (for inputs)
  description?: string  // Additional description
  focused?: boolean
  checked?: boolean
  disabled?: boolean
}

export interface AccessibilitySnapshot {
  url: string
  title: string
  nodes: AccessibilityNode[]
}

export interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementGeometry {
  ref: string
  role?: string
  name?: string
  box: ElementBox
  clickPoint: { x: number; y: number }
}

export interface ViewportMetrics {
  width: number
  height: number
  dpr: number
  scrollX: number
  scrollY: number
}

// Roles that are typically interactive or contain meaningful content
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'treeitem', 'row', 'cell', 'columnheader',
  'rowheader', 'gridcell',
])

const CONTENT_ROLES = new Set([
  'heading', 'img', 'table', 'list', 'listitem',
  'paragraph', 'blockquote', 'article', 'main',
  'navigation', 'complementary', 'contentinfo', 'banner',
  'form', 'region', 'alert', 'dialog', 'alertdialog',
  'status', 'progressbar', 'meter', 'timer',
])

const MAX_AX_SNAPSHOT_NODES = 500
const FALLBACK_EXCLUDED_ROLES = new Set(['none', 'generic', 'rootwebarea', 'webarea'])

function normalizeAxText(value: unknown): string {
  return String(value ?? '').trim()
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function summarizeTopCounts(map: Map<string, number>, maxEntries = 8): string {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntries)
    .map(([key, count]) => `${key}:${count}`)
    .join(', ')
}

const CDP_IDLE_DETACH_MS = 5_000

/** Subset of the `Fetch.requestPaused` payload we act on. */
interface CdpPausedRequest {
  requestId?: string
  request?: {
    url?: string
    method?: string
    /** The request body, when CDP captured one — what a mutating mock acts on. */
    postData?: string
  }
}

// ---------------------------------------------------------------------------
// Element picker (prototype workbench)
// ---------------------------------------------------------------------------

/** Window key the injected picker publishes its state into. */
const PICKER_STATE_KEY = '__craft_agent_picker_state__'
/** Window key exposing the injected picker's cancel handle. */
const PICKER_CANCEL_KEY = '__craft_agent_picker_cancel__'
const PICKER_OVERLAY_ID = '__craft_agent_picker_overlay__'

/** What the injected picker has reported since the last read. */
export interface PickerReport {
  /**
   * `pending` while the picker is armed and nothing has happened yet; `cancelled`
   * once the user pressed Escape (that is the page saying "stop", and only the
   * page knows); `picked` once a one-shot pick has been answered; `missing` when
   * this document has no picker at all, which is what a navigation looks like
   * from here.
   */
  status: 'pending' | 'picked' | 'cancelled' | 'missing'
  /** Elements picked since the last read — cleared as they are read. */
  picks: PickedElement[]
}

/**
 * How both overlays draw a selection: a solid frame around it, and its name on a
 * chip of the app's accent above it.
 *
 * Shared because there is one selection in the window, however it was made — the
 * picker's click and the editor's box mean the same thing to look at, and two
 * copies of a chip is how the two modes would come to look like two features.
 */
function selectionFrameStyle(accent: string): string {
  return `position:fixed;display:none;border:2px solid ${accent};border-radius:4px;pointer-events:none;`
}

function selectionLabelStyle(accent: string): string {
  return `position:fixed;display:none;padding:2px 6px;border-radius:6px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:${accent};color:#fff;pointer-events:none;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
}

/**
 * `buildStableSelector`, as source, for the scripts injected into a page.
 *
 * One copy for both overlays on purpose: the picker's selection and the editor's
 * are the same element described the same way — the selector the agent, a patch's
 * `@target` and the anchor record all agree on. A second copy would be a second
 * description of one thing, and the two would drift.
 */
const STABLE_SELECTOR_FN = `  const buildStableSelector = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (testId) return '[data-testid="' + testId + '"]';
    if (el.id && !/^[0-9]/.test(el.id)) return '#' + el.id;

    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6 && cur !== document.documentElement) {
      if (cur.id && !/^[0-9]/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = [];
        for (const child of parent.children) { if (child.tagName === cur.tagName) sameTag.push(child); }
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };`

/**
 * Injected picker: previews the element under the cursor, and turns the user's
 * click into a *selection* — a stable selector plus a box that stays on screen,
 * which is what the bar under it acts on. It reports into `PICKER_STATE_KEY`
 * rather than resolving a long-lived promise, so the caller can poll with short
 * CDP calls and the idle-detach timer never fires mid-pick.
 *
 * Injected through CDP, so it is unaffected by the page's CSP and needs no
 * `webPreferences` changes (stays sandboxed).
 */
function buildPickerInjectScript(options: {
  /** Show the "add to conversation" bar under the selection. */
  addToConversation: boolean
  /** Its label, in the caller's language — the toolbar owns the i18n, not this. */
  addLabel: string
  /**
   * The app's accent, as a concrete CSS colour.
   *
   * Resolved by the caller: a page cannot see the app's variables, and this class
   * knows nothing about themes. It is the same value the agent-control overlay is
   * drawn with, so the window's own chrome and everything drawn on a page agree.
   */
  accent: string
  /**
   * Stay armed after a pick.
   *
   * One pick is what the agent asks for (`browser_tool pick`), but a person who
   * turned the mode on is picking *elements*, plural, and moving between tabs
   * while they do it: the overlay stays, a click selects, and the mode ends when
   * they say so (Escape here, or the toolbar button) — plan §12.7.
   */
  resident: boolean
}): string {
  const accent = options.accent

  // Everything the overlay draws is one of these. The two frames carry the state
  // (dashed + tinted = what a click would take, solid = what it took), so the
  // selection is readable without covering the element up.
  const hoverBoxStyle = `position:fixed;display:none;border:1px dashed ${accent};background:color-mix(in oklab, ${accent} 15%, transparent);border-radius:4px;pointer-events:none;`
  const selectedBoxStyle = selectionFrameStyle(accent)
  const labelStyle = selectionLabelStyle(accent)
  const buttonStyle = `all:unset;cursor:pointer;padding:3px 10px;border-radius:6px;background:${accent};color:#fff;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;white-space:nowrap;`

  // The bar is only built when there is a conversation to add to: a button that
  // cannot do anything is worse than no button at all.
  const barMarkup = options.addToConversation
    ? `
  // A positioning holder and nothing else: the button is the whole of what the
  // user sees — no panel behind it.
  const bar = document.createElement('div');
  bar.setAttribute('style', 'position:fixed;display:none;pointer-events:auto;');
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.textContent = ${JSON.stringify(options.addLabel)};
  addButton.setAttribute('style', ${JSON.stringify(buttonStyle)});
  bar.appendChild(addButton);
  root.appendChild(bar);
`
    : ''

  // The bar hangs off the *selection*, not the cursor: adding is the second half
  // of a two-step gesture — click the element, then add it — so the bar exists
  // only while something is selected (plan §12.7, 第六轮).
  const barPosition = options.addToConversation
    ? `
    bar.style.display = 'flex';
    bar.style.left = Math.max(4, Math.min(r.left, window.innerWidth - bar.offsetWidth - 6)) + 'px';
    bar.style.top = Math.max(4, Math.min(r.bottom + 6, window.innerHeight - bar.offsetHeight - 4)) + 'px';
`
    : ''

  const barHide = options.addToConversation ? `bar.style.display = 'none';` : ''
  // The window's own click listener is in the capture phase, so it would swallow
  // a click on the button before the button ever saw it: the bar has to be let
  // through explicitly.
  const barGuard = options.addToConversation ? `    if (bar.contains(e.target)) return;\n` : ''

  const barHandler = options.addToConversation
    ? `
  addButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // It adds what is selected. This is the only place that asks for an add: a
    // click on the page selects (plan §12.7, 第六轮).
    const el = selected;
    if (!el) return;
    report(elementPayload(el, 'add-to-conversation'));
  });
`
    : ''

  return `(() => {
  try { window.${PICKER_CANCEL_KEY} && window.${PICKER_CANCEL_KEY}(); } catch (e) {}

  const root = document.createElement('div');
  root.id = '${PICKER_OVERLAY_ID}';
  root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;');

  // The two frames carry the state — dashed and tinted for "what a click would
  // take", solid for "what it took" — and both labels are the same accent chip
  // with the element's own name on it.

  // What the cursor is over.
  const box = document.createElement('div');
  box.setAttribute('style', ${JSON.stringify(hoverBoxStyle)});
  root.appendChild(box);

  const label = document.createElement('div');
  label.setAttribute('style', ${JSON.stringify(labelStyle)});
  root.appendChild(label);

  // What the user clicked: it stays until another element is clicked. This is the
  // picker's selected state — the thing the bar acts on, and the answer to "which
  // element am I about to add" (plan §12.7, 第六轮).
  const selBox = document.createElement('div');
  selBox.setAttribute('style', ${JSON.stringify(selectedBoxStyle)});
  root.appendChild(selBox);

  const selLabel = document.createElement('div');
  selLabel.setAttribute('style', ${JSON.stringify(labelStyle)});
  root.appendChild(selLabel);${barMarkup}

  document.documentElement.appendChild(root);

${STABLE_SELECTOR_FN}

  let current = null;   // what the cursor is over — what a click would take
  let selected = null;  // what the user clicked — what the bar adds

  // The picker's whole outward state: what it has picked, and whether it is still
  // armed. Written into the window key at the end of this script, where the caller
  // polls it — and kept out of cleanup(), so the final status is still readable
  // after the overlay is gone.
  const state = { status: 'pending', picks: [] };

  /** What both exits report: the element, and what the gesture asked for. */
  const elementPayload = (el, intent) => {
    const r = el.getBoundingClientRect();
    const payload = {
      selector: buildStableSelector(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.textContent || '').trim().slice(0, 200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
    if (intent) payload.intent = intent;
    return payload;
  };

  const paintHover = (el) => {
    // Nothing to preview while the cursor is on the selection: it has a marker of
    // its own, and a second box there would only say the same thing twice.
    if (!el || el === selected) { box.style.display = 'none'; label.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    label.style.display = 'block';
    label.style.left = r.left + 'px';
    label.style.top = Math.max(4, r.top - 22) + 'px';
    label.textContent = buildStableSelector(el);
  };

  /** Draw the selection: its box, its name, and the bar that adds it. */
  const paintSelected = () => {
    // An element the page re-rendered away is not a selection any more.
    if (selected && !selected.isConnected) selected = null;
    if (!selected) {
      selBox.style.display = 'none';
      selLabel.style.display = 'none';
      ${barHide}
      return;
    }
    const r = selected.getBoundingClientRect();
    selBox.style.display = 'block';
    selBox.style.left = r.left + 'px';
    selBox.style.top = r.top + 'px';
    selBox.style.width = r.width + 'px';
    selBox.style.height = r.height + 'px';
    selLabel.style.display = 'block';
    selLabel.style.left = r.left + 'px';
    selLabel.style.top = Math.max(4, r.top - 22) + 'px';
    selLabel.textContent = buildStableSelector(selected);${barPosition}
  };

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // The overlay's own chrome (the bar) is not something to pick, so it never
    // becomes the element under the cursor.
    const target = el && root.contains(el) ? null : el;
    if (target === current) return;
    current = target;
    paintHover(target);
    // A page can move under the selection — a hover animation, a list that grew —
    // and redrawing on the cursor's own steps keeps the marker on what it names.
    paintSelected();
  };

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    const existing = document.getElementById('${PICKER_OVERLAY_ID}');
    if (existing) existing.remove();
    try { delete window.${PICKER_CANCEL_KEY}; } catch (e) { window.${PICKER_CANCEL_KEY} = undefined; }
  }

  function finish(status) {
    cleanup();
    state.status = status;
  }

  function report(payload) {
    state.picks.push(payload);
    // A resident picker stays on the page after answering: the user is picking
    // several elements, and the next click belongs to it too.
    if (${options.resident}) return;
    finish('picked');
  }

  const onClick = (e) => {
  ${barGuard}    e.preventDefault();
    e.stopPropagation();
    const el = current || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) { finish('cancelled'); return; }
    // The click is the selection, and the bar under it is the only thing that
    // turns an element into a conversation draft (plan §12.7, 第六轮).
    selected = el;
    paintHover(el);
    paintSelected();
    // One-shot picking (the agent's browser_tool pick) has no second step: the
    // click is the answer, and the picker is torn down with it.
    if (${options.resident}) return;
    report(elementPayload(el));
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancelled'); }
  };

  const onViewportChange = () => { paintHover(current); paintSelected(); };

${barHandler}
  window.${PICKER_CANCEL_KEY} = () => finish('cancelled');
  window.${PICKER_STATE_KEY} = state;

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);

  return true;
})()`
}

/**
 * Read the picker's reports and clear them in one expression.
 *
 * Read-and-clear as a single step because two reads must not both see the same
 * pick, and a pick that lands between them must not be dropped — the page's own
 * script cannot run in the middle of this one.
 */
const PICKER_DRAIN_EXPRESSION = `(() => {
  const state = window.${PICKER_STATE_KEY};
  if (!state) return JSON.stringify({ status: 'missing', picks: [] });
  const picks = state.picks || [];
  state.picks = [];
  return JSON.stringify({ status: state.status, picks: picks });
})()`

const PICKER_CANCEL_EXPRESSION = `(() => { try { window.${PICKER_CANCEL_KEY} && window.${PICKER_CANCEL_KEY}(); } catch (e) {} })()`

// ---------------------------------------------------------------------------
// Element editor (the person's own edits)
// ---------------------------------------------------------------------------

/** Window key the injected editor publishes its state into. */
const EDITOR_STATE_KEY = '__craft_agent_editor_state__'
/** Window key exposing the injected editor's cancel handle — leave now, dropping the draft. */
const EDITOR_CANCEL_KEY = '__craft_agent_editor_cancel__'
/**
 * Window key asking the editor to leave *if it has nothing unsaved*.
 *
 * A second handle rather than a flag on the first, because the two are asked by
 * different callers for different reasons: the toolbar's button asks (the person may
 * have work in the draft, and that is a decision, not a teardown), while closing a
 * tab, re-arming the mode or the page going away tears down (there is nobody left to
 * ask, and the overlay must not outlive the mode).
 */
const EDITOR_ASK_KEY = '__craft_agent_editor_ask_leave__'
const EDITOR_OVERLAY_ID = '__craft_agent_editor_overlay__'

/**
 * What the injected editor has reported since the last read.
 *
 * A **save** at a time rather than an edit: the person's session accumulates in the
 * page, and what crosses this boundary is the moment they said "keep it" — which is
 * what the caller writes as one entry in the change layer.
 */
export interface EditorReport {
  /** `pending` while armed, `cancelled` once Escape ended the mode, `missing` = no editor in this document. */
  status: 'pending' | 'cancelled' | 'missing'
  /** Saves made since the last read, in order, cleared as they are read. */
  saves: BrowserEdit[][]
}

/** The bar's own words, in the window's language — the page has no i18n. */
export interface EditorLabels {
  /** Button that takes the last unsaved edit back. */
  undo: string
  /** Button that writes the session down; `{n}` is how many edits are waiting. */
  save: string
  /** Button that drops everything unsaved. */
  discard: string
}

/**
 * Injected editor: box elements and set styles on them, retype an element's text,
 * and press save — which is when anything is written.
 *
 * The window's third gesture, and a sibling of the picker — the same shape (an
 * overlay drawn in the page, a window key the caller polls, Escape ending the mode),
 * asking a different question. The picker answers *which element*; this one answers
 * *what it should look like*, and what it produces is one patch per save: the caller
 * writes the session as an entry in the change layer, which is what survives a
 * reload, reaches every window showing the prototype, and ships in the delivery.
 *
 * Three properties, each one a cost the other two bought:
 *
 * - **Nothing is written until save.** The session lives here as a draft: styles go
 *   into a preview stylesheet of our own (generated from the draft, so taking an
 *   edit back is regenerating it), text is what the person already typed into the
 *   element. That is what makes undo cheap and what keeps a session from being
 *   interrupted — a write would trigger the replay, and a page of ours re-renders on
 *   one, taking the selection and the draft with it.
 * - **The page therefore shows a draft**, which no patch states yet — the one thing
 *   this workbench otherwise refuses. It is bounded by the mode and owned by the
 *   bar: unsaved edits are counted, save and discard are the two ways out, and
 *   anything still unsaved when the mode ends is taken back rather than left on the
 *   page. The bar is not decoration; it is what makes this honest.
 * - **Text is the element's whole text.** Double-clicking makes the element editable
 *   and committing replaces all of it, children included — which is what "this
 *   element now says this" means, and what one `textContent` assignment can keep.
 *   Editing *part* of a text node would mean storing the element's markup in the
 *   patch, i.e. serializing the DOM (plan §14.1).
 */
function buildEditorInjectScript(options: { accent: string; labels: EditorLabels }): string {
  const accent = options.accent
  const marqueeStyle = `position:fixed;display:none;border:1px dashed ${accent};background:color-mix(in oklab, ${accent} 12%, transparent);border-radius:4px;pointer-events:none;`
  const frameStyle = selectionFrameStyle(accent)
  const labelStyle = selectionLabelStyle(accent)
  const layerStyle = `position:fixed;inset:0;pointer-events:none;`
  const barStyle = `position:fixed;display:none;align-items:center;gap:3px;padding:3px;border-radius:8px;background:${accent};box-shadow:0 2px 10px rgba(0,0,0,0.25);pointer-events:auto;`
  const barButtonStyle = `all:unset;cursor:pointer;min-width:22px;height:24px;line-height:24px;padding:0 6px;text-align:center;border-radius:6px;color:#fff;font:600 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;white-space:nowrap;`
  const barSpacerStyle = `width:1px;height:16px;background:rgba(255,255,255,0.35);margin:0 2px;`

  return `(() => {
  try { window.${EDITOR_CANCEL_KEY} && window.${EDITOR_CANCEL_KEY}(); } catch (e) {}

  const root = document.createElement('div');
  root.id = '${EDITOR_OVERLAY_ID}';
  root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;');

  // The box the current drag covers (dashed, the same frame the picker previews a
  // click with) and the boxes of what is selected (solid).
  const marquee = document.createElement('div');
  marquee.setAttribute('style', ${JSON.stringify(marqueeStyle)});
  root.appendChild(marquee);

  const layer = document.createElement('div');
  layer.setAttribute('style', ${JSON.stringify(layerStyle)});
  root.appendChild(layer);

  // The draft, drawn: the rules the session has made so far, in the order they were
  // made, so a later edit wins exactly as it will once it is written. It is our own
  // stylesheet and it lives and dies with the mode — the patch that follows is what
  // keeps the page looking like this afterwards.
  const preview = document.createElement('style');
  root.appendChild(preview);

  // The bar the person acts with. Five things, no more: two styles, take one back,
  // write it down, drop it.
  const bar = document.createElement('div');
  bar.setAttribute('style', ${JSON.stringify(barStyle)});
  const makeButton = (text, title, extra) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = title;
    button.setAttribute('style', ${JSON.stringify(barButtonStyle)} + extra);
    return button;
  };
  const boldButton = makeButton('B', 'font-weight', 'font-weight:700;');
  const italicButton = makeButton('I', 'font-style', 'font-style:italic;');
  const spacer = document.createElement('div');
  spacer.setAttribute('style', ${JSON.stringify(barSpacerStyle)});
  const undoButton = makeButton('\\u21b6', '', 'font-weight:400;');
  const saveButton = makeButton('', '', 'font-weight:600;');
  const discardButton = makeButton('', '', 'font-weight:400;opacity:0.85;');
  bar.appendChild(boldButton);
  bar.appendChild(italicButton);
  bar.appendChild(spacer);
  bar.appendChild(undoButton);
  bar.appendChild(saveButton);
  bar.appendChild(discardButton);
  root.appendChild(bar);

  document.documentElement.appendChild(root);

${STABLE_SELECTOR_FN}

  const SAVE_LABEL = ${JSON.stringify(options.labels.save)};
  const UNDO_LABEL = ${JSON.stringify(options.labels.undo)};
  const DISCARD_LABEL = ${JSON.stringify(options.labels.discard)};
  undoButton.textContent = UNDO_LABEL;
  discardButton.textContent = DISCARD_LABEL;

  // What the mode has reported, and what it has in hand. Two counters rather than
  // one list of "written" flags: the draft is appended to and popped from the end,
  // so the boundary is all the history this needs.
  const state = { status: 'pending', saves: [] };
  let draft = [];
  let savedCount = 0;
  let confirming = false;   // the bar is asking save-or-drop; the mode stays until it is answered
  let selected = [];
  let editing = null;   // { el, before, onBlur } — the element being typed into
  let drag = null;

  const inOverlay = (el) => !!el && root.contains(el);
  const targetOf = (el) => ({ selector: buildStableSelector(el), tag: el.tagName ? el.tagName.toLowerCase() : '' });
  const unsaved = () => draft.length - savedCount;

  const rectOf = (d) => ({
    left: Math.min(d.x0, d.x1),
    top: Math.min(d.y0, d.y1),
    right: Math.max(d.x0, d.x1),
    bottom: Math.max(d.y0, d.y1),
  });

  /**
   * What a rectangle selects.
   *
   * Inline boxes are skipped, and only the innermost of what is left is kept:
   * boxing a paragraph has to mean the paragraph and not the spans inside it, and
   * boxing a card has to mean its contents rather than the card *and* everything
   * in it. A click is a box with no area, so it takes the innermost element under
   * the cursor — the same answer, from the same rule.
   */
  const within = (rect) => {
    if (!document.body) return [];
    const hits = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (el === document.body || inOverlay(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < rect.top || r.top > rect.bottom || r.right < rect.left || r.left > rect.right) continue;
      const display = window.getComputedStyle(el).display;
      if (display === 'inline' || display === 'contents') continue;
      hits.push(el);
    }
    return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  };

  const drawMarquee = () => {
    if (!drag) return;
    const r = rectOf(drag);
    marquee.setAttribute('style', ${JSON.stringify(marqueeStyle)}
      + 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + (r.right - r.left) + 'px;height:' + (r.bottom - r.top) + 'px;');
  };

  /** The draft as CSS: every style edit so far, in the order it was made. */
  const renderPreview = () => {
    const chunks = [];
    for (const entry of draft) {
      if (entry.kind !== 'style') continue;
      const body = Object.keys(entry.declarations).map((property) => '  ' + property + ': ' + entry.declarations[property] + ';').join('\\n');
      for (const target of entry.targets) chunks.push(target.selector + ' {\\n' + body + '\\n}');
    }
    preview.textContent = chunks.join('\\n\\n');
  };

  const paintBar = () => {
    const waiting = unsaved();
    saveButton.textContent = SAVE_LABEL.split('{n}').join(String(waiting));
    const dim = waiting === 0 ? '0.5' : '1';
    saveButton.style.opacity = dim;
    discardButton.style.opacity = '1';
    undoButton.style.opacity = dim;
    // While the bar is asking, the only two answers are on it: making a style or
    // taking one back is not an answer to "save or drop?".
    for (const control of [boldButton, italicButton, spacer, undoButton]) {
      control.style.display = confirming ? 'none' : '';
    }
  };

  /** Draw the selection: one frame and one name per element, and the bar over the first. */
  const paint = () => {
    layer.textContent = '';
    selected = selected.filter((el) => el.isConnected);
    if (selected.length === 0) {
      paintBar();
      // With nothing selected the bar has nothing to point at — but it is where save
      // lives, so it stays while there is something to decide, parked out of the way
      // rather than gone. An edit nobody can press save on is the worse bug.
      if (unsaved() === 0 && !confirming) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      bar.style.left = 'auto';
      bar.style.top = 'auto';
      bar.style.right = '16px';
      bar.style.bottom = '16px';
      return;
    }

    let anchor = null;
    for (const el of selected) {
      const r = el.getBoundingClientRect();
      const frame = document.createElement('div');
      frame.setAttribute('style', ${JSON.stringify(frameStyle)}
        + 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;');
      layer.appendChild(frame);
      const label = document.createElement('div');
      label.setAttribute('style', ${JSON.stringify(labelStyle)}
        + 'display:block;left:' + r.left + 'px;top:' + Math.max(4, r.top - 22) + 'px;');
      label.textContent = buildStableSelector(el);
      layer.appendChild(label);
      if (!anchor) anchor = r;
    }

    // The bar hangs off the first selection: above it when there is room, below it
    // otherwise, and never outside the viewport.
    const above = anchor.top - bar.offsetHeight - 6;
    bar.style.display = 'flex';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    bar.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - bar.offsetWidth - 6)) + 'px';
    bar.style.top = Math.max(4, above >= 4 ? above : Math.min(anchor.bottom + 6, window.innerHeight - bar.offsetHeight - 4)) + 'px';
    paintBar();
  };

  /**
   * The two style toggles, read from the page rather than remembered here.
   *
   * What is on an element *now* is a fact only the page has — a patch may have set
   * it, and so may an edit made earlier in this same session (the preview is what
   * makes the second one read right) — and a mixed selection means "make them all
   * bold", which is what boxing several elements and pressing B means.
   */
  const isBold = (el) => {
    const weight = window.getComputedStyle(el).fontWeight;
    return weight === 'bold' || weight === 'bolder' || parseInt(weight, 10) >= 600;
  };
  const isItalic = (el) => window.getComputedStyle(el).fontStyle === 'italic';

  const applyStyle = (property, on, off, isOn) => {
    const elements = selected.filter((el) => el.isConnected);
    if (elements.length === 0) return;
    const turnOff = elements.every((el) => isOn(el));
    const declarations = {};
    declarations[property] = turnOff ? off : on;
    draft.push({ kind: 'style', targets: elements.map(targetOf), declarations: declarations });
    renderPreview();
    paintBar();
  };

  /** Type into one element: the whole of its text, replaced by what is typed. */
  const beginText = (el) => {
    if (editing) endText(true);
    const onBlur = () => endText(true);
    editing = { el: el, before: el.textContent, onBlur: onBlur };
    el.setAttribute('contenteditable', 'true');
    el.addEventListener('blur', onBlur, true);
    try { el.focus(); } catch (e) {}
    const range = document.createRange();
    range.selectNodeContents(el);
    const selectionApi = window.getSelection();
    if (selectionApi) { selectionApi.removeAllRanges(); selectionApi.addRange(range); }
    selected = [el];
    paint();
  };

  /**
   * Leave the text edit. Committing records what the element now says as a draft
   * entry; Escape puts the original text back — "not this" must not leave the page
   * saying something nobody asked for.
   *
   * What is read back is the element's own text, so the patch ends up asserting the
   * value the page is showing; typing nothing is not an edit and is dropped.
   */
  const endText = (commit) => {
    const current = editing;
    if (!current) return;
    editing = null;
    current.el.removeEventListener('blur', current.onBlur, true);
    current.el.removeAttribute('contenteditable');
    if (!commit) { current.el.textContent = current.before; return; }
    const text = current.el.textContent || '';
    if (text === current.before) return;
    // The element, not just its selector: taking this edit back has to put the old
    // text back, and that needs the node the person typed into.
    draft.push({ kind: 'text', targets: [targetOf(current.el)], text: text, el: current.el, before: current.before });
    paintBar();
  };

  /** Take the last unsaved edit back — and with it, whatever it did to the page. */
  const undo = () => {
    if (unsaved() === 0) return;
    const entry = draft.pop();
    if (entry.kind === 'text' && entry.el && entry.el.isConnected) entry.el.textContent = entry.before;
    renderPreview();
    paintBar();
  };

  /** Drop everything unsaved, the same way taking each one back would. */
  const discard = () => {
    while (unsaved() > 0) {
      const entry = draft.pop();
      if (entry.kind === 'text' && entry.el && entry.el.isConnected) entry.el.textContent = entry.before;
    }
    renderPreview();
    paintBar();
  };

  /**
   * Write the session down: what crosses to the caller is this moment, not the
   * individual edits — one save is one entry in the change layer.
   */
  const save = () => {
    if (unsaved() === 0) return;
    const batch = draft.slice(savedCount).map((entry) => entry.kind === 'text'
      ? { kind: 'text', targets: entry.targets, text: entry.text }
      : { kind: 'style', targets: entry.targets, declarations: entry.declarations });
    state.saves.push(batch);
    savedCount = draft.length;
    // Saving while the bar is asking "save or drop?" is the answer: the work is
    // written, so the mode has nothing left to hold open.
    if (confirming) { confirming = false; finish('cancelled'); return; }
    paintBar();
  };

  /**
   * Leave the mode — or, when there is a draft to lose, ask which it is.
   *
   * Leaving is the only way a session's work disappears without anyone deciding, so
   * it is the one moment the mode asks instead of acting: the bar becomes save or
   * drop, the mode stays, and nothing else is answerable until one of them is chosen
   * (Escape is the "no"). An immediate request is the caller saying there is nobody
   * left to ask — the tab is closing, or the mode is being re-armed on another page.
   *
   * A text edit in flight counts as an edit: what was typed is a change the person
   * made, so it goes into the draft rather than being thrown away with the mode.
   */
  const requestLeave = (immediate) => {
    if (editing) endText(true);
    if (!immediate && unsaved() > 0) {
      confirming = true;
      paint();
      return;
    }
    discard();
    finish('cancelled');
  };

  const onPointerDown = (e) => {
    // A press while typing belongs to the page (it is how the person leaves the
    // element they were editing); a press on the bar belongs to the bar; and while
    // the bar is asking, a press on the page is not an answer.
    if (e.button !== 0 || inOverlay(e.target) || editing || confirming) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };
    drawMarquee();
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    if (Math.abs(drag.x1 - drag.x0) > 3 || Math.abs(drag.y1 - drag.y0) > 3) drag.moved = true;
    drawMarquee();
  };

  const onPointerUp = () => {
    if (!drag) return;
    const box = rectOf(drag);
    const moved = drag.moved;
    drag = null;
    marquee.style.display = 'none';
    selected = moved ? within(box) : within({ left: box.left, top: box.top, right: box.left + 1, bottom: box.top + 1 });
    paint();
  };

  // Selecting is not using: nothing the person pressed may activate the page under
  // the mode (the picker suppresses clicks for the same reason).
  const swallowClick = (e) => {
    if (inOverlay(e.target) || editing) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onDblClick = (e) => {
    if (inOverlay(e.target) || editing || confirming) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return;
    // A form control keeps its own editing: contenteditable does nothing on it, and
    // its value is not its textContent — an edit read back here would report nothing
    // and be dropped, so it is not offered at all.
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    beginText(el);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // Escape answers whatever the mode is currently asking: an open text edit
      // ("not this"), then the save-or-drop question ("no"), and only then "leave".
      if (editing) { endText(false); paint(); return; }
      if (confirming) { confirming = false; discard(); finish('cancelled'); return; }
      requestLeave(false);
      return;
    }
    if (editing && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      endText(true);
      paint();
    }
  };

  function cleanup() {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('click', swallowClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', paint, true);
    window.removeEventListener('resize', paint, true);
    // Leave nothing of ours on the page. The text being typed goes back, and so does
    // every unsaved entry: this teardown is a mode ending, not an edit being saved,
    // and a change no patch states is the one thing this mode may not leave behind.
    if (editing) {
      const current = editing;
      editing = null;
      current.el.removeEventListener('blur', current.onBlur, true);
      current.el.removeAttribute('contenteditable');
      current.el.textContent = current.before;
    }
    discard();
    const existing = document.getElementById('${EDITOR_OVERLAY_ID}');
    if (existing) existing.remove();
    try { delete window.${EDITOR_CANCEL_KEY}; } catch (e) { window.${EDITOR_CANCEL_KEY} = undefined; }
  }

  function finish(status) {
    cleanup();
    state.status = status;
  }

  boldButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyStyle('font-weight', '700', '400', isBold);
  });
  italicButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyStyle('font-style', 'italic', 'normal', isItalic);
  });
  undoButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    undo();
  });
  saveButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    save();
  });
  discardButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    discard();
    // Dropping is also the answer to "save or drop?" — and then the mode is done.
    if (confirming) { confirming = false; finish('cancelled'); }
  });

  // Two ways out, and they ask different questions: the toolbar's button asks (there
  // may be a draft, and that is the person's call), while a teardown — the tab
  // closing, the mode being re-armed on a new page — takes the draft with it, because
  // there is nobody left to ask.
  window.${EDITOR_CANCEL_KEY} = () => requestLeave(true);
  window.${EDITOR_ASK_KEY} = () => requestLeave(false);
  window.${EDITOR_STATE_KEY} = state;

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('click', swallowClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', paint, true);
  window.addEventListener('resize', paint, true);
  paintBar();

  return true;
})()`
}

/**
 * Read the editor's reports and clear them in one expression — the same
 * read-and-clear the picker uses, and for the same reason: two reads must not both
 * see the same save, and a save landing between them must not be dropped.
 */
const EDITOR_DRAIN_EXPRESSION = `(() => {
  const state = window.${EDITOR_STATE_KEY};
  if (!state) return JSON.stringify({ status: 'missing', saves: [] });
  const saves = state.saves || [];
  state.saves = [];
  return JSON.stringify({ status: state.status, saves: saves });
})()`

const EDITOR_CANCEL_EXPRESSION = `(() => { try { window.${EDITOR_CANCEL_KEY} && window.${EDITOR_CANCEL_KEY}(); } catch (e) {} })()`

/** Ask the editor to leave — it answers by leaving, or by asking which it is. */
const EDITOR_ASK_EXPRESSION = `(() => { try { window.${EDITOR_ASK_KEY} && window.${EDITOR_ASK_KEY}(); } catch (e) {} })()`

export class BrowserCDP {
  private webContents: WebContents
  private attached = false
  private detachListenerRegistered = false
  private idleDetachTimer: ReturnType<typeof setTimeout> | null = null
  // Map from "@eN" refs to backend node IDs for the current snapshot.
  private refMap: Map<string, number> = new Map()
  // Map from "@eN" refs to semantic details captured during snapshot.
  private refDetails: Map<string, { role: string; name: string }> = new Map()
  // Stable mapping for backend DOM nodes across snapshots.
  private backendNodeRefMap: Map<number, string> = new Map()
  private nextRefCounter = 0
  // Caller-supplied init-script key → CDP identifier. Also gates idle detach:
  // CDP drops `addScriptToEvaluateOnNewDocument` registrations on detach.
  private initScriptIds: Map<string, string> = new Map()
  // CDP `Fetch.enable` state plus the mock served while it is on: the routes, and
  // the store they remember between requests (one apply = one run of the flow).
  private fetchMockEnabled = false
  private fetchMockRoutes: MockRoute[] = []
  private fetchMockStore: MockStore = {}
  private debuggerMessageListenerRegistered = false

  constructor(webContents: WebContents) {
    this.webContents = webContents
  }

  private async ensureAttached(): Promise<void> {
    if (this.attached) return
    try {
      this.webContents.debugger.attach('1.3')
      this.attached = true
    } catch (err) {
      // May already be attached
      if (String(err).includes('Already attached')) {
        this.attached = true
      } else {
        throw err
      }
    }

    if (!this.detachListenerRegistered) {
      this.detachListenerRegistered = true
      this.webContents.debugger.on('detach', () => {
        this.attached = false
      })
    }

    if (!this.debuggerMessageListenerRegistered) {
      this.debuggerMessageListenerRegistered = true
      this.webContents.debugger.on('message', (_event, method, params) => {
        if (method === 'Fetch.requestPaused') {
          void this.handlePausedRequest(params as CdpPausedRequest)
        }
      })
    }
  }

  /**
   * Both persistent injections and network interception live in the CDP session:
   * detaching silently drops them. Hold the attachment while either is active;
   * the idle timer resumes once both are off.
   */
  private holdsSessionState(): boolean {
    return this.initScriptIds.size > 0 || this.fetchMockEnabled
  }

  private resetIdleDetachTimer(): void {
    if (this.idleDetachTimer) {
      clearTimeout(this.idleDetachTimer)
      this.idleDetachTimer = null
    }

    if (this.holdsSessionState()) return

    this.idleDetachTimer = setTimeout(() => {
      if (this.attached) {
        mainLog.info('[browser-cdp] idle detach — detaching debugger after inactivity')
        this.detach()
      }
    }, CDP_IDLE_DETACH_MS)
  }

  detach(): void {
    if (this.idleDetachTimer) {
      clearTimeout(this.idleDetachTimer)
      this.idleDetachTimer = null
    }
    if (this.attached) {
      try {
        this.webContents.debugger.detach()
      } catch { /* ignore */ }
      this.attached = false
    }
    // CDP registrations die with the session, so our bookkeeping must too.
    this.initScriptIds.clear()
    this.fetchMockEnabled = false
    this.fetchMockRoutes = []
    this.fetchMockStore = {}
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<any> {
    await this.ensureAttached()
    try {
      return await this.webContents.debugger.sendCommand(method, params)
    } finally {
      // Keep detach countdown tied to completed calls so we do not detach mid-flight.
      this.resetIdleDetachTimer()
    }
  }

  private allocateRef(backendDOMNodeId?: number): string {
    if (backendDOMNodeId !== undefined) {
      const existing = this.backendNodeRefMap.get(backendDOMNodeId)
      if (existing) {
        return existing
      }
    }

    this.nextRefCounter += 1
    const ref = `@e${this.nextRefCounter}`

    if (backendDOMNodeId !== undefined) {
      this.backendNodeRefMap.set(backendDOMNodeId, ref)
    }

    return ref
  }

  // ---------------------------------------------------------------------------
  // Accessibility Snapshot
  // ---------------------------------------------------------------------------

  async getAccessibilitySnapshot(): Promise<AccessibilitySnapshot> {
    const tree = await this.send('Accessibility.getFullAXTree')
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes as any[] : []

    this.refMap.clear()
    this.refDetails.clear()
    const result: AccessibilityNode[] = []
    const fallbackCandidates: Array<{
      backendDOMNodeId: number
      role: string
      name: string
      value?: string
      description?: string
      focused?: boolean
      checked?: boolean
      disabled?: boolean
    }> = []

    const rawRoleCounts = new Map<string, number>()
    const droppedReasonCounts = new Map<string, number>()

    const seenBackendNodeIds = new Set<number>()

    const pushAccessNode = (entry: {
      backendDOMNodeId?: number
      role: string
      name: string
      value?: string
      description?: string
      focused?: boolean
      checked?: boolean
      disabled?: boolean
    }): boolean => {
      if (result.length >= MAX_AX_SNAPSHOT_NODES) return false

      if (entry.backendDOMNodeId !== undefined) {
        if (seenBackendNodeIds.has(entry.backendDOMNodeId)) {
          return true
        }
        seenBackendNodeIds.add(entry.backendDOMNodeId)
      }

      const ref = this.allocateRef(entry.backendDOMNodeId)

      if (entry.backendDOMNodeId !== undefined) {
        this.refMap.set(ref, entry.backendDOMNodeId)
      }
      this.refDetails.set(ref, { role: entry.role, name: entry.name })

      const accessNode: AccessibilityNode = {
        ref,
        role: entry.role,
        name: entry.name,
      }

      if (entry.value !== undefined) accessNode.value = entry.value
      if (entry.description) accessNode.description = entry.description
      if (entry.focused) accessNode.focused = true
      if (entry.checked) accessNode.checked = true
      if (entry.disabled) accessNode.disabled = true

      result.push(accessNode)
      return true
    }

    for (const node of nodes) {
      const role = normalizeAxText(node.role?.value).toLowerCase()
      const name = normalizeAxText(node.name?.value)
      const rawValue = node.value?.value
      const hasValue = rawValue !== undefined && rawValue !== ''
      const value = hasValue ? String(rawValue) : undefined
      const description = normalizeAxText(node.description?.value) || undefined
      const backendDOMNodeId = typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined

      incrementCount(rawRoleCounts, role || '(empty)')

      let focused = false
      let checked = false
      let disabled = false
      let focusable = false

      const props = node.properties as any[] | undefined
      if (props) {
        for (const prop of props) {
          if (prop.name === 'focused' && prop.value?.value === true) focused = true
          if (prop.name === 'checked' && prop.value?.value !== 'false') checked = prop.value?.value === true || prop.value?.value === 'true'
          if (prop.name === 'disabled' && prop.value?.value === true) disabled = true
          if (prop.name === 'focusable' && prop.value?.value === true) focusable = true
        }
      }

      const isInteractive = INTERACTIVE_ROLES.has(role)
      const isContent = CONTENT_ROLES.has(role) && !!name
      const hasPrimarySignal = isInteractive || isContent || hasValue
      const isGenericWithoutName = (!role || role === 'generic' || role === 'none') && !name

      if (!hasPrimarySignal) {
        incrementCount(droppedReasonCounts, 'no-primary-signal')
      } else if (isGenericWithoutName) {
        incrementCount(droppedReasonCounts, 'generic-without-name')
      }

      const shouldKeepPrimary = hasPrimarySignal && !isGenericWithoutName

      if (shouldKeepPrimary) {
        pushAccessNode({
          backendDOMNodeId,
          role,
          name,
          value,
          description,
          focused,
          checked,
          disabled,
        })

        if (result.length >= MAX_AX_SNAPSHOT_NODES) break
        continue
      }

      const fallbackEligible = !!backendDOMNodeId
        && !FALLBACK_EXCLUDED_ROLES.has(role)
        && (!!name || hasValue || focusable || focused)

      if (fallbackEligible) {
        fallbackCandidates.push({
          backendDOMNodeId,
          role,
          name,
          value,
          description,
          focused,
          checked,
          disabled,
        })
      }
    }

    let fallbackKept = 0
    if (result.length === 0 && fallbackCandidates.length > 0) {
      for (const candidate of fallbackCandidates) {
        const pushed = pushAccessNode(candidate)
        if (!pushed) break
        fallbackKept++
      }

      mainLog.info(
        `[browser-cdp] snapshot fallback engaged url=${this.webContents.getURL()} raw=${nodes.length} kept=${result.length} fallbackKept=${fallbackKept} roles=[${summarizeTopCounts(rawRoleCounts)}] dropped=[${summarizeTopCounts(droppedReasonCounts)}]`,
      )
    }

    if (result.length === 0 && nodes.length > 0) {
      mainLog.warn(
        `[browser-cdp] snapshot produced zero nodes url=${this.webContents.getURL()} raw=${nodes.length} roles=[${summarizeTopCounts(rawRoleCounts)}] dropped=[${summarizeTopCounts(droppedReasonCounts)}]`,
      )
    }

    return {
      url: this.webContents.getURL(),
      title: this.webContents.getTitle(),
      nodes: result,
    }
  }

  // ---------------------------------------------------------------------------
  // Screenshot Annotation Helpers
  // ---------------------------------------------------------------------------

  async getElementGeometry(ref: string): Promise<ElementGeometry> {
    const backendNodeId = this.refMap.get(ref)
    if (!backendNodeId) {
      throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`)
    }

    const { model } = await this.send('DOM.getBoxModel', { backendNodeId })
    const content = model.content as number[]

    const xs = [content[0], content[2], content[4], content[6]]
    const ys = [content[1], content[3], content[5], content[7]]

    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    const clickX = (content[0] + content[2] + content[4] + content[6]) / 4
    const clickY = (content[1] + content[3] + content[5] + content[7]) / 4

    const details = this.refDetails.get(ref)

    return {
      ref,
      role: details?.role,
      name: details?.name,
      box: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      clickPoint: { x: clickX, y: clickY },
    }
  }

  async getElementGeometryBySelector(selector: string): Promise<ElementGeometry> {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => {
        const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        if (candidates.length === 0) return null;

        const isVisible = (el) => {
          if (!(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          if (Number(style.opacity || '1') === 0) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          return true;
        };

        const el = candidates.find(isVisible) || candidates[0];
        const rect = el.getBoundingClientRect();
        const tag = (el.tagName && typeof el.tagName === 'string') ? el.tagName.toLowerCase() : 'element';
        const text = (typeof el.textContent === 'string') ? el.textContent.slice(0, 120) : '';
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          cx: rect.left + rect.width / 2,
          cy: rect.top + rect.height / 2,
          tag,
          text,
        };
      })()`,
      returnByValue: true,
    })

    const value = result?.result?.value
    if (!value) {
      throw new Error(`No element found for selector "${selector}"`)
    }

    if (Number(value.width) <= 0 || Number(value.height) <= 0) {
      throw new Error(`Element found for selector "${selector}" has zero size`)
    }

    return {
      ref: `selector:${selector}`,
      role: String(value.tag || 'element'),
      name: String(value.text || '').trim(),
      box: {
        x: Number(value.x),
        y: Number(value.y),
        width: Number(value.width),
        height: Number(value.height),
      },
      clickPoint: {
        x: Number(value.cx),
        y: Number(value.cy),
      },
    }
  }

  async getViewportMetrics(): Promise<ViewportMetrics> {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0
      }))()`,
      returnByValue: true,
    })

    const v = result?.result?.value ?? {}
    return {
      width: Number(v.width || 0),
      height: Number(v.height || 0),
      dpr: Number(v.dpr || 1),
      scrollX: Number(v.scrollX || 0),
      scrollY: Number(v.scrollY || 0),
    }
  }

  async renderTemporaryOverlay(params: {
    geometries: ElementGeometry[]
    includeMetadata?: boolean
    metadataText?: string
    includeClickPoints?: boolean
  }): Promise<void> {
    const payload = {
      geometries: params.geometries,
      includeMetadata: !!params.includeMetadata,
      metadataText: params.metadataText || '',
      includeClickPoints: params.includeClickPoints !== false,
    }

    await this.send('Runtime.evaluate', {
      expression: `(() => {
        const existing = document.getElementById('__craft_agent_screenshot_overlay__');
        if (existing) existing.remove();

        const root = document.createElement('div');
        root.id = '__craft_agent_screenshot_overlay__';
        root.style.position = 'fixed';
        root.style.inset = '0';
        root.style.pointerEvents = 'none';
        root.style.zIndex = '2147483647';

        const payload = ${JSON.stringify(payload)};

        for (const g of payload.geometries || []) {
          const box = document.createElement('div');
          box.style.position = 'fixed';
          box.style.left = g.box.x + 'px';
          box.style.top = g.box.y + 'px';
          box.style.width = g.box.width + 'px';
          box.style.height = g.box.height + 'px';
          box.style.border = '2px solid rgba(59, 130, 246, 0.95)';
          box.style.borderRadius = '6px';

          root.appendChild(box);

          const label = document.createElement('div');
          label.style.position = 'fixed';
          label.style.left = g.box.x + 'px';
          label.style.top = Math.max(4, g.box.y - 24) + 'px';
          label.style.padding = '2px 6px';
          label.style.borderRadius = '6px';
          label.style.font = '12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
          label.style.background = 'rgba(15, 23, 42, 0.92)';
          label.style.color = 'white';
          label.style.maxWidth = '70vw';
          label.style.whiteSpace = 'nowrap';
          label.style.overflow = 'hidden';
          label.style.textOverflow = 'ellipsis';
          const labelText = [g.ref, g.role, g.name].filter(Boolean).join(' • ');
          label.textContent = labelText;
          root.appendChild(label);

          if (payload.includeClickPoints && g.clickPoint) {
            const point = document.createElement('div');
            point.style.position = 'fixed';
            point.style.left = (g.clickPoint.x - 4) + 'px';
            point.style.top = (g.clickPoint.y - 4) + 'px';
            point.style.width = '8px';
            point.style.height = '8px';
            point.style.borderRadius = '999px';
            point.style.background = 'rgba(239, 68, 68, 0.98)';

            root.appendChild(point);
          }
        }

        if (payload.includeMetadata && payload.metadataText) {
          const meta = document.createElement('div');
          meta.style.position = 'fixed';
          meta.style.right = '8px';
          meta.style.bottom = '8px';
          meta.style.padding = '4px 8px';
          meta.style.borderRadius = '6px';
          meta.style.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
          meta.style.background = 'rgba(15, 23, 42, 0.92)';
          meta.style.color = 'white';
          meta.textContent = payload.metadataText;
          root.appendChild(meta);
        }

        document.documentElement.appendChild(root);
      })()`,
    })
  }

  async clearTemporaryOverlay(): Promise<void> {
    await this.send('Runtime.evaluate', {
      expression: `(() => {
        const existing = document.getElementById('__craft_agent_screenshot_overlay__');
        if (existing) existing.remove();
      })()`,
    })
  }

  // ---------------------------------------------------------------------------
  // Element picker (prototype workbench)
  // ---------------------------------------------------------------------------

  /**
   * Put the picker on the page and leave it there.
   *
   * Re-injecting is also how a page is re-armed: the script tears down whatever
   * was installed before it, so an arm is idempotent and a page that navigated
   * out from under an armed picker gets a fresh one.
   */
  async armPicker(options: {
    /**
     * Show the "add to conversation" bar under the selection.
     *
     * Decided by the caller, not here: whether there is a conversation to add to
     * is a fact about the window, and this class only knows about the page.
     */
    addToConversation?: boolean
    /** The bar's label, in the caller's language. */
    addLabel?: string
    /** The app's accent, as a concrete CSS colour — see `buildPickerInjectScript`. */
    accent: string
    /** Keep picking after a pick — see `buildPickerInjectScript`. */
    resident?: boolean
  }): Promise<void> {
    // The bar's markup is built here rather than in the page, and the injection
    // goes through CDP so the page's CSP is not in the way.
    const script = buildPickerInjectScript({
      addToConversation: options.addToConversation === true,
      addLabel: options.addLabel ?? 'Add to conversation',
      accent: options.accent,
      resident: options.resident === true,
    })
    await this.send('Runtime.evaluate', { expression: script })
  }

  /**
   * Take what the picker has reported since the last call, and clear it.
   *
   * Never throws on a missing picker: "there is no picker in this document" is an
   * answer (the page navigated), not a failure.
   */
  async drainPicker(): Promise<PickerReport> {
    const res = await this.send('Runtime.evaluate', {
      expression: PICKER_DRAIN_EXPRESSION,
      returnByValue: true,
    })

    const raw = res?.result?.value
    if (typeof raw !== 'string') return { status: 'missing', picks: [] }

    try {
      const parsed = JSON.parse(raw) as { status?: string; picks?: PickedElement[] }
      return {
        status: (parsed.status as PickerReport['status']) ?? 'missing',
        picks: Array.isArray(parsed.picks) ? parsed.picks : [],
      }
    } catch {
      return { status: 'missing', picks: [] }
    }
  }

  /**
   * Prompt the user to click an element on the page, once.
   *
   * Returns the picked element's stable selector + geometry, or `null` when the
   * user pressed Escape, the pick was cancelled, or the timeout elapsed. The
   * toolbar's own use of the picker is the resident one (`armPicker` +
   * `drainPicker`); this is what a caller that asked for one element gets.
   *
   * Polls instead of awaiting one long-lived CDP promise: each poll is a short
   * call, so the idle-detach timer keeps being reset and cannot fire mid-pick.
   */
  async pickElement(options: {
    timeoutMs?: number
    pollMs?: number
    addToConversation?: boolean
    addLabel?: string
    /** The app's accent, as a concrete CSS colour — see `buildPickerInjectScript`. */
    accent: string
  }): Promise<PickedElement | null> {
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000)
    const pollMs = Math.max(50, options.pollMs ?? 200)

    await this.armPicker({
      addToConversation: options.addToConversation === true,
      ...(options.addLabel ? { addLabel: options.addLabel } : {}),
      accent: options.accent,
      resident: false,
    })

    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        const report = await this.drainPicker()

        if (report.picks.length > 0) return report.picks[0] ?? null
        if (report.status === 'cancelled' || report.status === 'missing') return null

        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }

      mainLog.info('[browser-cdp] picker timed out — no element selected')
      return null
    } finally {
      await this.cancelPicker()
    }
  }

  /** Tear down an in-flight picker. Safe to call when no pick is running. */
  async cancelPicker(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: PICKER_CANCEL_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] cancelPicker ignored: ${String(err)}`)
    }
  }

  /**
   * Put the editor on the page and leave it there.
   *
   * Re-injecting is also how a page is re-armed, exactly as it is for the picker:
   * the script tears down whatever was installed before it, so an arm is
   * idempotent and a page that navigated out from under an armed editor gets a
   * fresh one.
   */
  async armEditor(options: { accent: string; labels: EditorLabels }): Promise<void> {
    const script = buildEditorInjectScript({ accent: options.accent, labels: options.labels })
    await this.send('Runtime.evaluate', { expression: script })
  }

  /**
   * Take the saves made since the last call, and clear them.
   *
   * Never throws on a missing editor: "there is no editor in this document" is an
   * answer (the page navigated), not a failure.
   */
  async drainEditor(): Promise<EditorReport> {
    const res = await this.send('Runtime.evaluate', {
      expression: EDITOR_DRAIN_EXPRESSION,
      returnByValue: true,
    })

    const raw = res?.result?.value
    if (typeof raw !== 'string') return { status: 'missing', saves: [] }

    try {
      const parsed = JSON.parse(raw) as { status?: string; saves?: BrowserEdit[][] }
      return {
        status: (parsed.status as EditorReport['status']) ?? 'missing',
        saves: Array.isArray(parsed.saves) ? parsed.saves.filter((save) => Array.isArray(save)) : [],
      }
    } catch {
      return { status: 'missing', saves: [] }
    }
  }

  /**
   * Ask the editor to leave.
   *
   * The mode ends only if there is nothing unsaved to lose — otherwise the page puts
   * save-or-discard on its own bar and stays. So this returns nothing to await, and
   * the caller learns the outcome the same way it learns everything else: the next
   * `drainEditor` says `cancelled` once the mode has really ended.
   */
  async askEditorToLeave(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: EDITOR_ASK_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] askEditorToLeave ignored: ${String(err)}`)
    }
  }

  /** Tear an armed editor down, draft and all. Safe to call when none is running. */
  async teardownEditor(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: EDITOR_CANCEL_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] teardownEditor ignored: ${String(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent injection (survives reload / navigation)
  // ---------------------------------------------------------------------------

  /**
   * Register a script that runs in every new document, before the page's own
   * scripts. This is the mechanism behind "reload keeps my changes".
   *
   * `key` is caller-chosen and re-registering the same key replaces the previous
   * script, so re-applying an edited patch is idempotent.
   *
   * While any init script is registered the debugger is held attached, because
   * CDP drops these registrations when the session detaches.
   */
  async addInitScript(key: string, source: string): Promise<string> {
    await this.removeInitScript(key)

    const result = await this.send('Page.addScriptToEvaluateOnNewDocument', { source })
    const identifier = String(result?.identifier ?? '')
    if (identifier) {
      this.initScriptIds.set(key, identifier)
    }
    this.resetIdleDetachTimer()
    return identifier
  }

  /** Unregister a previously added init script. No-op when the key is unknown. */
  async removeInitScript(key: string): Promise<void> {
    const identifier = this.initScriptIds.get(key)
    if (!identifier) return

    this.initScriptIds.delete(key)
    try {
      await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
    } catch (err) {
      mainLog.debug(`[browser-cdp] removeInitScript(${key}) ignored: ${String(err)}`)
    }
    this.resetIdleDetachTimer()
  }

  /** Keys of every currently registered init script, in registration order. */
  listInitScriptKeys(): string[] {
    return Array.from(this.initScriptIds.keys())
  }

  // ---------------------------------------------------------------------------
  // Network-level mock (CDP Fetch interception)
  // ---------------------------------------------------------------------------

  /**
   * Serve `program` for matching requests.
   *
   * Interception happens in the browser's network stack, so it covers `fetch`,
   * `XMLHttpRequest` (axios) and every other resource type, without patching any
   * page globals and without the app having to point at a mock server.
   *
   * The store is **copied** here, which is what makes one apply one run of the
   * flow: a second `prototype_tool mock-apply` starts the prototype's state over rather
   * than continuing whatever the last round of clicking left behind.
   *
   * Like init scripts this is CDP session state, so the debugger is held
   * attached while it is active.
   */
  async setFetchMockRoutes(program: MockProgram): Promise<number> {
    this.fetchMockRoutes = program.routes.map((route) => ({ ...route, method: route.method.toUpperCase() }))
    this.fetchMockStore = JSON.parse(JSON.stringify(program.store ?? {}))

    if (!this.fetchMockEnabled) {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
      this.fetchMockEnabled = true
    }

    this.resetIdleDetachTimer()
    return this.fetchMockRoutes.length
  }

  /** Stop intercepting. Requests fall through to the real network again. */
  async clearFetchMock(): Promise<void> {
    this.fetchMockRoutes = []
    this.fetchMockStore = {}

    if (this.fetchMockEnabled) {
      this.fetchMockEnabled = false
      try {
        await this.send('Fetch.disable')
      } catch (err) {
        mainLog.debug(`[browser-cdp] Fetch.disable ignored: ${String(err)}`)
      }
    }

    this.resetIdleDetachTimer()
  }

  /** Routes currently being served. */
  listFetchMockRoutes(): MockRoute[] {
    return [...this.fetchMockRoutes]
  }

  /** The store as it stands — for a caller that wants to see where the flow got to. */
  listFetchMockStore(): MockStore {
    return JSON.parse(JSON.stringify(this.fetchMockStore))
  }

  /**
   * Match on pathname only, so it works whether the app calls the mock with an
   * absolute URL, a baseUrl-prefixed URL, or a same-origin relative path. The
   * matching rule itself lives in the shared engine, because the delivered
   * carriers have to answer exactly as this layer does.
   */
  private matchFetchMockRoute(method: string, url: string): MockMatch | null {
    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch {
      // Not an absolute URL — fall back to the raw value.
    }

    return matchMockRoute(this.fetchMockRoutes, method, pathname)
  }

  private async handlePausedRequest(params: CdpPausedRequest): Promise<void> {
    const requestId = params.requestId
    if (!requestId) return

    const url = String(params.request?.url ?? '')
    const method = String(params.request?.method ?? 'GET').toUpperCase()
    const matched = this.matchFetchMockRoute(method, url)

    try {
      if (!matched) {
        await this.send('Fetch.continueRequest', { requestId })
        return
      }

      const read = parseMockRequestBody(params.request?.postData)
      // A mutating request whose body could not be read changes nothing, and saying
      // so is the only alternative to appending `null` and calling it state.
      const answer = !read.readable && matched.route.state
        ? { status: 500, body: { error: 'mock could not read the request body' } }
        : applyMockRequest({
            store: this.fetchMockStore,
            route: matched.route,
            params: matched.params,
            body: read.body,
          })

      await this.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: answer.status,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          // Cross-origin API calls would otherwise be blocked by CORS even
          // though we are the ones answering them.
          { name: 'access-control-allow-origin', value: '*' },
          { name: 'x-craft-mock', value: '1' },
        ],
        body: Buffer.from(JSON.stringify(answer.body ?? null)).toString('base64'),
      })
    } catch (err) {
      mainLog.debug(`[browser-cdp] fetch mock failed for ${method} ${url}: ${String(err)}`)
      // A paused request with no disposition freezes the page, so always release it.
      try {
        await this.send('Fetch.continueRequest', { requestId })
      } catch { /* the request is already gone */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Native Mouse Input (uses webContents.sendInputEvent for trusted events)
  // ---------------------------------------------------------------------------

  /**
   * Generate a series of intermediate points between two coordinates.
   * Adds slight curve and jitter for realistic mouse movement.
   */
  private generateTrajectory(
    fromX: number, fromY: number,
    toX: number, toY: number,
    steps: number,
  ): Array<{ x: number; y: number }> {
    const points: Array<{ x: number; y: number }> = []
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      // Slight arc: offset perpendicular to the line
      const arcOffset = Math.sin(t * Math.PI) * Math.min(15, Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2) * 0.05)
      const dx = toX - fromX
      const dy = toY - fromY
      const len = Math.sqrt(dx * dx + dy * dy) || 1
      const perpX = -dy / len
      const perpY = dx / len
      // Small per-step jitter (±2px)
      const jitterX = (Math.random() - 0.5) * 4
      const jitterY = (Math.random() - 0.5) * 4
      points.push({
        x: Math.round(fromX + dx * t + perpX * arcOffset + jitterX),
        y: Math.round(fromY + dy * t + perpY * arcOffset + jitterY),
      })
    }
    // Ensure last point is exactly the target
    if (points.length > 0) {
      points[points.length - 1] = { x: Math.round(toX), y: Math.round(toY) }
    }
    return points
  }

  private sendMouseEvent(type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, button?: 'left' | 'right' | 'middle', clickCount?: number): void {
    const event: Record<string, unknown> = { type, x: Math.round(x), y: Math.round(y) }
    if (button) event.button = button
    if (clickCount !== undefined) event.clickCount = clickCount
    this.webContents.sendInputEvent(event as any)
  }

  // Explicit CDP mouse fallback methods kept for resilience.
  private async clickAtCDP(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  private async dragCDP(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const dx = x2 - x1
    const dy = y2 - y1
    const distance = Math.sqrt(dx * dx + dy * dy)
    const steps = Math.max(5, Math.min(20, Math.round(distance / 20)))
    let lastX = x1
    let lastY = y1

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: x1,
      y: y1,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })

    try {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const x = Math.round(x1 + dx * t)
        const y = Math.round(y1 + dy * t)
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'left',
          buttons: 1,
        })
        lastX = x
        lastY = y

        if (i < steps) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }
    } finally {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: lastX,
        y: lastY,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Element Interaction
  // ---------------------------------------------------------------------------

  async clickAtCoordinates(x: number, y: number): Promise<void> {
    try {
      // Generate short trajectory to the click target for realism
      const startX = x + (Math.random() - 0.5) * 60
      const startY = y + (Math.random() - 0.5) * 60
      const trajectory = this.generateTrajectory(startX, startY, x, y, 3 + Math.floor(Math.random() * 3))

      for (const point of trajectory) {
        this.sendMouseEvent('mouseMove', point.x, point.y)
        await new Promise(resolve => setTimeout(resolve, 4 + Math.random() * 8))
      }

      this.sendMouseEvent('mouseDown', Math.round(x), Math.round(y), 'left', 1)
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 40))
      this.sendMouseEvent('mouseUp', Math.round(x), Math.round(y), 'left', 1)
    } catch (error) {
      mainLog.warn(`[browser-cdp] native clickAt failed, falling back to CDP: ${error instanceof Error ? error.message : String(error)}`)
      await this.clickAtCDP(x, y)
    }
  }

  async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    try {
      const dx = x2 - x1
      const dy = y2 - y1
      const distance = Math.sqrt(dx * dx + dy * dy)
      const steps = Math.max(5, Math.min(20, Math.round(distance / 20)))

      // Move to start position
      this.sendMouseEvent('mouseMove', x1, y1)
      await new Promise(resolve => setTimeout(resolve, 10))

      // Press at start position
      this.sendMouseEvent('mouseDown', x1, y1, 'left', 1)
      await new Promise(resolve => setTimeout(resolve, 30))

      let lastX = x1
      let lastY = y1

      try {
        const trajectory = this.generateTrajectory(x1, y1, x2, y2, steps)
        for (let i = 0; i < trajectory.length; i++) {
          const point = trajectory[i]!
          this.sendMouseEvent('mouseMove', point.x, point.y)
          lastX = point.x
          lastY = point.y

          if (i < trajectory.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 8 + Math.random() * 12))
          }
        }
      } catch (error) {
        // Always release even on error
        this.sendMouseEvent('mouseUp', lastX, lastY, 'left', 1)
        throw error
      }

      await new Promise(resolve => setTimeout(resolve, 20))
      this.sendMouseEvent('mouseUp', lastX, lastY, 'left', 1)
    } catch (error) {
      mainLog.warn(`[browser-cdp] native drag failed, falling back to CDP: ${error instanceof Error ? error.message : String(error)}`)
      await this.dragCDP(x1, y1, x2, y2)
    }
  }

  async typeText(text: string): Promise<void> {
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char })
    }
  }

  async setClipboard(text: string): Promise<void> {
    await this.send('Runtime.evaluate', {
      expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
      awaitPromise: true,
      userGesture: true,
    })
  }

  async getClipboard(): Promise<string> {
    const result = await this.send('Runtime.evaluate', {
      expression: 'navigator.clipboard.readText()',
      awaitPromise: true,
      userGesture: true,
    })
    return (result as any).result?.value ?? ''
  }

  async clickElement(ref: string): Promise<ElementGeometry> {
    const backendNodeId = this.refMap.get(ref)
    if (!backendNodeId) {
      throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`)
    }

    try {
      // Resolve node to get objectId
      const { object } = await this.send('DOM.resolveNode', { backendNodeId })

      // Scroll element into view first
      await this.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { this.scrollIntoViewIfNeeded(); }',
      })

      // Get element box model after scroll for up-to-date click coordinates
      const geometry = await this.getElementGeometry(ref)
      const x = geometry.clickPoint.x
      const y = geometry.clickPoint.y

      // Use native input events for trusted mouse interaction
      await this.clickAtCoordinates(x, y)

      return geometry
    } catch (err) {
      mainLog.error(`[browser-cdp] Click failed for ${ref}:`, err)
      throw new Error(`Failed to click ${ref}: ${err}`)
    }
  }

  async fillElement(ref: string, value: string): Promise<ElementGeometry> {
    const backendNodeId = this.refMap.get(ref)
    if (!backendNodeId) {
      throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`)
    }

    try {
      // Focus the element first
      await this.send('DOM.focus', { backendNodeId })

      // Clear existing content
      const { object } = await this.send('DOM.resolveNode', { backendNodeId })
      await this.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }`,
      })

      // Type the new value character by character for realistic input
      for (const char of value) {
        await this.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: char,
        })
        await this.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          text: char,
        })
      }

      // Dispatch change event
      await this.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
      })

      return await this.getElementGeometry(ref)
    } catch (err) {
      mainLog.error(`[browser-cdp] Fill failed for ${ref}:`, err)
      throw new Error(`Failed to fill ${ref}: ${err}`)
    }
  }

  async selectOption(ref: string, value: string): Promise<ElementGeometry> {
    const backendNodeId = this.refMap.get(ref)
    if (!backendNodeId) {
      throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`)
    }

    try {
      const { object } = await this.send('DOM.resolveNode', { backendNodeId })
      const result = await this.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function(val) {
          const normalize = (input) => String(input ?? '').trim().toLowerCase()
          const desired = normalize(val)

          const isVisible = (el) => {
            if (!el || !(el instanceof Element)) return false
            const style = window.getComputedStyle(el)
            if (!style) return false
            if (style.display === 'none' || style.visibility === 'hidden') return false
            if (Number(style.opacity || '1') === 0) return false
            const rect = el.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          }

          const fireClick = (el) => {
            if (!el) return
            const events = [
              ['pointerdown', PointerEvent],
              ['mousedown', MouseEvent],
              ['pointerup', PointerEvent],
              ['mouseup', MouseEvent],
              ['click', MouseEvent],
            ]
            for (const [name, EventCtor] of events) {
              try {
                el.dispatchEvent(new EventCtor(name, { bubbles: true, cancelable: true, composed: true }))
              } catch {
                el.dispatchEvent(new Event(name, { bubbles: true, cancelable: true }))
              }
            }
          }

          const readOptionValue = (el) => {
            if (!el || !(el instanceof Element)) return ''
            return (
              el.getAttribute('data-value')
              || el.getAttribute('value')
              || el.textContent
              || ''
            )
          }

          const hasDesired = (input) => normalize(input).includes(desired)

          const isNativeSelect = this instanceof HTMLSelectElement || String(this.tagName || '').toLowerCase() === 'select'
          if (isNativeSelect) {
            this.value = val
            this.dispatchEvent(new Event('input', { bubbles: true }))
            this.dispatchEvent(new Event('change', { bubbles: true }))

            const selected = this.selectedOptions && this.selectedOptions.length > 0 ? this.selectedOptions[0] : null
            const selectedValue = selected ? (selected.value || selected.textContent || '') : (this.value || '')
            const verified = hasDesired(selectedValue) || hasDesired(this.value)
            return {
              ok: verified,
              strategy: 'native',
              reason: verified ? undefined : 'native select value did not update as expected',
              selectedValue: this.value || '',
              selectedText: selected ? String(selected.textContent || '').trim() : '',
            }
          }

          this.focus && this.focus()
          fireClick(this)

          const candidateContainers = []
          const linkedIds = [this.getAttribute('aria-controls'), this.getAttribute('aria-owns')].filter(Boolean)
          for (const id of linkedIds) {
            const linked = document.getElementById(id)
            if (linked && isVisible(linked)) candidateContainers.push(linked)
          }

          const expandedCombos = Array.from(document.querySelectorAll('[role="combobox"][aria-expanded="true"]'))
          for (const combo of expandedCombos) {
            if (isVisible(combo) && combo !== this) candidateContainers.push(combo)
            const controls = combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns')
            if (controls) {
              const linked = document.getElementById(controls)
              if (linked && isVisible(linked)) candidateContainers.push(linked)
            }
          }

          for (const listbox of Array.from(document.querySelectorAll('[role="listbox"]'))) {
            if (isVisible(listbox)) candidateContainers.push(listbox)
          }

          const seen = new Set()
          const uniqueContainers = candidateContainers.filter((el) => {
            if (!el) return false
            if (seen.has(el)) return false
            seen.add(el)
            return true
          })

          const gatherOptions = (container) => {
            if (!container || !(container instanceof Element)) return []
            const options = Array.from(container.querySelectorAll('[role="option"], option, [data-value]'))
            return options.filter((opt) => isVisible(opt))
          }

          let options = []
          for (const container of uniqueContainers) {
            const local = gatherOptions(container)
            if (local.length > 0) {
              options = local
              break
            }
          }

          if (options.length === 0) {
            options = Array.from(document.querySelectorAll('[role="option"], option, [data-value]')).filter((opt) => isVisible(opt))
          }

          let matched = options.find((opt) => normalize(readOptionValue(opt)) === desired)
          if (!matched) matched = options.find((opt) => hasDesired(readOptionValue(opt)))

          if (!matched) {
            return {
              ok: false,
              strategy: 'aria',
              reason: 'option "' + val + '" not found in active listbox',
              selectedValue: '',
              selectedText: '',
            }
          }

          fireClick(matched)

          const selfValue = (
            this.value
            || this.getAttribute('value')
            || this.getAttribute('aria-valuetext')
            || this.getAttribute('aria-label')
            || this.textContent
            || ''
          )
          const matchedValue = readOptionValue(matched)
          const verified = hasDesired(selfValue) || hasDesired(matchedValue)

          return {
            ok: verified,
            strategy: 'aria',
            reason: verified ? undefined : 'option click succeeded but control state did not reflect selected value',
            selectedValue: String(selfValue || ''),
            selectedText: String(matchedValue || '').trim(),
          }
        }`,
        arguments: [{ value }],
      })

      const details = result?.result?.value as {
        ok?: boolean
        strategy?: string
        reason?: string
        selectedValue?: string
        selectedText?: string
      } | undefined

      if (details?.ok === false) {
        throw new Error(
          [
            `Selection did not bind to form state`,
            details.strategy ? `strategy=${details.strategy}` : null,
            details.reason ? `reason=${details.reason}` : null,
            details.selectedValue ? `selectedValue=${details.selectedValue}` : null,
            details.selectedText ? `selectedText=${details.selectedText}` : null,
          ].filter(Boolean).join('; '),
        )
      }

      return await this.getElementGeometry(ref)
    } catch (err) {
      mainLog.error(`[browser-cdp] Select failed for ${ref}:`, err)
      throw new Error(`Failed to select option in ${ref}: ${err}`)
    }
  }

  async setFileInputFiles(ref: string, filePaths: string[]): Promise<ElementGeometry> {
    const backendNodeId = this.refMap.get(ref)
    if (!backendNodeId) {
      throw new Error(`Element ${ref} not found. Run browser_snapshot first to get current element refs.`)
    }

    try {
      await this.send('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId,
      })

      return await this.getElementGeometry(ref)
    } catch (err) {
      mainLog.error(`[browser-cdp] setFileInputFiles failed for ${ref}:`, err)
      throw new Error(`Failed to set files on ${ref}: ${err}`)
    }
  }
}
