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
import type { PickedElement } from '@craft-agent/shared/protocol'
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

// ---------------------------------------------------------------------------
// The overlay a page gets while elements are being chosen on it
// ---------------------------------------------------------------------------

/** Window key the injected overlay publishes its state into. */
const OVERLAY_STATE_KEY = '__craft_agent_overlay_state__'
/** Window key exposing the overlay's teardown handle — take it down now. */
const OVERLAY_CANCEL_KEY = '__craft_agent_overlay_cancel__'
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
}

/** The bar's word when the caller brings none (the toolbar renderer brings its own). */
const DEFAULT_OVERLAY_LABELS: OverlayLabels = {
  add: 'Add to conversation',
}

/**
 * How a selection is drawn: a solid frame around it, its name on a chip of the app's
 * accent, and the one control at the frame's **bottom-left corner**.
 *
 * All three wear the accent, because all three are the app's marks *about* the page
 * rather than a piece of the page: one colour says "this is ours", and the accent is
 * the colour the window's own chrome already uses. The name chip is the one exception
 * to sitting on the frame — it stays at the page's bottom-left corner, because a name
 * that moves with what it names covers the very thing the person is looking at, at the
 * one moment they are looking at it.
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
 * One copy on purpose: the window's own mode and the agent's one-shot pick describe an
 * element the same way — the selector the agent reads back out of a pick, and the one
 * a mention carries. A second copy would be a second description of one thing, and the
 * two would drift.
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
   * Draw the bar.
   *
   * The window's own mode does: the bar is where the selection is handed to the
   * conversation. A one-shot pick does not — the agent asked for one element, and a
   * bar nobody asked for is chrome drawn over somebody's page.
   */
  bar: boolean
  /** The bar's word, in the caller's language — the toolbar owns the i18n, not this. */
  labels: { add: string }
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
  // The bar sits at the selection frame's bottom-left corner — positioned in `paint`,
  // because it belongs to that frame rather than to the page — and wears the accent,
  // like the frame and the name chip: one colour for everything the app draws here.
  // Compact on purpose: it is one short word on somebody else's page, and every pixel
  // of it is pixels of their page.
  const barStyle = `position:fixed;display:none;align-items:center;padding:2px;border-radius:7px;background:${accent};box-shadow:0 4px 14px rgba(0,0,0,0.18);pointer-events:auto;`
  // A button on a bar this small is a glyph or a short word: what it does is said on
  // hover (and to a screen reader) as well.
  const barButtonStyle = `all:unset;cursor:pointer;min-width:20px;height:20px;line-height:20px;padding:0 8px;text-align:center;border-radius:5px;color:#fff;font:400 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;white-space:nowrap;`

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

  // What a live box is covering right now: the same dashed box the hover draws, one per
  // element, on a layer above the frames — during a drag these are the thing being
  // decided, and the release settles them into solid frames in their place.
  const previewLayer = document.createElement('div');
  previewLayer.setAttribute('style', ${JSON.stringify(layerStyle)});
  root.appendChild(previewLayer);

  // The bar: the one thing a person acts with on the page — hand the selection to the
  // conversation. It is built even for a one-shot pick (where nothing shows it) rather
  // than spliced in conditionally — one script, one shape, and no second description to
  // drift.
  const bar = document.createElement('div');
  bar.setAttribute('style', ${JSON.stringify(barStyle)});
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.textContent = ${JSON.stringify(options.labels.add)};
  addButton.title = ${JSON.stringify(options.labels.add)};
  addButton.setAttribute('aria-label', ${JSON.stringify(options.labels.add)});
  addButton.setAttribute('style', ${JSON.stringify(barButtonStyle)} + 'padding:0 10px;');
  // A hover tint is what says the pointer is on a control rather than on the page
  // behind it — brightness on the accent fill rather than a second colour, so the
  // button reads as the same control in both states.
  addButton.addEventListener('mouseenter', () => { addButton.style.filter = 'brightness(1.12)'; });
  addButton.addEventListener('mouseleave', () => { addButton.style.filter = ''; });
  bar.appendChild(addButton);
  root.appendChild(bar);

  document.documentElement.appendChild(root);

${STABLE_SELECTOR_FN}

  const WITH_BAR = ${options.bar};

  // The overlay's whole outward state: what it has picked. Written into the window key
  // at the end of this script, where the caller polls it — and kept out of cleanup(), so
  // the final status is still readable after the overlay is gone.
  const state = {
    status: 'pending',
    picks: [],
  };

  let selected = [];
  let current = null;       // what the cursor is over
  let drag = null;
  // What a box being drawn covers right now — the chip's answer while the hand is still
  // down, before the release decides the selection.
  let preview = null;

  const inOverlay = (el) => !!el && root.contains(el);

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
   * Three sources, in the order a hand moves: the box being drawn (what it is covering
   * right now), else what the cursor is over — what a click would take — else what is
   * selected. So the chip answers "what am I choosing" at every moment, including while
   * a button is held. Several read one after another — each has its own frame to point
   * at it, and the chip is what says which is which.
   */
  const paintName = () => {
    const hovered = current && !inOverlay(current) && selected.indexOf(current) === -1 ? current : null;
    const names = preview
      ? preview.map(buildStableSelector)
      : hovered ? [buildStableSelector(hovered)] : selected.map(buildStableSelector);
    nameLabel.textContent = names.join('  ·  ');
    nameLabel.style.display = names.length > 0 ? 'block' : 'none';
  };

  const paintHover = (el) => {
    // The dashed box follows the hand: what a click would take, and — while a press has
    // not moved yet — what a release would take, which is the same element either way, so
    // pressing must not make it disappear. It steps aside once the press has become a box
    // (the covered elements are outlined instead), on the overlay's own chrome, and on
    // something already selected — that one has a solid frame, and a second box there
    // would only say the same thing twice.
    const taken = el && !inOverlay(el) && selected.indexOf(el) === -1 && !(drag && drag.moved);
    if (!taken) {
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

  /**
   * Outline what a live box covers — the same dashed box the hover draws, one per
   * element, so a drag reads as "these are being taken" while it is still happening
   * rather than only once the hand comes up.
   */
  const drawPreview = (elements) => {
    previewLayer.textContent = '';
    for (const el of elements) {
      const r = el.getBoundingClientRect();
      const box = document.createElement('div');
      box.setAttribute('style', ${JSON.stringify(hoverBoxStyle)}
        + 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;');
      previewLayer.appendChild(box);
    }
  };

  /**
   * Draw the selection, and put the bar at the corner it belongs to.
   *
   * Each selected element gets a frame, the one control sits at the **union's
   * bottom-left corner** (so it reads as that selection's own button rather than as
   * chrome belonging to the page), and the name of what is selected is on the one chip
   * at the page's bottom-left — out of the way of everything.
   */
  const paint = () => {
    layer.textContent = '';
    hoverBox.style.display = 'none';
    selected = selected.filter((el) => el.isConnected && !inOverlay(el));

    // The bar is where the selection is handed to the conversation, so it exists
    // exactly while there is a selection to hand over.
    bar.style.display = WITH_BAR && selected.length > 0 ? 'flex' : 'none';
    paintName();
    if (selected.length === 0) return;

    // A box selection can hold several elements, so the bar hangs off the **union** of
    // what is selected — its bottom-left corner, just below the lowest frame when there
    // is room and just inside its bottom edge when there is not (a selection near the
    // foot of the page must not push the one control off screen). Never past the left
    // edge either.
    let union = null;
    for (const el of selected) {
      const r = el.getBoundingClientRect();
      union = union
        ? {
            left: Math.min(union.left, r.left),
            top: Math.min(union.top, r.top),
            right: Math.max(union.right, r.right),
            bottom: Math.max(union.bottom, r.bottom),
          }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      const frame = document.createElement('div');
      frame.setAttribute('style', ${JSON.stringify(frameStyle)}
        + 'display:block;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;');
      layer.appendChild(frame);
    }

    if (WITH_BAR && union) {
      const barHeight = bar.offsetHeight || 32;
      const below = union.bottom + 6;
      bar.style.left = Math.max(8, union.left) + 'px';
      bar.style.top =
        (below + barHeight <= window.innerHeight ? below : Math.max(8, union.bottom - barHeight - 6)) + 'px';
    }
  };

  /**
   * Hand the selection to the conversation.
   *
   * Every selected element, because the selection is the unit here. A click selects
   * one, so the ordinary "talk about this" case is one reference; boxing several and
   * adding them says "look at these".
   */
  const addToConversation = () => {
    const elements = selected.filter((el) => el.isConnected);
    if (elements.length === 0) return;
    for (const el of elements) state.picks.push(elementPayload(el));
  };

  /**
   * What the cursor is over, for the chip that previews "what a click would take".
   *
   * Never while a button is held: a press is the start of a selection, and naming
   * whatever the cursor passes over during one would replace the selection in the
   * person's reading with a trail of elements — and if the press itself was missed (a
   * page's own handler ran first), drag would be null and that is exactly what this
   * guard prevents.
   */
  const onMove = (e) => {
    if (drag || e.buttons) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el === current) return;
    current = el;
    paintHover(el);
  };

  /**
   * Whether an event belongs to the browser rather than to the mode.
   *
   * One place, and it is where the browser's own behaviour is the point: the overlay's
   * own chrome — its button is clicked, not selected. Everything else is the mode's.
   */
  const browserOwnsIt = (e) => inOverlay(e.target);

  /**
   * The mouse events behind the pointer events, refused the same way.
   *
   * A page is as likely to be listening to mousedown / mouseup as to pointerdown, and
   * those are separate events with separate listeners: a press the mode does not take
   * is a press the page still gets, and a double-click the page still gets selects its
   * text or follows its link. Nothing is acted on here — the pointer handlers do the
   * work — so this is only the refusal, with the same exception.
   */
  const swallowMouse = (e) => {
    if (e.button !== 0 || browserOwnsIt(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || browserOwnsIt(e)) return;
    e.preventDefault();
    e.stopPropagation();

    // A press is "this one": the chip keeps naming what it landed on and the dashed box
    // stays around it, because that is what a release without a drag will take and taking
    // either away at the moment of pressing says the wrong thing. They step aside only
    // when the press becomes a box. A press on an empty patch targets nothing (the same
    // rule a click follows), so the chip stays on the selection and no box is drawn.
    const target = document.elementFromPoint(e.clientX, e.clientY);
    current = target && !inOverlay(target) && target !== document.body && target !== document.documentElement ? target : null;
    drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false };
    preview = null;
    drawPreview([]);
    paintHover(current);
    drawMarquee();
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    if (Math.abs(drag.x1 - drag.x0) > 3 || Math.abs(drag.y1 - drag.y0) > 3) drag.moved = true;
    // A drag is a box from here on: the dashed hover goes away (it would be one element
    // out of several) and what the box is covering is outlined instead. The chip says the
    // same thing in words, while the hand is still down.
    if (drag.moved) {
      preview = within(rectOf(drag));
      hoverBox.style.display = 'none';
    } else {
      preview = null;
    }
    drawPreview(preview || []);
    paintName();
    drawMarquee();
  };

  const onPointerUp = (e) => {
    if (!drag) return;
    const box = rectOf(drag);
    const moved = drag.moved;
    drag = null;
    preview = null;
    drawPreview([]);
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

    // A drag is a box — the blocks it covers. A press that did not move is a click, and
    // a click asks about the element under the cursor, inline or not.
    //
    // With one exception: an empty patch of page resolves to body (or html), and taking
    // that would frame the whole document for what the person meant as "nothing here" —
    // so a click that lands on nothing clears the selection instead.
    if (moved) {
      selected = within(box);
    } else {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      selected = el && !inOverlay(el) && el !== document.body && el !== document.documentElement ? [el] : [];
    }
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
    if (browserOwnsIt(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish('cancelled');
  };

  const onViewportChange = () => {
    // Everything is drawn in viewport coordinates, so a scroll moves what a live box is
    // covering: the previews are recomputed along with the frames.
    if (drag && drag.moved) {
      preview = within(rectOf(drag));
      drawPreview(preview);
    }
    paintHover(current);
    paint();
  };

  function cleanup() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('mousedown', swallowMouse, true);
    window.removeEventListener('mouseup', swallowMouse, true);
    window.removeEventListener('click', swallowClick, true);
    window.removeEventListener('dblclick', onDblClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    // Leave nothing of ours on the page.
    const existing = document.getElementById('${OVERLAY_ID}');
    if (existing) existing.remove();
    try { delete window.${OVERLAY_CANCEL_KEY}; } catch (e) { window.${OVERLAY_CANCEL_KEY} = undefined; }
  }

  function finish(status) {
    cleanup();
    state.status = status;
  }

  addButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addToConversation();
  });

  // One way out, and it is the same one the window's crosshair asks for: the overlay
  // holds nothing of its own on the page, so leaving is leaving.
  window.${OVERLAY_CANCEL_KEY} = () => finish('cancelled');
  window.${OVERLAY_STATE_KEY} = state;

  // On **window**, in the capture phase, so the mode sees a gesture before the page
  // can: a page with its own pointerdown on window capture runs before anything on
  // document, and one that stops propagation there would otherwise swallow the press
  // whole — the overlay would draw no marquee, the page would act on the click, and the
  // chip would start naming whatever the held cursor passed over.
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('mousedown', swallowMouse, true);
  window.addEventListener('mouseup', swallowMouse, true);
  window.addEventListener('click', swallowClick, true);
  window.addEventListener('dblclick', onDblClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);
  paint();

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
  if (!state) return JSON.stringify({ status: 'missing', picks: [] });
  const picks = state.picks || [];
  state.picks = [];
  return JSON.stringify({
    status: state.status,
    picks: picks,
  });
})()`

const OVERLAY_CANCEL_EXPRESSION = `(() => { try { window.${OVERLAY_CANCEL_KEY} && window.${OVERLAY_CANCEL_KEY}(); } catch (e) {} })()`

/**
 * The bar's own word, in the window's language — the page has no i18n.
 *
 * Written on the button as well as used for hover and a screen reader: it is the one
 * thing the bar does.
 */
export interface OverlayLabels {
  /** Hand the selection to the conversation. */
  add: string
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
  /**
   * Whether the page is being told it is focused — the active page, in an active window.
   *
   * Session state like the init scripts: detaching drops it, which is why asking for it holds
   * the session ({@link holdsSessionState}). Asked for only while a conversation holds a tab
   * (`BrowserPaneManager.setHeldBy`), so a page is told this for no longer than the work: a
   * browser that is focused forever is not what a person's browser does, and it is the reading
   * a site takes when it wants to know whether somebody is actually there.
   */
  private focusEmulated = false
  /**
   * Whether `Page.enable` has been sent on this session.
   *
   * `Page.addScriptToEvaluateOnNewDocument` is answered without it — an identifier
   * comes back — but a registration made while the domain is **off** is inert: the
   * script is never run in a document created afterwards (measured on Electron 39:
   * register, reload, and the flag the script sets is still absent, with the
   * debugger attached throughout). So the domain is turned on once per session,
   * before the first registration, and forgotten on detach along with the
   * registrations it is what makes live.
   */
  private pageDomainEnabled = false

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
        // Not always our own `detach()`: a session can end because the page's renderer died.
        // (Opening DevTools does **not** end it on Electron 39 — measure in
        // `spike/anti-bot-fingerprint.ts` round 5.) Whoever ended it, everything registered
        // on it went with it, and this is the half of that which used to be forgotten.
        this.forgetSessionState()
      })
    }
  }

  /**
   * Persistent injections and focus emulation live in the CDP session: detaching
   * silently drops them. Hold the attachment while any is active; the idle timer
   * resumes once all are off.
   */
  private holdsSessionState(): boolean {
    return this.initScriptIds.size > 0 || this.focusEmulated
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
    this.forgetSessionState()
  }

  /**
   * Everything the session was holding — registrations, the domain that makes them live, the
   * focus the page was told about — went with it.
   *
   * One place, because both ends need it: our own {@link detach}, and a session ended from
   * outside (the renderer dying), which is the half that used to be forgotten. A flag left
   * standing is a reader answering for a page that has never heard of it, and the failures
   * that produces are all silent — a stale `pageDomainEnabled` makes the next
   * `addInitScript` skip `Page.enable`, so the registration is accepted and then never run.
   */
  private forgetSessionState(): void {
    this.initScriptIds.clear()
    this.pageDomainEnabled = false
    this.focusEmulated = false
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

  /**
   * Make the page read `document.hasFocus()` as `true` — and `visibilityState` as `visible` —
   * without moving or activating any window.
   *
   * A tab being driven from the background is exactly the case a site's own "is somebody
   * there?" check catches, and the honest answer to it here is `false`: the parking window a
   * background tab lives in is never activated (that is its whole job — see
   * `BrowserPaneManager.parkingWindowFor`), so the page is visible and unfocused. Measured
   * what the two ways of changing that cost (`spike/anti-bot-fingerprint.ts` round 2): this
   * one leaves the person's own window the focused one and the page reads `hasFocus: true`;
   * `webContents.focus()` reaches the same reading only by activating the window holding the
   * tab — which for a parked tab means handing the keyboard to a window nobody can see.
   *
   * Emulation, not a fact: it is set while a conversation holds the tab and cleared when it
   * lets go, so a page that stops being worked on goes back to answering for the window it is
   * really in.
   */
  async setFocusEmulation(enabled: boolean): Promise<void> {
    if (this.focusEmulated === enabled) return
    try {
      await this.send('Emulation.setFocusEmulationEnabled', { enabled })
    } catch (err) {
      // Turning it *off* and failing means the session is already gone, and the emulation went
      // with it — holding the session for a page that will never be told would hold it forever.
      if (!enabled) this.focusEmulated = false
      mainLog.warn(`[browser-cdp] focus emulation ${enabled ? 'on' : 'off'} ignored: ${String(err)}`)
      return
    }
    this.focusEmulated = enabled
    // `send` has just restarted the countdown against the value from *before* this call, so
    // this is the line that turns "one more command" into "for as long as it is on".
    this.resetIdleDetachTimer()
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
  // Element picker
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
    /** The bar's word, in the caller's language — the toolbar renderer has i18n. */
    labels?: Partial<OverlayLabels>
    /**
     * Draw the bar.
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
    if (typeof raw !== 'string') return { status: 'missing', picks: [] }

    try {
      const parsed = JSON.parse(raw) as {
        status?: string
        picks?: PickedElement[]
      }
      return {
        status: (parsed.status as OverlayReport['status']) ?? 'missing',
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
  }): Promise<PickedElement | null> {
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000)
    const pollMs = Math.max(50, options.pollMs ?? 200)

    await this.armOverlay({ accent: options.accent, bar: false, resident: false })

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

  /** Take the overlay down. Safe to call when none is mounted. */
  async teardownOverlay(): Promise<void> {
    try {
      await this.send('Runtime.evaluate', { expression: OVERLAY_CANCEL_EXPRESSION })
    } catch (err) {
      mainLog.debug(`[browser-cdp] teardownOverlay ignored: ${String(err)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent injection (survives reload / navigation)
  // ---------------------------------------------------------------------------

  /**
   * Register a script that runs in every new document, before the page's own
   * scripts — the mechanism behind "an injection outlives a reload".
   *
   * `key` is caller-chosen and re-registering the same key replaces the previous
   * script, so re-applying the same injection is idempotent.
   *
   * While any init script is registered the debugger is held attached, because
   * CDP drops these registrations when the session detaches — and the Page domain
   * has to be on, or the registration is accepted and then never run
   * ({@link enablePageDomain}).
   */
  async addInitScript(key: string, source: string): Promise<string> {
    await this.enablePageDomain()
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

  /**
   * Turn the Page domain on, once per session.
   *
   * Without it `Page.addScriptToEvaluateOnNewDocument` is a registration nothing
   * reads back: the script runs in no document at all, which is indistinguishable
   * from a patch that changed nothing ({@link pageDomainEnabled} for the
   * measurement). Done here rather than at attach time so that the domains this
   * session uses stay the ones its features need.
   */
  private async enablePageDomain(): Promise<void> {
    if (this.pageDomainEnabled) return
    await this.send('Page.enable')
    this.pageDomainEnabled = true
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
