/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */

import { join, parse as parsePath } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { BrowserView, BrowserWindow, app, ipcMain, nativeTheme, session, shell, type Session as ElectronSession } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { BrowserCDP, type AccessibilitySnapshot, type ElementGeometry } from './browser-cdp'
import { pickVideoFile as pickVideoFileWithDialog, sampleVideoFrames } from './video-frames'
import {
  type BrowserEmptyStateLaunchPayload,
  type BrowserEmptyStateLaunchResult,
  type BrowserInstanceInfo,
} from '../shared/types'
import { DEFAULT_THEME, loadAppTheme, getAllowRemoteEvaluate } from '@craft-agent/shared/config'
import { CodedError, RPC_CHANNELS, describeWork, sameWork } from '@craft-agent/shared/protocol'
import type { PickedElement, PickedElementOrigin, BrowserToolbarAction, BrowserTabSummary, TabBelongsTo } from '@craft-agent/shared/protocol'
import type { MockProgram } from '@craft-agent/shared/prototypes'
import { getBrowserLiveFxCornerRadii } from '../shared/browser-live-fx'
import type {
  IBrowserPaneManager,
  BrowserInstanceSnapshot,
} from '@craft-agent/server-core/handlers'
import type {
  BrowserCapabilityRequest,
  ScreenshotResultWire,
} from '@craft-agent/server-core/transport'

export type { BrowserInstanceInfo }

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const TOOLBAR_LOAD_MAX_RETRIES = 4
const TOOLBAR_LOAD_RETRY_DELAY_MS = 500
/**
 * The toolbar's own height: the row with the address bar and the window's buttons.
 *
 * That row is a `BrowserView` at the top of the window, and every layout in this
 * file has to agree with it — the page starts below it, the overlay is inset by
 * it, `window-resize` adds it back. Which is why its height is one constant
 * rather than a number written out where it is needed.
 */
const TOOLBAR_HEIGHT = 48
/**
 * The page rail's width: the strip of pages down the window's left edge.
 *
 * The pages are a **column, not a row**, so the chrome takes its room from the
 * window's width instead of its height: a page keeps every pixel of height it had
 * (which is what a prototype's layout, a screenshot and the agent's viewport all
 * care about), and the rail is where a person's `+`, the page chips and their close
 * buttons live. A row across the top ate the page's height and its own content
 * scrolled sideways, which is how it ended up unusable (plan §22).
 */
const PAGE_RAIL_WIDTH = 200
const MAX_CONSOLE_LOG_ENTRIES = 500
const MAX_NETWORK_LOG_ENTRIES = 500
const MAX_DOWNLOAD_LOG_ENTRIES = 200
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_POLL_MS = 100
const SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS = 3

/**
 * Frame capture defaults (plan §20.3).
 *
 * A capture has two samplers with different jobs, and both need bounds: four
 * comparisons a second is fast enough that a streaming answer leaves a trail,
 * and slow enough that it is not a video encoder; a ceiling per capture is what
 * keeps a forgotten recording from filling a disk.
 */
const FRAME_CAPTURE_INTERVAL_MS = 400
const FRAME_CAPTURE_MIN_INTERVAL_MS = 100
const FRAME_CAPTURE_THRESHOLD = 0.005
const FRAME_CAPTURE_MAX_FRAMES = 60
const FRAME_CAPTURE_JPEG_QUALITY = 70
/** How long after an action the "what it produced" frame is taken. */
const FRAME_CAPTURE_RESULT_DELAY_MS = 350
/** Every 16th pixel — see {@link changedRatio}. */
const FRAME_CAPTURE_SAMPLE_STEP_BYTES = 64

/**
 * Share of the sampled screen that differs between two frames.
 *
 * Sampled rather than compared pixel by pixel: a 1280×800 window is 4 MB of BGRA
 * per frame, and the question is only "did the screen move". Reading every 16th
 * pixel answers it, at a cost small enough to run four times a second.
 */
function changedRatio(previous: Buffer, current: Buffer): number {
  if (previous.length === 0 || previous.length !== current.length) return 1

  let sampled = 0
  let changed = 0
  for (let offset = 0; offset < current.length; offset += FRAME_CAPTURE_SAMPLE_STEP_BYTES) {
    sampled += 1
    if (previous[offset] !== current[offset]) changed += 1
  }
  return sampled === 0 ? 0 : changed / sampled
}

/** One capture session, held in memory until it is stopped. */
interface FrameCaptureState {
  startedAt: string
  /** The page whose frames are kept: a recording follows the page it was started on. */
  tabId: string
  intervalMs: number
  threshold: number
  maxFrames: number
  /** Size of the first frame, in device pixels. */
  viewport: { width: number; height: number } | null
  /** Set once the ceiling was reached: what came back is a sample of the session. */
  truncated: boolean
  frames: Array<{
    index: number
    at: string
    url: string
    reason: 'start' | 'changed' | 'action' | 'result'
    action?: string
    bytes: Buffer
  }>
  /** The previous frame's pixels, which is what the next one is compared against. */
  lastBitmap: Buffer | null
  /** Set while a capture is in flight, so a slow one cannot stack behind itself. */
  capturing: boolean
  timer: ReturnType<typeof setInterval> | null
}
const SCREENSHOT_RETRY_DELAY_MS = 120
const SCREENSHOT_RESCUE_PAINT_DELAY_MS = 180
const SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 1_000
const SCREENSHOT_NETWORK_IDLE_MS = 300
const THEME_COLOR_SIGNAL_PREFIX = '__craft_theme_color__:'
const THEME_COLOR_NULL_SENTINEL = '__NULL__'
const THEME_OBSERVER_MIN_INTERVAL_MS = 120
const EARLY_THEME_EXTRACTION_DELAY_MS = 100
const BROWSER_EMPTY_STATE_PAGE = 'browser-empty-state.html'
const CRAFT_DEEPLINK_SCHEME_PREFIX = `${process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'}://`

/**
 * A load that a **newer navigation aborted**, as opposed to one that failed.
 *
 * `ERR_ABORTED` (`errno: -3`) is what Chromium reports when something else took
 * the WebContents over — creating a window and pointing it somewhere in the same
 * breath does exactly that to the empty-state page.
 *
 * Electron delivers that abort to whichever `loadURL` promise is *current*, not
 * to the one that was superseded, so a navigation that succeeded rejects with the
 * **previous** document's abort. Read as a failure it says "navigate failed"
 * about a page that is on screen — and the two fields that would identify it are
 * empty in practice (`{"errno":-3,"code":"","url":"file:///…/browser-empty-state.html"}`),
 * so `errno` is the one to match on. See dev notes §3.3.
 *
 * Returns the URL the aborted load was for, or null when this is a real failure.
 */
function abortedLoad(error: unknown): { url: string | null } | null {
  const fields = error as { errno?: number; code?: string; url?: string } | null
  const message = error instanceof Error ? error.message : ''
  const aborted = fields?.errno === -3 || fields?.code === 'ERR_ABORTED' || message.includes('ERR_ABORTED')
  return aborted ? { url: fields?.url ?? null } : null
}

/**
 * Whether two addresses are on the same host.
 *
 * Host, not origin: the scheme and port are ours to know, and a document served
 * by the prototype's own server is "inside" it whatever path it is on. Anything
 * unparsable (about:blank, a failed load) is not a match.
 */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host
  } catch {
    return false
  }
}

const THEME_COLOR_EXTRACTOR_FN = String.raw`
() => {
  const toHex = (r, g, b) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

  const parseColor = (str) => {
    if (!str) return null;
    str = str.trim();
    const hm = /^#([0-9a-f]{3,8})$/i.exec(str);
    if (hm) {
      const h = hm[1];
      let r, g, b;
      if (h.length === 3) { r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16); }
      else if (h.length >= 6) { r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
      else return null;
      return toHex(r, g, b);
    }
    const rm = str.match(/rgba?[\(]\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (rm) return toHex(+rm[1], +rm[2], +rm[3]);
    return null;
  };

  const parseBg = (el) => {
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return null;
    return parseColor(bg);
  };

  // 1. theme-color meta — respect media attribute for light/dark
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    const media = m.getAttribute('media');
    if (media && !window.matchMedia(media).matches) continue;
    const c = parseColor(m.content);
    if (c) return c;
  }

  // 2. Safari-like approach: sample fixed/sticky elements at viewport top-center
  const els = document.elementsFromPoint(window.innerWidth / 2, 4);
  for (const el of els) {
    if (el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.8) continue;
    const c = parseBg(el);
    if (c) return c;
  }

  // 3. Fallback: body then html
  return parseBg(document.body) || parseBg(document.documentElement) || null;
}
`

/** IPC channels for the browser toolbar preload */
const TOOLBAR_CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  MENU_GEOMETRY: 'browser-toolbar:menu-geometry',
  FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  PICK_ELEMENT: 'browser-toolbar:pick-element',
  CANCEL_PICK: 'browser-toolbar:cancel-pick',
  APPLY_PROTOTYPE: 'browser-toolbar:apply-prototype',
  TABS: 'browser-toolbar:tabs',
} as const
export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane'
const SESSION_PARTITION = BROWSER_PANE_SESSION_PARTITION

/**
 * How often an armed picker is asked whether anything was picked.
 *
 * Short enough that a pick lands while the user is still looking at the element
 * they clicked, long enough to be nothing next to the page's own work. Each poll
 * is also what keeps the CDP session attached for as long as the mode is on.
 */
const PICKER_POLL_MS = 250

/**
 * How many polls in a row may come back with nothing usable before the mode ends.
 *
 * A page that is navigating refuses calls for a moment, which is normal and the
 * loop rides it out; a page that keeps doing it — a redirect loop, a wedged view —
 * is not something to keep asking four times a second, and saying so beats leaving
 * a mode on that can never report anything.
 */
const PICKER_MAX_CONSECUTIVE_FAILURES = 4

/**
 * What one conversation at the browser is doing, for the overlay's chip.
 *
 * Per conversation rather than per window (plan §22, Conductor): several conversations
 * work in one window at the same time, each on its own page, so "what is being done"
 * has one answer per session — see {@link BrowserInstance.controlBy}.
 */
interface AgentControlLabel {
  displayName?: string
  intent?: string
}

/**
 * One page of a window.
 *
 * A window shows exactly one tab at a time, and everything that is a fact about
 * *what is being shown* lives here rather than on the window: the view, its CDP
 * session, the address, the title, the console, and — the reason this type exists
 * — **which prototype the page is**. A window used to carry that identity, which
 * is what made "one window, one prototype, one page" structural; moving it here is
 * what lets one window hold several pages at once (plan §22).
 *
 * Deliberately not a "browser tab" in the chrome sense: nothing here is about
 * ordering, pinning or persistence. It is the unit the agent addresses.
 */
interface BrowserTab {
  id: string
  pageView: BrowserView
  nativeOverlayView: BrowserView
  cdp: BrowserCDP
  currentUrl: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /**
   * The prototype this page belongs to, if it was opened for one.
   *
   * Stated at open time rather than read off the page: an overlay's view sits on a
   * third-party address, so once it loads, nothing in the URL says which prototype
   * is being worked on. The session chain (see {@link prototypeBindingFor}) covers
   * pages a session happened to open; this covers the case that matters most — a
   * prototype opened from its own page, which may have no conversation at all yet.
   *
   * Written once, when the page is created: opening a prototype gives it a page of
   * its own rather than re-pointing the one on screen (plan §22), so there is no
   * rebinding to be had. Wandering off with a normal navigation does not unbind it
   * either — the page is still the prototype's, and "apply it to whatever is here"
   * is a legitimate thing to want.
   */
  boundPrototype: PrototypeWindowBinding | null
  /**
   * The **work this page is part of** — whose page it is, or `null` for a person's.
   *
   * Written by whoever created it (a person through the toolbar or the panel, or the agent
   * through `tab-new`/`prototype-open`) and inherited by pages derived from it; nothing
   * rewrites it afterwards (plan §22, 第十一轮). It lives here rather than being inferred
   * because an agent has to leave other people's pages alone, and no URL says which ones
   * those are.
   *
   * It is the **work** rather than the conversation (plan §22): a page outlives the session
   * that opened it, so a DAG node's page says which task and which node it is for and a
   * re-run of that node inherits it instead of orphaning it. Which conversation is on the
   * page right now is the lease's answer ({@link driverSessionId}, {@link heldBy}).
   *
   * `openedBy: 'user' | 'agent'` is a rendering of this, produced where words are needed
   * (`toTabSummary`, the agent's `tabs` output) rather than stored as well.
   */
  belongsTo: TabBelongsTo | null
  /**
   * Which session is working on this page **now**, or `null` when nobody is.
   *
   * A lease of its own, refreshed by the same event that renews the window's: a
   * command resolves the window, which brings the page it will act on to the front,
   * and that page records the driver. One page at a time — the window showing a page
   * is what makes it the page a command is about.
   */
  driverSessionId: string | null
  /**
   * The page a conversation **works from** — its cursor, or `null` when this page is
   * no conversation's.
   *
   * One page per conversation, which is why it lives on the page: "where does my next
   * command go when I name no page" has to have exactly one answer, and the answer must
   * not be "wherever the window happens to be showing" — that is the person's cursor, and
   * it moves whenever they click (plan §22, 第十轮).
   *
   * Sticky across turns, unlike {@link driverSessionId} (a lease the turn releases): a
   * conversation that comes back after its turn ended still works from the same page.
   * Moved only by a command that names a page or resolves to one, and only by that
   * conversation's own commands — the person switching pages does not move it.
   */
  cursorOf: string | null
  /**
   * Which session is holding this page **right now**, or `null` when nobody is — the page
   * lock (plan §22, 第九轮).
   *
   * Stated rather than derived: the page is claimed when a command says it is the one being
   * worked on, and let go when that turn ends or the person takes it back. A held page takes
   * no input from a person, and another conversation's commands that name it are refused —
   * while the chrome, the other pages and the window itself stay usable.
   *
   * **Per page, because several conversations work in one window at once** (plan §22,
   * Conductor): a DAG's child sessions run in parallel, each on its own page. One slot per
   * window would mean the second conversation to start silently dropped the first one's
   * lock — which is exactly what parallel children ran into.
   */
  heldBy: string | null
  /**
   * How this page came to exist, when the browser asked for it rather than a command
   * doing so.
   *
   * `'link'` for a `target="_blank"` (or any click that wants a window of its own),
   * `'popup'` for a scripted `window.open` with features — the OAuth-window shape.
   * `null` for every other way a page is opened (the address bar, `tab-new`,
   * `prototype-open`, the panel).
   *
   * Recorded because both are now played in the same window, which has one cost worth
   * being able to name: a page opened this way has no `window.opener`, so a popup that
   * expects to `postMessage` back at the page that opened it (Google's sign-in is the
   * usual example) cannot. Reading the page's own report is not enough — the browser
   * said how it was requested, and only here is that kept (plan §22).
   */
  disposition: 'link' | 'popup' | null
  nativeOverlayReady: boolean
  themeColor: string | null
  inPageThemeTimer: ReturnType<typeof setTimeout> | null
  themeObserverToken: string | null
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
  downloads: BrowserDownloadEntry[]
}

interface BrowserInstance {
  id: string
  window: BrowserWindow
  /** The address bar, across the top of the window. */
  toolbarView: BrowserView
  /**
   * The page rail, down the left edge — the pages, vertically (plan §22).
   *
   * Its own view rather than part of the address bar's: one `BrowserView` is one
   * rectangle, and the chrome is an L (a column and a row). Both are chrome and both
   * stay above the page, so neither can be covered by it.
   */
  railView: BrowserView
  /**
   * The window's pages, in the order they were opened.
   *
   * Always at least one: a window with no pages is closed rather than left empty
   * (see `closeTab`). `activeTabId` names the one on screen; everything the rest
   * of this file calls "the window's address/title/console/prototype" is read
   * through {@link activeTab}, so a reader that says `activeTab(i).currentUrl` is
   * asking about the page the user is looking at.
   */
  tabs: BrowserTab[]
  activeTabId: string
  /**
   * The address and title of the page on screen — read-only window-level views of
   * the active tab.
   *
   * They exist because the rest of the app asks about *windows* (the toolbar's
   * state, and `BrowserInstanceSnapshot` in the server-side interface), and those
   * questions deserve the same answer this file uses internally rather than a
   * second copy that could drift. Read-only so the only way to change either is to
   * change the page: a writer that tries `instance.currentUrl = …` gets a compile
   * error pointing at the tab instead of an assignment that goes nowhere.
   */
  readonly title: string
  readonly currentUrl: string
  /**
   * The workspace whose browser window this is — the one every conversation in
   * that workspace, and the user, work in (plan §22), or `null` for a window
   * opened with no workspace context. Renderers in other workspaces filter such
   * entries out of the tab strip / status badge.
   *
   * Stamped at create-time and never rewritten, and it is the **whole** of the
   * window's identity: there is one window per workspace, so this is what keeps
   * two workspaces' windows apart and what every reach check is made against
   * (`instanceBelongsToWorkspace`). No session owns a window, and none is named
   * here: who is working in it is per page (`BrowserTab.cursorOf` / `heldBy`),
   * because a parent and its children can be in it at once (Conductor).
   *
   * A window's scope rather than its purpose: the same one is where a general
   * task's browsing happens, and most of its pages have no prototype behind them.
   */
  workspaceId: string | null
  isVisible: boolean
  isHiding: boolean
  keepAliveOnWindowClose: boolean
  toolbarReady: boolean
  toolbarMenuOpen: boolean
  toolbarMenuHeight: number
  toolbarMenuOverlayActive: boolean
  showOnCreate: boolean
  pendingShowOnReady: boolean
  pendingShowToken: number
  lastAction: LastBrowserAction | null
  /**
   * Which conversations have their overlay up in this window right now, and what each said
   * it is doing — keyed by session, in the order they started.
   *
   * A map rather than the single slot this used to be (plan §22, Conductor): one window is
   * shared, and a parent's child sessions run in parallel, each holding its own page. The
   * lock lives on the page (`BrowserTab.heldBy`); this is only "who is working here and
   * what they are doing", which is what the overlay chip renders.
   */
  controlBy: Map<string, AgentControlLabel>
  lastLaunchToken: string | null
  /**
   * Whether the element picker is **armed on this window** (plan §12.7).
   *
   * A window's mode rather than a page's, because the mode is what the user turned
   * on: they keep picking while they move between pages, so the picker is re-armed
   * on whatever page comes to the front, and each pick carries the page it came
   * from. One pick does not end it — that is what "resident" means here — so it
   * ends when the user says so (Escape in the page, or the toolbar button).
   */
  picking: boolean
  /** The label the injected bar shows — the toolbar's language, kept for re-arming. */
  pickLabel: string
  /**
   * Which page the picker is armed on, or `null` while the mode is off.
   *
   * Kept because the page that has to be disarmed is the one the overlay is on,
   * and by the time a loop is torn down the page on screen may be a different one
   * — the page left behind would otherwise keep swallowing the user's clicks.
   */
  pickTabId: string | null
  /**
   * Which arming the running pick loop belongs to.
   *
   * Bumped whenever the loop is superseded (a different page came forward, the mode
   * was turned off), so a loop that comes back after being torn down can tell that
   * it is no longer the one holding the window — and report nothing instead of
   * mistaking its own teardown for the user giving up.
   */
  pickerGeneration: number
}

/**
 * The page on screen — the one everything window-level means.
 *
 * Throwing rather than returning a fallback: a window always has at least one tab
 * (they are created together, and closing the last one closes the window), so a
 * missing active tab is a bug in this file, and silently reading `undefined` would
 * turn it into a mystery three frames away.
 */
function activeTab(instance: BrowserInstance): BrowserTab {
  const tab = instance.tabs.find((candidate) => candidate.id === instance.activeTabId) ?? instance.tabs[0]
  if (!tab) throw new Error(`[browser-pane] instance ${instance.id} has no tabs`)
  return tab
}

/** A tab by id, or undefined — for the callers that are allowed to miss. */
function tabById(instance: BrowserInstance, tabId: string | null | undefined): BrowserTab | undefined {
  if (!tabId) return undefined
  return instance.tabs.find((candidate) => candidate.id === tabId)
}


interface CreateBrowserInstanceOptions {
  show?: boolean
  workspaceId?: string | null
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements from accessibility tree */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

/**
 * The prototype a browser window belongs to, as its own address says it.
 *
 * `origin` is the prototype's *own* origin (`http://<slug>-<hash>.localhost`),
 * which is what the window's address bar shows — including for an overlay, whose
 * view is on the third-party page it patches. `slug` is pushed alongside so the
 * toolbar can name the prototype without parsing a URL.
 */
export interface PrototypeWindowBinding {
  slug: string
  origin: string
}

/**
 * What a prototype address names, once it has been looked up: the prototype, and
 * which of its pages the address is — `page` null means the address *is* the
 * prototype's root, which stands for the prototype itself rather than for a page.
 *
 * The two come back together because they answer one question from one lookup:
 * what should this window show, and what should its bar keep saying.
 */
export interface PrototypeAddressTarget {
  binding: PrototypeWindowBinding
  page: string | null
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserConsoleOptions {
  level?: 'all' | BrowserConsoleEntry['level']
  limit?: number
}

export interface BrowserScreenshotRegionTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserWaitResult {
  ok: true
  kind: BrowserWaitArgs['kind']
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: 'started' | 'completed' | 'interrupted' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: {
    mode: 'raw' | 'agent'
    viewport?: {
      width: number
      height: number
      dpr: number
      scrollX: number
      scrollY: number
    }
    targets?: Array<{
      ref: string
      role?: string
      name?: string
      box: { x: number; y: number; width: number; height: number }
      clickPoint: { x: number; y: number }
    }>
    action?: {
      tool: string
      ref?: string
      status: 'succeeded' | 'failed'
      timestamp: number
    }
    annotationPartial?: boolean
    warnings?: string[]
    region?: {
      x: number
      y: number
      width: number
      height: number
    }
    targetMode?: 'coords' | 'ref' | 'selector'
  }
}

interface LastBrowserAction {
  tool: string
  ref?: string
  status: 'succeeded' | 'failed'
  geometry?: ElementGeometry
  timestamp: number
}

let instanceCounter = 0
/**
 * Tab ids are unique across the app rather than per window, because a tab is what
 * the agent addresses: one name for one page, with no "of which window" to carry
 * alongside it (the window is already implied by the tab).
 */
let tabCounter = 0

export class BrowserPaneManager implements IBrowserPaneManager {
  private instances: Map<string, BrowserInstance> = new Map()
  private destroyingIds: Set<string> = new Set()
  private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null
  private removedCallback: ((id: string) => void) | null = null
  private interactedCallback: ((id: string) => void) | null = null
  private partitionPermissionsInitialized = false
  private partitionObserversInitialized = false
  private inFlightRequestsByWebContentsId = new Map<number, number>()
  private lastNetworkActivityByWebContentsId = new Map<number, number>()
  private windowManager: WindowManager | null = null
  private sessionPathResolver: ((sessionId: string) => string | null) | null = null
  /**
   * Which prototype a window's session is working on, asked per toolbar state
   * push. Injected because this manager owns windows, not conversations (see
   * main/index.ts).
   *
   * Two things come out of it, and they are the same fact twice: the window's
   * address bar reads as the prototype's own origin — even for an overlay, whose
   * page is a third-party address the view keeps loading — and the toolbar's two
   * prototype actions exist only when there is a prototype to act on. Deriving
   * both from one lookup is what keeps the address and the affordances from
   * disagreeing (plan §7: an entry point's precondition is shown before the
   * click, not answered after it).
   */
  private prototypeWindowResolver: ((sessionId: string) => PrototypeWindowBinding | null) | null = null
  /**
   * Which prototype an address names — and which of its pages, when it names one.
   * Also injected (see main/index.ts), and used for the opposite direction: a
   * *typed* address.
   *
   * A prototype's root is not a page you can navigate to (a live page has nothing
   * there at all), so typing it asks for the prototype rather than for that URL.
   * A page's own address (`/<name>`, plan §19.3) does have something to load, and
   * the answer is where: the caller resolves it here and loads *that*, instead of
   * handing the view an address the host would have to redirect — the bar is a
   * display of where the window is, not a request.
   *
   * Only prototypes this host has actually served are known, which is the same set
   * whose addresses it handed out.
   */
  private prototypeAddressResolver: ((url: string) => PrototypeAddressTarget | null) | null = null
  /**
   * Which **page** of a prototype a window is on, given its real address. Also
   * injected (see main/index.ts).
   *
   * The address bar cannot read this off the URL: an overlay page's address is a
   * third-party one, and only the prototype's page table knows that
   * `https://app.example.com/checkout/pay` is the page called `pay`. That name is
   * what makes the bar useful for an overlay — it can say which page you are on,
   * and typing it back returns you to that page instead of to the flow's entry.
   */
  private prototypePageResolver: ((slug: string, origin: string, url: string) => string | null) | null = null
  /**
   * What to call a conversation, for the page rail's group headers. Also injected
   * (see main/index.ts).
   *
   * A page says who opened it by **session id**, and an id is not something a person
   * can tell one conversation from another by. This is a *name for a group*, not a
   * second owner: the grouping reads `belongsTo` and nothing here can change
   * it. `null` for a session that is gone or has no name yet, and the chrome falls
   * back to a generic label rather than showing an id.
   */
  private sessionLabelResolver: ((sessionId: string) => string | null) | null = null

  setWindowManager(windowManager: WindowManager): void {
    this.windowManager = windowManager
  }

  setSessionPathResolver(fn: (sessionId: string) => string | null): void {
    this.sessionPathResolver = fn
  }

  setPrototypeWindowResolver(fn: (sessionId: string) => PrototypeWindowBinding | null): void {
    this.prototypeWindowResolver = fn
  }

  setPrototypeAddressResolver(fn: (url: string) => PrototypeAddressTarget | null): void {
    this.prototypeAddressResolver = fn
  }

  setPrototypePageResolver(fn: (slug: string, origin: string, url: string) => string | null): void {
    this.prototypePageResolver = fn
  }

  setSessionLabelResolver(fn: (sessionId: string) => string | null): void {
    this.sessionLabelResolver = fn
  }

  onStateChange(callback: (info: BrowserInstanceInfo) => void): void {
    this.stateChangeCallback = callback
  }

  onRemoved(callback: (id: string) => void): void {
    this.removedCallback = callback
  }

  onInteracted(callback: (id: string) => void): void {
    this.interactedCallback = callback
  }

  /**
   * Build one page: its two views, its CDP session, and the state that starts
   * empty. Nothing is wired and nothing is laid out — `attachTab` does that, and
   * every tab goes through both, so a page cannot be half-created.
   */
  private buildTab(ses: ElectronSession): BrowserTab {
    const pageView = new BrowserView({
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Throttling stays Chromium's business here; "pretend this page is in front" is turned
        // on per page, where it is known which page a conversation is working from. See
        // `syncPageThrottling`.
      },
    })

    const nativeOverlayView = new BrowserView({
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    return {
      id: `tab-${++tabCounter}`,
      pageView,
      nativeOverlayView,
      cdp: new BrowserCDP(pageView.webContents),
      currentUrl: 'about:blank',
      title: 'New Tab',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      boundPrototype: null,
      // A page nobody said they asked for is nobody's: only the opener writes this,
      // and a page the user opened has no session to name.
      belongsTo: null,
      driverSessionId: null,
      cursorOf: null,
      heldBy: null,
      disposition: null,
      nativeOverlayReady: false,
      themeColor: null,
      inPageThemeTimer: null,
      themeObserverToken: null,
      consoleLogs: [],
      networkLogs: [],
      downloads: [],
    }
  }

  createInstance(id?: string, options?: CreateBrowserInstanceOptions): string {
    const instanceId = id || `browser-${++instanceCounter}`
    const shouldShow = options?.show ?? false
    const workspaceId = options?.workspaceId ?? null

    if (this.instances.has(instanceId)) {
      mainLog.warn(`[browser-pane] Instance already exists, reusing: ${instanceId}`)
      return instanceId
    }

    const ses = session.fromPartition(SESSION_PARTITION)
    this.setupSessionPermissions(ses)
    this.setupSessionObservers(ses)

    // Match background to current OS theme to prevent black/white flash on open
    const bgColor = nativeTheme.shouldUseDarkColors ? '#2b292e' : '#fafafb'

    const window = new BrowserWindow({
      width: 1200,
      height: 900,
      minWidth: 700,
      minHeight: 500,
      show: false, // Always hidden until toolbar is painted (ready-to-show)
      backgroundColor: bgColor,
      // Fully chromeless — toolbar is rendered in a dedicated BrowserView
      frame: false,
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const toolbarView = new BrowserView({
      webPreferences: {
        preload: join(__dirname, 'browser-toolbar-preload.cjs'),
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    const supportsMultiView = typeof window.addBrowserView === 'function' && typeof window.setTopBrowserView === 'function'
    if (!supportsMultiView) {
      throw new Error('[browser-pane] Native overlay requires BrowserWindow.addBrowserView + setTopBrowserView')
    }

    // The toolbar's own background, so its transparent chrome does not flash white.
    // A page's background is set by `attachTab` — it belongs to the page.
    const toolbarWcWithBg = toolbarView.webContents as typeof toolbarView.webContents & { setBackgroundColor?: (color: string) => void }
    toolbarWcWithBg.setBackgroundColor?.('#00000000')

    // The same document, told to render the page rail instead of the bar: one entry
    // point, one preload, one state channel, two surfaces (plan §22).
    const railView = new BrowserView({
      webPreferences: {
        preload: join(__dirname, 'browser-toolbar-preload.cjs'),
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    const railWcWithBg = railView.webContents as typeof railView.webContents & { setBackgroundColor?: (color: string) => void }
    railWcWithBg.setBackgroundColor?.('#00000000')

    // A window is *opened on* something, so it starts with one page; the tabs a
    // user adds afterwards go through `createTab`.
    const tab = this.buildTab(ses)

    const instance: BrowserInstance = {
      id: instanceId,
      window,
      toolbarView,
      railView,
      tabs: [tab],
      activeTabId: tab.id,
      workspaceId,
      isVisible: false,
      isHiding: false,
      keepAliveOnWindowClose: true,
      toolbarReady: false,
      toolbarMenuOpen: false,
      toolbarMenuHeight: 0,
      toolbarMenuOverlayActive: false,
      showOnCreate: shouldShow,
      pendingShowOnReady: false,
      pendingShowToken: 0,
      lastAction: null,
      controlBy: new Map(),
      lastLaunchToken: null,
      picking: false,
      pickLabel: 'Add to conversation',
      pickTabId: null,
      pickerGeneration: 0,
      // What the window *is showing*, as one value, because `BrowserInstanceSnapshot`
      // (what the server side reads, and what the toolbar's state reports) is phrased
      // in terms of the window: "the window's address" has to mean "the address of the
      // page on screen" without every caller learning about tabs. Read-only on purpose
      // — the way to change either is to change the page, and a compile error pointing
      // at the tab is a better answer than an assignment that goes nowhere.
      get title(): string {
        return activeTab(instance).title
      },
      get currentUrl(): string {
        return activeTab(instance).currentUrl
      },
    }

    window.addBrowserView(toolbarView)
    window.addBrowserView(railView)
    this.raiseChromeViews(instance)

    this.attachTab(instance, tab)

    this.layoutAllViews(instance)

    this.setupWindowListeners(instance)
    this.instances.set(instanceId, instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] toolbar version: v4-react-chromeless`)
    mainLog.info(`[browser-pane] Created instance: ${instanceId} (show=${shouldShow}, workspace=${workspaceId ?? 'none'})`)

    void this.loadChromePage(instance, 'bar')
      .finally(() => {
        // Safety net: if Electron never fires ready-to-show, still unblock focus/show behavior.
        if (!instance.toolbarReady) {
          this.markToolbarReady(instance, 'toolbar-load-finalized')
        }
      })
    // The rail is chrome too, and it is the only way a person adds or closes a page
    // from inside the window — so it gets the same load-and-retry the bar has. It does
    // not gate showing the window: a window whose rail failed is still a window.
    void this.loadChromePage(instance, 'rail')
    void this.loadEmptyStatePage(instance).catch((error) => {
      mainLog.warn(`[browser-pane] empty-state load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)

      // `ERR_ABORTED` means something else navigated first — in practice the
      // caller creating a window and pointing it somewhere in the same breath.
      // Forcing `about:blank` here would abort *that* navigation and fail it, with
      // the error surfacing against `about:blank` (so the real navigation looks
      // broken when it actually succeeded). Only take over when nothing else did.
      const superseded = abortedLoad(error)
      if (superseded) {
        mainLog.info(`[browser-pane] empty-state load superseded id=${instance.id} aborted=${superseded.url ?? 'unknown'}`)
        return
      }

      void tab.pageView.webContents.loadURL('about:blank').catch((fallbackError) => {
        mainLog.warn(`[browser-pane] about:blank fallback failed id=${instance.id}: ${String(fallbackError)}`)
      })
    })

    return instanceId
  }

  /**
   * Add a page to a window.
   *
   * The new tab becomes the active one: a tab is added in order to be looked at,
   * and a caller that wants it in the background (the agent opening something to
   * read later) says so with `activate: false`. `prototype` is the page's identity
   * — what the address bar and the prototype actions will say this page is.
   *
   * A window with tabs of its own is what makes several prototypes visible at once;
   * the window itself stays one window (plan §22).
   *
   * **A window that is still untouched is opened into rather than beside.** A
   * window comes back from `createForSession` holding one blank page — what a
   * window is made of before it is used — and adding next to it would leave that
   * blank page behind, so opening a prototype into a fresh window would be two
   * pages instead of one. "Untouched" is the whole window, not just the page on
   * screen: a window with real pages in it gets a real new page.
   *
   * That reuse needs the request to be for **a** page rather than **another** page:
   * something to put in the window (`url`, `prototype`), or a caller that says so
   * outright ({@link BrowserTabCreateOptions.reuseUntouchedWindow} — the menu's "New
   * page", which opens the window if it is not up yet). A bare "add a page" — the
   * rail's `+`, `tab-new` with no address — is somebody asking for one more page, and
   * reusing the blank one would swallow the request: the window would keep its single
   * page and nothing would appear to happen, which is exactly how a person reads "new
   * page is broken".
   */
  createTab(
    instanceId: string,
    options?: {
      url?: string
      activate?: boolean
      prototype?: PrototypeWindowBinding | null
      /**
       * Whose page this is: the **work** of the conversation asking for it, or `null` for a
       * person's page — see {@link BrowserTab.belongsTo}.
       *
       * A page opened *for* a conversation also becomes the page it works from, and starts
       * with that conversation's lease (the work's own `sessionId`); a page merely derived
       * from one of its pages (`afterTabId`) only joins its group, which is why the browser's
       * own window-open channel passes the page it was opened from's work here.
       */
      belongsTo?: TabBelongsTo | null
      /**
       * Open it **right after** this page instead of at the end of the strip.
       *
       * A page the browser asked for belongs next to the page that asked: a link
       * opened from a screen is about that screen, and a page at the far end of the
       * strip reads as unrelated to what was on screen (plan §22).
       */
      afterTabId?: string
      /** How the browser asked for it, when it was the browser — see {@link BrowserTab.disposition}. */
      disposition?: 'link' | 'popup' | null
      /**
       * The caller wants *a* page to use, not *another* page — see the note above.
       *
       * It has nothing to put in the window and no identity to give the page, so this
       * is the only way it can say what it means; a window that has never been used
       * already holds the blank page it is asking for.
       */
      reuseUntouchedWindow?: boolean
    },
  ): string {
    const instance = this.requireAliveInstance(instanceId)

    // "Untouched" only counts when the request is for a page rather than for one more
    // page. A page the browser asked for belongs *beside* the one that asked for it, and
    // that page is in use by definition — reusing it would take away the page the link
    // was clicked on.
    const wantsAPage =
      Boolean(options?.url) || options?.prototype !== undefined || options?.reuseUntouchedWindow === true
    const unwritten =
      wantsAPage && !options?.afterTabId && instance.tabs.length === 1 && instance.tabs[0].currentUrl === 'about:blank'
        ? instance.tabs[0]
        : null

    if (unwritten) {
      if (options?.prototype !== undefined) unwritten.boundPrototype = options.prototype
      if (options?.belongsTo !== undefined) {
        unwritten.belongsTo = options.belongsTo ?? null
        // Someone is about to work on it, so it is not left looking idle.
        unwritten.driverSessionId = options.belongsTo?.sessionId ?? null
        // …and it is where they work from: a page a conversation opened is the page its
        // next unnamed command means (plan §22, 第十轮).
        if (options.belongsTo) {
          this.recordSessionPage(instance, unwritten.id, options.belongsTo.sessionId)
        }
      }
      if (options?.disposition !== undefined) unwritten.disposition = options.disposition
      if (options?.url) this.loadTab(instance, unwritten, options.url)
      else {
        this.pushToolbarState(instance)
        this.emitStateChange(instance)
      }
      mainLog.info(`[browser-pane] Tab reused instance=${instance.id} tab=${unwritten.id} url=${unwritten.currentUrl}`)
      return unwritten.id
    }

    const tab = this.buildTab(session.fromPartition(SESSION_PARTITION))
    if (options?.belongsTo !== undefined) {
      tab.belongsTo = options.belongsTo ?? null
    }
    if (options?.disposition !== undefined) tab.disposition = options.disposition
    // A page the browser derived from another one (`afterTabId`: it was a link or a popup on
    // the page that asked) **joins that page's group and nothing else**: no lease, no cursor,
    // no lock. Group membership is inherited; the fact that somebody is *working* here is not
    // — a person following a link inside a task's page must not retarget that task, and must
    // not make the window say the task's conversation is driving the new page either
    // (plan §22, 第十一轮).
    const derivedFromAnotherPage = Boolean(options?.afterTabId)
    if (!derivedFromAnotherPage) {
      // Whoever opened a page is working on it: the lease starts where the page does,
      // so a conversation that just opened something does not have to touch it twice
      // before the window says what is going on.
      tab.driverSessionId = tab.belongsTo?.sessionId ?? null
    }

    const afterIndex = options?.afterTabId
      ? instance.tabs.findIndex((candidate) => candidate.id === options.afterTabId)
      : -1
    if (afterIndex >= 0) instance.tabs.splice(afterIndex + 1, 0, tab)
    else instance.tabs.push(tab)

    // …and it becomes the page they work from, for the same reason (plan §22, 第十轮).
    // After the page is in the window: the cursor is written on the page, so the page has
    // to be findable by id when this runs.
    if (!derivedFromAnotherPage && tab.belongsTo) {
      this.recordSessionPage(instance, tab.id, tab.belongsTo.sessionId)
    }

    this.attachTab(instance, tab)
    if (options?.prototype !== undefined) tab.boundPrototype = options.prototype

    if (options?.activate ?? true) {
      this.activateTab(instanceId, tab.id)
    } else {
      // A page added behind the one on screen still changes the window's chrome:
      // the strip has to appear, and the room for it was made above.
      this.layoutAllViews(instance)
      this.emitStateChange(instance)
      this.pushToolbarState(instance)
    }

    if (options?.url) {
      this.loadTab(instance, tab, options.url)
    }

    mainLog.info(`[browser-pane] Tab opened instance=${instance.id} tab=${tab.id} total=${instance.tabs.length} active=${instance.activeTabId}`)
    return tab.id
  }

  /**
   * Async twin of {@link createTab}, for callers that reach this through
   * `IBrowserPaneManager` and may be talking to a remote instance of this class.
   */
  async createTabAsync(
    instanceId: string,
    options?: {
      url?: string
      activate?: boolean
      prototype?: PrototypeWindowBinding | null
      belongsTo?: TabBelongsTo | null
      afterTabId?: string
      disposition?: 'link' | 'popup' | null
      reuseUntouchedWindow?: boolean
    },
  ): Promise<string> {
    return this.createTab(instanceId, options)
  }

  /** Send a page somewhere without waiting: a page is opened before it is read. */
  private loadTab(instance: BrowserInstance, tab: BrowserTab, url: string): void {
    void tab.pageView.webContents.loadURL(url).catch((error) => {
      mainLog.warn(`[browser-pane] new tab failed to load id=${instance.id} tab=${tab.id}: ${String(error)}`)
    })
  }

  /**
   * Put one page on screen.
   *
   * Everything the window reports — address, title, prototype, console, what the
   * toolbar's actions would act on — follows from here, because all of it is read
   * through the active tab. The toolbar is told the whole state again rather than
   * a delta: it is a snapshot by construction, and a delta would be a second
   * description of the same thing.
   *
   * This is the *display's* verb: the person switching pages, and the agent's one
   * explicit "bring it forward" (`browser_tab_activate`). A command no longer comes
   * through here — it records the page it works from and leaves the window where it is
   * ({@link setSessionPage}), because moving the person's view is not a command's to do
   * (plan §22, 第十二轮).
   */
  activateTab(instanceId: string, tabId: string): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no tab "${tabId}".`)

    if (instance.activeTabId === tab.id) return

    instance.activeTabId = tab.id
    this.forceCloseToolbarMenu(instance, 'tab-switch')
    this.layoutAllViews(instance)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    this.pushToolbarState(instance)
    // The picker is the window's mode, so it follows the page that just came
    // forward (plan §12.7): the user keeps picking across pages, and this is where
    // "any page's elements can be picked" is made true.
    if (instance.picking) this.armPickerOn(instance, tab)
    mainLog.info(`[browser-pane] Tab activated instance=${instance.id} tab=${tab.id} url=${tab.currentUrl}`)
  }

  /**
   * "This conversation works from this page" — recorded without moving the window.
   *
   * The whole of a command's routing: this page becomes the one the conversation's next
   * unnamed command lands on, the one its lock is on while it works, and the one Chromium
   * is asked to treat as in front so the site behaves the same as it would on screen
   * (plan §22, 第十轮/第十二轮).
   *
   * Nothing about the display changes, and that is the point: the person may be looking at
   * another page of the same window — they opened it, or they went back — and an agent
   * working in the background must not take them off it. It is also why this exists next to
   * `activateTab` rather than inside it: the two facts used to always happen together, and
   * now they do not.
   */
  setSessionPage(instanceId: string, tabId: string, sessionId: string): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no tab "${tabId}".`)

    this.recordSessionPage(instance, tab.id, sessionId)
    // The shield depends on which page is held, so the overlay hears about it — and it has
    // to, even when the page was already the one on screen (the cursor moves without the
    // display moving).
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    this.pushToolbarState(instance)
  }

  /**
   * Close one page.
   *
   * Closing the last one closes the window: a window with no pages is not a state
   * the rest of this file would know how to be in, and "no pages" is what closing
   * the last tab means to a person anyway. The neighbour that takes over is the one
   * before it when there is one (browsers do the same), otherwise the one after.
   */
  closeTab(instanceId: string, tabId: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance) return
    const index = instance.tabs.findIndex((candidate) => candidate.id === tabId)
    if (index === -1) return

    if (instance.tabs.length === 1) {
      this.destroyInstance(instanceId)
      return
    }

    const [tab] = instance.tabs.splice(index, 1)
    this.clearInPageThemeTimer(tab)
    const wcId = tab.pageView.webContents.id
    this.inFlightRequestsByWebContentsId.delete(wcId)
    this.lastNetworkActivityByWebContentsId.delete(wcId)

    // A lock never outlives what it locks: closing the page a session was holding lets go
    // of it here, rather than leaving the window claiming a page that is gone (plan §22,
    // 第九轮修正). The cursor needs no such care — it lived on the page and went with it.
    this.releaseHeldPage(instance, tab.id)

    // A page that is going away takes its overlay with it: leaving the picker
    // armed on a page nobody can see would be a mode with nothing to click.
    if (instance.pickTabId === tab.id) {
      instance.pickTabId = null
      void tab.cdp.cancelPicker()
    }

    if (instance.activeTabId === tab.id) {
      // `splice` already removed it, so the neighbour is at the same index unless
      // this was the last one — then it is the new last one.
      const next = instance.tabs[Math.min(index, instance.tabs.length - 1)]
      if (next) {
        instance.activeTabId = next.id
        this.forceCloseToolbarMenu(instance, 'tab-closed')
        this.layoutAllViews(instance)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
        this.pushToolbarState(instance)
        // Whatever page the window shows next is where an armed picker belongs.
        if (instance.picking) this.armPickerOn(instance, next)
      }
    } else {
      // Closing a page the window was not showing still shrinks the chrome when it
      // was the second-to-last one, so the layout and the toolbar both have to
      // hear about it even though the page on screen did not change.
      this.layoutAllViews(instance)
      this.emitStateChange(instance)
      this.pushToolbarState(instance)
    }

    mainLog.info(`[browser-pane] Tab closed instance=${instance.id} tab=${tab.id} remaining=${instance.tabs.length}`)
  }

  // ---------------------------------------------------------------------------
  // Element picker (plan §12.7)
  // ---------------------------------------------------------------------------

  /**
   * Turn the element picker on for this window — and leave it on.
   *
   * The mode belongs to the window, so it is remembered here and applied to
   * whatever page is on screen: now, and each time the user moves to another one.
   * That is the whole of "any page's elements can be picked".
   */
  private armPicker(instance: BrowserInstance, label?: string): void {
    if (label) instance.pickLabel = label
    instance.picking = true
    this.armPickerOn(instance, activeTab(instance))
    this.pushToolbarState(instance)
  }

  /**
   * Turn it off.
   *
   * The running loop is superseded rather than told: it is being torn down, and a
   * page that answers its teardown must not be read as the user giving up (the
   * toolbar is told, by this function, instead).
   */
  private disarmPicker(instance: BrowserInstance): void {
    instance.picking = false
    instance.pickerGeneration += 1
    const tab = tabById(instance, instance.pickTabId)
    instance.pickTabId = null
    if (tab) void tab.cdp.cancelPicker()
    this.pushToolbarState(instance)
  }

  /**
   * Arm the picker on one page, taking it off whichever page had it before.
   *
   * One page at a time: the overlay follows what the user is looking at, and a
   * page nobody is looking at that kept its overlay would be swallowing clicks
   * the user never aimed at picking.
   */
  private armPickerOn(instance: BrowserInstance, tab: BrowserTab): void {
    const previous = tabById(instance, instance.pickTabId)
    if (previous && previous.id !== tab.id) void previous.cdp.cancelPicker()

    instance.pickTabId = tab.id
    const generation = ++instance.pickerGeneration
    void this.runPickLoop(instance, tab, generation)
  }

  /**
   * Read what the armed page reports, for as long as this arming is the current
   * one.
   *
   * The loop ends three ways. Escape in the page: the page says `cancelled`, and
   * the toolbar has to hear it, because the page — not the button — is where the
   * user said stop. The page going away: nothing left to pick on. This arming
   * being superseded: silent, because the loop that took over is the one speaking
   * for the window now.
   */
  private async runPickLoop(instance: BrowserInstance, tab: BrowserTab, generation: number): Promise<void> {
    const isCurrent = () => instance.pickerGeneration === generation
    const arm = { addToConversation: true, addLabel: instance.pickLabel, resident: true } as const

    let armed = false
    let unusable = 0

    while (isCurrent()) {
      try {
        if (!armed) {
          await tab.cdp.armPicker(arm)
          armed = true
        }

        const report = await tab.cdp.drainPicker()
        // Read while the window may already be someone else's to report on.
        if (!isCurrent()) return

        for (const element of report.picks) {
          this.emitToolbarAction({
            kind: 'add-to-conversation',
            instanceId: instance.id,
            element,
            // The page it came from, read at the moment of the pick: the picker is
            // the window's, so the element alone does not say where it was picked.
            origin: this.describePageLocation(tab),
          })
        }

        if (report.status === 'cancelled') {
          mainLog.info(`[browser-pane] Picker stopped in the page instance=${instance.id} tab=${tab.id}`)
          this.disarmPicker(instance)
          return
        }

        // `missing` = this document has no picker: the page navigated out from
        // under it, or the injection did not take. The mode is the window's, so the
        // page is armed again rather than the mode quietly ending.
        armed = report.status !== 'missing'
        unusable = armed ? 0 : unusable + 1
      } catch (error) {
        if (!isCurrent()) return

        // A page that is gone is not a failure to report: the window it belonged to
        // is closed, and the picker went with it.
        if (instance.window.isDestroyed() || tab.pageView.webContents.isDestroyed()) {
          instance.picking = false
          instance.pickTabId = null
          return
        }

        // A page mid-navigation can refuse a call for a moment — the execution
        // context it was about to run in is gone — and that is not a reason to end
        // the user's mode. Re-arming on the next pass is what covers that.
        armed = false
        unusable += 1
        mainLog.debug(`[browser-pane] Pick poll failed instance=${instance.id} tab=${tab.id}: ${String(error)}`)
      }

      // A page that will not hold a picker (it never stops navigating, or its view
      // is wedged) ends the mode rather than being re-armed forever.
      if (unusable >= PICKER_MAX_CONSECUTIVE_FAILURES) {
        mainLog.warn(`[browser-pane] Giving up on the picker instance=${instance.id} tab=${tab.id}`)
        this.disarmPicker(instance)
        this.emitToolbarAction({
          kind: 'pick-failed',
          instanceId: instance.id,
          message: 'The page would not keep the element picker.',
        })
        return
      }

      await new Promise((resolve) => setTimeout(resolve, PICKER_POLL_MS))
    }
  }

  /** The window's pages, in the order they were opened, with the active one marked. */
  listTabs(instanceId: string): BrowserTabSummary[] {
    const instance = this.instances.get(instanceId)
    if (!instance) return []
    return instance.tabs.map((tab) => this.toTabSummary(instance, tab))
  }

  /**
   * Hand one page to another conversation: from now on it is **that conversation's work**, and
   * the page it works from (plan §22, Conductor).
   *
   * The orchestrator's verb — a parent's child sessions each need a page of their own, and
   * "whose work is this page" is what decides who may work there. Giving a page away is
   * therefore only possible for a page that is **the caller's own work or nobody's**: a
   * conversation cannot hand on work it does not have, and it cannot take another's page and
   * pass it along. Whether the receiver is a session worth handing to (same workspace, actually
   * exists) is `SessionManager`'s call — it is the side that knows the conversations, and it is
   * also the side that can resolve the receiver's **work**, which is why `to` is passed whole
   * rather than as a session id the browser side could only guess a task from.
   *
   * The page also stops being the giver's in every other sense: its cursor and its hold move with
   * the work, or the giver would keep working from a page it just gave away.
   */
  assignTab(instanceId: string, tabId: string, to: TabBelongsTo, by: TabBelongsTo): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no page "${tabId}".`)
    if (!to?.sessionId) {
      throw new Error('Handing a page over needs the conversation to hand it to.')
    }
    if (tab.belongsTo && !sameWork(tab.belongsTo, by)) {
      throw new Error(
        `Page ${tabId} is ${describeWork(tab.belongsTo)}'s, so ${by.sessionId} cannot hand it on.`,
      )
    }

    if (tab.cursorOf === by.sessionId) tab.cursorOf = null
    if (tab.driverSessionId === by.sessionId) tab.driverSessionId = null
    if (tab.heldBy === by.sessionId) tab.heldBy = null

    tab.belongsTo = to
    // It becomes the page the receiver works from: "here is your page" has to mean it can start
    // working without naming one, or the handover would be a page it cannot reach.
    for (const other of instance.tabs) {
      if (other.cursorOf === to.sessionId && other.id !== tabId) other.cursorOf = null
    }
    tab.cursorOf = to.sessionId

    this.updateNativeOverlayState(instance)
    this.pushToolbarState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] page handed over instance=${instance.id} tab=${tabId} from=${by.sessionId} to=${to.sessionId}`)
  }

  /**
   * Async twin of {@link listTabs}, for callers that reach this through
   * `IBrowserPaneManager` and may be talking to a remote instance of this class.
   */
  async listTabsAsync(instanceId: string): Promise<BrowserTabSummary[]> {
    return this.listTabs(instanceId)
  }

  destroyInstance(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) {
      mainLog.info(`[browser-pane] destroy requested for missing instance id=${id}`)
      return
    }

    const destroyedBefore = instance.window.isDestroyed()
    mainLog.info(`[browser-pane] destroy requested id=${id} destroyedBefore=${destroyedBefore} keepAlive=${instance.keepAliveOnWindowClose}`)

    // Clear pending timers and in-flight tracking for *every* page: a window being
    // destroyed takes all of them with it, not just the one on screen.
    for (const tab of instance.tabs) {
      this.clearInPageThemeTimer(tab)
      tab.themeObserverToken = null
      const wcId = tab.pageView.webContents.id
      this.inFlightRequestsByWebContentsId.delete(wcId)
      this.lastNetworkActivityByWebContentsId.delete(wcId)
    }
    instance.pendingShowOnReady = false
    instance.pendingShowToken += 1

    const runCleanup = (label: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        mainLog.warn(`[browser-pane] destroy cleanup failed id=${id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }

    runCleanup('updateNativeOverlayState', () => this.updateNativeOverlayState(instance))

    try {
      if (!instance.window.isDestroyed()) {
        this.destroyingIds.add(id)
        instance.window.destroy()
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] destroy failed id=${id} error=${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Finalize synchronously in case closed does not fire (or fires later).
      this.finalizeDestroyedInstance(instance, 'destroy')
      mainLog.info(`[browser-pane] destroy completed id=${id} removed=${!this.instances.has(id)}`)
    }
  }

  getInstance(id: string): BrowserInstance | undefined {
    return this.instances.get(id)
  }

  private cleanupDestroyedInstance(instance: BrowserInstance, reason: string): void {
    this.finalizeDestroyedInstance(instance, 'closed')
    mainLog.info(`[browser-pane] cleaned up stale instance ${instance.id}: ${reason}`)
  }

  /**
   * Get an instance that is confirmed alive (window not destroyed).
   * Throws a clear error if the instance is missing or its window was closed.
   * Automatically cleans up stale entries from the instance map.
   */
  private requireAliveInstance(id: string): BrowserInstance {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)
    if (instance.window.isDestroyed()) {
      this.cleanupDestroyedInstance(instance, `lookup by id ${id}`)
      throw new Error(`Browser window was closed (instance: ${id})`)
    }
    return instance
  }

  /**
   * The page a command acts on.
   *
   * `tabId` is the page the caller named. For a capability call that is the page the
   * requesting conversation works from (`commandTabIdFor`), and a command that names
   * none means the page on screen — which is what the person's own calls mean, and what
   * a window with nobody's cursor set falls back to.
   *
   * A named page that is gone **throws** rather than sliding onto the page on screen:
   * the named page was the whole point of the command, and a click that lands somewhere
   * else because the page was closed under it is worse than a failed call. Being on
   * screen is not a reason to be the target — that decoupling is the reason this exists
   * (plan §22, 第十轮/第十二轮).
   */
  private pageOf(instance: BrowserInstance, tabId?: string | null): BrowserTab {
    if (!tabId) return activeTab(instance)
    const tab = tabById(instance, tabId)
    if (!tab) {
      throw new Error(`Browser window "${instance.id}" has no page "${tabId}" — it may have been closed.`)
    }
    return tab
  }

  async handleEmptyStateLaunchFromRenderer(
    senderWebContentsId: number,
    payload: BrowserEmptyStateLaunchPayload,
  ): Promise<BrowserEmptyStateLaunchResult> {
    const instance = this.findInstanceByPageWebContentsId(senderWebContentsId)
    if (!instance) {
      mainLog.warn(`[browser-pane] empty-state launch ignored: sender not mapped senderWebContentsId=${senderWebContentsId}`)
      return { ok: false, handled: false, reason: 'instance_not_found' }
    }

    const route = payload.route?.trim()
    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return { ok: false, handled: false, reason: 'missing_route' }
    }

    const token = payload.token ?? null
    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'ipc')
    return {
      ok: true,
      handled,
      reason: handled ? undefined : 'duplicate',
    }
  }

  /**
   * Which window a page belongs to, by the page itself.
   *
   * Every page, not just the one on screen: an empty-state page that asks to
   * launch something is asking from *its* tab, and with a window holding several
   * pages the page in front may be a different one entirely.
   */
  private findInstanceByPageWebContentsId(senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      for (const tab of instance.tabs) {
        if (tab.pageView.webContents.id === senderWebContentsId) return instance
      }
    }
    return undefined
  }

  private resolveLaunchWorkspaceId(): string | null {
    if (!this.windowManager) return null

    const focusedWindow = this.windowManager.getFocusedWindow()
    if (focusedWindow) {
      const focusedWorkspaceId = this.windowManager.getWorkspaceForWindow(focusedWindow.webContents.id)
      if (focusedWorkspaceId) {
        return focusedWorkspaceId
      }
    }

    const managedWindows = this.windowManager.getAllWindows()
    return managedWindows[0]?.workspaceId ?? null
  }

  private buildDeepLinkFromRoute(route: string): string {
    const queryStart = route.indexOf('?')
    const routePath = queryStart >= 0 ? route.slice(0, queryStart) : route
    const routeQuery = queryStart >= 0 ? route.slice(queryStart + 1) : ''
    let normalizedPath = routePath.replace(/^\/+/, '')

    const workspaceId = this.resolveLaunchWorkspaceId()
    if (workspaceId && !normalizedPath.startsWith('workspace/')) {
      normalizedPath = `workspace/${encodeURIComponent(workspaceId)}/${normalizedPath}`
    }

    return `${CRAFT_DEEPLINK_SCHEME_PREFIX}${normalizedPath}${routeQuery ? `?${routeQuery}` : ''}`
  }

  private async triggerEmptyStateRouteLaunch(
    instance: BrowserInstance,
    route: string,
    token: string | null,
    source: 'hash' | 'ipc',
  ): Promise<boolean> {
    const dedupeToken = token ?? route
    if (dedupeToken && instance.lastLaunchToken === dedupeToken) {
      mainLog.info(`[browser-pane] ignoring duplicate empty-state launch id=${instance.id} source=${source} token=${dedupeToken}`)
      return false
    }

    instance.lastLaunchToken = dedupeToken
    const deepLink = this.buildDeepLinkFromRoute(route)
    mainLog.info(`[browser-pane] handling empty-state launch id=${instance.id} source=${source} route=${route} deepLink=${deepLink}`)

    await this.handleDeepLinkUrl(deepLink)
    return true
  }

  listInstances(): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'listInstances')
        continue
      }
      infos.push(this.toInfo(instance))
    }
    return infos
  }

  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    return this.listInstances()
  }

  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    return this.getInstance(id)
  }

  async createForSessionAsync(
    sessionId: string,
    options?: { show?: boolean; workspaceId?: string | null },
  ): Promise<string> {
    return this.createForSession(sessionId, options)
  }

  async getOrCreateForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null },
  ): Promise<string> {
    return this.getOrCreateForSession(sessionId, options)
  }

  async focusBoundForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null },
  ): Promise<string> {
    return this.focusBoundForSession(sessionId, options)
  }

  getWindowCount(): number {
    return this.instances.size
  }

  getBrowserWindows(): BrowserWindow[] {
    return Array.from(this.instances.values())
      .map((instance) => instance.window)
      .filter((win) => !win.isDestroyed())
  }

  async navigate(id: string, url: string, tabId?: string): Promise<{ url: string; title: string }> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)

    let normalizedUrl = url.trim()
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl)
    const isAbout = normalizedUrl.startsWith('about:')
    if (!hasScheme && !isAbout) {
      const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(normalizedUrl)
      if (looksLikeHost) {
        normalizedUrl = `https://${normalizedUrl}`
      } else {
        normalizedUrl = `https://duckduckgo.com/?q=${encodeURIComponent(normalizedUrl)}`
      }
    }

    const timeoutMs = 30_000
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    try {
      const loaded = tab.pageView.webContents.loadURL(normalizedUrl)
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Navigation to "${normalizedUrl}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      })
      await Promise.race([loaded, timeout])
    } catch (error) {
      // A *previous* load's abort is not this navigation failing: Electron hands
      // the abort to whichever `loadURL` promise is current, so the window is
      // already on the page we asked for (see `abortedLoad`). An abort of the URL
      // we asked for is a real "did not get there" — and so is anything else.
      const superseded = abortedLoad(error)
      if (!superseded || superseded.url === normalizedUrl) throw error
      mainLog.info(`[browser-pane] navigation superseded a pending load id=${id} aborted=${superseded.url ?? 'unknown'}`)
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }

    this.pushToolbarState(instance)
    return { url: tab.currentUrl, title: tab.title }
  }

  async goBack(id: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)
    if (tab.pageView.webContents.canGoBack()) {
      tab.pageView.webContents.goBack()
    }
  }

  async goForward(id: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)
    if (tab.pageView.webContents.canGoForward()) {
      tab.pageView.webContents.goForward()
    }
  }

  reload(id: string, tabId?: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    this.pageOf(instance, tabId).pageView.webContents.reload()
  }

  stop(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    activeTab(instance).pageView.webContents.stop()
  }

  focus(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    const win = instance.window
    if (win.isDestroyed()) return

    // If toolbar hasn't painted yet, defer showing until markToolbarReady runs.
    // Token guard prevents stale deferred focus from showing after hide/destroy.
    if (!instance.toolbarReady) {
      if (instance.pendingShowOnReady) return
      instance.pendingShowOnReady = true
      const token = ++instance.pendingShowToken
      mainLog.info(`[browser-pane] focus deferred until ready id=${instance.id} token=${token}`)
      return
    }

    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()

    instance.isVisible = true
    this.emitStateChange(instance)
  }

  hide(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    // Re-entrancy guard: bail if a hide is already in progress. Prevents the
    // 'close' listener from re-entering hide() during teardown, which can crash
    // Chromium's compositor when the BrowserView is mid-load.
    if (instance.isHiding) return

    const win = instance.window
    if (win.isDestroyed()) return

    instance.isHiding = true

    // Cancel any deferred show request queued before toolbar was ready.
    if (instance.pendingShowOnReady) {
      instance.pendingShowOnReady = false
      instance.pendingShowToken += 1
    }

    this.forceCloseToolbarMenu(instance, 'window-hide')

    // Cancel an in-flight page load before hiding. Hiding the window while the
    // BrowserView is still loading can trigger a Chromium compositor assertion
    // and kill the main process.
    if (activeTab(instance).isLoading) {
      try {
        const pageWc = activeTab(instance).pageView.webContents
        if (!pageWc.isDestroyed()) pageWc.stop()
      } catch (error) {
        mainLog.warn(`[browser-pane] failed to stop page load before hide id=${id}: ${(error as Error)?.message ?? error}`)
      }
    }

    win.hide()

    instance.isVisible = false

    // Defer the state-change callback so native window teardown completes before
    // listeners (which may touch BrowserView/Chromium internals) run.
    queueMicrotask(() => {
      instance.isHiding = false
      this.emitStateChange(instance)
    })
  }

  async getAccessibilitySnapshot(id: string, tabId?: string): Promise<AccessibilitySnapshot> {
    const instance = this.requireAliveInstance(id)
    return this.pageOf(instance, tabId).cdp.getAccessibilitySnapshot()
  }

  async clickAtCoordinates(id: string, x: number, y: number, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await this.pageOf(instance, tabId).cdp.clickAtCoordinates(x, y)
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async drag(id: string, x1: number, y1: number, x2: number, y2: number, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await this.pageOf(instance, tabId).cdp.drag(x1, y1, x2, y2)
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async typeText(id: string, text: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await this.pageOf(instance, tabId).cdp.typeText(text)
      instance.lastAction = {
        tool: 'browser_type',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_type',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async setClipboard(id: string, text: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    await this.pageOf(instance, tabId).cdp.setClipboard(text)
  }

  async getClipboard(id: string, tabId?: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return this.pageOf(instance, tabId).cdp.getClipboard()
  }

  async clickElement(
    id: string,
    ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number },
    tabId?: string,
  ): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)

    try {
      const geometry = await tab.cdp.clickElement(ref)
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }

      const waitFor = options?.waitFor ?? 'none'
      if (waitFor === 'navigation') {
        const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup()
            reject(new Error(
              `Click navigation wait timed out after ${timeoutMs}ms (no navigation event observed). `
              + `Tip: retry with "click ${ref}" (no navigation wait), then use "wait url <pattern>" or "wait network-idle".`
            ))
          }, timeoutMs)

          const onNav = () => {
            cleanup()
            resolve()
          }

          const cleanup = () => {
            clearTimeout(timer)
            tab.pageView.webContents.removeListener('did-navigate', onNav)
            tab.pageView.webContents.removeListener('did-navigate-in-page', onNav)
          }

          tab.pageView.webContents.once('did-navigate', onNav)
          tab.pageView.webContents.once('did-navigate-in-page', onNav)
        })
      } else if (waitFor === 'network-idle') {
        await this.waitFor(id, { kind: 'network-idle', timeoutMs: options?.timeoutMs }, tabId)
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async fillElement(id: string, ref: string, value: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await this.pageOf(instance, tabId).cdp.fillElement(ref, value)
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async selectOption(id: string, ref: string, value: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await this.pageOf(instance, tabId).cdp.selectOption(ref, value)
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  /**
   * Take the agent's overlay out of the picture, when it is in it.
   *
   * The overlay view only ever sits over the page on screen (`updateNativeOverlayState`), so
   * a capture of a page behind that one has nothing to hide — and hiding it anyway would
   * blink the outline and the shield in front of the person for a shot they are not in.
   */
  private suspendOverlayForCapture(instance: BrowserInstance, tab: BrowserTab): boolean {
    if (tab.id !== instance.activeTabId) return false
    const shouldSuspend = instance.controlBy.size > 0
      && tab.nativeOverlayReady

    if (!shouldSuspend) return false

    tab.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    return true
  }

  private restoreOverlayAfterCapture(instance: BrowserInstance, suspended: boolean): void {
    if (!suspended) return
    this.updateNativeOverlayState(instance)
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions, tabId?: string): Promise<BrowserScreenshotResult> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)

    // Hide native agent overlay so it doesn't appear in captures
    const suspendedOverlay = this.suspendOverlayForCapture(instance, tab)

    try {
      // When annotating, force agent mode and gather refs from accessibility tree
      const annotate = !!options?.annotate
      const mode = (annotate || options?.mode === 'agent') ? 'agent' : 'raw'

      if (mode === 'raw') {
        const viewport = await tab.cdp.getViewportMetrics()
        const captured = await this.capturePageWithRecovery(instance, {
          tab,
          mode,
          errorPrefix: 'screenshot',
          dpr: viewport.dpr,
          format: options?.format,
          jpegQuality: options?.jpegQuality,
        })

        return {
          imageBuffer: captured.imageBuffer,
          imageFormat: captured.imageFormat,
          metadata: options?.includeMetadata
            ? {
              mode: 'raw',
              warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
            }
            : undefined,
        }
      }

      const warnings: string[] = []
      const geometries: ElementGeometry[] = []

      const MAX_ANNOTATED_REFS = 100
      let refs = options?.refs ?? []

      if (annotate) {
        try {
          const snapshot = await tab.cdp.getAccessibilitySnapshot()
          refs = snapshot.nodes.map((node) => node.ref).slice(0, MAX_ANNOTATED_REFS)
          if (snapshot.nodes.length > MAX_ANNOTATED_REFS) {
            warnings.push(`Annotation capped at ${MAX_ANNOTATED_REFS} of ${snapshot.nodes.length} elements`)
          }
        } catch (error) {
          warnings.push(`Accessibility snapshot for annotation failed: ${error instanceof Error ? error.message : String(error)}`)
          refs = []
        }
      }

      const settled = await Promise.allSettled(
        refs.map((ref) => tab.cdp.getElementGeometry(ref)),
      )

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!
        if (result.status === 'fulfilled') {
          geometries.push(result.value)
        } else if (!annotate) {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
          warnings.push(`Could not resolve ref ${refs[i]}: ${reason}`)
        }
      }

      if (options?.includeLastAction && instance.lastAction?.geometry) {
        geometries.push(instance.lastAction.geometry)
      }

      const metadataText = instance.lastAction
        ? `${instance.lastAction.tool} • ${instance.lastAction.status} • ${new Date(instance.lastAction.timestamp).toISOString()}`
        : `browser_screenshot • ${new Date().toISOString()}`

      let annotationPartial = false

      try {
        if (geometries.length > 0 || options?.includeMetadata) {
          await tab.cdp.renderTemporaryOverlay({
            geometries,
            includeMetadata: !!options?.includeMetadata,
            metadataText,
            includeClickPoints: true,
          })
        }
      } catch (error) {
        annotationPartial = true
        warnings.push(`Annotation overlay failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      try {
        const viewport = await tab.cdp.getViewportMetrics()
        const captured = await this.capturePageWithRecovery(instance, {
          tab,
          mode,
          errorPrefix: 'screenshot',
          dpr: viewport.dpr,
          format: options?.format,
          jpegQuality: options?.jpegQuality,
        })

        if (captured.warnings.length > 0) {
          warnings.push(...captured.warnings)
        }

        return {
          imageBuffer: captured.imageBuffer,
          imageFormat: captured.imageFormat,
          metadata: {
            mode: 'agent',
            viewport,
            targets: geometries.map((g) => ({
              ref: g.ref,
              role: g.role,
              name: g.name,
              box: g.box,
              clickPoint: g.clickPoint,
            })),
            action: instance.lastAction
              ? {
                tool: instance.lastAction.tool,
                ref: instance.lastAction.ref,
                status: instance.lastAction.status,
                timestamp: instance.lastAction.timestamp,
              }
              : undefined,
            annotationPartial,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        }
      } finally {
        try {
          await tab.cdp.clearTemporaryOverlay()
        } catch {
          // ignore cleanup errors
        }
      }
    } finally {
      this.restoreOverlayAfterCapture(instance, suspendedOverlay)
    }
  }

  async screenshotRegion(
    id: string,
    target: BrowserScreenshotRegionTarget,
    tabId?: string,
  ): Promise<BrowserScreenshotResult> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)
    const tab = this.pageOf(instance, tabId)

    const hasCoords = [target.x, target.y, target.width, target.height].every((v) => typeof v === 'number')
    const hasRef = typeof target.ref === 'string' && target.ref.length > 0
    const hasSelector = typeof target.selector === 'string' && target.selector.length > 0

    const modeCount = [hasCoords, hasRef, hasSelector].filter(Boolean).length
    if (modeCount === 0) {
      throw new Error('Region screenshot requires either coordinates, ref, or selector')
    }
    if (modeCount > 1) {
      throw new Error('Region screenshot target is ambiguous. Provide only one of coordinates, ref, or selector')
    }

    const suspendedOverlay = this.suspendOverlayForCapture(instance, tab)

    try {
      let box: { x: number; y: number; width: number; height: number }

      if (hasRef) {
        const geometry = await tab.cdp.getElementGeometry(String(target.ref))
        box = { ...geometry.box }
      } else if (hasSelector) {
        const geometry = await tab.cdp.getElementGeometryBySelector(String(target.selector))
        box = { ...geometry.box }
      } else {
        box = {
          x: Number(target.x),
          y: Number(target.y),
          width: Number(target.width),
          height: Number(target.height),
        }
      }

      const padding = Math.max(0, Number(target.padding ?? 0))
      box = {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + padding * 2,
        height: box.height + padding * 2,
      }

      const viewport = await tab.cdp.getViewportMetrics()

      const clippedX = Math.max(0, Math.floor(box.x))
      const clippedY = Math.max(0, Math.floor(box.y))
      const maxWidth = Math.max(0, Math.floor(viewport.width - clippedX))
      const maxHeight = Math.max(0, Math.floor(viewport.height - clippedY))
      const clippedWidth = Math.min(Math.max(1, Math.floor(box.width)), maxWidth)
      const clippedHeight = Math.min(Math.max(1, Math.floor(box.height)), maxHeight)

      if (maxWidth <= 0 || maxHeight <= 0 || clippedWidth <= 0 || clippedHeight <= 0) {
        throw new Error('Resolved screenshot region is outside the current viewport')
      }

      const captured = await this.capturePageWithRecovery(instance, {
        tab,
        mode: 'region',
        errorPrefix: 'region screenshot',
        rect: {
          x: clippedX,
          y: clippedY,
          width: clippedWidth,
          height: clippedHeight,
        },
        dpr: viewport.dpr,
        format: target.format,
        jpegQuality: target.jpegQuality,
      })

      return {
        imageBuffer: captured.imageBuffer,
        imageFormat: captured.imageFormat,
        metadata: {
          mode: 'raw',
          viewport,
          region: {
            x: clippedX,
            y: clippedY,
            width: clippedWidth,
            height: clippedHeight,
          },
          targetMode: hasRef ? 'ref' : hasSelector ? 'selector' : 'coords',
          warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
        },
      }
    } finally {
      this.restoreOverlayAfterCapture(instance, suspendedOverlay)
    }
  }

  private async capturePageWithRecovery(
    instance: BrowserInstance,
    options: {
      /** The page being captured — named rather than assumed, so a shot of a page
       * nobody is looking at is a shot of *that* page (plan §22, 第十二轮). */
      tab: BrowserTab
      mode: 'raw' | 'agent' | 'region'
      errorPrefix: 'screenshot' | 'region screenshot'
      rect?: { x: number; y: number; width: number; height: number }
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; warnings: string[] }> {
    const tab = options.tab
    let rescueUsed = false
    let sawDisplaySurfaceUnavailable = false
    const warnings: string[] = []
    const imageOpts = { dpr: options.dpr, format: options.format, jpegQuality: options.jpegQuality }

    for (let attempt = 1; attempt <= SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS; attempt += 1) {
      let result: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
      try {
        result = await this.capturePageImage({
          tab,
          rect: options.rect,
          useHiddenCaptureOptions: true,
          ...imageOpts,
        })
      } catch (error) {
        if (this.isDisplaySurfaceUnavailableError(error)) {
          sawDisplaySurfaceUnavailable = true
          mainLog.warn(
            `[browser-pane] ${options.errorPrefix} display surface unavailable instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} tab=${tab.id} url=${tab.currentUrl}`,
          )
        } else {
          throw error
        }
      }

      if (result) {
        if (attempt > 1) {
          warnings.push(`Capture recovered after ${attempt} hidden attempt${attempt === 1 ? '' : 's'}.`)
        }
        return { imageBuffer: result.buffer, imageFormat: result.format, warnings }
      }

      mainLog.warn(
        `[browser-pane] ${options.errorPrefix} empty capture attempt instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl}`,
      )

      if (attempt < SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS) {
        await this.waitForScreenshotReadiness(instance.id)
      }
    }

    const window = instance.window
    const wasVisible = instance.isVisible

    if (!window.isDestroyed()) {
      try {
        if (!wasVisible) {
          if (window.isMinimized()) {
            window.restore()
          }
          window.showInactive()
          instance.isVisible = true
          this.emitStateChange(instance)
          rescueUsed = true
          await this.sleep(SCREENSHOT_RESCUE_PAINT_DELAY_MS)
          await this.waitForScreenshotReadiness(instance.id)
        }

        let rescueResult: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
        try {
          rescueResult = await this.capturePageImage({
            tab,
            rect: options.rect,
            useHiddenCaptureOptions: false,
            ...imageOpts,
          })
        } catch (error) {
          if (this.isDisplaySurfaceUnavailableError(error)) {
            sawDisplaySurfaceUnavailable = true
            mainLog.warn(
              `[browser-pane] ${options.errorPrefix} display surface unavailable during rescue instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} tab=${tab.id} url=${tab.currentUrl}`,
            )
          } else {
            throw error
          }
        }

        if (rescueResult) {
          if (rescueUsed) {
            warnings.push('Capture required temporary inactive reveal for rendering; browser visibility was restored immediately.')
          }
          return { imageBuffer: rescueResult.buffer, imageFormat: rescueResult.format, warnings }
        }
      } finally {
        if (!wasVisible && !window.isDestroyed()) {
          window.hide()
          instance.isVisible = false
          this.emitStateChange(instance)
        }
      }
    }

    mainLog.warn(
      `[browser-pane] ${options.errorPrefix} capture failed after recovery instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl} rescueUsed=${rescueUsed}`,
    )

    if (sawDisplaySurfaceUnavailable) {
      throw new Error(
        `Failed to capture ${options.errorPrefix}: current display surface is unavailable. `
        + `Try focusing the browser window first ("focus ${instance.id}" or "open --foreground") and retry.`
      )
    }

    throw new Error(`Failed to capture ${options.errorPrefix}: empty image buffer`)
  }

  private isDisplaySurfaceUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.toLowerCase().includes('current display surface not available for capture')
  }

  private async capturePageImage(
    options: {
      tab: BrowserTab
      rect?: { x: number; y: number; width: number; height: number }
      useHiddenCaptureOptions: boolean
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' } | null> {
    const captureOpts = options.useHiddenCaptureOptions
      ? { stayHidden: true, stayAwake: true }
      : undefined

    const pageView = options.tab.pageView
    let image = options.rect
      ? await pageView.webContents.capturePage(options.rect, captureOpts)
      : await pageView.webContents.capturePage(undefined, captureOpts)

    if (image.isEmpty()) {
      return null
    }

    // Downscale from device pixels to CSS pixels so screenshot coordinates
    // match click-at viewport coordinates (uses Skia Lanczos via 'best')
    const dpr = options.dpr ?? 1
    if (dpr > 1) {
      const size = image.getSize()
      image = image.resize({
        width: Math.round(size.width / dpr),
        height: Math.round(size.height / dpr),
        quality: 'best',
      })
    }

    const fmt = options.format ?? 'png'
    const encoded = fmt === 'jpeg'
      ? image.toJPEG(options.jpegQuality ?? 80)
      : image.toPNG()

    if (!encoded || encoded.length === 0) {
      return null
    }

    return { buffer: encoded, format: fmt }
  }

  private async waitForScreenshotReadiness(instanceId: string): Promise<void> {
    try {
      await this.waitFor(instanceId, {
        kind: 'network-idle',
        timeoutMs: SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
        idleMs: SCREENSHOT_NETWORK_IDLE_MS,
      })
    } catch {
      // network-idle can fail on continuously active pages; still proceed after bounded delay
    }

    await this.sleep(SCREENSHOT_RETRY_DELAY_MS)
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions, tabId?: string): BrowserConsoleEntry[] {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)

    const level = options?.level ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))

    const filtered = level === 'all'
      ? tab.consoleLogs
      : tab.consoleLogs.filter((entry) => entry.level === level)

    return filtered.slice(-limit)
  }

  getNetworkLogs(id: string, options?: BrowserNetworkOptions, tabId?: string): BrowserNetworkEntry[] {
    const instance = this.requireAliveInstance(id)
    const logs = this.pageOf(instance, tabId).networkLogs

    const statusFilter = options?.status ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))
    const method = options?.method?.toUpperCase()
    const resourceType = options?.resourceType?.toLowerCase()

    const filtered = logs.filter((entry) => {
      if (method && entry.method !== method) return false
      if (resourceType && entry.resourceType.toLowerCase() !== resourceType) return false

      if (statusFilter === 'all') return true
      if (statusFilter === 'failed') return !entry.ok
      if (statusFilter === '2xx') return entry.status >= 200 && entry.status < 300
      if (statusFilter === '3xx') return entry.status >= 300 && entry.status < 400
      if (statusFilter === '4xx') return entry.status >= 400 && entry.status < 500
      if (statusFilter === '5xx') return entry.status >= 500 && entry.status < 600
      return true
    })

    return filtered.slice(-limit)
  }

  async waitFor(id: string, args: BrowserWaitArgs, tabId?: string): Promise<BrowserWaitResult> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)

    const timeoutMs = Math.max(100, args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const pollMs = Math.max(25, args.pollMs ?? DEFAULT_WAIT_POLL_MS)
    const idleMs = Math.max(100, args.idleMs ?? 700)
    const started = Date.now()

    const until = async (predicate: () => Promise<boolean>, detail: string): Promise<BrowserWaitResult> => {
      while (Date.now() - started <= timeoutMs) {
        if (await predicate()) {
          return {
            ok: true,
            kind: args.kind,
            elapsedMs: Date.now() - started,
            detail,
          }
        }
        await this.sleep(pollMs)
      }
      throw new Error(`Wait timed out after ${timeoutMs}ms (${args.kind})`)
    }

    if (args.kind === 'selector') {
      const selector = args.value?.trim()
      if (!selector) throw new Error('browser_wait selector requires value')
      return until(async () => {
        const exists = await tab.pageView.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        )
        return Boolean(exists)
      }, `selector matched: ${selector}`)
    }

    if (args.kind === 'text') {
      const text = args.value?.trim()
      if (!text) throw new Error('browser_wait text requires value')
      return until(async () => {
        const found = await tab.pageView.webContents.executeJavaScript(
          `document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(text)})`
        )
        return Boolean(found)
      }, `text found: ${text}`)
    }

    if (args.kind === 'url') {
      const needle = args.value?.trim()
      if (!needle) throw new Error('browser_wait url requires value')
      return until(async () => {
        return tab.currentUrl.includes(needle)
      }, `url matched: ${needle}`)
    }

    if (args.kind === 'network-idle') {
      const wcId = tab.pageView.webContents.id
      return until(async () => {
        const inflight = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        const last = this.lastNetworkActivityByWebContentsId.get(wcId) ?? started
        return inflight === 0 && (Date.now() - last) >= idleMs
      }, `network idle for ${idleMs}ms`)
    }

    throw new Error(`Unknown wait kind: ${args.kind}`)
  }

  async sendKey(id: string, args: BrowserKeyArgs, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const pageWebContents = this.pageOf(instance, tabId).pageView.webContents

    const key = args.key?.trim()
    if (!key) throw new Error('browser_key requires key')

    const modifiers = (args.modifiers ?? []) as Array<'shift' | 'control' | 'alt' | 'meta'>

    pageWebContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key,
      modifiers,
    } as any)
    pageWebContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key,
      modifiers,
    } as any)
  }

  async getDownloads(id: string, options?: BrowserDownloadOptions, tabId?: string): Promise<BrowserDownloadEntry[]> {
    const instance = this.requireAliveInstance(id)
    const downloads = this.pageOf(instance, tabId).downloads

    const action = options?.action ?? 'list'
    const limit = Math.max(1, Math.min(200, Number(options?.limit ?? 20)))

    if (action === 'wait') {
      const timeoutMs = Math.max(100, Number(options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))
      const started = Date.now()
      while (Date.now() - started <= timeoutMs) {
        const hasTerminal = downloads.some((d) => d.state === 'completed' || d.state === 'interrupted' || d.state === 'cancelled')
        if (hasTerminal) break
        await this.sleep(100)
      }
    }

    return downloads.slice(-limit)
  }

  // validateUploadFilePath removed — uses shared validateFilePath from @craft-agent/server-core/handlers

  async uploadFile(id: string, ref: string, filePaths: string[], tabId?: string): Promise<ElementGeometry> {
    const instance = this.requireAliveInstance(id)

    const safePaths: string[] = []
    for (const p of filePaths) {
      const workspaceId = this.resolveLaunchWorkspaceId()
      const safePath = await validateFilePath(p, getWorkspaceAllowedDirs(workspaceId))
      if (!existsSync(safePath)) throw new Error(`File not found: ${p}`)
      safePaths.push(safePath)
    }

    return this.pageOf(instance, tabId).cdp.setFileInputFiles(ref, safePaths)
  }

  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    const instance = this.requireAliveInstance(id)

    const requestedViewportWidth = Math.max(320, Math.floor(width))
    const requestedViewportHeight = Math.max(240, Math.floor(height))
    // The promise is the *page's* viewport, so the window grows by whatever the chrome
    // takes: the bar from the top, the rail from the side.
    instance.window.setContentSize(requestedViewportWidth + PAGE_RAIL_WIDTH, requestedViewportHeight + TOOLBAR_HEIGHT)

    this.layoutAllViews(instance)

    // Return effective viewport dimensions after OS/window min-size constraints are applied.
    // Both chrome surfaces come back off again — the same two numbers that were added.
    const [appliedContentWidth, appliedContentHeight] = instance.window.getContentSize()
    return {
      width: Math.max(0, Math.floor(appliedContentWidth - PAGE_RAIL_WIDTH)),
      height: Math.max(0, Math.floor(appliedContentHeight - TOOLBAR_HEIGHT)),
    }
  }

  async evaluate(id: string, expression: string, tabId?: string): Promise<unknown> {
    const instance = this.requireAliveInstance(id)
    return this.pageOf(instance, tabId).pageView.webContents.executeJavaScript(expression)
  }

  /**
   * Prompt the user to click an element on the page.
   * Resolves null when the user cancels (Escape) or the pick times out.
   */
  async pickElement(
    id: string,
    options?: { timeoutMs?: number; pollMs?: number },
    tabId?: string,
  ): Promise<PickedElement | null> {
    const instance = this.requireAliveInstance(id)
    return this.pageOf(instance, tabId).cdp.pickElement(options)
  }

  // -- Frame capture --------------------------------------------------------

  /**
   * Frame captures, one per window, in memory until they are stopped.
   *
   * Keyed by instance rather than kept on `BrowserInstance`: a capture is a
   * session of observation, not a property of a window, and a window destroyed
   * mid-capture must leave nothing behind (the state goes when the key does).
   */
  private frameCaptures = new Map<string, FrameCaptureState>()

  /**
   * Start keeping frames of a window.
   *
   * Two samplers, because a screen changes for two reasons that are worth
   * different things: the interval keeps what moved on its own (a stream
   * answering), and {@link noteFrameAction} keeps what was *done* (a click),
   * whether or not the screen agreed to move.
   */
  async startFrameCapture(
    id: string,
    options?: { intervalMs?: number; threshold?: number; maxFrames?: number },
    tabId?: string,
  ) {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)
    // One capture per window: starting a second replaces the first rather than
    // running two timers over the same screen.
    const previous = this.frameCaptures.get(id)
    if (previous?.timer) clearInterval(previous.timer)

    const state: FrameCaptureState = {
      startedAt: new Date().toISOString(),
      tabId: tab.id,
      intervalMs: Math.max(FRAME_CAPTURE_MIN_INTERVAL_MS, options?.intervalMs ?? FRAME_CAPTURE_INTERVAL_MS),
      threshold: Math.min(1, Math.max(0.0001, options?.threshold ?? FRAME_CAPTURE_THRESHOLD)),
      maxFrames: Math.max(1, Math.min(600, options?.maxFrames ?? FRAME_CAPTURE_MAX_FRAMES)),
      viewport: null,
      truncated: false,
      frames: [],
      lastBitmap: null,
      capturing: false,
      timer: null,
    }
    this.frameCaptures.set(id, state)

    // The first frame is forced: without it the first comparison would have
    // nothing to compare against, and a capture would open on a change rather
    // than on the screen as it was.
    await this.captureFrame(instance, state, { reason: 'start', force: true })
    state.timer = setInterval(
      () => void this.captureFrame(instance, state, { reason: 'changed' }),
      state.intervalMs,
    )

    return {
      startedAt: state.startedAt,
      intervalMs: state.intervalMs,
      threshold: state.threshold,
      maxFrames: state.maxFrames,
    }
  }

  /** Stop a capture and hand back what it kept, or null when none was running. */
  async stopFrameCapture(id: string) {
    const state = this.frameCaptures.get(id)
    if (!state) return null
    // Removed before it is returned: a timer that fired during serialisation
    // would push frames into a capture its caller already has.
    this.frameCaptures.delete(id)
    if (state.timer) clearInterval(state.timer)

    return {
      startedAt: state.startedAt,
      endedAt: new Date().toISOString(),
      intervalMs: state.intervalMs,
      threshold: state.threshold,
      maxFrames: state.maxFrames,
      viewport: state.viewport,
      truncated: state.truncated,
      frames: state.frames,
    }
  }

  /**
   * Keep a frame for an action that was just taken.
   *
   * Called from the CDP client, which is the one place every verb passes through.
   * The action frame is forced — a click that changed nothing is still a click
   * somebody made, and "nothing happened" is a finding of its own — and a second
   * frame follows a moment later to catch what it produced.
   */
  private noteFrameAction(instance: BrowserInstance, action: { kind: string; target: string }): void {
    const state = this.frameCaptures.get(instance.id)
    if (!state) return

    const label = action.target ? `${action.kind} ${action.target}` : action.kind
    void this.captureFrame(instance, state, { reason: 'action', action: label, force: true })

    // The result frame waits a beat: what an action produces is rarely there in
    // the same tick, and one taken too early is a picture of the old screen.
    const timer = setTimeout(() => {
      if (this.frameCaptures.get(instance.id) !== state) return
      void this.captureFrame(instance, state, { reason: 'result', force: true })
    }, FRAME_CAPTURE_RESULT_DELAY_MS)
    timer.unref?.()
  }

  private async captureFrame(
    instance: BrowserInstance,
    state: FrameCaptureState,
    frame: { reason: 'start' | 'changed' | 'action' | 'result'; action?: string; force?: boolean },
  ): Promise<void> {
    // A capture slower than the interval must not stack up behind itself.
    if (state.capturing) return

    if (instance.window.isDestroyed()) {
      this.frameCaptures.delete(instance.id)
      if (state.timer) clearInterval(state.timer)
      return
    }

    // A recording follows one page. When that page is gone there is nothing left to
    // record — and following the page on screen instead would quietly tape something
    // else, which is worse than an ended recording.
    const tab = tabById(instance, state.tabId)
    if (!tab) {
      this.frameCaptures.delete(instance.id)
      if (state.timer) clearInterval(state.timer)
      return
    }

    state.capturing = true
    try {
      const image = await tab.pageView.webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
      if (image.isEmpty()) return

      const bitmap = image.toBitmap()
      if (!frame.force && state.lastBitmap && changedRatio(state.lastBitmap, bitmap) < state.threshold) return
      state.lastBitmap = bitmap

      if (state.frames.length >= state.maxFrames) {
        state.truncated = true
        if (state.timer) clearInterval(state.timer)
        state.timer = null
        return
      }

      const size = image.getSize()
      if (!state.viewport) state.viewport = { width: size.width, height: size.height }

      state.frames.push({
        index: state.frames.length + 1,
        at: new Date().toISOString(),
        url: tab.currentUrl,
        reason: frame.reason,
        ...(frame.action ? { action: frame.action } : {}),
        bytes: image.toJPEG(FRAME_CAPTURE_JPEG_QUALITY),
      })
    } catch {
      // A capture that fails is skipped: a window being resized or hidden
      // mid-shot is ordinary, and losing one frame must not end a recording.
    } finally {
      state.capturing = false
    }
  }

  /**
   * Ask the user for a recording. Null when they dismiss the dialog.
   *
   * The dialog and the decoder live together in `video-frames.ts`: one answers
   * "which file", the other reads it, and neither has anything to do with a
   * browser window — this method exists so the interface stays one surface.
   */
  async pickVideoFile(): Promise<string | null> {
    return pickVideoFileWithDialog()
  }

  /** Sample frames out of a recording someone recorded elsewhere (plan §20.5). */
  async extractVideoFrames(
    filePath: string,
    options: { mode: 'timeline' | 'changes'; everyMs: number; maxFrames: number },
  ) {
    if (!existsSync(filePath)) {
      throw new Error(`No recording at ${filePath}.`)
    }
    return sampleVideoFrames(filePath, options)
  }

  /**
   * Register `source` to run in every new document (survives reload/navigation).
   * Re-registering the same key replaces the previous script.
   */
  async addInitScript(id: string, key: string, source: string, tabId?: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return this.pageOf(instance, tabId).cdp.addInitScript(key, source)
  }

  /** Remove every init script whose key starts with `keyPrefix`. */
  async clearInitScripts(id: string, keyPrefix: string, tabId?: string): Promise<string[]> {
    const instance = this.requireAliveInstance(id)
    const tab = this.pageOf(instance, tabId)
    const keys = tab.cdp.listInitScriptKeys().filter((key) => key.startsWith(keyPrefix))
    for (const key of keys) {
      await tab.cdp.removeInitScript(key)
    }
    return keys
  }

  /**
   * Serve the contract's mock for matching requests at the browser's network layer.
   * Covers fetch and XHR alike, with no page-level patching.
   *
   * The program carries the store as well as the routes, and each apply starts it
   * over — "apply the mock" is how a demo of the flow is reset.
   */
  async setFetchMock(id: string, program: MockProgram, tabId?: string): Promise<number> {
    const instance = this.requireAliveInstance(id)
    return this.pageOf(instance, tabId).cdp.setFetchMockRoutes(program)
  }

  /** Stop intercepting; requests fall through to the real network again. */
  async clearFetchMock(id: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    await this.pageOf(instance, tabId).cdp.clearFetchMock()
  }

  async detectSecurityChallenge(id: string, tabId?: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return { detected: false, provider: 'none', signals: [] }
    const tab = this.pageOf(instance, tabId)

    const signals: string[] = []
    const title = tab.title || ''
    const url = tab.currentUrl || ''

    // Title-based detection
    if (/^Just a moment/i.test(title)) {
      signals.push('title:just-a-moment')
    }

    // URL-based detection
    if (url.includes('/cdn-cgi/challenge-platform/')) {
      signals.push('url:cdn-cgi-challenge')
    }

    // DOM-based detection via JS evaluation
    try {
      const domSignals = await tab.pageView.webContents.executeJavaScript(`(() => {
        const signals = [];
        const bodyText = (document.body?.innerText || '').slice(0, 2000);
        if (/Verify you are human/i.test(bodyText)) signals.push('text:verify-human');
        if (/Checking (if the site connection is secure|your browser)/i.test(bodyText)) signals.push('text:checking-browser');
        if (/Performing security verification/i.test(bodyText)) signals.push('text:security-verification');
        if (document.querySelector('#challenge-form')) signals.push('dom:challenge-form');
        if (document.querySelector('#turnstile-wrapper')) signals.push('dom:turnstile-wrapper');
        if (document.querySelector('.cf-turnstile')) signals.push('dom:cf-turnstile');
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) signals.push('dom:cf-challenge-iframe');
        return signals;
      })()`) as string[]

      if (Array.isArray(domSignals)) {
        signals.push(...domSignals)
      }
    } catch {
      // JS evaluation can fail if page is in a weird state — don't block on it
    }

    try {
      const snapshot = await tab.cdp.getAccessibilitySnapshot()
      const actionableRoles = new Set([
        'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
        'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox',
      ])
      const actionableCount = snapshot.nodes.filter((node) => {
        const role = (node.role || '').toLowerCase()
        return actionableRoles.has(role) && !node.disabled
      }).length

      if (snapshot.nodes.length > 0 && actionableCount <= 2) {
        signals.push(`ax:near-empty(${actionableCount}/${snapshot.nodes.length})`)
      }
    } catch {
      // AX snapshot can fail transiently during navigation; ignore
    }

    const detected = signals.length > 0
    const isCloudflare = signals.some(s =>
      s.includes('cf-') || s.includes('challenge') || s.includes('turnstile') || s === 'title:just-a-moment'
    )
    const provider = detected ? (isCloudflare ? 'cloudflare' : 'unknown') : 'none'

    if (detected) {
      mainLog.info(`[browser-pane] security challenge detected id=${id} provider=${provider} signals=[${signals.join(', ')}]`)
    }

    return { detected, provider, signals }
  }

  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount = 500, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0

    await this.pageOf(instance, tabId).pageView.webContents.executeJavaScript(`window.scrollBy(${deltaX}, ${deltaY})`)
  }

  /**
   * Let go of everything a session was holding in the browser.
   *
   * Non-destructive: the window stays, because the workspace's window is almost never
   * this session's alone — the next turn, the next conversation or the user picks it up
   * from here. What goes is what this session put there: its page leases (across every
   * window, see `clearPageLeases`), its holds, and its overlay.
   */
  unbindAllForSession(sessionId: string): void {
    this.clearPageLeases(sessionId)
    this.clearControl(sessionId)
  }

  /**
   * The window a session works in — its **workspace's browser window** (plan §22).
   *
   * One window per workspace, shared by every conversation in it and by the user, whatever
   * the work is: a prototype flow, or a general task that has nothing to do with one.
   * Resolving it depends on the **workspace** alone; `sessionId` names who is asking, and
   * nothing about the window is written from it — which conversations are working in it is
   * per page (`BrowserTab.cursorOf` / `heldBy`), because a parent and its child sessions can
   * be in it at once (Conductor).
   *
   * `sessionId` may be null: opening a browser by hand is the same window.
   */
  createForSession(
    sessionId: string | null,
    options?: { show?: boolean; workspaceId?: string | null },
  ): string {
    const workspaceId = options?.workspaceId ?? null
    const existing = this.findWindowForWorkspace(workspaceId)

    if (existing) {
      if (options?.show) {
        this.focus(existing.id)
      }
      mainLog.info(`[browser-pane] Workspace window resolved instance=${existing.id} workspace=${workspaceId ?? 'none'} askedBy=${sessionId ?? 'a person'} pages=${existing.tabs.length}`)
      return existing.id
    }

    const id = this.createInstance(undefined, {
      show: options?.show ?? false,
      workspaceId,
    })
    mainLog.info(`[browser-pane] Workspace window created instance=${id} workspace=${workspaceId ?? 'none'} askedBy=${sessionId ?? 'a person'}`)
    return id
  }

  /**
   * This workspace's browser window, or null when none is open yet.
   *
   * Found by the workspace it was stamped with, which is the whole of a window's
   * identity now that there is one window per workspace (plan §22): `workspaceId`
   * is stamped at create-time and never rewritten, so two workspaces' windows cannot
   * be confused for each other and neither needs an owner. `workspaceId === null` is
   * a bucket of its own (a caller with no workspace context), which keeps such a
   * window from being handed to a workspace that has none of its own.
   */
  private findWindowForWorkspace(workspaceId: string | null): BrowserInstance | null {
    for (const instance of this.instances.values()) {
      if (instance.workspaceId !== workspaceId) continue
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'findWindowForWorkspace')
        continue
      }
      return instance
    }
    return null
  }

  /**
   * Take one session's lease off every page it was driving.
   *
   * Swept across every window: a conversation can hold a page in a window another one is
   * working in too, and a turn ending must release *its* pages wherever they are. A page
   * that says "driven by X" for a conversation that has stopped is worse than one that says
   * nobody is.
   */
  private clearPageLeases(sessionId: string): void {
    for (const instance of this.instances.values()) {
      let changed = false
      for (const tab of instance.tabs) {
        if (tab.driverSessionId !== sessionId) continue
        tab.driverSessionId = null
        changed = true
      }
      if (!changed) continue
      this.pushToolbarState(instance)
      this.emitStateChange(instance)
    }
  }

  /**
   * Take one session's overlay and page holds off every window it has them in.
   *
   * The other half of letting go, and swept the same way: a parent and its child sessions
   * share one window (Conductor), so "what this session was holding" is not a fact about a
   * window — it is scattered across the pages that session claimed.
   */
  private clearControl(sessionId: string): void {
    for (const instance of this.instances.values()) {
      let changed = instance.controlBy.delete(sessionId)
      for (const tab of instance.tabs) {
        if (tab.heldBy !== sessionId) continue
        tab.heldBy = null
        changed = true
      }
      if (!changed) continue
      this.updateNativeOverlayState(instance)
      this.pushToolbarState(instance)
      this.emitStateChange(instance)
      mainLog.info(`[browser-pane] Released session ${sessionId}'s overlay and holds on ${instance.id}`)
    }
  }

  focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): string {
    const id = this.createForSession(sessionId, { show: true, workspaceId: options?.workspaceId })
    this.focus(id)
    return id
  }

  getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): string {
    return this.createForSession(sessionId, { show: false, workspaceId: options?.workspaceId })
  }

  /**
   * Let go of everything a session was holding. Nothing is destroyed.
   *
   * The only window is its workspace's — every conversation in that workspace and the user
   * work in it — so a session being torn down lets go instead of taking the window with it:
   * another conversation or the user may be holding pages in it right now (plan §22's third
   * rule). There is no second kind of window to destroy, so this is the same act as
   * {@link unbindAllForSession}: a session is gone, and what it put in the browser is not.
   */
  destroyForSession(sessionId: string): void {
    this.unbindAllForSession(sessionId)
  }

  /**
   * Drop this session's overlay and native overlay state, wherever it had them.
   *
   * Called between turns: the session keeps its pages (`cursorOf` is sticky) and only the
   * "working right now" marks come off.
   */
  async clearVisualsForSession(sessionId: string): Promise<void> {
    this.clearControl(sessionId)
  }

  private getAgentControlLabel(label: AgentControlLabel | null | undefined): string {
    if (label?.intent) {
      return `${label.displayName ?? 'Agent'} — ${label.intent}`
    }

    return label?.displayName ?? 'Agent is working…'
  }

  /** Resolve the app's current accent color as a concrete CSS value (not a var reference). */
  private getResolvedAccentColor(): string {
    const isDark = nativeTheme.shouldUseDarkColors
    const userTheme = loadAppTheme()
    const accent = isDark
      ? (userTheme?.dark?.accent ?? userTheme?.accent ?? DEFAULT_THEME.dark!.accent!)
      : (userTheme?.accent ?? DEFAULT_THEME.accent!)
    return accent
  }

  private async loadNativeOverlayPage(instance: BrowserInstance, tab: BrowserTab): Promise<void> {
    const liveFxPlatform: Parameters<typeof getBrowserLiveFxCornerRadii>[0] =
      process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'other'
    const cornerRadii = getBrowserLiveFxCornerRadii(liveFxPlatform)

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #overlay {
        position: fixed;
        inset: 0;
        border: 2px solid transparent;
        border-top-left-radius: ${cornerRadii.topLeft};
        border-top-right-radius: ${cornerRadii.topRight};
        border-bottom-left-radius: ${cornerRadii.bottomLeft};
        border-bottom-right-radius: ${cornerRadii.bottomRight};
        box-sizing: border-box;
        pointer-events: none;
      }
      #chip {
        position: fixed;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.82);
        color: rgba(236, 254, 255, 0.95);
        font-size: 11px;
        line-height: 1.2;
        backdrop-filter: blur(4px);
        max-width: calc(100vw - 16px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #shield {
        position: fixed;
        inset: 0;
        pointer-events: none;
        cursor: default;
      }
    </style>
  </head>
  <body>
    <div id="overlay">
      <div id="shield"></div>
      <div id="chip">Agent is working…</div>
    </div>
  </body>
</html>`

    try {
      await tab.nativeOverlayView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      tab.nativeOverlayReady = true
      mainLog.info(`[browser-pane] native overlay ready id=${instance.id} platform=${liveFxPlatform} corners=${cornerRadii.bottomLeft}/${cornerRadii.bottomRight}`)
      this.updateNativeOverlayState(instance)
    } catch (error) {
      tab.nativeOverlayReady = false
      mainLog.warn(`[browser-pane] native overlay load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Drop the in-page theme check a page has pending, if any.
   *
   * Per page rather than per window, like everything else a page owns: the timer
   * belongs to the view that scheduled it, and leaving it on the window would mean
   * a tab switch could cancel a check the *other* page was waiting on.
   */
  private clearInPageThemeTimer(tab: BrowserTab): void {
    if (tab.inPageThemeTimer) {
      clearTimeout(tab.inPageThemeTimer)
      tab.inPageThemeTimer = null
    }
  }

  /**
   * How much of a window the chrome takes off the top, in px: the address bar.
   *
   * The rail takes its room off the *side* (`PAGE_RAIL_WIDTH`), so this is only the
   * row — and every layout asks `pageAreaBounds` rather than doing the sums, so a page
   * is never laid out over its own chrome.
   */
  private toolbarChromeHeight(): number {
    return TOOLBAR_HEIGHT
  }

  /**
   * Where the page is: right of the rail, below the bar.
   *
   * One answer for every reader — the page's bounds, the agent overlay's bounds and
   * the viewport `window-resize` promises — so the three cannot disagree about how much
   * window a page actually gets.
   */
  private pageAreaBounds(instance: BrowserInstance): { x: number; y: number; width: number; height: number } {
    const [width, height] = instance.window.getContentSize()
    return {
      x: PAGE_RAIL_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(200, width - PAGE_RAIL_WIDTH),
      height: Math.max(100, height - TOOLBAR_HEIGHT),
    }
  }

  /**
   * Both chrome surfaces above the page, the rail on top.
   *
   * The rail goes last so it is the topmost view in the window: it is the one surface
   * a person must always be able to reach, so nothing — page, agent overlay, or the
   * bar while its menu is expanded over the page — gets to sit over it. The page's own
   * geometry already stops where the rail starts (`pageAreaBounds`); this is the belt
   * to that pair of braces.
   */
  private raiseChromeViews(instance: BrowserInstance): void {
    if (instance.window.isDestroyed()) return
    instance.window.setTopBrowserView(instance.toolbarView)
    instance.window.setTopBrowserView(instance.railView)
  }

  /**
   * Tell the window's chrome something — the bar and the rail together.
   *
   * They are one surface split in two by the shape of a `BrowserView`, so a message
   * that reached only one of them would leave the other showing yesterday's pages,
   * theme or menu state.
   */
  private sendToChrome(instance: BrowserInstance, channel: string, payload?: unknown): void {
    if (instance.window.isDestroyed()) return
    for (const view of [instance.toolbarView, instance.railView]) {
      if (view.webContents.isDestroyed()) continue
      view.webContents.send(channel, payload)
    }
  }

  private getToolbarEffectiveHeight(instance: BrowserInstance): number {
    const chrome = this.toolbarChromeHeight()
    if (!instance.toolbarMenuOpen) return chrome

    const [, contentHeight] = instance.window.getContentSize()
    return Math.max(chrome, contentHeight)
  }

  /**
   * The bar: the window's *upper right* — everything to the right of the rail.
   *
   * Back button, address and actions all start where the rail ends, so the rail is one
   * unbroken column from the window's top edge down and nothing of the bar sits over
   * it. The bar still expands downwards over the page while its menu is open; the rail
   * is not part of that, and stays both visible and clickable.
   */
  private layoutToolbarView(instance: BrowserInstance): void {
    const [width] = instance.window.getContentSize()
    const toolbarHeight = this.getToolbarEffectiveHeight(instance)
    const railWidth = Math.min(PAGE_RAIL_WIDTH, width)

    instance.toolbarView.setBounds({
      x: railWidth,
      y: 0,
      width: Math.max(0, width - railWidth),
      height: toolbarHeight,
    })
    instance.toolbarView.setAutoResize({ width: true, height: false })
  }

  /**
   * The rail: the window's whole left column, top edge to bottom edge.
   *
   * Full height rather than starting below the bar, because the bar is beside it now:
   * with the bar to its right there is nothing above the rail to give that row to, and
   * a column that stops 48px short of the top reads as a panel somebody forgot to
   * finish. The rail's own header row is the same height as the bar, so the two bands
   * line up across the window.
   */
  private layoutRailView(instance: BrowserInstance): void {
    const [width, height] = instance.window.getContentSize()
    instance.railView.setBounds({
      x: 0,
      y: 0,
      width: Math.min(PAGE_RAIL_WIDTH, width),
      height: Math.max(120, height),
    })
    instance.railView.setAutoResize({ width: false, height: true })
  }

  /**
   * This conversation is now working **from** this page.
   *
   * One call for one fact, read at three speeds (plan §22, 第九轮修正 / 第十轮):
   *
   * - the **cursor** (`tab.cursorOf`) is sticky — it answers "which page does this
   *   conversation's next unnamed command mean", and it survives the turn ending, because
   *   the person clicking around must not move somebody else's target;
   * - the **page lease** (`tab.driverSessionId`) is "last moved by", swept when the turn ends;
   * - the **hold** (`tab.heldBy`) lasts as long as the overlay does — the page is held while
   *   that session works, and let go when its turn ends or the person releases it (`release`).
   *
   * A session without the overlay on this window gets the first two and not the hold: an
   * overlay is what says "somebody is at the wheel here right now", and a conversation that
   * is not working is not holding anything.
   *
   * This is the write; {@link setSessionPage} is the public verb around it (a window id
   * instead of a live instance) and is what a command reaches for.
   */
  private recordSessionPage(instance: BrowserInstance, tabId: string, sessionId: string): void {
    for (const tab of instance.tabs) {
      if (tab.cursorOf === sessionId && tab.id !== tabId) tab.cursorOf = null
    }
    const target = tabById(instance, tabId)
    if (target) {
      target.cursorOf = sessionId
      // The page a conversation works from is the page it is driving: this is the page the
      // command is about, so the lease is written here rather than where the window was
      // resolved (plan §22, 第十轮). It says "last moved by", not "owned by" — the turn
      // ending sweeps it, and moving the cursor to another page leaves this one as a page
      // that conversation did work on.
      target.driverSessionId = sessionId
    }

    if (target && instance.controlBy.has(sessionId)) {
      this.holdPage(instance, target.id, sessionId)
    }

    this.syncPageThrottling(instance)
  }

  /**
   * This session is holding this page now — and, being one session, only this one page.
   *
   * One hold per session (`agentControl.tabId` used to be that single slot, for the whole
   * window): a conversation works from one page at a time, so claiming a new one lets the
   * old go. Several conversations may each hold their own page of the same window at once
   * (plan §22, Conductor) — that is what makes parallel children possible.
   */
  private holdPage(instance: BrowserInstance, tabId: string, sessionId: string): void {
    let changed = false
    for (const tab of instance.tabs) {
      if (tab.id !== tabId && tab.heldBy === sessionId) {
        tab.heldBy = null
        changed = true
      }
    }
    const target = tabById(instance, tabId)
    if (target && target.heldBy !== sessionId) {
      target.heldBy = sessionId
      changed = true
    }
    if (!changed) return
    this.updateNativeOverlayState(instance)
    mainLog.info(`[browser-pane] Page held session=${sessionId} instance=${instance.id} tab=${tabId}`)
  }

  /**
   * Pretend the pages a conversation works from are in front — and only those.
   *
   * A page Chromium counts as hidden stops animating *and tells the site it is hidden*, so the
   * same page would behave differently depending on which tab happens to be on screen. Turning
   * throttling off for every page would fix that at the cost of keeping every background
   * animation running (memory is not the issue — the spike measured 613MB parked vs 614MB
   * unthrottled for four pages); this follows the **cursors** instead, so exactly the pages
   * somebody is working from are treated as in front and the rest stay Chromium's business.
   * The geometry never depends on it: a covered page keeps its viewport and its captures are
   * correct either way (measured in `apps/electron/spike`).
   */
  private syncPageThrottling(instance: BrowserInstance): void {
    for (const tab of instance.tabs) {
      const webContents = tab.pageView.webContents
      if (webContents.isDestroyed()) continue
      if (typeof webContents.setBackgroundThrottling !== 'function') continue
      webContents.setBackgroundThrottling(tab.cursorOf === null)
    }
  }

  /**
   * Let go of a page that is held — used when the page is gone, so a lock can never outlive
   * what it locks (plan §22, 第九轮修正).
   */
  private releaseHeldPage(instance: BrowserInstance, tabId: string): void {
    const held = tabById(instance, tabId)
    if (!held?.heldBy) return
    held.heldBy = null
    this.updateNativeOverlayState(instance)
    mainLog.info(`[browser-pane] page lock released with its page instance=${instance.id} tab=${tabId}`)
  }

  private updateNativeOverlayState(instance: BrowserInstance): void {
    const menuActive = !!instance.toolbarMenuOverlayActive
    /**
     * Whether anybody is working in this window at all — the indicator, not the lock.
     *
     * Kept window-level on purpose: the person should be able to tell at a glance that this
     * window is in use even while looking at a page nobody holds. What it no longer claims
     * is *which* page is held: that is the page's own answer (`heldBy`), and with a parent
     * and its children working in parallel there is no single page it could name.
     */
    const someoneWorking = instance.controlBy.size > 0
    const shouldShow = someoneWorking || menuActive

    // Only the page on screen can be overlaid: an overlay on a page nobody is
    // looking at would swallow clicks nobody made. Auto-resize goes off with it —
    // a zero-sized view that still resizes with the window would grow back into a
    // strip of click-swallowing overlay at the window's top-left corner, which is
    // where the page rail is.
    for (const tab of instance.tabs) {
      if (tab.id !== instance.activeTabId) {
        tab.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
        tab.nativeOverlayView.setAutoResize({ width: false, height: false })
      }
    }

    if (!shouldShow || !activeTab(instance).nativeOverlayReady || instance.window.isDestroyed()) {
      activeTab(instance).nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      activeTab(instance).nativeOverlayView.setAutoResize({ width: false, height: false })
      if (!instance.window.isDestroyed()) {
        this.raiseChromeViews(instance)
      }
      return
    }

    // The overlay covers the page and only the page: the chrome is not the agent's to
    // block, and a person has to be able to switch pages while it is up.
    const page = this.pageAreaBounds(instance)
    activeTab(instance).nativeOverlayView.setBounds(page)
    activeTab(instance).nativeOverlayView.setAutoResize({ width: true, height: true })
    // Above its page, under the chrome — and raised here rather than once at layout time,
    // because every page is laid out (and the active one raised) before the overlay document
    // may have loaded at all.
    instance.window.setTopBrowserView(activeTab(instance).nativeOverlayView)
    this.raiseChromeViews(instance)

    // Two independent things are drawn here, and only one of them takes input.
    const heldBy = activeTab(instance).heldBy
    // What is being done is named by whoever is at the wheel *here*: the holder of the page
    // on screen when there is one, else whoever started working most recently — both true,
    // and the page's own answer is the more specific of the two.
    const label = this.getAgentControlLabel(
      heldBy ? instance.controlBy.get(heldBy) : [...instance.controlBy.values()].at(-1),
    )
    const accent = someoneWorking ? this.getResolvedAccentColor() : 'transparent'
    // The page on screen is the only one a person can touch, so this is where the shield
    // belongs — and only while that page is the held one, or a menu of ours is open.
    // Switching to another page therefore hands the keyboard and mouse straight back.
    const shieldActive = menuActive || heldBy !== null

    void activeTab(instance).nativeOverlayView.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('overlay');
      const chip = document.getElementById('chip');
      const shield = document.getElementById('shield');
      if (!overlay || !chip || !shield) return;

      const agentActive = ${someoneWorking};
      const shieldActive = ${shieldActive};
      const locked = ${heldBy !== null};

      // The agent's outline and chip say this window is being worked on and what is being
      // done here — the lock itself is per page, so this is the "someone is in here"
      // indicator rather than a claim about the page in front of you.
      if (agentActive) {
        overlay.style.borderColor = ${JSON.stringify(accent)};
        overlay.style.boxShadow = 'inset 0 0 0 1px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 45%, transparent), inset 0 0 24px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 28%, transparent)';
        chip.textContent = ${JSON.stringify(label)};
        chip.style.display = 'inline-flex';
      } else {
        overlay.style.borderColor = 'transparent';
        overlay.style.boxShadow = 'none';
        chip.style.display = 'none';
      }

      // The shield takes input for two reasons and no more: this page is locked by the
      // conversation working on it (plan §22, 第九轮 — the lock is on the page, so the
      // rail, the address bar and the window's own size stay the person's), or a menu of
      // ours is open above the page and a click on the page is how it is dismissed.
      shield.style.pointerEvents = shieldActive ? 'auto' : 'none';
      shield.style.cursor = locked ? 'not-allowed' : 'default';
      shield.style.background = locked
        ? 'rgba(2, 6, 23, 0.03)'
        : (shieldActive ? 'rgba(0, 0, 0, 0.001)' : 'transparent');
    })()`).catch(() => {})
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.destroyInstance(id)
    }
  }

  private finalizeDestroyedInstance(instance: BrowserInstance, source: 'destroy' | 'closed'): void {
    if (!this.instances.has(instance.id)) {
      return
    }

    this.destroyingIds.delete(instance.id)
    this.updateNativeOverlayState(instance)
    activeTab(instance).cdp.detach()
    this.instances.delete(instance.id)
    this.removedCallback?.(instance.id)
    mainLog.info(`[browser-pane] Destroyed instance: ${instance.id} (${source})`)
  }

  /**
   * Lay every page out at the page area and stack the one on screen on top.
   *
   * The others are **not** parked at zero size: a zero-sized view has no viewport (so
   * coordinates, rects and scrolling in it mean nothing) and paints nothing (so capturing it
   * returns an empty image) — which is what used to make a background page unusable. Stacked
   * under the active page instead, a background page is a real page that happens not to be
   * visible: it keeps its viewport, and with `backgroundThrottling: false` on the page views
   * (`buildTab`) Chromium keeps counting it visible. Measured in `apps/electron/spike`.
   *
   * Being laid out at the same bounds is also the whole of "switching pages": raising the
   * other view is a stack change, not a resize, so nothing has to be re-attached and the
   * pages that are not on screen never learned they were anywhere else.
   */
  private layoutPageView(instance: BrowserInstance): void {
    const area = this.pageAreaBounds(instance)

    for (const tab of instance.tabs) {
      // Anchored at the chrome's inside corner, so a page resizes with the window but never
      // moves over the chrome.
      tab.pageView.setBounds(area)
      tab.pageView.setAutoResize({ width: true, height: true })
    }

    this.raiseActivePage(instance)
    this.updateNativeOverlayState(instance)
  }

  /**
   * Put the page on screen above the other pages, and the chrome above everything.
   *
   * Between the two goes the page's own overlay — the shield the agent's control draws there —
   * and that is raised where it is positioned (`updateNativeOverlayState`), because it may not
   * even be loaded yet when the page is raised.
   */
  private raiseActivePage(instance: BrowserInstance): void {
    if (instance.window.isDestroyed()) return
    instance.window.setTopBrowserView(activeTab(instance).pageView)
    this.raiseChromeViews(instance)
  }

  private layoutAllViews(instance: BrowserInstance): void {
    this.layoutToolbarView(instance)
    this.layoutRailView(instance)
    this.layoutPageView(instance)
    this.raiseChromeViews(instance)
  }

  private forceCloseToolbarMenu(instance: BrowserInstance, reason: string): void {
    if (!instance.toolbarMenuOpen && instance.toolbarMenuHeight === 0 && !instance.toolbarMenuOverlayActive) {
      return
    }

    instance.toolbarMenuOpen = false
    instance.toolbarMenuHeight = 0
    instance.toolbarMenuOverlayActive = false
    this.layoutAllViews(instance)

    this.sendToChrome(instance, TOOLBAR_CHANNELS.FORCE_CLOSE_MENU, { reason })
  }

  private isBrowserEmptyStateUrl(url: string): boolean {
    if (!url) return false
    return url.includes(`/${BROWSER_EMPTY_STATE_PAGE}`) || url.includes(`\\${BROWSER_EMPTY_STATE_PAGE}`)
  }

  private normalizePageState(url: string, title: string): { url: string; title: string } {
    if (this.isBrowserEmptyStateUrl(url)) {
      return { url: 'about:blank', title: 'New Tab' }
    }
    return { url, title }
  }

  private async loadEmptyStatePage(instance: BrowserInstance, tab: BrowserTab = activeTab(instance)): Promise<void> {
    if (VITE_DEV_SERVER_URL) {
      await tab.pageView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/${BROWSER_EMPTY_STATE_PAGE}`)
      return
    }

    await tab.pageView.webContents.loadFile(join(__dirname, `renderer/${BROWSER_EMPTY_STATE_PAGE}`))
  }

  private async handleDeepLinkUrl(url: string): Promise<void> {
    if (!url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) return

    try {
      if (!this.windowManager) {
        mainLog.warn('[browser-pane] window manager unavailable for deep-link handling, falling back to shell.openExternal')
        await shell.openExternal(url)
        return
      }

      const { handleDeepLink } = await import('./deep-link')
      const sink = this.windowManager.getRpcEventSink() ?? undefined
      const resolver = (wcId: number) => this.windowManager?.getClientIdForWindow(wcId)
      const result = await handleDeepLink(url, this.windowManager, sink, resolver)
      if (!result.success) {
        mainLog.warn(`[browser-pane] deep-link handling failed: ${result.error ?? 'unknown error'} url=${url}`)
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] deep-link handling threw, falling back to shell.openExternal: ${error instanceof Error ? error.message : String(error)}`)
      await shell.openExternal(url)
    }
  }

  private async maybeHandleEmptyStateLaunch(instance: BrowserInstance, url: string): Promise<boolean> {
    if (!this.isBrowserEmptyStateUrl(url) || !url.includes('#launch=')) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
    const launchPayload = hash.startsWith('launch=') ? hash.slice('launch='.length) : hash
    if (!launchPayload) return false

    const params = new URLSearchParams(launchPayload)
    const route = params.get('route')
    const token = params.get('ts') ?? route ?? null

    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return false
    }

    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'hash')

    try {
      await activeTab(instance).pageView.webContents.executeJavaScript(
        "if (window.location.hash.includes('launch=')) history.replaceState(null, '', window.location.pathname + window.location.search);",
      )
    } catch {
      // Best effort cleanup only
    }

    return handled
  }

  /**
   * Load one of the window's two chrome surfaces.
   *
   * Both are the same document (`browser-toolbar.html`) with a different `view`, so a
   * window is not missing a surface because somebody forgot to add an entry point —
   * and both get the same retry, because a chrome that failed to load is a window with
   * a hole in it.
   */
  private async loadChromePage(
    instance: BrowserInstance,
    surface: 'bar' | 'rail',
  ): Promise<void> {
    const view = surface === 'rail' ? instance.railView : instance.toolbarView
    const query = `instanceId=${encodeURIComponent(instance.id)}&view=${surface}`
    let lastError: unknown = null

    for (let attempt = 0; attempt <= TOOLBAR_LOAD_MAX_RETRIES; attempt++) {
      try {
        if (VITE_DEV_SERVER_URL) {
          await view.webContents.loadURL(`${VITE_DEV_SERVER_URL}/browser-toolbar.html?${query}`)
        } else {
          await view.webContents.loadFile(
            join(__dirname, 'renderer/browser-toolbar.html'),
            { query: { instanceId: instance.id, view: surface } },
          )
        }

        if (attempt > 0) {
          mainLog.info(`[browser-pane] ${surface} load recovered id=${instance.id} attempt=${attempt + 1}`)
        }
        return
      } catch (error) {
        lastError = error
        const retrying = attempt < TOOLBAR_LOAD_MAX_RETRIES
        mainLog.warn(
          `[browser-pane] ${surface} load failed id=${instance.id} attempt=${attempt + 1}/${TOOLBAR_LOAD_MAX_RETRIES + 1}: ${error instanceof Error ? error.message : String(error)}${retrying ? ' (retrying)' : ''}`,
        )

        if (retrying) {
          await this.sleep(TOOLBAR_LOAD_RETRY_DELAY_MS)
        }
      }
    }

    const errorText = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
    await this.loadChromeFallback(instance, surface, errorText)
  }

  private async loadChromeFallback(
    instance: BrowserInstance,
    surface: 'bar' | 'rail',
    reason: string,
  ): Promise<void> {
    const safeReason = reason.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] || ch))
    const title = surface === 'rail' ? 'Browser page rail failed to load' : 'Browser toolbar failed to load'
    const body = surface === 'rail'
      ? 'The page area still works, but the page rail is unavailable. Pages can still be switched and added from the app, or by the agent.'
      : 'The page area still works, but toolbar UI is unavailable. Try reopening the browser window.'
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser Toolbar Error</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafafb; color: #1f2937; }
      @media (prefers-color-scheme: dark) { html, body { background: #2b292e; color: #e5e7eb; } }
      .wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
      .card { max-width: 640px; margin: 0 20px; padding: 14px 16px; border-radius: 10px; background: rgba(127,127,127,0.12); font-size: 12px; line-height: 1.45; }
      .title { font-weight: 600; margin-bottom: 6px; }
      .muted { opacity: 0.8; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="title">${title}</div>
        <div class="muted">${body}</div>
        <div class="muted" style="margin-top: 8px; word-break: break-word;">Reason: ${safeReason}</div>
      </div>
    </div>
  </body>
</html>`

    const view = surface === 'rail' ? instance.railView : instance.toolbarView
    try {
      await view.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      mainLog.warn(`[browser-pane] Loaded ${surface} fallback id=${instance.id}`)
    } catch (error) {
      mainLog.error(`[browser-pane] Failed to load ${surface} fallback id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * What the address bar shows for a window.
   *
   * A prototype window reads as the prototype's **own** address, not as the page
   * underneath it: the window is an app surface whose identity is the prototype it
   * works on, so an overlay's window says the prototype rather than the
   * third-party address it happens to render (the view keeps loading that address
   * — its session, its JavaScript and its origin all have to stay real).
   *
   * On the prototype's own origin the real URL says more — a page of ours keeps
   * showing the path inside itself (`/cart.html`, an SPA route) — so it is left
   * alone.
   *
   * Anywhere else the window is an overlay on someone else's page, and which
   * *page* is part of the answer. The root alone says "this prototype", and typing
   * it opens the entry page, so an overlay window would both hide which page is on
   * screen and lose it on Enter. The page's own address (`/<name>`, plan §19.3)
   * says which page and survives being typed — the host answers it with a redirect
   * to the real address. `binding` null means the bar mirrors the page, unchanged
   * from a plain browser.
   */
  private toolbarAddress(
    instance: BrowserInstance,
    binding: PrototypeWindowBinding | null,
    page: string | null,
  ): string {
    if (!binding) return activeTab(instance).currentUrl
    if (sameHost(activeTab(instance).currentUrl, binding.origin)) return activeTab(instance).currentUrl

    const root = binding.origin.replace(/\/+$/, '')
    return page ? `${root}/${page}` : binding.origin
  }

  /**
   * Which prototype a window is working on — the one fact behind both its
   * address bar and its prototype actions (plan §7: an entry point's
   * precondition is shown before the click, not answered after it).
   *
   * Two sources, in this order:
   *
   * 1. the prototype the window was **opened for** — a statement about this
   *    window, and the only one that survives an overlay's view loading a
   *    third-party address;
   * 2. the prototype its **session** is working on, which covers windows nobody
   *    opened for a prototype (one a session created and is driving).
   */
  private prototypeBindingFor(instance: BrowserInstance): PrototypeWindowBinding | null {
    return this.tabPrototypeBinding(activeTab(instance))
  }

  /**
   * The prototype **one page** is for: what it was opened for, else what the conversation
   * working in it is working on.
   *
   * Split out of {@link prototypeBindingFor} so a page can be asked about without
   * being the page on screen — which is the whole point of a window with several
   * pages. Both halves are the same facts as before, only per page.
   */
  private tabPrototypeBinding(tab: BrowserTab): PrototypeWindowBinding | null {
    if (tab.boundPrototype) return tab.boundPrototype
    // The fallback is asked of **the page's** conversation, not the window's: a page that
    // cannot say what it is for borrows from whoever works from it (`cursorOf`, sticky) or
    // from whoever opened it — the conversation is what a prototype binding is resolved
    // against, so this reads the work's opener rather than the work itself (plan §22).
    // There is no window-level answer to fall back to — one window holds several
    // conversations' pages at once (Conductor).
    const sessionId = tab.cursorOf ?? tab.belongsTo?.sessionId
    return sessionId ? this.prototypeWindowResolver?.(sessionId) ?? null : null
  }

  /**
   * Names for the conversations that opened some of this window's pages.
   *
   * The rail groups the pages by work and names each section — a session's pages by the
   * conversation, a task's by the task (that name comes from the page's own `belongsTo`, and
   * needs nothing from here); this map answers the first kind. `sessionId` is an id, and a
   * header reading `session-4f2a…` is not an answer to "whose pages are these". Only openers
   * that have a name are included; the chrome has its own fallback, so a nameless (or
   * deleted) session still groups.
   */
  private sessionLabelsFor(instance: BrowserInstance): Record<string, string> {
    const labels: Record<string, string> = {}
    for (const tab of instance.tabs) {
      const sessionId = tab.belongsTo?.sessionId
      if (!sessionId || sessionId in labels) continue
      const label = this.sessionLabelResolver?.(sessionId)
      if (label) labels[sessionId] = label
    }
    return labels
  }

  private pushToolbarState(instance: BrowserInstance): void {
    if (instance.window.isDestroyed() || instance.toolbarView.webContents.isDestroyed()) return
    // One lookup for both answers, so the address bar and what a click would do
    // cannot disagree (see `prototypeBindingFor`).
    const binding = this.prototypeBindingFor(instance)
    // Which page, for the bar's sake: only the prototype's page table knows that a
    // third-party address is the page called `cart` (see `prototypePageResolver`).
    const page = binding ? this.prototypePageResolver?.(binding.slug, binding.origin, activeTab(instance).currentUrl) ?? null : null
    const state = {
      url: this.toolbarAddress(instance, binding, page),
      title: activeTab(instance).title,
      isLoading: activeTab(instance).isLoading,
      canGoBack: activeTab(instance).canGoBack,
      canGoForward: activeTab(instance).canGoForward,
      /** `null` = no prototype here, which is also when the two prototype
       *  actions below are withheld. Never `undefined` after the first push. */
      prototypeSlug: binding?.slug ?? null,
      /**
       * Whether the element picker is on for this window (plan §12.7).
       *
       * The window's own mode, and the only reason the toolbar can draw it
       * truthfully: the mode also ends from inside the page (Escape), which the
       * toolbar would otherwise never hear about. There is no "has a conversation"
       * flag here any more, because a pick with no conversation to go to opens one.
       */
      picking: instance.picking,
      /**
       * The window's pages.
       *
       * `tabs` comes from the window itself rather than from the renderer's own
       * count: the rail is not told "show the pages", it is told which pages there
       * are. Whether the rail exists is not a fact to agree about — it is the
       * window's left column, laid out with `PAGE_RAIL_WIDTH` before any of this was
       * pushed, so there is no second answer to disagree with.
       */
      tabs: instance.tabs.map((tab) => this.toTabSummary(instance, tab)),
      /**
       * How to name the conversations those pages came from, for the rail's group
       * headers. Keyed by session id; a missing id is a session with no name yet, and
       * the rail says so generically rather than printing an id.
       */
      sessionLabels: this.sessionLabelsFor(instance),
    }
    this.sendToChrome(instance, TOOLBAR_CHANNELS.STATE_UPDATE, state)
  }

  /** Register IPC handlers for toolbar actions. Call once at app startup. */
  registerToolbarIpc(): void {
    const findInstance = (instanceId: string): BrowserInstance | undefined => {
      return this.instances.get(instanceId)
    }

    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, async (_event, instanceId: string, url: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return

      // A prototype's own addresses are the one thing here that is not a page
      // request. The root stands for the prototype itself — which is per page, so
      // there is nothing to fetch — and goes to whoever knows the workspaces (the
      // same path the panel's preview takes). A page's address resolves to *that
      // page's* address and is loaded directly: the view goes to the real page
      // (or to the host's rendering of a document of ours), and no redirect is
      // involved — an overlay page is loaded, not bounced through the prototype.
      const named = this.prototypeAddressResolver?.(url)
      if (named) {
        // Naming a prototype asks for *it*, so it gets a page of its own rather
        // than the one on screen being re-pointed at it (plan §22). The page
        // carries the prototype as its identity, because an overlay's view loads a
        // third-party address and nothing in the URL would say so afterwards —
        // which is why the bar has to be told rather than read it back.
        this.createTab(inst.id, { prototype: named.binding, activate: true })
        this.emitToolbarAction({
          kind: 'open-prototype',
          instanceId: inst.id,
          slug: named.binding.slug,
          page: named.page,
        })
        return
      }

      await this.navigate(inst.id, url)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) await this.goBack(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) await this.goForward(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) this.reload(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.STOP, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) this.stop(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.MENU_GEOMETRY, async (_event, instanceId: string, open: boolean, height?: number) => {
      const inst = findInstance(instanceId)
      if (!inst) return

      const normalizedOpen = !!open
      const normalizedHeight = Math.max(0, Math.ceil(Number(height ?? 0)))

      if (!normalizedOpen) {
        this.forceCloseToolbarMenu(inst, 'renderer-close')
        return
      }

      const changed = !inst.toolbarMenuOpen
        || inst.toolbarMenuHeight !== normalizedHeight
        || !inst.toolbarMenuOverlayActive

      if (!changed) return

      inst.toolbarMenuOpen = true
      inst.toolbarMenuHeight = normalizedHeight
      inst.toolbarMenuOverlayActive = true
      this.layoutAllViews(inst)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.HIDE, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      mainLog.info(`[browser-pane] toolbar ipc hide requested instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`)
      if (inst) this.hide(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.DESTROY, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      mainLog.info(`[browser-pane] toolbar ipc destroy requested instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`)
      if (inst) this.destroyInstance(inst.id)
    })

    /**
     * The window's own pages, managed from the strip it draws.
     *
     * One channel for all four actions rather than four channels: they are one
     * sentence — "do this to this window's pages" — sent by a renderer that holds
     * the buttons side by side, and an action that names its target cannot mean
     * anything else.
     */
    ipcMain.handle(
      TOOLBAR_CHANNELS.TABS,
      async (_event, instanceId: string, action: 'activate' | 'close' | 'new' | 'release', tabId?: string) => {
        const inst = findInstance(instanceId)
        if (!inst) return

        if (action === 'activate') {
          if (tabId) this.activateTab(inst.id, tabId)
          return
        }

        if (action === 'close') {
          if (tabId) this.closeTab(inst.id, tabId)
          return
        }

        if (action === 'release') {
          // The person taking a locked page back. The overlay is what holds the page, so
          // dropping the overlay *is* the unlock (plan §22, 第九轮修正) — and it is the
          // same act as the agent's own `release`, only sent from the other side. No
          // session is named: whoever is working here lets go.
          const result = this.clearAgentControlForInstance(inst.id)
          mainLog.info(
            `[browser-pane] page lock released by hand instance=${inst.id} tab=${tabId ?? 'unstated'} released=${result.released}${result.reason ? ` reason=${result.reason}` : ''}`,
          )
          return
        }

        // A new page starts on the empty state — the same page a brand-new window
        // opens with, rather than a white void that says nothing about what this
        // window can do.
        const openedId = this.createTab(inst.id, { activate: true })
        const opened = tabById(inst, openedId)

        if (opened) {
          void this.loadEmptyStatePage(inst, opened).catch((error) => {
            mainLog.warn(`[browser-pane] new tab empty-state load failed id=${inst.id} tab=${openedId}: ${String(error)}`)
          })
        }
      },
    )

    // -------------------------------------------------------------------------
    // Prototype workbench actions from the panel's own toolbar.
    //
    // The panel cannot resolve any of this itself: "apply" needs the bound
    // prototype, and "pick" needs a decision about what the selection is for.
    // Both live in the main window, so the panel reports the action and we
    // forward it there.
    // -------------------------------------------------------------------------

    /**
     * Turn the window's element picker on, and leave it on until it is turned off.
     *
     * Returns as soon as the mode is on rather than when a pick happens: the mode
     * outlives any one pick, and what the picks are travels back through
     * `emitToolbarAction` — a promise is the wrong shape for "several answers,
     * later, until further notice".
     *
     * The bar under the highlight is always offered: with a pick able to open a
     * conversation of its own when there is none, there is always somewhere for it
     * to go (plan §12.7).
     */
    ipcMain.handle(TOOLBAR_CHANNELS.PICK_ELEMENT, (_event, instanceId: string, addLabel?: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return
      this.armPicker(inst, addLabel)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.CANCEL_PICK, (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return
      // The toolbar button, as opposed to Escape in the page — both mean the same
      // thing, and both end the mode.
      this.disarmPicker(inst)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.APPLY_PROTOTYPE, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return
      // No injection happens here — the main window resolves the prototype and
      // calls the same RPC the prototype panel's Apply button uses, so the two
      // entry points cannot drift.
      this.emitToolbarAction({ kind: 'apply-requested', instanceId: inst.id })
    })

    mainLog.info('[browser-pane] Toolbar IPC handlers registered')
  }

  /**
   * Forward a toolbar action to the main window(s).
   *
   * Broadcast rather than targeted: the panel does not know which client opened
   * it, and a renderer that does not own the instance simply ignores the action.
   */
  private emitToolbarAction(action: BrowserToolbarAction): void {
    const sink = this.windowManager?.getRpcEventSink()
    if (!sink) {
      mainLog.warn(`[browser-pane] no RPC event sink; dropping toolbar action ${action.kind}`)
      return
    }
    sink(RPC_CHANNELS.browserPane.TOOLBAR_ACTION, { to: 'all' }, action)
  }

  // ---------------------------------------------------------------------------
  // Capability IPC — dispatcher for the `client:browser:invoke` WS capability.
  //
  // Sits between the preload bridge (which receives the WS request from the
  // remote server) and the real BrowserPaneManager. It refuses any instance ID
  // outside the caller's **workspace**, and blocks unsafe methods like
  // `uploadFile` or (optionally) `evaluate`.
  //
  // The caller's session id is used as-is: one window is only ever touched by
  // sessions of its own workspace, and those come from one server, so there is
  // one id space to be in. Keeping the session out of the reach check is what
  // makes `workspaceId` the only boundary — the same one the server side draws
  // (`SessionManager`'s `sessionWindows`).
  // ---------------------------------------------------------------------------

  /** Register the `__browser:invoke` IPC handler. Call once at app startup. */
  registerCapabilityIpc(): void {
    ipcMain.handle('__browser:invoke', async (_event, req: BrowserCapabilityRequest) => {
      return await this.dispatchCapability(req)
    })
    mainLog.info('[browser-pane] Capability IPC handler registered')
  }

  /**
   * Throws `BROWSER_INSTANCE_NOT_OWNED` unless the instance is in `workspaceId`.
   * Called by every dispatcher branch that accepts an instanceId — including read-only ones.
   */
  private requireInstanceInWorkspace(instanceId: string, workspaceId: string | null): void {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.window.isDestroyed()) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED', `Browser instance "${instanceId}" not found.`)
    }
    if (this.instanceBelongsToWorkspace(instance, workspaceId)) return
    throw new CodedError('BROWSER_INSTANCE_NOT_OWNED',
      `Browser instance "${instanceId}" is not in this workspace.`)
  }

  /**
   * Whether an instance is within a workspace's reach — the **workspace's window**
   * is the workspace's, shared by every session in it (plan §22), so the workspace
   * is what says who may act on it. A session is not part of this question: it
   * drives a window for a while (the lease) rather than owning one.
   */
  private instanceBelongsToWorkspace(instance: BrowserInstance, workspaceId: string | null): boolean {
    return instance.workspaceId === workspaceId
  }

  /** The windows a caller in `workspaceId` may act on — its workspace's. */
  private listInstancesForWorkspace(workspaceId: string | null): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'listInstancesForWorkspace')
        continue
      }
      if (!this.instanceBelongsToWorkspace(instance, workspaceId)) continue
      infos.push(this.toInfo(instance))
    }
    return infos
  }

  /**
   * Extract a plain {@link BrowserInstanceSnapshot} from a live `BrowserInstance`.
   *
   * `this.getInstance(id)` returns the full instance, which has non-cloneable
   * Electron native references (`window: BrowserWindow`, `pageView: BrowserView`,
   * `toolbarView`, ...). When we ship the result back over the `__browser:invoke`
   * IPC channel, Electron's structured-clone serializer throws
   * "An object could not be cloned" — see the user-reported bug on the remote
   * bridge path. Always pass the live instance through this helper before
   * returning over IPC.
   */
  private toSnapshot(instance: BrowserInstance): BrowserInstanceSnapshot {
    return {
      isVisible: instance.isVisible,
      title: activeTab(instance).title,
      currentUrl: activeTab(instance).currentUrl,
    }
  }

  private toScreenshotWire(result: BrowserScreenshotResult): ScreenshotResultWire {
    const buf = result.imageBuffer
    return {
      imageFormat: result.imageFormat,
      imageBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      metadata: result.metadata,
    }
  }

  /** Main dispatcher. Strongly-typed `switch` over `IBrowserPaneManager` methods. */
  private async dispatchCapability(req: BrowserCapabilityRequest): Promise<unknown> {
    if (!req || req.v !== 1) {
      throw new CodedError('HANDLER_ERROR',
        `Unsupported browser capability request shape (v=${(req as { v?: unknown })?.v}).`)
    }
    const workspaceId = req.workspaceId
    const sessionId = req.sessionId
    const args = req.args ?? []
    // The **work** the asking session is part of — the task's node for a Conductor child, the
    // session itself otherwise. Identity, like `sessionId`, and therefore never read from
    // `args`: a request that named somebody else's work would be writing a page's declaration
    // on their behalf, and "leave other people's pages alone" is decided from it (plan §22).
    const work: TabBelongsTo = req.work ?? { kind: 'session', sessionId }
    // The page every page-scoped branch below acts on: named by the caller, which is the
    // side that resolved it (`pickCommandTarget` — the conversation's own page, or the one
    // on screen when it has none), and named *here* rather than looked up, so the page a
    // command lands on is decided once and in one place. A caller that names none means the
    // page on screen — the person's own actions, and a window nobody has routed to yet
    // (plan §22, 第十轮/第十二轮).
    const commandTabId = req.tabId

    switch (req.method) {
      // -- Session-scoped (no instanceId arg, takes a sessionId) ----------------
      //
      // All of these resolve the same thing: the workspace's browser window. A remote
      // agent used to be given a window of its own so it could never touch a window
      // the user had opened; with one window per workspace that distinction is gone
      // by construction — the agent and the user are looking at the same window,
      // which is what "shared" means (plan §22). What is *not* gone is the workspace
      // boundary: `workspaceId` is what picks the window, so an agent in another
      // workspace gets its own and can reach no further. The session named on the
      // wire is the caller's own id, used as-is: it is the window's lease, not a key.
      case 'createForSession': {
        const [, options] = args as [string, { show?: boolean } | undefined]
        return this.createForSession(sessionId, {
          show: options?.show ?? false,
          workspaceId,
        })
      }
      case 'getOrCreateForSession':
        return this.createForSession(sessionId, {
          show: false,
          workspaceId,
        })
      case 'focusBoundForSession': {
        const id = this.createForSession(sessionId, {
          show: true,
          workspaceId,
        })
        this.focus(id)
        return id
      }
      case 'destroyForSession':
        this.destroyForSession(sessionId)
        return undefined
      case 'clearVisualsForSession':
        await this.clearVisualsForSession(sessionId)
        return undefined
      case 'unbindAllForSession':
        this.unbindAllForSession(sessionId)
        return undefined
      case 'setAgentControl': {
        const [, meta] = args as [string, { displayName?: string; intent?: string }]
        this.setAgentControl(sessionId, meta, { workspaceId })
        return undefined
      }
      case 'clearAgentControl':
        this.clearAgentControl(sessionId)
        return undefined

      // -- Mixed (instanceId + optional sessionId) ----------------------------
      case 'clearAgentControlForInstance': {
        const [instanceId, namedSessionId] = args as [string, string | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.clearAgentControlForInstance(
          instanceId,
          namedSessionId !== undefined ? sessionId : undefined,
        )
      }

      // -- Instance-id only ----------------------------------------------------
      case 'getInstance': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        const live = this.getInstance(instanceId)
        if (!live) return undefined
        // `getInstance` returns the live BrowserInstance (which embeds non-
        // cloneable Electron native objects). Project to a plain snapshot
        // before crossing the IPC boundary.
        return this.toSnapshot(live)
      }
      case 'listInstances':
        return this.listInstancesForWorkspace(workspaceId)
      case 'focus': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.focus(instanceId)
        return undefined
      }
      case 'hide': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.hide(instanceId)
        return undefined
      }
      case 'destroyInstance': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.destroyInstance(instanceId)
        return undefined
      }

      // -- Tabs ----------------------------------------------------------------
      case 'createTab': {
        const [instanceId, options] = args as [string, { url?: string; activate?: boolean; prototype?: PrototypeWindowBinding | null } | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // The opener is the caller, stamped here rather than read off the wire: a
        // request that named somebody else's work would be writing a page's
        // declaration on their behalf, and "leave other people's pages alone" is
        // decided from this field.
        return this.createTab(instanceId, { ...options, belongsTo: work })
      }
      case 'activateTab': {
        const [instanceId, tabId] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.activateTab(instanceId, tabId)
        return undefined
      }
      case 'setSessionPage': {
        const [instanceId, tabId] = args as [string, string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // Same rule as `createTab`: the page is recorded as the *caller's* cursor
        // and lease, so the id comes from the request's identity rather than from a
        // third argument that could say anything.
        this.setSessionPage(instanceId, tabId, sessionId)
        return undefined
      }
      case 'closeTab': {
        const [instanceId, tabId] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.closeTab(instanceId, tabId)
        return undefined
      }
      case 'assignTab': {
        const [instanceId, tabId, to] = args as [string, string, TabBelongsTo]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // Who is handing it over is the caller, not an argument — the same rule the tab
        // commands follow (see `createTab`), because the permission is "you may give away what
        // is your work or nobody's", and only the request knows who is asking. Who it goes to
        // is an argument, because the receiver's task is not something this side can resolve.
        this.assignTab(instanceId, tabId, to, work)
        return undefined
      }
      case 'listTabs': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.listTabs(instanceId)
      }

      // -- Navigation ----------------------------------------------------------
      case 'navigate': {
        const [instanceId, url] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.navigate(instanceId, url, commandTabId)
      }
      case 'goBack': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.goBack(instanceId, commandTabId)
      }
      case 'goForward': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.goForward(instanceId, commandTabId)
      }
      case 'reload': {
        // Declared in the protocol since the beginning and dispatched here all along it was
        // missing: a remote replay asked for a reload and got "unknown method" instead.
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.reload(instanceId, commandTabId)
        return undefined
      }

      // -- Interaction ---------------------------------------------------------
      case 'getAccessibilitySnapshot': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.getAccessibilitySnapshot(instanceId, commandTabId)
      }
      case 'clickElement': {
        const [instanceId, ref, options] = args as [
          string, string,
          { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number } | undefined,
        ]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.clickElement(instanceId, ref, options, commandTabId)
      }
      case 'clickAtCoordinates': {
        const [instanceId, x, y] = args as [string, number, number]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.clickAtCoordinates(instanceId, x, y, commandTabId)
      }
      case 'drag': {
        const [instanceId, x1, y1, x2, y2] = args as [string, number, number, number, number]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.drag(instanceId, x1, y1, x2, y2, commandTabId)
      }
      case 'fillElement': {
        const [instanceId, ref, value] = args as [string, string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.fillElement(instanceId, ref, value, commandTabId)
      }
      case 'typeText': {
        const [instanceId, text] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.typeText(instanceId, text, commandTabId)
      }
      case 'selectOption': {
        const [instanceId, ref, value] = args as [string, string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.selectOption(instanceId, ref, value, commandTabId)
      }
      case 'sendKey': {
        const [instanceId, keyArgs] = args as [string, BrowserKeyArgs]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.sendKey(instanceId, keyArgs, commandTabId)
      }
      case 'scroll': {
        const [instanceId, direction, amount] = args as [
          string, 'up' | 'down' | 'left' | 'right', number | undefined,
        ]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.scroll(instanceId, direction, amount, commandTabId)
      }
      case 'waitFor': {
        const [instanceId, waitArgs] = args as [string, BrowserWaitArgs]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.waitFor(instanceId, waitArgs, commandTabId)
      }
      case 'evaluate': {
        const [instanceId, expression] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        if (!getAllowRemoteEvaluate()) {
          throw new CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED',
            'JavaScript evaluation from remote agents is disabled in this client.')
        }
        return this.evaluate(instanceId, expression, commandTabId)
      }
      case 'pickElement': {
        const [instanceId, pickOptions] = args as [string, { timeoutMs?: number; pollMs?: number } | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        if (!getAllowRemoteEvaluate()) {
          throw new CodedError('BROWSER_REMOTE_PICK_BLOCKED',
            'Element picking from remote agents is disabled in this client.')
        }
        return this.pickElement(instanceId, pickOptions, commandTabId)
      }
      case 'addInitScript': {
        const [instanceId, key, source] = args as [string, string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        if (!getAllowRemoteEvaluate()) {
          throw new CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED',
            'Persistent script injection from remote agents is disabled in this client.')
        }
        return this.addInitScript(instanceId, key, source, commandTabId)
      }
      case 'clearInitScripts': {
        const [instanceId, keyPrefix] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.clearInitScripts(instanceId, keyPrefix, commandTabId)
      }
      case 'startFrameCapture': {
        const [instanceId, options] = args as [
          string,
          { intervalMs?: number; threshold?: number; maxFrames?: number } | undefined,
        ]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.startFrameCapture(instanceId, options, commandTabId)
      }
      case 'stopFrameCapture': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.stopFrameCapture(instanceId)
      }
      case 'pickVideoFile':
        // No instance: choosing a recording is not an act on a window, and a
        // remote session that may not open one still may import a video.
        return this.pickVideoFile()
      case 'extractVideoFrames': {
        const [filePath, options] = args as [
          string,
          { mode: 'timeline' | 'changes'; everyMs: number; maxFrames: number },
        ]
        return this.extractVideoFrames(filePath, options)
      }
      case 'setFetchMock': {
        const [instanceId, program] = args as [string, MockProgram]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        if (!getAllowRemoteEvaluate()) {
          throw new CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED',
            'Network mocking from remote agents is disabled in this client.')
        }
        return this.setFetchMock(instanceId, program, commandTabId)
      }
      case 'clearFetchMock': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.clearFetchMock(instanceId, commandTabId)
      }

      // -- Clipboard -----------------------------------------------------------
      case 'setClipboard': {
        const [instanceId, text] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.setClipboard(instanceId, text, commandTabId)
      }
      case 'getClipboard': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.getClipboard(instanceId, commandTabId)
      }

      // -- Capture / introspection --------------------------------------------
      case 'screenshot': {
        const [instanceId, options] = args as [string, BrowserScreenshotOptions | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        const result = await this.screenshot(instanceId, options, commandTabId)
        return this.toScreenshotWire(result)
      }
      case 'screenshotRegion': {
        const [instanceId, target] = args as [string, BrowserScreenshotRegionTarget]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        const result = await this.screenshotRegion(instanceId, target, commandTabId)
        return this.toScreenshotWire(result)
      }
      case 'getConsoleLogs': {
        const [instanceId, options] = args as [string, BrowserConsoleOptions | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.getConsoleLogs(instanceId, options, commandTabId)
      }
      case 'getNetworkLogs': {
        const [instanceId, options] = args as [string, BrowserNetworkOptions | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.getNetworkLogs(instanceId, options, commandTabId)
      }
      case 'windowResize': {
        const [instanceId, width, height] = args as [string, number, number]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.windowResize(instanceId, width, height)
      }
      case 'getDownloads': {
        const [instanceId, options] = args as [string, BrowserDownloadOptions | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.getDownloads(instanceId, options, commandTabId)
      }
      case 'uploadFile':
        throw new CodedError('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
          'File upload from a remote agent is not supported yet. Ask the user to attach the file to the session.')
      case 'detectSecurityChallenge': {
        const [instanceId] = args as [string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.detectSecurityChallenge(instanceId, commandTabId)
      }

      default: {
        const method = (req as { method?: unknown }).method
        throw new CodedError('HANDLER_ERROR', `Unknown browser capability method: ${String(method)}`)
      }
    }
  }

  private markToolbarReady(instance: BrowserInstance, reason: string): void {
    if (instance.toolbarReady || instance.window.isDestroyed()) return

    instance.toolbarReady = true
    mainLog.info(`[browser-pane] toolbar ready id=${instance.id} reason=${reason}`)

    const shouldShowNow = instance.showOnCreate || instance.pendingShowOnReady
    if (!shouldShowNow) return

    const tokenAtReady = instance.pendingShowToken
    instance.pendingShowOnReady = false

    if (instance.window.isDestroyed()) return
    if (instance.pendingShowToken !== tokenAtReady) return

    instance.window.show()
    instance.window.focus()
    instance.isVisible = true
    this.emitStateChange(instance)

  }

  // ---------------------------------------------------------------------------
  // Agent Control — persistent overlay while agent is using the browser
  // ---------------------------------------------------------------------------

  /**
   * Note that a session is working in the browser window of `options.workspaceId`, and what
   * it says it is doing. Called from sessions.ts on browser_* tool_start events.
   *
   * Per session rather than per window: a parent and its child sessions work in one window at
   * the same time (Conductor), so this adds an entry instead of taking over the window's. The
   * page a session holds is claimed later, by the command that says which page it is about
   * (`recordSessionPage`) — a tool start does not know a page yet.
   */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void {
    const instance = this.findWindowForWorkspace(options?.workspaceId ?? null)
    if (!instance) return

    // Re-inserted, so the last entry is the one that started working most recently — that is
    // what the window's chip falls back to when the page on screen is nobody's.
    instance.controlBy.delete(sessionId)
    instance.controlBy.set(sessionId, { displayName: meta.displayName, intent: meta.intent })

    const label = this.getAgentControlLabel({ displayName: meta.displayName, intent: meta.intent })

    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)

    mainLog.info(`[browser-pane] agent control activated session=${sessionId} instance=${instance.id} label=${label} working=${instance.controlBy.size}`)
  }

  /**
   * Take a session's overlay off every window it has one in.
   * Called on explicit browser_tool release and session/window teardown.
   */
  clearAgentControl(sessionId: string): void {
    this.clearControl(sessionId)
  }

  /**
   * Let go of what is being held here: a named session's overlay and holds, or — when nobody
   * is named, which is the person pressing `release` — the hold on the page on screen.
   *
   * The person's half is deliberately narrower than it used to be: the shield they are
   * looking at covers one page, so that is the one that comes back. Their other pages, and
   * the other conversations sharing the window, are not what the button was about (plan §22,
   * 第九轮修正).
   */
  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string } {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      return { released: false, reason: `Browser window "${instanceId}" not found.` }
    }

    if (sessionId) {
      const held = instance.tabs.some((tab) => tab.heldBy === sessionId)
      if (!held && !instance.controlBy.has(sessionId)) {
        return { released: false, reason: `No active agent overlay for session ${sessionId} on this window.` }
      }
      this.clearControl(sessionId)
      mainLog.info(`[browser-pane] agent control released instance=${instanceId} session=${sessionId}`)
      return { released: true }
    }

    const page = activeTab(instance)
    if (!page.heldBy) {
      return { released: false, reason: 'No active agent overlay on the target window.' }
    }

    page.heldBy = null
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] page lock released by hand instance=${instanceId} tab=${page.id}`)

    return { released: true }
  }

  /**
   * Extract a theme color from the page using Safari 26-style heuristics.
   * Priority: media-aware theme-color meta → elementsFromPoint (fixed/sticky headers) → body/html bg.
   * All colors pass through (including white/black) — contrast is handled by the renderer.
   * Guards against stale extraction (URL change during async executeJavaScript).
   *
   * Takes the page it is about: a background tab finishing its load must measure
   * *itself*, not whatever happens to be on screen.
   */
  private async extractThemeColor(instance: BrowserInstance, tab: BrowserTab): Promise<void> {
    if (tab.themeColor) return // already set by did-change-theme-color or observer
    const urlAtStart = tab.currentUrl
    try {
      const color = await tab.pageView.webContents.executeJavaScript(`(${THEME_COLOR_EXTRACTOR_FN})()`)
      // Guard: if user navigated away during extraction, discard stale result
      if (tab.currentUrl !== urlAtStart) return
      if (typeof color === 'string' && color.length > 0) {
        this.applyThemeColor(instance, tab, color)
      }
    } catch {
      // page destroyed or JS error — ignore
    }
  }

  private applyThemeColor(instance: BrowserInstance, tab: BrowserTab, color: string | null): void {
    if (tab.themeColor === color) return
    tab.themeColor = color
    // Recorded on the page it belongs to, and read back off the page **on screen** when
    // the window is described — the top bar's chip for this window is tinted with it.
    // The window's own chrome is deliberately not part of that: chrome is the app's
    // surface, so a page painting its background dark does not get to repaint the
    // address bar or the page rail next to it.
    this.emitStateChange(instance)
  }

  private installThemeObserver(instance: BrowserInstance, tab: BrowserTab, allowRetry = true): void {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const urlAtInstall = tab.currentUrl
    tab.themeObserverToken = token

    void tab.pageView.webContents.executeJavaScript(`
      (() => {
        const token = ${JSON.stringify(token)};
        const prefix = ${JSON.stringify(THEME_COLOR_SIGNAL_PREFIX)} + token + ':';
        const nullSentinel = ${JSON.stringify(THEME_COLOR_NULL_SENTINEL)};
        const extractThemeColor = ${THEME_COLOR_EXTRACTOR_FN};

        const w = window;
        const previousCleanup = w.__CRAFT_THEME_OBSERVER_CLEANUP__;
        if (typeof previousCleanup === 'function') {
          try { previousCleanup(); } catch {}
        }

        let lastColor = '__unset__';
        let rafId = 0;
        let timerId = 0;
        let lastRunAt = 0;
        const minIntervalMs = ${THEME_OBSERVER_MIN_INTERVAL_MS};

        const clearScheduled = () => {
          if (timerId) {
            clearTimeout(timerId);
            timerId = 0;
          }
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
        };

        const emit = (color) => {
          const normalized = typeof color === 'string' && color.length > 0 ? color : null;
          if (normalized === lastColor) return;
          lastColor = normalized;
          console.info(prefix + (normalized ?? nullSentinel));
        };

        const run = () => {
          rafId = 0;
          lastRunAt = Date.now();
          try {
            emit(extractThemeColor());
          } catch {}
        };

        const schedule = () => {
          if (rafId || timerId) return;
          const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRunAt));
          if (waitMs > 0) {
            timerId = setTimeout(() => {
              timerId = 0;
              rafId = requestAnimationFrame(run);
            }, waitMs);
            return;
          }
          rafId = requestAnimationFrame(run);
        };

        const onScroll = () => schedule();
        const onResize = () => schedule();
        const onMutation = () => schedule();

        const headObserver = new MutationObserver(onMutation);
        if (document.head) {
          headObserver.observe(document.head, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['name', 'content', 'media'],
          });
        }

        const rootObserver = new MutationObserver(onMutation);
        if (document.documentElement) {
          rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }
        if (document.body) {
          rootObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }

        w.addEventListener('scroll', onScroll, { passive: true });
        w.addEventListener('resize', onResize, { passive: true });

        const mql = w.matchMedia('(prefers-color-scheme: dark)');
        const onSchemeChange = () => schedule();
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);

        w.__CRAFT_THEME_OBSERVER_CLEANUP__ = () => {
          headObserver.disconnect();
          rootObserver.disconnect();
          w.removeEventListener('scroll', onScroll);
          w.removeEventListener('resize', onResize);
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onSchemeChange);
          else if (typeof mql.removeListener === 'function') mql.removeListener(onSchemeChange);
          clearScheduled();
        };

        // Fast first color for initial toolbar paint and after SPA route changes
        schedule();
      })()
    `).catch(() => {
      if (!allowRetry) return
      setTimeout(() => {
        if (!this.instances.has(instance.id)) return
        if (tab.currentUrl !== urlAtInstall) return
        if (tab.themeObserverToken !== token) return
        this.installThemeObserver(instance, tab, false)
      }, 120)
    })
  }

  private scheduleEarlyThemeExtraction(instance: BrowserInstance, tab: BrowserTab, urlAtSchedule: string): void {
    setTimeout(() => {
      if (!this.instances.has(instance.id)) return
      if (tab.currentUrl !== urlAtSchedule) return
      void this.extractThemeColor(instance, tab)
    }, EARLY_THEME_EXTRACTION_DELAY_MS)
  }

  /**
   * Which page of which window this is, by the page itself.
   *
   * Every page, not just the one on screen — the same reason `findInstanceByPageWebContentsId`
   * looks at all of them. A command now runs on the page its conversation works from, which is
   * usually a page behind the one the person is looking at, and a request or a download a page
   * makes belongs to *that* page's log: reading it through the page on screen would file it
   * under somebody else's (plan §22, 第十二轮).
   */
  private findTabByWebContentsId(webContentsId: number): { instance: BrowserInstance; tab: BrowserTab } | undefined {
    for (const instance of this.instances.values()) {
      for (const tab of instance.tabs) {
        if (tab.pageView.webContents.id === webContentsId) return { instance, tab }
      }
    }
    return undefined
  }

  private pushNetworkLog(tab: BrowserTab, entry: BrowserNetworkEntry): void {
    tab.networkLogs.push(entry)
    if (tab.networkLogs.length > MAX_NETWORK_LOG_ENTRIES) {
      tab.networkLogs.splice(0, tab.networkLogs.length - MAX_NETWORK_LOG_ENTRIES)
    }
  }

  private pushDownloadLog(tab: BrowserTab, entry: BrowserDownloadEntry): void {
    tab.downloads.push(entry)
    if (tab.downloads.length > MAX_DOWNLOAD_LOG_ENTRIES) {
      tab.downloads.splice(0, tab.downloads.length - MAX_DOWNLOAD_LOG_ENTRIES)
    }
  }

  /**
   * Where a page's downloads are filed: the directory of the conversation that page belongs
   * to, else the OS downloads folder.
   *
   * Asked of **the page** — whoever works from it (`cursorOf`, sticky) or opened it — because
   * a download is the page's, not the window's: two conversations sharing one window file
   * their downloads apart (plan §22, Conductor).
   */
  private resolveDownloadsDir(tab: BrowserTab): string {
    const sessionId = tab.cursorOf ?? tab.belongsTo?.sessionId
    if (sessionId && this.sessionPathResolver) {
      const sessionPath = this.sessionPathResolver(sessionId)
      if (sessionPath) {
        const dir = join(sessionPath, 'downloads')
        mkdirSync(dir, { recursive: true })
        return dir
      }
    }
    // Nobody's page — the person's own browsing — goes to the OS downloads folder.
    return app.getPath('downloads')
  }

  private uniqueFilename(dir: string, filename: string): string {
    if (!existsSync(join(dir, filename))) return filename
    const { name, ext } = parsePath(filename)
    let counter = 1
    while (existsSync(join(dir, `${name}_${counter}${ext}`))) {
      counter++
    }
    return `${name}_${counter}${ext}`
  }

  private setupSessionObservers(ses: ElectronSession): void {
    if (this.partitionObserversInitialized) return
    this.partitionObserversInitialized = true

    ses.webRequest.onBeforeRequest((details, callback) => {
      const wcId = details.webContentsId
      if (typeof wcId === 'number' && wcId > 0) {
        const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        this.inFlightRequestsByWebContentsId.set(wcId, current + 1)
        this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())
      }
      callback({})
    })

    ses.webRequest.onCompleted((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const located = this.findTabByWebContentsId(wcId)
      if (!located) return

      this.pushNetworkLog(located.tab, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: details.statusCode ?? 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: (details.statusCode ?? 0) >= 200 && (details.statusCode ?? 0) < 400,
      })
    })

    ses.webRequest.onErrorOccurred((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const located = this.findTabByWebContentsId(wcId)
      if (!located) return

      this.pushNetworkLog(located.tab, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: false,
      })
    })

    ses.on('will-download', (_event, item, webContents) => {
      const wcId = webContents?.id
      if (typeof wcId !== 'number') return
      const located = this.findTabByWebContentsId(wcId)
      if (!located) return
      const instance = located.instance
      // The page that started it: a download keeps reporting to the page it came from,
      // even after the person has moved to another one.
      const tab = located.tab

      // Auto-save: set a deterministic path so Electron doesn't show a native dialog
      const downloadsDir = this.resolveDownloadsDir(tab)
      const filename = this.uniqueFilename(downloadsDir, item.getFilename())
      const savePath = join(downloadsDir, filename)
      item.setSavePath(savePath)

      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const started: BrowserDownloadEntry = {
        id: downloadId,
        timestamp: Date.now(),
        url: item.getURL(),
        filename,
        state: 'started',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        mimeType: item.getMimeType() || 'application/octet-stream',
        savePath,
      }
      this.pushDownloadLog(tab, started)

      const onUpdated = (_e: Electron.Event, state: string) => {
        const latest = tab.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        if (state === 'interrupted') latest.state = 'interrupted'
      }

      item.on('updated', onUpdated)

      item.once('done', (_e, state) => {
        item.removeListener('updated', onUpdated)
        const latest = tab.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        latest.savePath = item.getSavePath()
        latest.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      })
    })
  }

  private logPermissionDecision(kind: 'check' | 'request', permission: string, origin: string): void {
    const isNonBlockingNoise = permission === 'background-sync'
    const suffix = isNonBlockingNoise ? ' (non-blocking)' : ''
    const message = `[browser-pane] permission denied (${kind}): ${permission} origin=${origin}${suffix}`
    if (isNonBlockingNoise) {
      mainLog.info(message)
      return
    }
    mainLog.warn(message)
  }

  private setupSessionPermissions(ses: ElectronSession): void {
    if (this.partitionPermissionsInitialized) return
    this.partitionPermissionsInitialized = true

    const allow = new Set([
      'fullscreen',
      'pointerLock',
      'window-management',
      'notifications',
      'geolocation',
      'media',
      'clipboard-read',
      'clipboard-sanitized-write',
      'idle-detection',
    ])

    if (typeof ses.setPermissionCheckHandler === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ses.setPermissionCheckHandler((_webContents, permission: string, requestingOrigin: string, _details: any) => {
        const allowed = allow.has(permission)
        if (!allowed) {
          this.logPermissionDecision('check', permission, requestingOrigin)
        }
        return allowed
      })
    }

    if (typeof ses.setPermissionRequestHandler === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ses.setPermissionRequestHandler((_webContents, permission: string, callback: (allow: boolean) => void, details: any) => {
        const allowed = allow.has(permission)
        if (!allowed) {
          this.logPermissionDecision('request', permission, details?.requestingOrigin ?? 'unknown')
        }
        callback(allowed)
      })
    }
  }

  private isToolbarUiDocumentUrl(url: string): boolean {
    if (!url) return false
    if (url.startsWith('data:text/html')) return true

    try {
      const parsed = new URL(url)
      return parsed.pathname.toLowerCase().endsWith('/browser-toolbar.html')
    } catch {
      return /browser-toolbar\.html(?:$|[?#])/i.test(url)
    }
  }

  /**
   * Wire the parts of a window that outlive any single page: the window itself and
   * the toolbar. Called once per window — the toolbar is shared by every tab, so
   * its listeners must not be installed again when a tab is added.
   */
  private setupWindowListeners(instance: BrowserInstance): void {
    const toolbarWc = instance.toolbarView.webContents

    instance.window.on('close', (event) => {
      const explicitDestroy = this.destroyingIds.has(instance.id)
      const interceptToHide = !explicitDestroy && instance.keepAliveOnWindowClose
      mainLog.info(`[browser-pane] window close requested id=${instance.id} explicitDestroy=${explicitDestroy} keepAlive=${instance.keepAliveOnWindowClose} interceptToHide=${interceptToHide}`)

      if (interceptToHide) {
        event.preventDefault()
        // Skip if a hide is already in flight — hide() guards against re-entry
        // itself, but bailing here also avoids redundant log noise during the
        // teardown race that triggered issue #695.
        if (!instance.isHiding) {
          this.hide(instance.id)
        }
      }
    })

    instance.window.on('resize', () => {
      this.layoutAllViews(instance)
    })

    toolbarWc.on('did-finish-load', () => {
      const loadedUrl = typeof toolbarWc.getURL === 'function' ? toolbarWc.getURL() : ''
      if (!this.isToolbarUiDocumentUrl(loadedUrl)) {
        mainLog.info(`[browser-pane] toolbar did-finish-load ignored id=${instance.id} url=${loadedUrl || 'unknown'}`)
        this.pushToolbarState(instance)
        return
      }

      this.markToolbarReady(instance, 'did-finish-load')
      this.pushToolbarState(instance)
    })

    toolbarWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.warn(`[browser-pane] toolbar did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    // The rail is the window's other chrome surface: same pushes, and its own document
    // — a push sent before it finished loading would be lost, so its own
    // `did-finish-load` is where it catches up on the pages it has to draw.
    const railWc = instance.railView.webContents

    railWc.on('did-finish-load', () => {
      this.pushToolbarState(instance)
    })

    instance.window.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })

    instance.window.on('show', () => {
      instance.isVisible = true
      this.emitStateChange(instance)
      this.pushToolbarState(instance)
      this.updateNativeOverlayState(instance)
      if (!activeTab(instance).themeColor) {
        void this.extractThemeColor(instance, activeTab(instance))
      }
    })

    instance.window.on('hide', () => {
      instance.isVisible = false
      this.emitStateChange(instance)
      this.updateNativeOverlayState(instance)
    })

    instance.window.on('closed', () => {
      this.finalizeDestroyedInstance(instance, 'closed')
    })
  }

  /**
   * Wire one page.
   *
   * Everything in here belongs to `tab` and writes to `tab` — *not* to whatever is
   * on screen. The events below fire for the view they were installed on, so a
   * background tab loading a page must record its address on itself even while the
   * user is looking at another one; reading through the active tab would quietly
   * write this page's facts onto that one. Window-level work that these events
   * trigger (state pushes, the toolbar, frame capture) still goes through
   * `instance`, because that is what it is about.
   */
  private attachTab(instance: BrowserInstance, tab: BrowserTab): void {
    const pageWc = tab.pageView.webContents
    const overlayWc = tab.nativeOverlayView.webContents

    // Everything a page needs to be a page: a user agent that does not announce
    // Electron (the site's own scripts should not see the frame we put it in), its
    // own background so about:blank does not flash, its views in the window, and the
    // overlay document the agent's control chip is drawn in. Both entry points —
    // `createInstance` and `createTab` — come through here, so a second page cannot
    // be missing one of these.
    const defaultUa = pageWc.userAgent || ''
    const sanitizedUa = defaultUa.replace(/\sElectron\/[^\s]+/g, '')
    if (sanitizedUa && sanitizedUa !== defaultUa) {
      pageWc.setUserAgent(sanitizedUa)
    }

    const bgColor = nativeTheme.shouldUseDarkColors ? '#2b292e' : '#fafafb'
    const pageWcWithBg = pageWc as typeof pageWc & { setBackgroundColor?: (color: string) => void }
    pageWcWithBg.setBackgroundColor?.(bgColor)
    const overlayWcWithBg = overlayWc as typeof overlayWc & { setBackgroundColor?: (color: string) => void }
    overlayWcWithBg.setBackgroundColor?.('#00000000')

    instance.window.addBrowserView(tab.pageView)
    instance.window.addBrowserView(tab.nativeOverlayView)
    // The chrome stays on top of whatever page is showing — both surfaces of it.
    this.raiseChromeViews(instance)
    void this.loadNativeOverlayPage(instance, tab)

    // Every action taken on this page is a frame, whatever the screen did with it:
    // a click is a *cause*, and a reader who cannot tell "somebody did this" from
    // "it moved on its own" has a pile of pictures rather than a record (plan §20.3).
    tab.cdp.onAction = (action) => this.noteFrameAction(instance, action)

    pageWc.on('did-start-loading', () => {
      tab.isLoading = true
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    pageWc.on('did-stop-loading', () => {
      tab.isLoading = false
      tab.canGoBack = pageWc.canGoBack()
      tab.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — all pending requests are settled once loading stops
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      void this.extractThemeColor(instance, tab)
      this.updateNativeOverlayState(instance)
    })

    pageWc.on('dom-ready', () => {
      this.installThemeObserver(instance, tab)
      void this.extractThemeColor(instance, tab)
    })

    // Every page's answer to "may Chromium throttle this?" is stated once it exists, so a page
    // is never left on an inherited default it did not mean (`syncPageThrottling`).
    this.syncPageThrottling(instance)

    // A locked page takes no input from a person. The shield already swallows the mouse;
    // this is the keyboard half — typing into a page a conversation is driving is the
    // same interruption by another route. Read live rather than captured, so the lock
    // follows the lease: the page stops refusing input when its turn ends or the overlay
    // goes, and a page the person switched to is never covered by a lock on another.
    pageWc.on('before-input-event', (event) => {
      if (tab.heldBy !== null) {
        event.preventDefault()
      }
    })

    // The window's own toolbar listener lives in `setupWindowListeners` — one
    // install per window, not per tab.

    overlayWc.on('before-input-event', (event, input) => {
      if (!instance.toolbarMenuOverlayActive) return

      const inputType = input.type || ''
      if (inputType === 'mouseDown' || inputType === 'touchStart' || inputType === 'pointerDown') {
        event.preventDefault()
        this.forceCloseToolbarMenu(instance, 'overlay-tap')
      }
    })

    pageWc.on('did-navigate', (_event, urlFromEvent) => {
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || tab.currentUrl)
      const previousUrl = tab.currentUrl
      this.clearInPageThemeTimer(tab)
      tab.themeObserverToken = null
      tab.themeColor = null // reset for new page (batched with state push below)
      const normalized = this.normalizePageState(url, pageWc.getTitle())
      tab.currentUrl = normalized.url
      tab.title = normalized.title
      mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${tab.currentUrl}`)
      tab.canGoBack = pageWc.canGoBack()
      tab.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — prior page's requests are cancelled on navigation
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      this.scheduleEarlyThemeExtraction(instance, tab, url)
      this.updateNativeOverlayState(instance)
    })

    pageWc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.info(`[browser-pane] did-redirect-navigation id=${instance.id} url=${url} inPlace=${isInPlace}`)
    })

    pageWc.on('did-navigate-in-page', (_event, urlFromEvent) => {
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || tab.currentUrl)
      const normalized = this.normalizePageState(url, tab.title)
      tab.currentUrl = normalized.url
      tab.title = normalized.title
      tab.canGoBack = pageWc.canGoBack()
      tab.canGoForward = pageWc.canGoForward()

      void this.maybeHandleEmptyStateLaunch(instance, url).then((handled) => {
        if (handled) {
          this.emitStateChange(instance)
          void this.pushToolbarState(instance)
          return
        }

        // SPA route change — re-extract theme color (debounced)
        this.clearInPageThemeTimer(tab)
        tab.themeObserverToken = null
        tab.themeColor = null
        this.emitStateChange(instance)
        void this.pushToolbarState(instance)
        this.installThemeObserver(instance, tab)
        tab.inPageThemeTimer = setTimeout(() => { void this.extractThemeColor(instance, tab) }, 300)
        this.updateNativeOverlayState(instance)
      }).catch((error) => {
        mainLog.warn(`[browser-pane] empty-state launch handling failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    pageWc.on('page-title-updated', (_event, title) => {
      const normalized = this.normalizePageState(pageWc.getURL(), title)
      tab.title = normalized.title
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    pageWc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] || null
      this.emitStateChange(instance)
    })

    pageWc.on('did-change-theme-color', (_event, color) => {
      this.applyThemeColor(instance, tab, color ?? null)
    })

    pageWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      mainLog.warn(`[browser-pane] did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    pageWc.on('console-message', (_event, level, message) => {
      if (message.startsWith(THEME_COLOR_SIGNAL_PREFIX)) {
        const payload = message.slice(THEME_COLOR_SIGNAL_PREFIX.length)
        const delimiterIdx = payload.indexOf(':')
        if (delimiterIdx > 0) {
          const token = payload.slice(0, delimiterIdx)
          const value = payload.slice(delimiterIdx + 1).trim()
          if (token === tab.themeObserverToken) {
            if (value === THEME_COLOR_NULL_SENTINEL) {
              this.applyThemeColor(instance, tab, null)
            } else if (value.length > 0) {
              this.applyThemeColor(instance, tab, value)
            }
          }
        }
        return
      }

      const mappedLevel: BrowserConsoleEntry['level'] = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : 'log'
      tab.consoleLogs.push({
        timestamp: Date.now(),
        level: mappedLevel,
        message,
      })
      if (tab.consoleLogs.length > MAX_CONSOLE_LOG_ENTRIES) {
        tab.consoleLogs.splice(0, tab.consoleLogs.length - MAX_CONSOLE_LOG_ENTRIES)
      }

      if (level >= 2) {
        mainLog.warn(`[browser-pane] console id=${instance.id} level=${level}: ${message}`)
      }
    })

    pageWc.on('will-navigate', (event, url) => {
      if (url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
        event.preventDefault()
        void this.handleDeepLinkUrl(url)
      }
    })

    pageWc.setWindowOpenHandler((details) => {
      mainLog.info(
        `[browser-pane] window-open requested id=${instance.id} tab=${tab.id} url=${details.url} disposition=${details.disposition ?? 'unknown'} frameName=${details.frameName || 'none'}`,
      )

      if (details.url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
        void this.handleDeepLinkUrl(details.url)
        return { action: 'deny' }
      }

      let parsed: URL
      try {
        parsed = new URL(details.url)
      } catch {
        mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=invalid_url url=${details.url}`)
        return { action: 'deny' }
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=unsupported_protocol protocol=${parsed.protocol} url=${details.url}`)
        return { action: 'deny' }
      }

      // A page that wants a window of its own gets a **page beside the one that asked
      // for it** (plan §22). Every one of them: `target="_blank"`, `window.open`, a
      // popup, a link on a prototype's own document. A real second window used to be
      // how popups were played, and it is the one thing the window model does not have
      // room for — a bare Electron window with no toolbar, no prototype, no patches,
      // which is a page of ours dressed up as somebody else's site.
      //
      // The cost is stated and real: a page opened this way has no `window.opener`, so
      // a popup that waits for a `postMessage` from the page that opened it (Google's
      // sign-in is the usual one) will wait forever. `tab.disposition` is where that is
      // recorded, so it is diagnosable rather than mysterious.
      // Whose page this is: **the page it was opened from**. No attribution is needed —
      // who clicked is not asked, and could not be told anyway (an agent's click and a
      // person's look the same from here) — because a page derived from a task's page
      // belongs to that task (plan §22, 第十一轮). That is what makes a conversation's pages
      // a group rather than a list of pages it happened to open: the link it could not
      // follow itself still lands in its group, and `close` cleans up the whole task.
      // A page opened from a page nobody owns stays nobody's: no owner is invented.
      const openedTabId = this.createTab(instance.id, {
        url: details.url,
        // A link is clicked in order to be looked at; a page the site opened in the
        // background asked not to be brought forward.
        activate: details.disposition !== 'background-tab',
        afterTabId: tab.id,
        disposition: details.disposition === 'new-window' ? 'popup' : 'link',
        belongsTo: tab.belongsTo,
      })

      mainLog.info(`[browser-pane] window-open opened as a page id=${instance.id} tab=${openedTabId} after=${tab.id} url=${details.url}`)
      return { action: 'deny' }
    })

    pageWc.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })
  }

  /**
   * Where one page is: the part of a page that outlives the moment it is read
   * (plan §22).
   *
   * Split out of {@link toTabSummary} because a pick needs exactly these answers
   * about the page it happened on — and nothing else — and a second producer of
   * "which prototype, which page, which URL" is how a picked element and the tab
   * strip would come to disagree about where the user was standing.
   */
  private describePageLocation(tab: BrowserTab): PickedElementOrigin {
    const binding = this.tabPrototypeBinding(tab)
    return {
      // -- Observation: what the page itself reports --
      url: tab.currentUrl,
      title: tab.title,
      prototype: binding ? { slug: binding.slug, origin: binding.origin } : null,
      // Which page of it, asked of the prototype's own page table — a URL cannot
      // answer this for an overlay (someone else's address) and should not be
      // trusted to for a page of ours either.
      prototypePage: binding
        ? this.prototypePageResolver?.(binding.slug, binding.origin, tab.currentUrl) ?? null
        : null,
    }
  }

  /**
   * One page, as everything outside this file reads it (plan §22).
   *
   * **The single place a page becomes a wire shape**, so the toolbar's strip, the
   * panel's list and the agent's `tabs` command cannot describe the same page
   * differently. The two halves are kept in the order the type declares them: what
   * the page reports, then what its opener said about it.
   */
  private toTabSummary(instance: BrowserInstance, tab: BrowserTab): BrowserTabSummary {
    return {
      id: tab.id,
      ...this.describePageLocation(tab),
      favicon: tab.favicon,
      isLoading: tab.isLoading,
      active: tab.id === instance.activeTabId,
      // -- Declaration: whose work it is --
      belongsTo: tab.belongsTo,
      driverSessionId: tab.driverSessionId,
      // Which conversation works from this page, when one does (plan §22, 第十轮).
      cursorOf: tab.cursorOf,
      // -- The lock: who is working on this page right now, and only while they are --
      lockedBy: tab.heldBy,
      // How the browser asked for it, when it did (plan §22).
      disposition: tab.disposition,
    }
  }

  private toInfo(instance: BrowserInstance): BrowserInstanceInfo {
    return {
      id: instance.id,
      url: activeTab(instance).currentUrl,
      title: activeTab(instance).title,
      favicon: activeTab(instance).favicon,
      isLoading: activeTab(instance).isLoading,
      canGoBack: activeTab(instance).canGoBack,
      canGoForward: activeTab(instance).canGoForward,
      tabs: instance.tabs.map((tab) => this.toTabSummary(instance, tab)),
      prototypeSlug: this.prototypeBindingFor(instance)?.slug ?? null,
      isVisible: instance.isVisible,
      // Any conversation working in this window at all — the window-level indicator. Which
      // page each one holds is the page's own answer (`lockedBy`, per tab).
      agentControlActive: instance.controlBy.size > 0,
      themeColor: activeTab(instance).themeColor,
      workspaceId: instance.workspaceId,
    }
  }

  private emitStateChange(instance: BrowserInstance): void {
    if (!this.instances.has(instance.id)) {
      return
    }
    this.stateChangeCallback?.(this.toInfo(instance))
  }
}
