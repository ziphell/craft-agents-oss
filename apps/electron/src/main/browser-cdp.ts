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
// The overlay a page gets while elements are being chosen on it
// ---------------------------------------------------------------------------

/** Window key the injected overlay publishes its state into. */
const OVERLAY_STATE_KEY = '__craft_agent_overlay_state__'
/** Window key exposing the overlay's teardown handle — leave now, dropping the draft. */
const OVERLAY_CANCEL_KEY = '__craft_agent_overlay_cancel__'
/**
 * Window key asking the overlay to leave *if it has nothing unsaved*.
 *
 * A second handle rather than a flag on the first, because the two are asked by
 * different callers for different reasons: the toolbar's button asks (the person may
 * have work in the draft, and that is a decision, not a teardown), while closing a
 * tab, re-arming the overlay or finishing a one-shot pick tears down (there is
 * nobody left to ask, and the overlay must not outlive the mode).
 */
const OVERLAY_ASK_KEY = '__craft_agent_overlay_ask_leave__'
/**
 * Window key the window's own ✓ presses to write the draft down.
 *
 * One caller, one moment: while the bar is asking "save before leaving?", the ✓ beside
 * the crosshair is the "yes" — save the draft and end the mode. Saving in the ordinary
 * way is the ✓ on the page's own bar and needs no handle out here; this exists because
 * the question is *asked* in the window's chrome (a page cannot be sure its own bar is
 * visible), and the answer still has to reach the page's draft.
 */
const OVERLAY_SAVE_KEY = '__craft_agent_overlay_save__'
const OVERLAY_ID = '__craft_agent_overlay__'

/** What the injected overlay has reported since the last read. */
export interface OverlayReport {
  /**
   * `pending` while mounted and nothing has happened yet; `cancelled` once it has
   * been taken down (Escape in the page, or the toolbar's button); `picked` once a
   * one-shot pick has been answered; `missing` when this document has no overlay at
   * all, which is what a navigation looks like from here.
   */
  status: 'pending' | 'picked' | 'cancelled' | 'missing'
  /** Elements picked since the last read — cleared as they are read. */
  picks: PickedElement[]
  /** Saves made since the last read, in order — cleared as they are read. */
  saves: BrowserEdit[][]
  /**
   * Whether the draft is what is keeping the mode open: the person tried to leave and
   * was asked to save or drop, and has not answered yet.
   */
  leavingWithEdits: boolean
}

/** The bar's words when the caller brings none (the toolbar renderer brings its own). */
const DEFAULT_OVERLAY_LABELS: OverlayLabels = {
  add: 'Add to conversation',
  undo: 'Undo',
  redo: 'Redo',
  save: 'Save',
  bold: 'Bold',
  italic: 'Italic',
}

/** The bar's colours when the caller brings none — the bar is not drawn then anyway. */
const DEFAULT_OVERLAY_MENU = { surface: '#ffffff', text: '#111111' }

/**
 * How a selection is drawn: a solid frame around it, and its name on a chip of the
 * app's accent.
 *
 * The frame and the chip are the app's marks *about* the page, which is why they keep
 * the accent while the bar wears the menu's colours. The chip is **fixed to the page's
 * bottom-left corner** rather than hung off the frame it describes: a name that moves
 * with the page covers the very thing the person is looking at, at the one moment they
 * are looking at it, and it changes place every time the page scrolls.
 */
function selectionFrameStyle(accent: string): string {
  return `position:fixed;display:none;border:2px solid ${accent};border-radius:4px;pointer-events:none;`
}

function selectionLabelStyle(accent: string): string {
  return `position:fixed;display:none;left:8px;bottom:8px;padding:2px 6px;border-radius:6px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:${accent};color:#fff;pointer-events:none;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
}

/**
 * `buildStableSelector`, as source, for the scripts injected into a page.
 *
 * One copy for both of the overlay's users on purpose: the window's mode and the
 * agent's one-shot pick describe an element the same way — the selector the agent, a
 * patch's `@target` and the anchor record all agree on. A second copy would be a
 * second description of one thing, and the two would drift.
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
 * The overlay a page gets while someone is choosing elements on it.
 *
 * One script for the window's own mode and for the agent's one-shot
 * `browser_tool pick`, because the gesture is one gesture: point at the page — click
 * an element, or box several — and what comes back is a selection. Only what happens
 * afterwards differs, and that is the `resident`/`bar` pair: the window's mode keeps
 * the selection, draws its bar above it and stays mounted; a one-shot pick reports
 * the element and tears itself down before anything else can happen.
 *
 * Two scripts for that difference would be two descriptions of one gesture, and they
 * would drift — which is what the mode looked like before this: a picker and an
 * editor, each with its own overlay, its own bar and its own idea of what a click
 * means, and a person had to know which one to enter before they knew what they
 * would find (plan §12.7).
 *
 * It reports into `OVERLAY_STATE_KEY` rather than resolving a long-lived promise, so
 * the caller can poll with short CDP calls and the idle-detach timer never fires
 * mid-selection.
 *
 * Injected through CDP, so it is unaffected by the page's CSP and needs no
 * `webPreferences` changes (stays sandboxed).
 */
function buildOverlayScript(options: {
  /**
   * The app's accent, as a concrete CSS colour.
   *
   * Resolved by the caller: a page cannot see the app's variables, and this class
   * knows nothing about themes. It is the same value the agent-control overlay is
   * drawn with, so the window's own chrome and everything drawn on a page agree.
   */
  accent: string
  /**
   * What the bar is drawn in: the app's *menu* surface and text.
   *
   * The bar is a menu of ours sitting on somebody else's page — the same job a
   * dropdown in the app does — so it wears what a dropdown wears. The accent stays
   * for the marks the app draws *about* the page (the selection's frames and its
   * name), which are not part of the menu.
   */
  menu: { surface: string; text: string }
  /**
   * Draw the bar, and keep what the person makes as a draft.
   *
   * The window's own mode does. A one-shot pick does not — the agent asked for one
   * element, and a bar nobody asked for is chrome drawn over somebody's page.
   */
  bar: boolean
  /**
   * The bar's words, in the caller's language — the toolbar owns the i18n, not this.
   *
   * They are titles rather than labels: the buttons carry glyphs, and what each one
   * means is said on hover (and to a screen reader).
   */
  labels: { add: string; undo: string; redo: string; save: string; bold: string; italic: string }
  /**
   * Stay armed after a selection.
   *
   * One pick is what the agent asks for, but a person who turned the mode on is
   * working on *elements*, plural, and moving between tabs while they do it: the
   * overlay stays, a click or a box selects, and the mode ends when they say so
   * (Escape here, or the toolbar button).
   */
  resident: boolean
}): string {
  const accent = options.accent

  // Everything the overlay draws is one of these. The frames carry the state —
  // dashed and tinted for "what a click would take", solid for "what it took", and
  // a third dashed one for what a drag is covering right now.
  const hoverBoxStyle = `position:fixed;display:none;border:1px dashed ${accent};background:color-mix(in oklab, ${accent} 15%, transparent);border-radius:4px;pointer-events:none;`
  const marqueeStyle = `position:fixed;display:none;border:1px dashed ${accent};background:color-mix(in oklab, ${accent} 12%, transparent);border-radius:4px;pointer-events:none;`
  const frameStyle = selectionFrameStyle(accent)
  const nameStyle = selectionLabelStyle(accent)
  const layerStyle = `position:fixed;inset:0;pointer-events:none;`
  // One surface for both clusters of the bar — the selection's work at the top of the
  // page, and the draft's back-and-forward at its top-left — so the two read as one
  // thing that happens to be in two places.
  const barSurfaceStyle = `position:fixed;display:none;align-items:center;gap:2px;padding:4px;border-radius:10px;background:${options.menu.surface};border:1px solid color-mix(in oklab, ${options.menu.text} 14%, transparent);box-shadow:0 6px 20px rgba(0,0,0,0.18);pointer-events:auto;`
  const barStyle = barSurfaceStyle + 'left:50%;top:8px;transform:translateX(-50%);'
  const undoBarStyle = barSurfaceStyle + 'left:8px;top:8px;'
  const barButtonStyle = `all:unset;cursor:pointer;min-width:24px;height:24px;line-height:24px;padding:0 6px;text-align:center;border-radius:6px;color:${options.menu.text};font:400 13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;white-space:nowrap;`
  const spacerStyle = `width:1px;height:16px;background:color-mix(in oklab, ${options.menu.text} 20%, transparent);margin:0 3px;`

  return `(() => {
  try { window.${OVERLAY_CANCEL_KEY} && window.${OVERLAY_CANCEL_KEY}(); } catch (e) {}

  const root = document.createElement('div');
  root.id = '${OVERLAY_ID}';
  root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;');

  // What the cursor is over — what a click would take.
  const hoverBox = document.createElement('div');
  hoverBox.setAttribute('style', ${JSON.stringify(hoverBoxStyle)});
  root.appendChild(hoverBox);

  // The name of what is hovered or selected — one chip, fixed at the page's bottom-left
  // by its own style, so it never covers what it names.
  const nameLabel = document.createElement('div');
  nameLabel.setAttribute('style', ${JSON.stringify(nameStyle)});
  root.appendChild(nameLabel);

  // What the drag covers right now.
  const marquee = document.createElement('div');
  marquee.setAttribute('style', ${JSON.stringify(marqueeStyle)});
  root.appendChild(marquee);

  // What is selected: a frame and a name per element, on a layer of their own.
  const layer = document.createElement('div');
  layer.setAttribute('style', ${JSON.stringify(layerStyle)});
  root.appendChild(layer);

  // The draft, drawn: the rules the session has made so far, in the order they were
  // made, so a later edit wins exactly as it will once it is written. It is our own
  // stylesheet and it lives and dies with the overlay — the patch that follows is
  // what keeps the page looking like this afterwards.
  const preview = document.createElement('style');
  root.appendChild(preview);

  // The bar, which is the whole of what a person acts with on the page: two styles,
  // back and forward through the draft, write it down, and hand it to the conversation.
  // It is built even for a one-shot pick (where nothing shows it) rather than spliced
  // in conditionally — one script, one shape, and no second description to drift.
  const bar = document.createElement('div');
  bar.setAttribute('style', ${JSON.stringify(barStyle)});
  // Back, forward and save live on their own, at the page's top-left: the first two
  // are the ones the person reaches for constantly (and by keyboard), and keeping them
  // apart lets the rest of the bar change with the selection while these stay where
  // they are. Save belongs with them for the same reason — it is about the draft as a
  // whole, not about what is selected, and it is the answer to "save before leaving?".
  const undoBar = document.createElement('div');
  undoBar.setAttribute('style', ${JSON.stringify(undoBarStyle)});
  // A button is a glyph with a title: on a bar this small, what each one does is said
  // on hover (and to a screen reader) rather than written out.
  const makeButton = (glyph, title, extra) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.setAttribute('style', ${JSON.stringify(barButtonStyle)} + extra);
    // Menus here have no room for a pressed state: a hover tint is what says the
    // pointer is on a control rather than on the page behind it.
    button.addEventListener('mouseenter', () => {
      button.style.background = 'color-mix(in oklab, ' + ${JSON.stringify(options.menu.text)} + ' 12%, transparent)';
    });
    button.addEventListener('mouseleave', () => { button.style.background = ''; });
    return button;
  };
  const boldButton = makeButton('B', ${JSON.stringify(options.labels.bold)}, 'font-weight:700;');
  const italicButton = makeButton('I', ${JSON.stringify(options.labels.italic)}, 'font-style:italic;');
  const undoButton = makeButton('\\u21b6', ${JSON.stringify(options.labels.undo)}, '');
  const redoButton = makeButton('\\u21b7', ${JSON.stringify(options.labels.redo)}, '');
  const saveButton = makeButton('\\u2713', ${JSON.stringify(options.labels.save)}, '');
  const addSpacer = document.createElement('div');
  addSpacer.setAttribute('style', ${JSON.stringify(spacerStyle)});
  const addButton = makeButton(${JSON.stringify(options.labels.add)}, ${JSON.stringify(options.labels.add)}, 'padding:0 10px;');
  for (const node of [undoButton, redoButton, saveButton]) {
    undoBar.appendChild(node);
  }
  for (const node of [boldButton, italicButton, addSpacer, addButton]) {
    bar.appendChild(node);
  }
  root.appendChild(undoBar);
  root.appendChild(bar);

  document.documentElement.appendChild(root);

${STABLE_SELECTOR_FN}

  const WITH_BAR = ${options.bar};

  // The overlay's whole outward state: what it has picked, what it has been told to
  // write down, and whether the draft is holding the mode open. Written into the
  // window key at the end of this script, where the caller polls it — and kept out of
  // cleanup(), so the final status is still readable after the overlay is gone. The
  // last one is read through a getter: it is a fact about now, and the caller has to
  // see it as it is at the moment it asks — that is what the window's chip says the
  // question is, while the bar's own save button is the answer.
  const state = {
    status: 'pending',
    picks: [],
    saves: [],
    get leavingWithEdits() { return confirming; },
  };

  // The draft, and where the last save left it: the draft is appended to and popped
  // from the end, so one boundary is all the history this needs. What was taken back
  // is kept aside, in the order it was taken back, so forward is possible too.
  let draft = [];
  let savedCount = 0;
  let undone = [];
  let confirming = false;   // the bar is asking save-or-drop; the mode stays until it is answered
  let selected = [];
  let current = null;       // what the cursor is over
  let editing = null;       // { el, before, onBlur } — the element being typed into
  let drag = null;

  const inOverlay = (el) => !!el && root.contains(el);
  const targetOf = (el) => ({ selector: buildStableSelector(el), tag: el.tagName ? el.tagName.toLowerCase() : '' });
  const unsaved = () => draft.length - savedCount;

  /** What a pick reports: the element, and where it is. */
  const elementPayload = (el) => {
    const r = el.getBoundingClientRect();
    return {
      selector: buildStableSelector(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.textContent || '').trim().slice(0, 200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
  };

  const rectOf = (d) => ({
    left: Math.min(d.x0, d.x1),
    top: Math.min(d.y0, d.y1),
    right: Math.max(d.x0, d.x1),
    bottom: Math.max(d.y0, d.y1),
  });

  /**
   * What a rectangle selects.
   *
   * Inline boxes are skipped, and only the innermost of what is left is kept: boxing
   * a paragraph has to mean the paragraph and not the spans inside it, and boxing a
   * card has to mean its contents rather than the card *and* everything in it. A
   * click is not a box with no area — it is a different question, answered by what is
   * actually under the cursor, inline elements included: clicking a link inside a
   * paragraph has to select the link.
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

  /**
   * What the name chip says — one chip, one place (the page's bottom-left).
   *
   * What the cursor is over comes first, because it is what a click would take;
   * otherwise it is what is selected. Several selected read one after another — each
   * has its own frame to point at it, and the chip is what says which is which.
   */
  const paintName = () => {
    const hovered = current && !inOverlay(current) && selected.indexOf(current) === -1 ? current : null;
    const names = hovered ? [buildStableSelector(hovered)] : selected.map(buildStableSelector);
    nameLabel.textContent = names.join('  ·  ');
    nameLabel.style.display = names.length > 0 ? 'block' : 'none';
  };

  const paintHover = (el) => {
    // Nothing to preview while dragging (the marquee says it), on the overlay's own
    // chrome, or on something already selected — it has a marker of its own, and a
    // second frame there would only say the same thing twice.
    if (drag || !el || inOverlay(el) || selected.indexOf(el) !== -1) {
      hoverBox.style.display = 'none';
      paintName();
      return;
    }
    const r = el.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.left + 'px';
    hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px';
    hoverBox.style.height = r.height + 'px';
    paintName();
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

  /** What each button can do right now — which is the only thing the bar says about the draft. */
  const paintBar = () => {
    // Nothing unsaved means the "save or drop?" question has nothing left to ask.
    if (unsaved() === 0) confirming = false;
    undoButton.style.opacity = unsaved() === 0 ? '0.45' : '1';
    redoButton.style.opacity = undone.length === 0 ? '0.45' : '1';
    // Dimmed rather than hidden, like the two above: the bar says what it can do by
    // what is lit, and save is the one whose availability the person is asking about.
    saveButton.style.opacity = unsaved() === 0 ? '0.45' : '1';
  };

  /**
   * Draw the selection, and put the bar where it cannot cover the work.
   *
   * The bar is pinned to the top of the page rather than hung off the selection: it
   * belongs to the window, it stays put while the person moves between elements, and
   * above the page's own content is the one place that is never over the thing being
   * changed. Each selected element gets a frame, and the name of what is selected is
   * on the one chip at the page's bottom-left — out of the way of everything.
   */
  const paint = () => {
    layer.textContent = '';
    hoverBox.style.display = 'none';
    selected = selected.filter((el) => el.isConnected && !inOverlay(el));

    // Both clusters are where the draft lives — save among them — so they stay while
    // there is something to decide or something to take back, even with nothing
    // selected to point at.
    const working = selected.length > 0 || unsaved() > 0 || undone.length > 0;
    bar.style.display = WITH_BAR && working ? 'flex' : 'none';
    undoBar.style.display = WITH_BAR && working ? 'flex' : 'none';
    paintBar();
    paintName();
    if (selected.length === 0) return;

    for (const el of selected) {
      const r = el.getBoundingClientRect();
      const frame = document.createElement('div');
      frame.setAttribute('style', ${JSON.stringify(frameStyle)}
        + 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;');
      layer.appendChild(frame);
    }
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
    // A new edit forks the draft: what was taken back is no longer ahead of us, and the
    // person working on rather than answering is the answer to "save or drop?".
    undone = [];
    confirming = false;
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
    const inFlight = editing;
    if (!inFlight) return;
    editing = null;
    inFlight.el.removeEventListener('blur', inFlight.onBlur, true);
    inFlight.el.removeAttribute('contenteditable');
    if (!commit) { inFlight.el.textContent = inFlight.before; return; }
    const text = inFlight.el.textContent || '';
    if (text === inFlight.before) return;
    // The element, not just its selector: taking this edit back has to put the old
    // text back, and that needs the node the person typed into. It forks the draft,
    // like any other new edit — and it, too, is the person working on rather than
    // answering the save-or-drop question.
    undone = [];
    confirming = false;
    draft.push({ kind: 'text', targets: [targetOf(inFlight.el)], text: text, el: inFlight.el, before: inFlight.before });
    paintBar();
  };

  /**
   * Put one entry's change on the page, or take it back off.
   *
   * Styles need nothing here — they are drawn by regenerating the preview from the
   * draft — so this is about the text a retype left in an element. The element may be
   * gone (the page re-rendered it away), and then there is nothing to move.
   */
  const applyEntry = (entry, forward) => {
    if (entry.kind !== 'text' || !entry.el || !entry.el.isConnected) return;
    entry.el.textContent = forward ? entry.text : entry.before;
  };

  /** Take the last unsaved edit back — and with it, whatever it did to the page. */
  const undo = () => {
    if (unsaved() === 0) return;
    const entry = draft.pop();
    applyEntry(entry, false);
    undone.unshift(entry);
    renderPreview();
    paintBar();
  };

  /**
   * Put the last edit taken back on again.
   *
   * Only ever forward within the unsaved part of the draft: undo refuses once it
   * reaches the line the last save drew, so nothing that came back can cross it.
   */
  const redo = () => {
    const entry = undone.shift();
    if (!entry) return;
    applyEntry(entry, true);
    draft.push(entry);
    renderPreview();
    paintBar();
  };

  /** Drop everything unsaved, the same way taking each one back would. */
  const discard = () => {
    while (unsaved() > 0) {
      const entry = draft.pop();
      applyEntry(entry, false);
    }
    undone = [];
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
    // A save is a new baseline: what was taken back before it is not "behind" the
    // line any more, and offering to put it forward again would be a second history.
    undone = [];
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

  /**
   * Hand the selection to the conversation.
   *
   * Every selected element, because the selection is the unit here — the same one a
   * style applies to. A click selects one, so the ordinary "talk about this" case is
   * one reference; boxing several and adding them says "look at these".
   */
  const addToConversation = () => {
    const elements = selected.filter((el) => el.isConnected);
    if (elements.length === 0) return;
    for (const el of elements) state.picks.push(elementPayload(el));
  };

  const onMove = (e) => {
    if (drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el === current) return;
    current = el;
    paintHover(el);
  };

  /**
   * Whether an event belongs to the browser rather than to the mode.
   *
   * Two places, and both are where the browser's own behaviour is the point: the
   * overlay's own chrome (its buttons are clicked, not selected), and the element
   * being typed into (placing the caret and selecting a word inside it is what makes
   * typing in it possible at all). Everything else is the mode's.
   */
  const browserOwnsIt = (e) => inOverlay(e.target) || !!(editing && editing.el.contains(e.target));

  /**
   * The mouse events behind the pointer events, refused the same way.
   *
   * A page is as likely to be listening to mousedown / mouseup as to pointerdown, and
   * those are separate events with separate listeners: a press the mode does not take
   * is a press the page still gets, and a double-click the page still gets selects its
   * text or follows its link. Nothing is acted on here — the pointer handlers do the
   * work — so this is only the refusal, with the same two exceptions.
   */
  const swallowMouse = (e) => {
    if (e.button !== 0 || browserOwnsIt(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerDown = (e) => {
    // A press outside what is being typed into ends that edit — and the mode keeps the
    // press: committing here rather than letting the page blur the element means the
    // typed text goes into the draft and the press itself is still ours.
    if (editing && !editing.el.contains(e.target)) endText(true);
    if (e.button !== 0 || browserOwnsIt(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };
    // Nothing is hovering anything while a box is being drawn, so the chip falls back
    // to what is selected rather than naming whatever the drag started over.
    current = null;
    paintHover(null);
    drawMarquee();
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    if (Math.abs(drag.x1 - drag.x0) > 3 || Math.abs(drag.y1 - drag.y0) > 3) drag.moved = true;
    drawMarquee();
  };

  const onPointerUp = (e) => {
    if (!drag) return;
    const box = rectOf(drag);
    const moved = drag.moved;
    drag = null;
    marquee.style.display = 'none';

    // A one-shot pick (the agent's browser_tool pick) has no second step and no
    // selection to keep: what is under the cursor is the answer, and the overlay is
    // torn down with it.
    if (!${options.resident}) {
      const el = document.elementFromPoint(e.clientX, e.clientY) || within(box)[0];
      if (!el || inOverlay(el)) { finish('cancelled'); return; }
      state.picks.push(elementPayload(el));
      finish('picked');
      return;
    }

    // A drag is a box — the blocks it covers. A press that did not move is a click,
    // and a click asks about the element under the cursor, inline or not.
    selected = moved ? within(box) : [document.elementFromPoint(e.clientX, e.clientY)].filter((el) => el && !inOverlay(el));
    paint();
  };

  // Choosing is not using: nothing the person pressed may activate the page under
  // the mode.
  const swallowClick = (e) => {
    if (browserOwnsIt(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onDblClick = (e) => {
    if (!WITH_BAR || browserOwnsIt(e)) return;
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
      if (WITH_BAR) { requestLeave(false); return; }
      finish('cancelled');
      return;
    }

    // Enter finishes a retype: what was typed is a change the person made, so it goes
    // into the draft. Shift+Enter is a line break, and belongs to the page.
    if (editing && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      endText(true);
      paint();
      return;
    }

    // Back and forward, spelled the way every editor spells them: Ctrl/Cmd+Z, and
    // either Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y for forward. Not while typing: there the
    // browser's own undo belongs to the text being typed.
    //
    // Swallowed even when there is nothing to move: while this mode holds the page, an
    // undo the page performs on its own is a change neither the person nor the app sees
    // or can record.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !editing) {
      const key = (e.key || '').toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        undo();
        return;
      }
      if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }
    }
  };

  const onViewportChange = () => {
    paintHover(current);
    paint();
  };

  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('mousedown', swallowMouse, true);
    document.removeEventListener('mouseup', swallowMouse, true);
    document.removeEventListener('click', swallowClick, true);
    document.removeEventListener('dblclick', onDblClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    // Leave nothing of ours on the page. The text being typed goes back, and so does
    // every unsaved entry: this teardown is a mode ending, not an edit being saved,
    // and a change no patch states is the one thing this mode may not leave behind.
    if (editing) {
      const inFlight = editing;
      editing = null;
      inFlight.el.removeEventListener('blur', inFlight.onBlur, true);
      inFlight.el.removeAttribute('contenteditable');
      inFlight.el.textContent = inFlight.before;
    }
    discard();
    const existing = document.getElementById('${OVERLAY_ID}');
    if (existing) existing.remove();
    try { delete window.${OVERLAY_CANCEL_KEY}; } catch (e) { window.${OVERLAY_CANCEL_KEY} = undefined; }
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
  redoButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    redo();
  });
  saveButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    save();
  });
  addButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addToConversation();
  });

  // The window's chrome has two handles on the question "save before leaving?" — the ✓
  // beside the crosshair is the "yes" (and the same save as the bar's own button, which
  // is why it runs through save()), and the crosshair pressed a second time is the "no"
  // (leave, draft and all). The two ways out still ask different things: the crosshair
  // asks (there may be a draft, and that is the person's call), while a teardown — the
  // tab closing, the overlay being re-armed on a new page, a one-shot pick being
  // finished — takes the draft with it, because there is nobody left to ask.
  window.${OVERLAY_SAVE_KEY} = () => save();
  window.${OVERLAY_CANCEL_KEY} = () => requestLeave(true);
  window.${OVERLAY_ASK_KEY} = () => requestLeave(false);
  window.${OVERLAY_STATE_KEY} = state;

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('mousedown', swallowMouse, true);
  document.addEventListener('mouseup', swallowMouse, true);
  document.addEventListener('click', swallowClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);
  paintBar();

  return true;
})()`
}

/**
 * Read the overlay's reports and clear them in one expression.
 *
 * Read-and-clear as a single step because two reads must not both see the same pick,
 * and a pick that lands between them must not be dropped — the page's own script
 * cannot run in the middle of this one.
 */
const OVERLAY_DRAIN_EXPRESSION = `(() => {
  const state = window.${OVERLAY_STATE_KEY};
  if (!state) return JSON.stringify({ status: 'missing', picks: [], saves: [] });
  const picks = state.picks || [];
  const saves = state.saves || [];
  state.picks = [];
  state.saves = [];
  return JSON.stringify({
    status: state.status,
    picks: picks,
    saves: saves,
    leavingWithEdits: state.leavingWithEdits === true,
  });
})()`

const OVERLAY_CANCEL_EXPRESSION = `(() => { try { window.${OVERLAY_CANCEL_KEY} && window.${OVERLAY_CANCEL_KEY}(); } catch (e) {} })()`

/** Ask the overlay to leave — it answers by leaving, or by asking which it is. */
const OVERLAY_ASK_EXPRESSION = `(() => { try { window.${OVERLAY_ASK_KEY} && window.${OVERLAY_ASK_KEY}(); } catch (e) {} })()`

/** Write the draft down and end the mode — the window's ✓ answering "save before leaving?". */
const OVERLAY_SAVE_EXPRESSION = `(() => { try { window.${OVERLAY_SAVE_KEY} && window.${OVERLAY_SAVE_KEY}(); } catch (e) {} })()`

/**
 * The bar's own words, in the window's language — the page has no i18n.
 *
 * Titles, not labels: the buttons carry glyphs (B, I, ↶, ↷, ✓), and these are what
 * hover and a screen reader say about them. `add` is the one word actually written on
 * the bar — handing the selection to the conversation, the odd one out among the
 * draft's own actions.
 */
export interface OverlayLabels {
  /** Hand the selection to the conversation. */
  add: string
  /** Take the last unsaved edit back. */
  undo: string
  /** Put the last edit taken back on again. */
  redo: string
  /** Write the draft down. */
  save: string
  /** Make the selection bold. */
  bold: string
  /** Make the selection italic. */
  italic: string
}

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
   * Put the overlay on the page and leave it there.
   *
   * Re-injecting is also how a page is re-armed: the script tears down whatever was
   * installed before it, so an arm is idempotent and a page that navigated out from
   * under an armed overlay gets a fresh one.
   */
  async armOverlay(options: {
    /** The app's accent, as a concrete CSS colour — see `buildOverlayScript`. */
    accent: string
    /** The bar's colours: the app's menu surface and text — see `buildOverlayScript`. */
    menu?: { surface: string; text: string }
    /** The bar's words, in the caller's language — the toolbar renderer has i18n. */
    labels?: Partial<OverlayLabels>
    /**
     * Draw the bar, and keep what the person makes as a draft.
     *
     * The window's own mode does; a one-shot pick does not — the agent asked for one
     * element, and a bar nobody asked for is chrome over somebody's page.
     */
    bar?: boolean
    /** Stay mounted after a selection — see `buildOverlayScript`. */
    resident?: boolean
  }): Promise<void> {
    const script = buildOverlayScript({
      accent: options.accent,
      menu: options.menu ?? DEFAULT_OVERLAY_MENU,
      bar: options.bar === true,
      labels: { ...DEFAULT_OVERLAY_LABELS, ...options.labels },
      resident: options.resident === true,
    })
    await this.send('Runtime.evaluate', { expression: script })
  }

  /**
   * Take what the overlay has reported since the last call, and clear it.
   *
   * Never throws on a missing overlay: "there is no overlay in this document" is an
   * answer (the page navigated), not a failure.
   */
  async drainOverlay(): Promise<OverlayReport> {
    const res = await this.send('Runtime.evaluate', {
      expression: OVERLAY_DRAIN_EXPRESSION,
      returnByValue: true,
    })

    const raw = res?.result?.value
    if (typeof raw !== 'string') return { status: 'missing', picks: [], saves: [], leavingWithEdits: false }

    try {
      const parsed = JSON.parse(raw) as {
        status?: string
        picks?: PickedElement[]
        saves?: BrowserEdit[][]
        leavingWithEdits?: boolean
      }
      return {
        status: (parsed.status as OverlayReport['status']) ?? 'missing',
        picks: Array.isArray(parsed.picks) ? parsed.picks : [],
        saves: Array.isArray(parsed.saves) ? parsed.saves.filter((save) => Array.isArray(save)) : [],
        leavingWithEdits: parsed.leavingWithEdits === true,
      }
    } catch {
      return { status: 'missing', picks: [], saves: [], leavingWithEdits: false }
    }
  }

  /**
   * Prompt the user to click an element on the page, once.
   *
   * Returns the picked element's stable selector + geometry, or `null` when the
   * user pressed Escape, the pick was cancelled, or the timeout elapsed. The
   * window's own mode is the resident, bar-carrying one (`armOverlay` +
   * `drainOverlay`); this is what a caller that asked for one element gets — the
   * same overlay, without the bar and gone as soon as it answers.
   *
   * Polls instead of awaiting one long-lived CDP promise: each poll is a short
   * call, so the idle-detach timer keeps being reset and cannot fire mid-pick.
   */
  async pickElement(options: {
    timeoutMs?: number
    pollMs?: number
    /** The app's accent, as a concrete CSS colour — see `buildOverlayScript`. */
    accent: string
    /** The bar's colours — never drawn for a one-shot pick, but the script is one script. */
    menu?: { surface: string; text: string }
  }): Promise<PickedElement | null> {
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000)
    const pollMs = Math.max(50, options.pollMs ?? 200)

    await this.armOverlay({ accent: options.accent, menu: options.menu, bar: false, resident: false })

    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        const report = await this.drainOverlay()

        if (report.picks.length > 0) return report.picks[0] ?? null
        if (report.status === 'cancelled' || report.status === 'missing') return null

        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }

      mainLog.info('[browser-cdp] picker timed out — no element selected')
      return null
    } finally {
      await this.teardownOverlay()
    }
  }

  /**
   * Ask the overlay to leave.
   *
   * It ends only if there is nothing unsaved to lose — otherwise the mode stays and
   * says so (`leavingWithEdits`), which is what puts "save before leaving?" in the
   * window's chip. The answers are `saveEdits` (the ✓ beside the crosshair, and the
   * bar's own button), a second request (the crosshair again, or Escape — leave, draft
   * and all), so there is nothing to await: the caller learns the outcome the way it
   * learns everything else, and the next `drainOverlay` says `cancelled` once the
   * overlay has really gone.
   */
  async askOverlayToLeave(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: OVERLAY_ASK_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] askOverlayToLeave ignored: ${String(err)}`)
    }
  }

  /** Take the overlay down, draft and all. Safe to call when none is mounted. */
  async teardownOverlay(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: OVERLAY_CANCEL_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] teardownOverlay ignored: ${String(err)}`)
    }
  }

  /**
   * Write the draft down, and end the mode — the window's ✓ answering the question.
   *
   * The same save the page's own bar performs, reached from the window's chrome because
   * that is where the question is asked (`leavingWithEdits`); nothing is awaited for an
   * outcome, as ever: what the save *is* comes back through the next `drainOverlay` as
   * one `saves` entry.
   */
  async saveEdits(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: OVERLAY_SAVE_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] saveEdits ignored: ${String(err)}`)
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
