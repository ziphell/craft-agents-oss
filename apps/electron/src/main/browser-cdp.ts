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
import type { MockRoute } from '@craft-agent/shared/prototypes'
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
  request?: { url?: string; method?: string }
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
 * Injected picker: highlights the element under the cursor and turns the user's
 * click into a stable selector. It reports into `PICKER_STATE_KEY` rather than
 * resolving a long-lived promise, so the caller can poll with short CDP calls
 * and the idle-detach timer never fires mid-pick.
 *
 * Injected through CDP, so it is unaffected by the page's CSP and needs no
 * `webPreferences` changes (stays sandboxed).
 */
function buildPickerInjectScript(options: {
  /** Show the "add to conversation" bar under the highlight. */
  addToConversation: boolean
  /** Its label, in the caller's language — the toolbar owns the i18n, not this. */
  addLabel: string
  /**
   * Stay armed after a pick.
   *
   * One pick is what the agent asks for (`browser_tool pick`), but a person who
   * turned the mode on is picking *elements*, plural, and moving between pages
   * while they do it: the overlay stays, every click is reported, and the mode
   * ends when they say so (Escape here, or the toolbar button) — plan §12.7.
   */
  resident: boolean
}): string {
  // The bar is only built when there is a conversation to add to: a button that
  // cannot do anything is worse than no button at all.
  const barMarkup = options.addToConversation
    ? `
  const bar = document.createElement('div');
  bar.setAttribute('style', 'position:fixed;display:none;align-items:center;padding:4px 6px;border-radius:8px;background:rgba(15,23,42,0.95);box-shadow:0 2px 10px rgba(0,0,0,0.35);pointer-events:auto;');
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.textContent = ${JSON.stringify(options.addLabel)};
  addButton.setAttribute('style', 'all:unset;cursor:pointer;padding:3px 10px;border-radius:6px;background:rgb(59,130,246);color:#fff;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;white-space:nowrap;');
  bar.appendChild(addButton);
  root.appendChild(bar);
`
    : ''

  const barPosition = options.addToConversation
    ? `
    bar.style.display = 'flex';
    bar.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 190)) + 'px';
    bar.style.top = Math.max(4, Math.min(r.bottom + 6, window.innerHeight - 34)) + 'px';
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
    const el = current;
    if (!el) { finish('cancelled'); return; }
    const r = el.getBoundingClientRect();
    report({
      selector: buildStableSelector(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.textContent || '').trim().slice(0, 200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      intent: 'add-to-conversation',
    });
  });
`
    : ''

  return `(() => {
  try { window.${PICKER_CANCEL_KEY} && window.${PICKER_CANCEL_KEY}(); } catch (e) {}

  const root = document.createElement('div');
  root.id = '${PICKER_OVERLAY_ID}';
  root.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;');

  const box = document.createElement('div');
  box.setAttribute('style', 'position:fixed;display:none;border:2px solid rgba(59,130,246,0.95);background:rgba(59,130,246,0.12);border-radius:4px;pointer-events:none;');
  root.appendChild(box);

  const label = document.createElement('div');
  label.setAttribute('style', 'position:fixed;display:none;padding:2px 6px;border-radius:6px;font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:rgba(15,23,42,0.92);color:#fff;pointer-events:none;max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
  root.appendChild(label);${barMarkup}

  document.documentElement.appendChild(root);

  const buildStableSelector = (el) => {
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
  };

  let current = null;

  // The picker's whole outward state: what it has picked, and whether it is still
  // armed. Written into the window key at the end of this script, where the caller
  // polls it — and kept out of cleanup(), so the final status is still readable
  // after the overlay is gone.
  const state = { status: 'pending', picks: [] };

  const paint = (el) => {
    if (!el) { box.style.display = 'none'; label.style.display = 'none'; ${barHide} return; }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    label.style.display = 'block';
    label.style.left = r.left + 'px';
    label.style.top = Math.max(4, r.top - 22) + 'px';
    label.textContent = buildStableSelector(el);${barPosition}
  };

  const onMove = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== current) { current = el; paint(el); }
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
    const r = el.getBoundingClientRect();
    report({
      selector: buildStableSelector(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: (el.textContent || '').trim().slice(0, 200),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    });
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish('cancelled'); }
  };

  const onViewportChange = () => { if (current) paint(current); };

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

export interface BrowserPageAction {
  /** `click` | `type` | `key` | `navigate`. */
  kind: string
  /** What it acted on — a key, an address, some text, or coordinates. */
  target: string
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
  // CDP `Fetch.enable` state plus the route table served while it is on.
  private fetchMockEnabled = false
  private fetchMockRoutes: MockRoute[] = []
  private debuggerMessageListenerRegistered = false

  /**
   * Told about every action taken on the page, read off the CDP traffic.
   *
   * Set by the pane manager while a frame capture is running. One hook rather than
   * one report per verb, because every way of acting on a page goes through
   * `Input.*` or `Page.navigate`: clicks, typing, selecting and dragging are all
   * covered without any of them having to remember to say so (plan §20.3).
   */
  onAction?: (action: BrowserPageAction) => void

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
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<any> {
    await this.ensureAttached()
    try {
      const result = await this.webContents.debugger.sendCommand(method, params)
      this.reportAction(method, params)
      return result
    } finally {
      // Keep detach countdown tied to completed calls so we do not detach mid-flight.
      this.resetIdleDetachTimer()
    }
  }

  /**
   * Turn a CDP call into "what somebody did", for the frame capture.
   *
   * Only after the call succeeded: a frame whose caption is an action that never
   * happened would be a lie about the cause, which is the one thing these frames
   * are for. Deliberate silence is fine — most CDP traffic is not an action, and
   * the list below is the whole of what counts as one.
   */
  private reportAction(method: string, params?: Record<string, unknown>): void {
    const listener = this.onAction
    if (!listener) return

    if (method === 'Page.navigate') {
      listener({ kind: 'navigate', target: String(params?.url ?? '') })
      return
    }
    if (method === 'Input.insertText') {
      listener({ kind: 'type', target: String(params?.text ?? '').slice(0, 40) })
      return
    }
    if (method === 'Input.dispatchKeyEvent') {
      // Only a press: keyUp doubles every keystroke, and `char` events are text.
      if (params?.type !== 'keyDown') return
      const key = typeof params.key === 'string' ? params.key : ''
      if (key.length > 1) listener({ kind: 'key', target: key })
      return
    }
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') {
      const button = typeof params.button === 'string' ? params.button : 'left'
      const clicks = Number(params.clickCount ?? 1)
      const x = Math.round(Number(params.x ?? 0))
      const y = Math.round(Number(params.y ?? 0))
      listener({ kind: 'click', target: `${button}${clicks > 1 ? ` ×${clicks}` : ''} at ${x},${y}` })
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
     * Show the "add to conversation" bar under the highlight.
     *
     * Decided by the caller, not here: whether there is a conversation to add to
     * is a fact about the window, and this class only knows about the page.
     */
    addToConversation?: boolean
    /** The bar's label, in the caller's language. */
    addLabel?: string
    /** Keep picking after a pick — see `buildPickerInjectScript`. */
    resident?: boolean
  }): Promise<void> {
    // The bar's markup is built here rather than in the page, and the injection
    // goes through CDP so the page's CSP is not in the way.
    const script = buildPickerInjectScript({
      addToConversation: options.addToConversation === true,
      addLabel: options.addLabel ?? 'Add to conversation',
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
  async pickElement(options?: {
    timeoutMs?: number
    pollMs?: number
    addToConversation?: boolean
    addLabel?: string
  }): Promise<PickedElement | null> {
    const timeoutMs = Math.max(1_000, options?.timeoutMs ?? 120_000)
    const pollMs = Math.max(50, options?.pollMs ?? 200)

    await this.armPicker({
      addToConversation: options?.addToConversation === true,
      ...(options?.addLabel ? { addLabel: options.addLabel } : {}),
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
   * Serve `routes` for matching requests.
   *
   * Interception happens in the browser's network stack, so it covers `fetch`,
   * `XMLHttpRequest` (axios) and every other resource type, without patching any
   * page globals and without the app having to point at a mock server.
   *
   * Like init scripts this is CDP session state, so the debugger is held
   * attached while it is active.
   */
  async setFetchMockRoutes(routes: MockRoute[]): Promise<number> {
    this.fetchMockRoutes = routes.map((route) => ({ ...route, method: route.method.toUpperCase() }))

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

  /**
   * Match on pathname only, so it works whether the app calls the mock with an
   * absolute URL, a baseUrl-prefixed URL, or a same-origin relative path.
   * The leading `/` in the route path keeps `endsWith` boundary-safe.
   */
  private matchFetchMockRoute(method: string, url: string): MockRoute | null {
    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch {
      // Not an absolute URL — fall back to the raw value.
    }

    for (const route of this.fetchMockRoutes) {
      if (route.method !== method) continue
      if (pathname === route.path || pathname.endsWith(route.path)) return route
    }

    return null
  }

  private async handlePausedRequest(params: CdpPausedRequest): Promise<void> {
    const requestId = params.requestId
    if (!requestId) return

    const url = String(params.request?.url ?? '')
    const method = String(params.request?.method ?? 'GET').toUpperCase()
    const route = this.matchFetchMockRoute(method, url)

    try {
      if (!route) {
        await this.send('Fetch.continueRequest', { requestId })
        return
      }

      await this.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: route.status,
        responseHeaders: [
          { name: 'content-type', value: 'application/json' },
          // Cross-origin API calls would otherwise be blocked by CORS even
          // though we are the ones answering them.
          { name: 'access-control-allow-origin', value: '*' },
          { name: 'x-craft-mock', value: '1' },
        ],
        body: Buffer.from(JSON.stringify(route.body ?? null)).toString('base64'),
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
