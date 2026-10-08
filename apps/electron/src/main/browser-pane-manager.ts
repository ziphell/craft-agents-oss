/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */

import { join, parse as parsePath } from 'path'
import { existsSync, rmSync } from 'fs'
import {
  validateFilePath,
  getWorkspaceAllowedDirs,
  type DrawioRenderOptions,
  type RenderedDrawioFile,
  type ISessionManager,
} from '@craft-agent/server-core/handlers'
import { BrowserView, BrowserWindow, WebContentsView, app, ipcMain, nativeTheme, screen, session, shell, type Session as ElectronSession } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { BrowserCDP, type AccessibilitySnapshot, type ElementGeometry, type OverlayLabels } from './browser-cdp'
import { registerLocalOriginHandler } from './local-origin-router'
import { applyLowEntropyClientHints, currentClientHintIdentity } from './browser-client-hints'
import { sampleVideoFrames } from './video-frames'
import * as drawioRender from './drawio-render'
import { TabRecorder, type TabRecordingState } from './tab-recorder'
import {
  RECORDING_OBSERVER_KEY,
  RECORDING_SIGNAL_PREFIX,
  buildRecordingObserverOffSource,
  buildRecordingObserverSource,
  parseRecordingSignal,
} from './recording-observer'
import { SessionRecordings } from './session-recordings'
import { openRecordingEncoder } from './recording-encoder'
import type {
  BrowserFetchedResource,
  BrowserFinishedRecording,
  BrowserRecordingRef,
  BrowserStartRecordingArgs,
  BrowserStartRecordingResult,
  BrowserStopRecordingResult,
} from '@craft-agent/shared/agent/browser-pane'
import {
  type BrowserEmptyStateLaunchPayload,
  type BrowserEmptyStateLaunchResult,
  type BrowserInstanceInfo,
} from '../shared/types'
import { BACKGROUND_HEX, DEFAULT_THEME, getBackgroundColor, loadAppTheme, getAllowRemoteEvaluate, CONFIG_DIR } from '@craft-agent/shared/config'
import { CodedError, RPC_CHANNELS, describeWork, sameWork, tabSectionOf } from '@craft-agent/shared/protocol'
import type { PickedElement, PickedElementOrigin, BrowserToolbarAction, BrowserTabSummary, TabBelongsTo } from '@craft-agent/shared/protocol'
import { PAGE_PANEL_RING, resolvePagePanelRing } from '../shared/browser-live-fx'
import { PANEL_EDGE_INSET, PANEL_RADIUS_INNER } from '../shared/panel-geometry'
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
 * file has to agree with it — the tab starts below it, the overlay is inset by
 * it, `viewport-resize` adds it back. Which is why its height is one constant
 * rather than a number written out where it is needed.
 */
const TOOLBAR_HEIGHT = 48
/**
 * The tab rail's width: the strip of tabs down the window's left edge.
 *
 * The tabs are a **column, not a row**, so the chrome takes its room from the
 * window's width instead of its height: a tab keeps every pixel of height it had
 * (which is what a page's layout, a screenshot and the agent's viewport all
 * care about), and the rail is where a person's `+`, the tab chips and their close
 * buttons live. A row across the top ate the tab's height and its own content
 * scrolled sideways, which is how it ended up unusable.
 */
const TAB_RAIL_WIDTH = 200
/**
 * The width a browser window's **page** opens at.
 *
 * The window is not the viewport: the rail takes `TAB_RAIL_WIDTH` off the side and the page panel
 * is inset by the gutter (`pageAreaBounds`), so the window opens that much wider — the same sum
 * `resizeViewport` does in reverse, for the size a window is born with.
 */
const DEFAULT_VIEWPORT_WIDTH = 1024
const MAX_CONSOLE_LOG_ENTRIES = 500
const MAX_NETWORK_LOG_ENTRIES = 500
const MAX_DOWNLOAD_LOG_ENTRIES = 200
/**
 * A ceiling on what `fetchResource` will hand back, for the caller that names none.
 *
 * A refusal after the fact is not a refusal: the bytes have already crossed the bridge by then. So
 * the caller's own limit is what is enforced, and this is only the backstop for a caller that
 * forgot to have one.
 */
const MAX_FETCHED_RESOURCE_BYTES = 32 * 1024 * 1024
/**
 * How many of a window's downloads the chrome lists.
 *
 * The list exists to answer "where did that go", which is a question about the last few
 * minutes, not about everything a workspace has ever downloaded — the whole log is kept
 * (`downloadsByWorkspace`) and the agent's `downloads` command reads it.
 */
const TOOLBAR_DOWNLOAD_LIST_LIMIT = 8
/**
 * How often a download in progress may push a toolbar update.
 *
 * Electron reports progress on every chunk, and the chrome only draws a percentage: a
 * push per chunk would serialize the whole toolbar state hundreds of times for a file
 * nobody is watching. The start and the end push at once; the middle is sampled.
 */
const TOOLBAR_DOWNLOAD_PROGRESS_MS = 300
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_POLL_MS = 100
/** How many goes a capture gets where the tab already has a surface to copy. */
const SCREENSHOT_CAPTURE_ATTEMPTS = 3

const SCREENSHOT_RETRY_DELAY_MS = 120
const SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 1_000
const SCREENSHOT_NETWORK_IDLE_MS = 300
/**
 * How long a single capture may take before it counts as no image at all.
 *
 * A live surface answers in tens of milliseconds (measured: 10–68ms across every combination in
 * `apps/electron/spike/screenshot-e2e.cjs`); this bound is for the case that never answers at all.
 */
const SCREENSHOT_CAPTURE_TIMEOUT_MS = 1_000
/**
 * How long a parked view is given to produce its first frame (`captureWhileParked`).
 *
 * One frame at 60Hz, which is what the measurement showed is needed: nothing at all is not enough,
 * and 16ms, 32ms and 200ms all are. It is also the whole of what the shot waits on.
 */
const SCREENSHOT_FIRST_FRAME_MS = 16
/**
 * How far past the last display a window that must never be seen is *asked* to go.
 *
 * "Off screen" is not a place, it is a relation to the displays — and the displays move: a screen
 * plugged in to the right of the old spot, a scaling change (which rescales every coordinate), or
 * the desktop's own habit of bringing a window it judges unreachable back onto a screen. 400 DIPs —
 * what this used to be — is about one dragged window away, so a second screen arriving put the
 * parking window on it (the person's report: "你的停车窗太靠近屏幕了").
 *
 * It is a request, not a fact: measured, the desktop caps it and quietly lands the window on its own
 * limit (20_000, 100_000 and 1_000_000 all came back as **16_383** DIPs), while a view that far out
 * still has its viewport and its picture exactly as it does at 400. So this constant only has to be
 * "more than any desk", and `keepOffEveryDisplay` is what actually holds the window off the screens.
 */
const OFFSCREEN_PARK_MARGIN = 20_000
/** Only ever seen inside this file: how a capture that never answered names its own error. */
const SCREENSHOT_CAPTURE_TIMEOUT_MARKER = 'capture did not come back'

/**
 * What a page's own view is backed with — the browser's default canvas, not the app's surface.
 *
 * A document that paints nothing (no `theme-color`, no `html`/`body` background, no full-width
 * bar: measured on `www.baidu.com/more/`) is a **light** page that leaves the canvas to the
 * browser, and the browser's canvas is white. Painting the app's surface here instead put the
 * app's dark background (`#080a10`) behind the page's black text in dark mode — the whole page
 * read as black-on-black. The app's surface belongs *outside* the page's rectangle (the gutter,
 * `#mask`, and the window's own `backgroundColor`), which is where it still is.
 *
 * Deliberately not theme-derived: this is the one colour in the pane that is not the app's to
 * choose, and a value that follows the theme would also leave a tab created before a theme
 * switch wearing the old one.
 */
const PAGE_VIEW_BACKDROP = '#ffffff'

const THEME_COLOR_SIGNAL_PREFIX = '__craft_theme_color__:'
const THEME_COLOR_NULL_SENTINEL = '__NULL__'
const THEME_OBSERVER_MIN_INTERVAL_MS = 120
const EARLY_THEME_EXTRACTION_DELAY_MS = 100
const BROWSER_EMPTY_STATE_FILE = 'browser-empty-state.html'
const CRAFT_DEEPLINK_SCHEME_PREFIX = `${process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'}://`

/**
 * A load that a **newer navigation aborted**, as opposed to one that failed.
 *
 * `ERR_ABORTED` (`errno: -3`) is what Chromium reports when something else took
 * the WebContents over — creating a window and pointing it somewhere in the same
 * breath does exactly that to the empty-state document.
 *
 * Electron delivers that abort to whichever `loadURL` promise is *current*, not
 * to the one that was superseded, so a navigation that succeeded rejects with the
 * **previous** document's abort. Read as a failure it says "navigate failed"
 * about a tab that is on screen — and the two fields that would identify it are
 * empty in practice (`{"errno":-3,"code":"","url":"file:///…/browser-empty-state.html"}`),
 * so `errno` is the one to match on.
 *
 * Returns the URL the aborted load was for, or null when this is a real failure.
 */
function abortedLoad(error: unknown): { url: string | null } | null {
  const fields = error as { errno?: number; code?: string; url?: string } | null
  const message = error instanceof Error ? error.message : ''
  const aborted = fields?.errno === -3 || fields?.code === 'ERR_ABORTED' || message.includes('ERR_ABORTED')
  return aborted ? { url: fields?.url ?? null } : null
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
  TABS: 'browser-toolbar:tabs',
  DEVTOOLS: 'browser-toolbar:devtools',
  RECORD: 'browser-toolbar:record',
  /**
   * The encoded bytes, one message each.
   *
   * Its own channel rather than an action on `RECORD` because it is the one message here
   * that is not a command: it arrives on every `dataavailable`, and a recording's last
   * chunk must be on disk before the stop that follows it — one channel, in order, is what
   * makes that true.
   */
  RECORD_CHUNK: 'browser-toolbar:record-chunk',
  /**
   * Show a finished download where it landed.
   *
   * The chrome knows a file's name and path from the state push; revealing it is the one
   * thing it cannot do itself, because a reveal is the OS's.
   */
  DOWNLOAD_REVEAL: 'browser-toolbar:download-reveal',
} as const
export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane'
const SESSION_PARTITION = BROWSER_PANE_SESSION_PARTITION

/**
 * The container the record button asked for, from the set it may ask for.
 *
 * The chrome picks the format — it is the side that has `MediaRecorder`, and the file has
 * to be named for what is about to be written into it, so the extension has to come from
 * there. Taken from a list rather than trusted: this ends up in a file name, and a name the
 * other side invents is what a path traversal looks like. The list holds one entry because a
 * recording is one container (`shared/recording-formats.ts`); anything else is not a name we
 * take, and the answer to a name we do not take is the container we do write.
 */
const RECORDING_EXTENSIONS = new Set(['mp4'])
function recordingExtension(requested: string | undefined): string {
  const wanted = (requested ?? '').toLowerCase().replace(/^\./, '')
  return RECORDING_EXTENSIONS.has(wanted) ? wanted : 'mp4'
}

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
 * Per conversation rather than per window: several conversations
 * work in one window at the same time, each on its own tab, so "what is being done"
 * has one answer per session — see {@link BrowserInstance.controlBy}.
 */
interface AgentControlLabel {
  displayName?: string
  intent?: string
}

/**
 * One tab of a window.
 *
 * A window shows exactly one tab at a time, and everything that is a fact about
 * *what is being shown* lives here rather than on the window: the view, its CDP
 * session, the address, the title, the console, and whose work it is. A window
 * used to carry the identity of the thing being worked on, which is what made
 * "one window, one thing, one tab" structural; moving it here is what lets one
 * window hold several tabs at once.
 *
 * Deliberately not a "browser tab" in the chrome sense: nothing here is about
 * ordering, pinning or persistence. It is the unit the agent addresses.
 */
interface BrowserTab {
  id: string
  /**
   * The page: a `WebContentsView`, because the page's own corners are rounded by the view
   * itself and only that class can do it (`applyPageCornerRadius`). Everything else in the
   * window is still a `BrowserView`; the two share one view tree, so they stack against each
   * other normally (one is added through `contentView`, the other through `addBrowserView`).
   *
   * The ground it sits on is the window's, not this tab's: `BrowserInstance.nativeOverlayView`.
   */
  tabView: WebContentsView
  cdp: BrowserCDP
  currentUrl: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /**
   * The **work this tab is part of** — whose tab it is, or `null` for a person's.
   *
   * Written by whoever created it (a person through the toolbar or the panel, or the agent
   * through `tab-new` or the menu's "New tab") and inherited by tabs derived from it; nothing
   * rewrites it afterwards. It lives here rather than being inferred
   * because an agent has to leave other people's tabs alone, and no URL says which ones
   * those are.
   *
   * It is the **work** rather than the conversation: a tab outlives the session
   * that opened it, so a DAG node's tab says which task and which node it is for and a
   * re-run of that node inherits it instead of orphaning it. Which conversation moved the
   * tab last is {@link drivenBy}'s answer and which one is inside it right now is
   * {@link heldBy}'s.
   *
   * `openedBy: 'user' | 'agent'` is a rendering of this, produced where words are needed
   * (`toTabSummary`, the agent's `tabs` output) rather than stored as well.
   */
  belongsTo: TabBelongsTo | null
  /**
   * Which session drove this tab last, or `null` when nobody has.
   *
   * One per tab, and a session may have several — so unlike the cursor (one per session)
   * and the hold (one per session, while it works) this is not a claim of its own: it
   * answers "who has been moving this tab", which is what the rail's plain dot draws and
   * what `tabs` reports as `driven by`. Nothing reads it to decide anything — no routing,
   * no reach, no lock.
   *
   * Written by every command that resolves to the tab, and by a tab being born for a
   * session; swept when that session's work ends (not when the turn ends — a turn takes
   * only the hold) or when the tab changes hands (`assignTab`).
   *
   * Named `driverSessionId` and described as the tab's **lease** until the word was retired:
   * "lease" promised exclusivity and expiry that this fact
   * never had, and the four places describing it disagreed — one called it "who is working
   * on it at the moment" (the hold's job), one "one tab at a time" (the cursor's), one
   * "the lease plus the window being engaged" (the model before the hold became a field of
   * its own). The data never changed; the name and the prose did.
   */
  drivenBy: string | null
  /**
   * The conversations that **work from** this tab, one entry each — their cursors, and `[]`
   * when it is nobody's.
   *
   * One entry per conversation, which is why it lives on the tab: "where does my next command
   * go when I name no tab" has to have exactly one answer, and the answer must not be "wherever
   * the window happens to be showing" — that is the person's cursor, and it moves whenever they
   * click.
   *
   * **Several conversations may be in it at once**. The list used to hold
   * a single id, and that one slot was the whole reason a conversation's tab was out of reach for
   * everyone else: letting a second one in would have meant overwriting the first one's answer,
   * sending its next unnamed command wherever the person happened to be looking. A person's tab is
   * where the person is looking, so whoever they are talking to works there — with one cursor each,
   * nobody's route has to be overwritten for that to be true. It is a **route, not a claim**: what
   * keeps two conversations out of the tab at the same moment is the hold ({@link heldBy}).
   *
   * Sticky across turns, unlike {@link drivenBy}: a conversation that comes back after its turn
   * ended still works from the same tab. Moved only by a command of that conversation that names a
   * tab or resolves to one — the person switching tabs does not move it — and given back only when
   * that conversation is **deleted** ({@link clearCursors}).
   */
  cursorOf: string[]
  /**
   * Which session is holding this tab **right now**, or `null` when nobody is — the tab
   * lock.
   *
   * Stated rather than derived: the tab is claimed when a command says it is the one being
   * worked on, and let go when that turn ends or the person takes it back. A held tab takes
   * no input from a person, and another conversation's commands that name it are refused —
   * while the chrome, the other tabs and the window itself stay usable.
   *
   * **Per tab, because several conversations work in one window at once**:
   * a DAG's child sessions run in parallel, each on its own tab. One slot per
   * window would mean the second conversation to start silently dropped the first one's
   * lock — which is exactly what parallel children ran into.
   */
  heldBy: string | null
  /**
   * How this tab came to exist, when the browser asked for it rather than a command
   * doing so.
   *
   * `'link'` for a `target="_blank"` (or any click that wants a window of its own),
   * `'popup'` for a scripted `window.open` with features — the OAuth-window shape.
   * `null` for every other way a tab is opened (the address bar, `tab-new`, the panel).
   *
   * Recorded because both are now played in the same window, which has one cost worth
   * being able to name: a tab opened this way has no `window.opener`, so a popup that
   * expects to `postMessage` back at the page that opened it (Google's sign-in is the
   * usual example) cannot. Reading the page's own report is not enough — the browser
   * said how it was requested, and only here is that kept.
   */
  disposition: 'link' | 'popup' | null
  themeColor: string | null
  inPageThemeTimer: ReturnType<typeof setTimeout> | null
  themeObserverToken: string | null
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
}

/** The bar's word when the caller brings none — see `armOverlay`'s own default. */
const DEFAULT_PICK_LABELS: OverlayLabels = {
  add: 'Add to conversation',
}

interface BrowserInstance {
  id: string
  window: BrowserWindow
  /**
   * Where every tab that is **not on screen** lives: a window of its own, outside every display,
   * shown but never seen.
   *
   * Shown, because a view in a window that is never shown is never composited — and a view that is
   * not composited has **no viewport at all** (`innerWidth` 0, no layout, input landing nowhere), so
   * a tab parked in an unshown window would lose the very layout the freeze keeps
   * (`apps/electron/spike/background-viewport.ts` section E). Outside every display, because a tab
   * that is not on screen must not be visible whatever size the person's window is; `skipTaskbar`,
   * because it is not a window of theirs. One per browser window, made when the first tab is parked
   * and destroyed with the window (`parkingWindowFor`).
   */
  parkingWindow: BrowserWindow | null
  /** The address bar, across the top of the window. */
  toolbarView: BrowserView
  /**
   * The tab rail, down the left edge — the tabs, vertically.
   *
   * Its own view rather than part of the address bar's: one `BrowserView` is one
   * rectangle, and the chrome is an L (a column and a row). Both are chrome and both
   * stay above the tab, so neither can be covered by it.
   */
  railView: BrowserView
  /**
   * The ground the page sits on: the surface in the gutter around the page and the panel's
   * hairline, and — while a conversation holds the tab on screen — the agent's frame, chip and
   * shield.
   *
   * The **window's**, not a tab's. What it draws is the same for every tab (the geometry is
   * constants, the colours come from the theme), and it has to be there *before* the page it
   * frames: a tab's page view is added on top of it. Built per tab it was a document to load
   * per tab, which is a panel whose line arrives a beat after the page does — visible every
   * time a tab is opened. Built here it is loaded once, before any page view exists, and a new
   * tab's page lands inside a frame that is already drawn.
   */
  nativeOverlayView: BrowserView
  nativeOverlayReady: boolean
  /**
   * The window's tabs, in the order they were opened.
   *
   * Always at least one: a window with no tabs is closed rather than left empty
   * (see `closeTab`). `activeTabId` names the one on screen; everything the rest
   * of this file calls "the window's address/title/console" is read
   * through {@link activeTab}, so a reader that says `activeTab(i).currentUrl` is
   * asking about the tab the user is looking at.
   */
  tabs: BrowserTab[]
  activeTabId: string
  /**
   * The address and title of the tab on screen — read-only window-level views of
   * the active tab.
   *
   * They exist because the rest of the app asks about *windows* (the toolbar's
   * state, and `BrowserInstanceSnapshot` in the server-side interface), and those
   * questions deserve the same answer this file uses internally rather than a
   * second copy that could drift. Read-only so the only way to change either is to
   * change the tab: a writer that tries `instance.currentUrl = …` gets a compile
   * error pointing at the tab instead of an assignment that goes nowhere.
   */
  readonly title: string
  readonly currentUrl: string
  /**
   * The workspace whose browser window this is — the one every conversation in
   * that workspace, and the user, work in, or `null` for a window
   * opened with no workspace context. Renderers in other workspaces filter such
   * entries out of the tab strip / status badge.
   *
   * Stamped at create-time and never rewritten, and it is the **whole** of the
   * window's identity: there is one window per workspace, so this is what keeps
   * two workspaces' windows apart and what every reach check is made against
   * (`instanceBelongsToWorkspace`). No session owns a window, and none is named
   * here: who is working in it is per tab (`BrowserTab.cursorOf` / `heldBy`),
   * because a parent and its children can be in it at once (Conductor).
   *
   * A window's scope rather than its purpose: the same one is where a general
   * task's browsing happens.
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
   * A map rather than the single slot this used to be: one window is
   * shared, and a parent's child sessions run in parallel, each holding its own tab. The
   * lock lives on the tab (`BrowserTab.heldBy`); this is only "who is working here and
   * what they are doing", which is what the overlay chip renders.
   */
  controlBy: Map<string, AgentControlLabel>
  lastLaunchToken: string | null
  /**
   * Whether the window's element overlay is **armed on this window**.
   *
   * A window's mode rather than a tab's, because the mode is what the user turned
   * on: they keep working on elements while they move between tabs, so the overlay
   * is re-armed on whatever tab comes to the front, and each selection carries the
   * tab it came from. One selection does not end it — that is what "resident" means
   * here — so it ends when the user says so (Escape in the page, or the toolbar
   * button).
   */
  picking: boolean
  /**
   * The bar's words, in the toolbar's language — kept for re-arming.
   *
   * The bar is drawn inside the page, which has no i18n; the toolbar renderer has.
   */
  pickLabels: OverlayLabels
  /**
   * Which tab the overlay is armed on, or `null` while the mode is off.
   *
   * Kept because the tab that has to be disarmed is the one the overlay is on,
   * and by the time a loop is torn down the tab on screen may be a different one
   * — the tab left behind would otherwise keep swallowing the user's clicks.
   */
  pickTabId: string | null
  /**
   * Which arming the running loop belongs to.
   *
   * Bumped whenever the loop is superseded (a different tab came forward, the mode
   * was turned off), so a loop that comes back after being torn down can tell that
   * it is no longer the one holding the window — and report nothing instead of
   * mistaking its own teardown for the user giving up.
   */
  pickerGeneration: number
}

/**
 * The tab on screen — the one everything window-level means.
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
  /** Return the incomplete image instead of failing when the region is bigger than the page painted. */
  force?: boolean
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
 * the agent addresses: one name for one tab, with no "of which window" to carry
 * alongside it (the window is already implied by the tab).
 */
let tabCounter = 0

/**
 * Where the person's recordings go: **one fixed folder**, not configurable.
 *
 * It is the app's own (`~/.craft-agent/records/`, or wherever `CRAFT_CONFIG_DIR` points), which is
 * what keeps a recording — and now the clicks and typed values beside it — out of a folder people
 * pass files around in. The toolbar says where the file went, and hovering that chip gives the
 * whole path, so nothing has to be guessed.
 */
function getPersonRecordsDir(): string {
  return join(CONFIG_DIR, 'records')
}

export class BrowserPaneManager implements IBrowserPaneManager {
  private instances: Map<string, BrowserInstance> = new Map()
  private destroyingIds: Set<string> = new Set()
  private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null
  private removedCallback: ((id: string) => void) | null = null
  private interactedCallback: ((id: string) => void) | null = null
  private partitionPermissionsInitialized = false
  private partitionDisplayMediaInitialized = false
  private partitionObserversInitialized = false
  private inFlightRequestsByWebContentsId = new Map<number, number>()
  private lastNetworkActivityByWebContentsId = new Map<number, number>()
  /**
   * The downloads of each **workspace**, oldest first.
   *
   * Keyed by the workspace rather than kept on a tab, and that is the whole reason this
   * is not a field of `BrowserTab`: a download does not belong to the tab it was started
   * from. The person closes the window while a file is still arriving, the file keeps
   * arriving (the *session* owns a download, not the view that asked for it), and the
   * next window in this workspace — a new instance, new tabs — still has to be able to say
   * what happened and where it went. Hung on the tab it would have gone with the tab,
   * which is exactly the silence the chrome's downloads button exists to end.
   *
   * One writer: `will-download`. Two readers of the same list: the chrome
   * (`pushToolbarState`) and the agent's `downloads` command (`getDownloads`). Neither of
   * them filters by tab, because neither of them means a tab — a window, and the
   * workspace behind it, is the unit both are asking about.
   *
   * `null` is its own bucket, the same convention windows use: a window with no workspace
   * context is not a window of anybody's workspace.
   */
  private downloadsByWorkspace = new Map<string | null, BrowserDownloadEntry[]>()
  private windowManager: WindowManager | null = null
  /**
   * Conversations, for the working directories a file may legitimately come from.
   *
   * Injected (see main/index.ts) once the session manager exists — it is created after
   * this manager. A conversation's working directory is settable and may sit outside
   * its workspace, so a file picked from there is still one the workspace showed and
   * must not be refused as "outside allowed directories".
   */
  private sessionManager: ISessionManager | null = null
  /**
   * What to call a conversation, for the tab rail's group headers. Injected
   * (see main/index.ts).
   *
   * A tab says who opened it by **session id**, and an id is not something a person
   * can tell one conversation from another by. This is a *name for a group*, not a
   * second owner: the grouping reads `belongsTo` and nothing here can change
   * it. `null` for a session that is gone or has no name yet, and the chrome falls
   * back to a generic label rather than showing an id.
   */
  private sessionLabelResolver: ((sessionId: string) => string | null) | null = null

  /**
   * The person's recording of a tab, if one is running.
   *
   * One per app rather than per window: the display-media handler answers per session,
   * and only one thing can be armed at a time anyway — the button is a person's, and a
   * person records one thing at a time.
   */
  /** The recorder, wired so that however a recording ends, the page's observer comes back out. */
  private readonly tabRecorder = this.createTabRecorder()

  private createTabRecorder(): TabRecorder {
    const recorder = new TabRecorder()
    // One place, not four call sites: the deadline and a tab going away never pass through the code
    // that started the recording, and those are the endings nobody is around to clean up after.
    recorder.onRecordingEnded = (tabId) => {
      void this.syncRecordingObserver(this.findInstanceByTabId(tabId)?.id ?? null, tabId)
    }
    return recorder
  }

  /**
   * A conversation's recordings — the frames, the encoder behind them, and the one place they end.
   *
   * The person's recordings never come through here: they are armed by the toolbar, delivered by
   * display media, and filed in downloads, all of which is that path's own.
   */
  private readonly sessionRecordings = new SessionRecordings({
    recorder: this.tabRecorder,
    openEncoder: openRecordingEncoder,
  })

  /**
   * How long one capture may take before it counts as no image at all
   * (`SCREENSHOT_CAPTURE_TIMEOUT_MS`), on the instance rather than read from the constant
   * so a test can hold a capture to a bound it can wait for.
   */
  private captureTimeoutMs = SCREENSHOT_CAPTURE_TIMEOUT_MS
  /**
   * Windows that are supposed to be off every display and would not go: remembered so the attempt to
   * move them is not repeated on every move event, and forgotten as soon as one is found clear (which
   * is what a person changing displays again can do — see `keepOffEveryDisplay`).
   */
  private parkingStuck = new WeakSet<BrowserWindow>()
  /** The one `screen` subscription that keeps parking windows off the displays, if any is live. */
  private displayWatcher: (() => void) | null = null
  /**
   * Whether a window that is not on screen can still be captured where it is.
   *
   * Not on Windows, where it was measured: a hidden window has no surface, and every path either
   * refuses or stops answering (`apps/electron/spike/capture-methods.cjs`), so a shot of a hidden
   * window goes straight to the parked view instead of paying the bound for an answer that is not
   * coming. On macOS Electron does answer for a hidden window, so it gets the first go there and the
   * parked view is the fallback — that side is Electron's documented behaviour, not something this
   * machine could measure.
   */
  private canCaptureHiddenWindows = process.platform !== 'win32'

  setWindowManager(windowManager: WindowManager): void {
    this.windowManager = windowManager
  }

  setSessionManager(sessionManager: ISessionManager): void {
    this.sessionManager = sessionManager
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
   * Build one tab: its page, its CDP session, and the state that starts empty. Nothing is
   * wired and nothing is laid out — `attachTab` does that, and every tab goes through both,
   * so a tab cannot be half-created.
   */
  private buildTab(ses: ElectronSession): BrowserTab {
    /**
     * The page is a `WebContentsView` rather than the deprecated `BrowserView` for one reason:
     * only the former can round its own corners (`setBorderRadius`). The page's panel look —
     * rounded corners with the surface showing outside them — is otherwise impossible without
     * drawing over the page, and anything drawn over the page swallows the person's clicks,
     * because a view covers a rectangle whatever it paints. See `applyPageCornerRadius`.
     */
    const tabView = new WebContentsView({
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        /**
         * Never throttled — for every tab, not only the one somebody works from.
         *
         * Every tab but the one on screen is covered by the view above it (the tab on screen,
         * or the window's overlay while that tab is held), and Chromium marks a covered page
         * **hidden**. A hidden page stops honouring the layout it is handed: with the window
         * grown while the page sat behind, its viewport kept the old size — measured in
         * `apps/electron/spike/resize-follow.cjs`, where a throttled covered page stayed at 573
         * as the window went 780 → 1420 while its unthrottled twin followed both ways. Growing
         * was what it ignored; shrinking still applied, which is what made this read as "it
         * follows one way only". Letting the page stay counted as visible is also what the rest
         * of this file assumes: a background tab keeps a real viewport, which is what
         * coordinates, scrolling and captures are read against (`layoutTabView`).
         */
        backgroundThrottling: false,
      },
    })

    return {
      id: `tab-${++tabCounter}`,
      tabView,
      cdp: new BrowserCDP(tabView.webContents),
      currentUrl: 'about:blank',
      title: 'New Tab',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      // A tab nobody said they asked for is nobody's: only the opener writes this,
      // and a tab the user opened has no session to name.
      belongsTo: null,
      drivenBy: null,
      cursorOf: [],
      heldBy: null,
      disposition: null,
      themeColor: null,
      inPageThemeTimer: null,
      themeObserverToken: null,
      consoleLogs: [],
      networkLogs: [],
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
    // Designs are served on this partition too, so a design can be opened as a tab and
    // read or driven with the browser tools. What a page here may reach is bounded by
    // the host, not by the partition: a design's `data/` is never served (see
    // design-preview-host).
    registerLocalOriginHandler(ses)
    this.setupSessionPermissions(ses)
    this.setupDisplayMediaHandler(ses)
    this.setupSessionObservers(ses)

    // Match background to current OS theme to prevent black/white flash on open. The same
    // value paints the page panel's surroundings in the overlay, so the two cannot disagree
    // about what "the surface" is.
    const bgColor = getBackgroundColor(nativeTheme.shouldUseDarkColors)

    // Where it opens is left to Electron on purpose (the person's call): a window is something
    // they move, snap and maximise, and a position computed from a work area we read once would
    // fight that — and on a small display it can put the window's top edge off the screen.
    //
    // The width is not left to Electron: it opens around a page `DEFAULT_VIEWPORT_WIDTH` wide, and
    // the rail beside it and the panel's gutter are what the window adds to that.
    const panelInset = this.pagePanelInsets()
    const window = new BrowserWindow({
      width: DEFAULT_VIEWPORT_WIDTH + TAB_RAIL_WIDTH + panelInset.left + panelInset.right,
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
    // A tab's background is set by `attachTab` — it belongs to the tab.
    toolbarView.setBackgroundColor('#00000000')

    // The same document, told to render the tab rail instead of the bar: one entry
    // point, one preload, one state channel, two surfaces.
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
    railView.setBackgroundColor('#00000000')

    /**
     * The ground the page sits on, built here rather than per tab: created before any page
     * exists and loaded once, so a tab opened later has a frame around it from its first
     * frame instead of one that arrives with the document (see
     * {@link BrowserInstance.nativeOverlayView}).
     */
    const nativeOverlayView = new BrowserView({
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    nativeOverlayView.setBackgroundColor('#00000000')

    // A window is *opened on* something, so it starts with one tab; the tabs a
    // user adds afterwards go through `createTab`.
    const tab = this.buildTab(ses)

    const instance: BrowserInstance = {
      id: instanceId,
      window,
      parkingWindow: null,
      toolbarView,
      railView,
      nativeOverlayView,
      nativeOverlayReady: false,
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
      pickLabels: DEFAULT_PICK_LABELS,
      pickTabId: null,
      pickerGeneration: 0,
      // What the window *is showing*, as one value, because `BrowserInstanceSnapshot`
      // (what the server side reads, and what the toolbar's state reports) is phrased
      // in terms of the window: "the window's address" has to mean "the address of the
      // tab on screen" without every caller learning about tabs. Read-only on purpose
      // — the way to change either is to change the tab, and a compile error pointing
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
    // The ground goes in before the page does: a tab's page view is added *on top* of it
    // (`attachTab`), which is what makes the panel's line sit under the page's edge.
    window.addBrowserView(nativeOverlayView)
    this.raiseChromeViews(instance)

    this.attachTab(instance, tab)

    this.layoutAllViews(instance)

    this.setupWindowListeners(instance)
    this.instances.set(instanceId, instance)
    this.loadNativeOverlay(instance)
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
    // The rail is chrome too, and it is the only way a person adds or closes a tab
    // from inside the window — so it gets the same load-and-retry the bar has. It does
    // not gate showing the window: a window whose rail failed is still a window.
    void this.loadChromePage(instance, 'rail')
    void this.loadEmptyStateDocument(instance).catch((error) => {
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

      void tab.tabView.webContents.loadURL('about:blank').catch((fallbackError) => {
        mainLog.warn(`[browser-pane] about:blank fallback failed id=${instance.id}: ${String(fallbackError)}`)
      })
    })

    return instanceId
  }

  /**
   * Add a tab to a window.
   *
   * The new tab becomes the active one: a tab is added in order to be looked at,
   * and a caller that wants it in the background (the agent opening something to
   * read later) says so with `activate: false`.
   *
   * A window with tabs of its own is what makes several pages workable at once;
   * the window itself stays one window.
   *
   * **A window that is still untouched is opened into rather than beside.** A
   * window comes back from `createForSession` holding one blank tab — what a
   * window is made of before it is used — and adding next to it would leave that
   * blank tab behind, so opening something into a fresh window would be two
   * tabs instead of one. "Untouched" is the whole window, not just the tab on
   * screen: a window with real tabs in it gets a real new tab.
   *
   * That reuse needs the request to be for **a** tab rather than **another** tab:
   * something to put in the window (`url`), or a caller that says so
   * outright ({@link BrowserTabCreateOptions.reuseUntouchedWindow} — the menu's "New
   * tab", which opens the window if it is not up yet). A bare "add a tab" — the
   * rail's `+`, `tab-new` with no address — is somebody asking for one more tab, and
   * reusing the blank one would swallow the request: the window would keep its single
   * tab and nothing would appear to happen, which is exactly how a person reads "new
   * tab is broken".
   */
  createTab(
    instanceId: string,
    options?: {
      url?: string
      activate?: boolean
      /**
       * Whose tab this is: the **work** of the conversation asking for it, or `null` for a
       * person's tab — see {@link BrowserTab.belongsTo}.
       *
       * A tab opened *for* a conversation also becomes the tab it works from, and starts
       * with that conversation's lease (the work's own `sessionId`); a tab merely derived
       * from one of its tabs (`afterTabId`) only joins its group, which is why the browser's
       * own window-open channel passes the tab it was opened from's work here.
       */
      belongsTo?: TabBelongsTo | null
      /**
       * The **person** opened this one, for the work above rather than as part of it.
       *
       * The rail's "new tab in this section": somebody setting a page up for a conversation
       * to carry on from. Everything else follows from `belongsTo` — the tab
       * groups with that work and becomes the tab its conversation reaches for — but the
       * **lease** is not taken, because "last moved by" would be the person: the rail's
       * in-use mark would otherwise appear on a tab no agent has touched. {@link assignTab}
       * hands a tab over on exactly these terms.
       */
      openedByPerson?: boolean
      /**
       * Open it **right after** this tab instead of at the end of the strip.
       *
       * A tab the browser asked for belongs next to the tab that asked: a link
       * opened from a screen is about that screen, and a tab at the far end of the
       * strip reads as unrelated to what was on screen.
       */
      afterTabId?: string
      /** How the browser asked for it, when it was the browser — see {@link BrowserTab.disposition}. */
      disposition?: 'link' | 'popup' | null
      /**
       * The caller wants *a* tab to use, not *another* tab — see the note above.
       *
       * It has nothing to put in the window and no identity to give the tab, so this
       * is the only way it can say what it means; a window that has never been used
       * already holds the blank tab it is asking for.
       */
      reuseUntouchedWindow?: boolean
    },
  ): string {
    const instance = this.requireAliveInstance(instanceId)

    // "Untouched" only counts when the request is for a tab rather than for one more
    // tab. A tab the browser asked for belongs *beside* the one that asked for it, and
    // that tab is in use by definition — reusing it would take away the tab the link
    // was clicked on.
    const wantsATab = Boolean(options?.url) || options?.reuseUntouchedWindow === true
    const unwritten =
      wantsATab && !options?.afterTabId && instance.tabs.length === 1 && instance.tabs[0].currentUrl === 'about:blank'
        ? instance.tabs[0]
        : null

    if (unwritten) {
      if (options?.belongsTo !== undefined) {
        unwritten.belongsTo = options.belongsTo ?? null
        // Someone is about to work on it, so it is not left looking idle.
        unwritten.drivenBy = options.belongsTo?.sessionId ?? null
        // …and it is where they work from: a tab a conversation opened is the tab its
        // next unnamed command means.
        if (options.belongsTo) {
          this.recordSessionTab(instance, unwritten.id, options.belongsTo.sessionId)
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
    // A tab the browser derived from another one (`afterTabId`: it was a link or a popup on
    // the tab that asked) **joins that tab's group and nothing else**: no lease, no cursor,
    // no lock. Group membership is inherited; the fact that somebody is *working* here is not
    // — a person following a link inside a task's tab must not retarget that task, and must
    // not make the window say the task's conversation is driving the new tab either.
    const derivedFromAnotherTab = Boolean(options?.afterTabId)
    if (!derivedFromAnotherTab && !options?.openedByPerson) {
      // Whoever opened a tab is working on it: the lease starts where the tab does,
      // so a conversation that just opened something does not have to touch it twice
      // before the window says what is going on.
      tab.drivenBy = tab.belongsTo?.sessionId ?? null
    }

    const afterIndex = options?.afterTabId
      ? instance.tabs.findIndex((candidate) => candidate.id === options.afterTabId)
      : -1
    if (afterIndex >= 0) instance.tabs.splice(afterIndex + 1, 0, tab)
    else instance.tabs.push(tab)

    // …and it becomes the tab they work from, for the same reason.
    // After the tab is in the window: the cursor is written on the tab, so the tab has
    // to be findable by id when this runs.
    if (!derivedFromAnotherTab && tab.belongsTo) {
      if (options?.openedByPerson) {
        // The person's tab for a conversation is still the tab that conversation reaches
        // for — that is the whole point of preparing one — but the cursor comes without
        // the lease: the person moved this tab, not the conversation (`assignTab`).
        this.pointConversationAt(instance, tab.id, tab.belongsTo.sessionId)
      } else {
        this.recordSessionTab(instance, tab.id, tab.belongsTo.sessionId)
      }
    }

    this.attachTab(instance, tab)

    if (options?.activate ?? true) {
      this.activateTab(instanceId, tab.id)
    } else {
      // A tab added behind the one on screen still changes the window's chrome:
      // the strip has to appear, and the room for it was made above.
      this.layoutAllViews(instance)
      this.emitStateChange(instance)
      this.pushToolbarState(instance)
    }

    if (options?.url) {
      this.loadTab(instance, tab, options.url)
    } else {
      // A tab nobody gave an address to still has to show something: see
      // `startEmptyStateLoad` for why "nothing" is not one of the things it can show.
      this.startEmptyStateLoad(instance, tab)
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
      belongsTo?: TabBelongsTo | null
      afterTabId?: string
      disposition?: 'link' | 'popup' | null
      reuseUntouchedWindow?: boolean
    },
  ): Promise<string> {
    return this.createTab(instanceId, options)
  }

  /** Send a tab somewhere without waiting: a tab is opened before it is read. */
  private loadTab(instance: BrowserInstance, tab: BrowserTab, url: string): void {
    void tab.tabView.webContents.loadURL(url).catch((error) => {
      mainLog.warn(`[browser-pane] new tab failed to load id=${instance.id} tab=${tab.id}: ${String(error)}`)
    })
  }

  /**
   * Put one tab on screen.
   *
   * Everything the window reports — address, title, console, what the
   * toolbar's actions would act on — follows from here, because all of it is read
   * through the active tab. The toolbar is told the whole state again rather than
   * a delta: it is a snapshot by construction, and a delta would be a second
   * description of the same thing.
   *
   * This is the *display's* verb: the person switching tabs, and the agent's one
   * explicit "bring it forward" (`browser_tab_activate`). The keyboard goes with the display:
   * the tab that comes on screen is the one the person types into
   * ({@link focusTheTabOnScreen}), and each tab keeps its own focused element, so coming back
   * to a tab comes back to where they were. A command no longer comes
   * through here — it records the tab it works from and leaves the window where it is
   * ({@link setSessionTab}), because moving the person's view is not a command's to do.
   */
  activateTab(instanceId: string, tabId: string): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no tab "${tabId}".`)

    if (instance.activeTabId === tab.id) {
      // A tab that is already showing still has to be handed the keyboard — that is what a person
      // clicking their own tab means — and nothing about it moves.
      this.focusTheTabOnScreen(instance, tab)
      return
    }

    // The developer tools inspect the tab that is on screen, so they leave with the tab
    // that is leaving: the window must never show one page while its tools describe
    // another (`toggleTabDevTools`).
    this.closeTabDevTools(activeTab(instance))

    instance.activeTabId = tab.id
    this.forceCloseToolbarMenu(instance, 'tab-switch')
    this.layoutAllViews(instance)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    this.pushToolbarState(instance)
    // The picker is the window's mode, so it follows the tab that just came
    // forward: the user keeps picking across tabs, and this is where
    // "any tab's elements can be picked" is made true.
    if (instance.picking) this.armPickerOn(instance, tab)
    // **After** the layout, never before: the tab that just came forward has been moved out of the
    // parking window and raised in this one, and a view that is about to be handed to another window
    // cannot hold the keyboard — asking for it first is asking the wrong view (measured: the focus
    // is lost by the move).
    this.focusTheTabOnScreen(instance, tab)
    mainLog.info(`[browser-pane] Tab activated instance=${instance.id} tab=${tab.id} url=${tab.currentUrl}`)
  }

  /**
   * The keyboard belongs to the tab that is on screen — and only ever inside the window the
   * person is already in.
   *
   * Chromium hands a page the focus when that page commits, and it does not ask which tab is
   * showing: a tab opened behind the person's (`activate: false`) takes the caret out of
   * whatever they were typing into, and the page sees its own `blur` — measured, with the
   * cursor in a field on the tab on screen: opening an agent's tab behind it left that tab
   * with `document.hasFocus() === false` and fired the field's `blur`, and switching back to
   * it did not bring the caret back, because nothing here ever asks for the focus back. What
   * a browser does instead is what this is: the tab that comes on screen takes the keyboard
   * ({@link activateTab}), and a tab that loads while another one is on screen gives it
   * straight back (`did-navigate`).
   *
   * The window check is the whole reason this is not just `webContents.focus()`: that call
   * activates the window when it is not active (measured: the app's window came forward over
   * another window), and a conversation working in the background must never pull the window
   * in front of what the person is doing.
   */
  private focusTheTabOnScreen(instance: BrowserInstance, tab: BrowserTab): void {
    if (instance.window.isDestroyed() || !instance.window.isFocused()) return
    const tabWc = tab.tabView.webContents
    if (tabWc.isDestroyed() || tabWc.isFocused()) return
    tabWc.focus()
  }

  /**
   * "This conversation works from this tab" — recorded without moving the window.
   *
   * The whole of a command's routing: this tab becomes the one the conversation's next
   * unnamed command lands on, the one its lock is on while it works, and the one Chromium
   * is asked to treat as in front so the site behaves the same as it would on screen.
   *
   * Nothing about the display changes, and that is the point: the person may be looking at
   * another tab of the same window — they opened it, or they went back — and an agent
   * working in the background must not take them off it. It is also why this exists next to
   * `activateTab` rather than inside it: the two facts used to always happen together, and
   * now they do not.
   */
  setSessionTab(instanceId: string, tabId: string, sessionId: string): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no tab "${tabId}".`)

    this.recordSessionTab(instance, tab.id, sessionId)
    // The shield depends on which tab is held, so the overlay hears about it — and it has
    // to, even when the tab was already the one on screen (the cursor moves without the
    // display moving).
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    this.pushToolbarState(instance)
  }

  /**
   * Close one tab.
   *
   * Closing the last one closes the window: a window with no tabs is not a state
   * the rest of this file would know how to be in, and "no tabs" is what closing
   * the last tab means to a person anyway.
   *
   * Which tab takes over is {@link successorOf}'s to decide.
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
    const wcId = tab.tabView.webContents.id
    this.inFlightRequestsByWebContentsId.delete(wcId)
    this.lastNetworkActivityByWebContentsId.delete(wcId)

    // A recording follows a tab, so the tab going away ends it — with what was captured
    // kept: somebody was recording something, and part of it happened. Nobody else can
    // say "stop" for a file whose tab is closed, so this is the one that must. Every
    // recording of this tab ends, whoever owns it — the person's and any conversation's.
    if (this.tabRecorder.stopIfSource(wcId).length) this.pushToolbarState(instance)
    // A conversation's recording of this tab ends here too, and through its own service — which
    // stops the capture and waits for the encoder before the file settles.
    this.sessionRecordings.endForTabs([tab.id])

    // A lock never outlives what it locks: closing the tab a session was holding lets go
    // of it here, rather than leaving the window claiming a tab that is gone.
    // The cursor needs no such care — it lived on the tab and went with it.
    this.releaseHeldTab(instance, tab.id)

    // A mode armed on a tab that is going away goes with it: leaving the picker
    // armed on a tab nobody can see would be a mode with nothing to click.
    if (instance.pickTabId === tab.id) {
      instance.pickTabId = null
      void tab.cdp.teardownOverlay()
    }

    // Out of the window and gone — `instance.tabs` is not the window's view list.
    this.detachTab(instance, tab)

    if (instance.activeTabId === tab.id) {
      const next = this.successorOf(instance, tab, index)
      if (next) {
        instance.activeTabId = next.id
        this.forceCloseToolbarMenu(instance, 'tab-closed')
        this.layoutAllViews(instance)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
        this.pushToolbarState(instance)
        // Whatever tab the window shows next is where an armed picker belongs.
        if (instance.picking) this.armPickerOn(instance, next)
        // The keyboard goes with the display here too, and **after** the layout for the same reason
        // as `activateTab`: the tab that takes over has just been moved into this window.
        this.focusTheTabOnScreen(instance, next)
      }
    } else {
      // Closing a tab the window was not showing still shrinks the chrome when it
      // was the second-to-last one, so the layout and the toolbar both have to
      // hear about it even though the tab on screen did not change.
      this.layoutAllViews(instance)
      this.emitStateChange(instance)
      this.pushToolbarState(instance)
    }

    mainLog.info(`[browser-pane] Tab closed instance=${instance.id} tab=${tab.id} remaining=${instance.tabs.length}`)
  }

  /**
   * Which tab takes over when one closes.
   *
   * Its **own section's** neighbour first: a section is what the rail draws (and
   * `tabSectionOf` is the one definition of it — see the note there), and somebody closing a
   * page they opened for a conversation means the next page of *that* conversation, not the tab
   * that happened to sit beside it in the window's list — which may belong to nobody, or to
   * another conversation entirely. The person's own tabs are a section like the rest, so theirs
   * hands over inside itself too.
   *
   * The direction is the browser's: the tab **after** it, and the one before it when it was the
   * last of its section (or of the window). Only a section with nothing left in it hands over
   * outside itself — which this rule makes rare rather than forbids: the alternative would be
   * dragging the person into another conversation's page because that was the neighbour.
   */
  private successorOf(instance: BrowserInstance, closed: BrowserTab, closedIndex: number): BrowserTab | null {
    const section = tabSectionOf(closed.belongsTo)
    const inSection = (tab: BrowserTab) => tabSectionOf(tab.belongsTo) === section

    // From the position the closed tab *had*, which `splice` has taken it out of: the first tab
    // of its section at or past that index is the one that was after it…
    for (let i = closedIndex; i < instance.tabs.length; i++) {
      if (inSection(instance.tabs[i])) return instance.tabs[i]
    }
    // …otherwise the first one going back, which is the last of that section before it.
    for (let i = closedIndex - 1; i >= 0; i--) {
      if (inSection(instance.tabs[i])) return instance.tabs[i]
    }

    // Nothing of that work left at all: the neighbour by position, the way the window chose
    // before there were sections.
    return instance.tabs[Math.min(closedIndex, instance.tabs.length - 1)] ?? null
  }

  /**
   * Take a tab out of the window and let go of it.
   *
   * `instance.tabs` is not the window's view list. A tab removed from the array alone would keep
   * its view as a child of the window: still painting at the tab area, still in the stack (so it
   * is a tab nobody can name showing through every tab opened after it, and one more renderer to
   * pay for). So a tab that is closed leaves the window the same way it would leave a display:
   * its view comes off the window, then its contents are closed.
   *
   * Only the page: the overlay around it is the window's and stays (`nativeOverlayView`) — a tab
   * going away does not take the panel's ground with it.
   */
  private detachTab(instance: BrowserInstance, tab: BrowserTab): void {
    tab.cdp.detach()
    // A tab that is going away takes its developer tools with it.
    this.closeTabDevTools(tab)

    // Out of whichever window holds it: the tab on screen lives in the window itself, and every tab
    // that is not on screen lives in the parking window (`parkTab`).
    for (const home of [instance.window, instance.parkingWindow]) {
      if (!home || home.isDestroyed()) continue
      try {
        home.contentView.removeChildView(tab.tabView)
      } catch (error) {
        mainLog.debug(`[browser-pane] detaching tab=${tab.id} view ignored: ${String(error)}`)
      }
    }

    try {
      const contents = tab.tabView.webContents
      if (!contents.isDestroyed()) contents.close()
    } catch (error) {
      mainLog.debug(`[browser-pane] tab close ignored tab=${tab.id}: ${String(error)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Developer tools
  // ---------------------------------------------------------------------------

  /**
   * Open the developer tools for the tab on screen, or close them if they are up.
   *
   * The tools are the **tab's**, because the tab is what they inspect: they belong to
   * whatever is on screen, so switching tabs puts them away with the tab that leaves
   * ({@link activateTab}) and closing the tab takes them with it ({@link detachTab}).
   *
   * Detached rather than docked: the page is a `BrowserView`, and a docked panel is laid
   * out inside that view's own rectangle — over the page it is inspecting.
   */
  private toggleTabDevTools(instance: BrowserInstance): void {
    const contents = activeTab(instance).tabView.webContents
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'detach' })
  }

  /** Put a tab's developer tools away, if they are up. */
  private closeTabDevTools(tab: BrowserTab): void {
    const contents = tab.tabView.webContents
    if (contents.isDestroyed() || !contents.isDevToolsOpened()) return
    contents.closeDevTools()
  }

  // ---------------------------------------------------------------------------
  // The window's element overlay
  // ---------------------------------------------------------------------------

  /**
   * Turn the overlay on for this window — and leave it on.
   *
   * The mode belongs to the window, so it is remembered here and applied to whatever
   * tab is on screen: now, and each time the user moves to another one. That is the
   * whole of "any tab's elements can be worked on".
   *
   * The bar's words come with the call: it is drawn inside the page, which has no
   * i18n, and the toolbar renderer is the side that has it.
   */
  private armPicker(instance: BrowserInstance, labels?: OverlayLabels): void {
    if (labels) instance.pickLabels = labels
    instance.picking = true
    this.armPickerOn(instance, activeTab(instance))
    this.pushToolbarState(instance)
  }

  /**
   * Take it down.
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
    if (tab) void tab.cdp.teardownOverlay()
    this.pushToolbarState(instance)
  }

  /**
   * Arm the overlay on one tab, taking it off whichever tab had it before.
   *
   * One tab at a time: the overlay is a mode *in a page* — its own UI is drawn in that tab's
   * document — so a second armed tab would be a document waiting for clicks nobody aimed at it.
   */
  private armPickerOn(instance: BrowserInstance, tab: BrowserTab): void {
    const previous = tabById(instance, instance.pickTabId)
    if (previous && previous.id !== tab.id) void previous.cdp.teardownOverlay()

    instance.pickTabId = tab.id
    const generation = ++instance.pickerGeneration
    void this.runPickLoop(instance, tab, generation)
  }

  /**
   * Read what the armed tab reports, for as long as this arming is the current
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
    // The accent is resolved here, once per arming: the page cannot see the app's
    // variables, and a theme change mid-mode is not worth re-injecting for. The
    // bar's words ride along for the same kind of reason — the page has no i18n.
    const arm = {
      accent: this.getResolvedAccentColor(),
      labels: instance.pickLabels,
      bar: true,
      resident: true,
    } as const

    let armed = false
    let unusable = 0

    while (isCurrent()) {
      try {
        if (!armed) {
          await tab.cdp.armOverlay(arm)
          armed = true
        }

        const report = await tab.cdp.drainOverlay()
        // Read while the window may already be someone else's to report on.
        if (!isCurrent()) return

        for (const element of report.picks) {
          // Every pick that arrives here is the selection's "add to conversation":
          // the selection itself only selects.
          this.emitToolbarAction({
            kind: 'add-to-conversation',
            instanceId: instance.id,
            element,
            // The tab it came from, read at the moment of the pick: the overlay is
            // the window's, so the element alone does not say where it was picked.
            origin: this.describeTabLocation(tab),
          })
        }

        if (report.status === 'cancelled') {
          mainLog.info(`[browser-pane] Overlay left the page instance=${instance.id} tab=${tab.id}`)
          this.disarmPicker(instance)
          return
        }

        // `missing` = this document has no overlay: the page navigated out from
        // under it, or the injection did not take. The mode is the window's, so the
        // tab is armed again rather than the mode quietly ending.
        armed = report.status !== 'missing'
        unusable = armed ? 0 : unusable + 1
      } catch (error) {
        if (!isCurrent()) return

        // A tab that is gone is not a failure to report: the window it belonged to
        // is closed, and the overlay went with it.
        if (instance.window.isDestroyed() || tab.tabView.webContents.isDestroyed()) {
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

  /** The window's tabs, in the order they were opened, with the active one marked. */
  listTabs(instanceId: string): BrowserTabSummary[] {
    const instance = this.instances.get(instanceId)
    if (!instance) return []
    return instance.tabs.map((tab) => this.toTabSummary(instance, tab))
  }

  /**
   * Hand one tab to another conversation: from now on it is **that conversation's work**, and
   * the tab it works from.
   *
   * The orchestrator's verb — a parent's child sessions each need a tab of their own, and
   * "whose work is this tab" is what decides who may work there. Giving a tab away is
   * therefore only possible for a tab that is **the caller's own work or nobody's**: a
   * conversation cannot hand on work it does not have, and it cannot take another's tab and
   * pass it along. Whether the receiver is a session worth handing to (same workspace, actually
   * exists) is `SessionManager`'s call — it is the side that knows the conversations, and it is
   * also the side that can resolve the receiver's **work**, which is why `to` is passed whole
   * rather than as a session id the browser side could only guess a task from.
   *
   * The tab also stops being the giver's in every other sense: its cursor and its hold move with
   * the work, or the giver would keep working from a tab it just gave away.
   */
  assignTab(instanceId: string, tabId: string, to: TabBelongsTo, by: TabBelongsTo): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no tab "${tabId}".`)
    if (!to?.sessionId) {
      throw new Error('Handing a tab over needs the conversation to hand it to.')
    }
    if (tab.belongsTo && !sameWork(tab.belongsTo, by)) {
      throw new Error(
        `Tab ${tabId} is ${describeWork(tab.belongsTo)}'s, so ${by.sessionId} cannot hand it on.`,
      )
    }

    if (tab.cursorOf.includes(by.sessionId)) {
      tab.cursorOf = tab.cursorOf.filter((session) => session !== by.sessionId)
    }
    if (tab.drivenBy === by.sessionId) tab.drivenBy = null
    if (tab.heldBy === by.sessionId) this.setHeldBy(tab, null)

    tab.belongsTo = to
    // It becomes the tab the receiver works from: "here is your tab" has to mean it can start
    // working without naming one, or the handover would be a tab it cannot reach.
    for (const other of instance.tabs) {
      if (other.id === tabId || !other.cursorOf.includes(to.sessionId)) continue
      other.cursorOf = other.cursorOf.filter((session) => session !== to.sessionId)
    }
    if (!tab.cursorOf.includes(to.sessionId)) tab.cursorOf = [...tab.cursorOf, to.sessionId]

    this.updateNativeOverlayState(instance)
    this.pushToolbarState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] tab handed over instance=${instance.id} tab=${tabId} from=${by.sessionId} to=${to.sessionId}`)
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

    // Clear pending timers and in-flight tracking for *every* tab: a window being
    // destroyed takes all of them with it, not just the one on screen.
    for (const tab of instance.tabs) {
      this.clearInPageThemeTimer(tab)
      tab.themeObserverToken = null
      const wcId = tab.tabView.webContents.id
      this.inFlightRequestsByWebContentsId.delete(wcId)
      this.lastNetworkActivityByWebContentsId.delete(wcId)
    }
    // A window takes its tabs with it, and a recording of one of them ends with what it
    // captured — there is no button left to press once the window is gone.
    this.tabRecorder.stopIfSource(...instance.tabs.map((tab) => tab.tabView.webContents.id))
    this.sessionRecordings.endForTabs(instance.tabs.map((tab) => tab.id))
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
   * The tab a command acts on.
   *
   * `tabId` is the tab the caller named. For a capability call that is the tab the
   * requesting conversation works from (`commandTabIdFor`), and a command that names
   * none means the tab on screen — which is what the person's own calls mean, and what
   * a window with nobody's cursor set falls back to.
   *
   * A named tab that is gone **throws** rather than sliding onto the tab on screen:
   * the named tab was the whole point of the command, and a click that lands somewhere
   * else because the tab was closed under it is worse than a failed call. Being on
   * screen is not a reason to be the target — that decoupling is the reason this exists.
   */
  private tabOf(instance: BrowserInstance, tabId?: string | null): BrowserTab {
    if (!tabId) return activeTab(instance)
    const tab = tabById(instance, tabId)
    if (!tab) {
      throw new Error(`Browser window "${instance.id}" has no tab "${tabId}" — it may have been closed.`)
    }
    return tab
  }

  async handleEmptyStateLaunchFromRenderer(
    senderWebContentsId: number,
    payload: BrowserEmptyStateLaunchPayload,
  ): Promise<BrowserEmptyStateLaunchResult> {
    const instance = this.findInstanceByTabWebContentsId(senderWebContentsId)
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
   * Which window a tab belongs to, by the tab itself.
   *
   * Every tab, not just the one on screen: an empty-state document that asks to
   * launch something is asking from *its* tab, and with a window holding several
   * tabs the tab in front may be a different one entirely.
   */
  private findInstanceByTabWebContentsId(senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      for (const tab of instance.tabs) {
        if (tab.tabView.webContents.id === senderWebContentsId) return instance
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
    const tab = this.tabOf(instance, tabId)

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
      const loaded = tab.tabView.webContents.loadURL(normalizedUrl)
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
    const tab = this.tabOf(instance, tabId)
    if (tab.tabView.webContents.canGoBack()) {
      tab.tabView.webContents.goBack()
    }
  }

  async goForward(id: string, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const tab = this.tabOf(instance, tabId)
    if (tab.tabView.webContents.canGoForward()) {
      tab.tabView.webContents.goForward()
    }
  }

  reload(id: string, tabId?: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    this.tabOf(instance, tabId).tabView.webContents.reload()
  }

  stop(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    activeTab(instance).tabView.webContents.stop()
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
        const tabWc = activeTab(instance).tabView.webContents
        if (!tabWc.isDestroyed()) tabWc.stop()
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
    return this.tabOf(instance, tabId).cdp.getAccessibilitySnapshot()
  }

  async clickAtCoordinates(id: string, x: number, y: number, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await this.tabOf(instance, tabId).cdp.clickAtCoordinates(x, y)
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
      await this.tabOf(instance, tabId).cdp.drag(x1, y1, x2, y2)
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
      await this.tabOf(instance, tabId).cdp.typeText(text)
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
    await this.tabOf(instance, tabId).cdp.setClipboard(text)
  }

  async getClipboard(id: string, tabId?: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return this.tabOf(instance, tabId).cdp.getClipboard()
  }

  async clickElement(
    id: string,
    ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number },
    tabId?: string,
  ): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const tab = this.tabOf(instance, tabId)

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
            tab.tabView.webContents.removeListener('did-navigate', onNav)
            tab.tabView.webContents.removeListener('did-navigate-in-page', onNav)
          }

          tab.tabView.webContents.once('did-navigate', onNav)
          tab.tabView.webContents.once('did-navigate-in-page', onNav)
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
      const geometry = await this.tabOf(instance, tabId).cdp.fillElement(ref, value)
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
      const geometry = await this.tabOf(instance, tabId).cdp.selectOption(ref, value)
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

  async screenshot(id: string, options?: BrowserScreenshotOptions, tabId?: string): Promise<BrowserScreenshotResult> {
    const instance = this.requireAliveInstance(id)
    const tab = this.tabOf(instance, tabId)

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
  }

  async screenshotRegion(
    id: string,
    target: BrowserScreenshotRegionTarget,
    tabId?: string,
  ): Promise<BrowserScreenshotResult> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)
    const tab = this.tabOf(instance, tabId)

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
      throw new Error(
        `The region is not on screen at all (viewport ${viewport.width}×${viewport.height}). ` +
          `Give the tab the room it needs (\`viewport-resize ${Math.ceil(box.x + box.width)} ${Math.ceil(box.y + box.height)}\`) or scroll it into view, then shoot again.`,
      )
    }

    // All or nothing.
    //
    // An image missing part of what was asked for is a wrong answer, not a smaller one: nobody can
    // tell from the picture that something was cut, so a clipped region is an error rather than a
    // quiet crop. The caller can insist with `--force`, and then the result says what was missing.
    //
    // Measured: pixels outside the viewport are not available to this capture at all (background
    // with `fromSurface: true`, black with `false`), so no flag conjures them. The way to a whole
    // element is to give the tab the room (`viewport-resize`), which reflows the page — the
    // caller's call, not something a shot does behind their back.
    const clipped = clippedWidth < Math.floor(box.width) || clippedHeight < Math.floor(box.height)
    if (clipped && !target.force) {
      throw new Error(
        `The region is bigger than the page has painted (${clippedWidth}×${clippedHeight} of ` +
          `${Math.floor(box.width)}×${Math.floor(box.height)}; viewport is ${viewport.width}×${viewport.height}). ` +
          `Run \`viewport-resize ${Math.ceil(box.x + box.width)} ${Math.ceil(box.y + box.height)}\` and shoot again — that reflows the page, which is your call — ` +
          `or pass \`--force\` to take the incomplete image. (The size is the region's bottom-right corner, not its width and height: the region does not start at the origin. A reflow can move it, so the next shot may ask for another size.)`,
      )
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

    if (clipped) {
      captured.warnings.push(
        `Incomplete, as forced (\`--force\`): ${clippedWidth}×${clippedHeight} of ${Math.floor(box.width)}×${Math.floor(box.height)} — the rest was not on screen.`,
      )
    }

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
  }

  private async capturePageWithRecovery(
    instance: BrowserInstance,
    options: {
      /** The tab being captured — named rather than assumed, so a shot of a tab
       * nobody is looking at is a shot of *that* tab. */
      tab: BrowserTab
      mode: 'raw' | 'agent' | 'region'
      errorPrefix: 'screenshot' | 'region screenshot' | 'recording seed'
      rect?: { x: number; y: number; width: number; height: number }
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; warnings: string[] }> {
    const tab = options.tab
    let sawNoSurface = false
    const warnings: string[] = []
    const imageOpts = { dpr: options.dpr, format: options.format, jpegQuality: options.jpegQuality }

    // Where the tab already has something to copy, the shot is taken where it is: a few goes, because
    // a page that has just been painted can still answer empty once. A window that is not on screen is
    // skipped unless it is known to answer there (`canCaptureHiddenWindows`) — on Windows it has no
    // surface at all, so the wait would buy nothing and the parked shot below is the way to any tab in
    // it, the one on screen included.
    if (instance.isVisible || this.canCaptureHiddenWindows) {
      for (let attempt = 1; attempt <= SCREENSHOT_CAPTURE_ATTEMPTS; attempt += 1) {
        let result: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
        try {
          result = await this.capturePageImage({
            tab,
            rect: options.rect,
            useHiddenCaptureOptions: true,
            ...imageOpts,
          })
        } catch (error) {
          if (this.isNoSurfaceCaptureError(error)) {
            sawNoSurface = true
            mainLog.warn(
              `[browser-pane] ${options.errorPrefix} no surface to capture instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_CAPTURE_ATTEMPTS} tab=${tab.id} url=${tab.currentUrl} detail=${error instanceof Error ? error.message : String(error)}`,
            )
            // Nothing inside this window will find one for this tab — a page that has never been
            // composited has no surface to copy — so the parked shot below is the way to it.
            break
          }
          throw error
        }

        if (result) {
          if (attempt > 1) {
            warnings.push(`Capture recovered after ${attempt} attempt${attempt === 1 ? '' : 's'}.`)
          }
          return { imageBuffer: result.buffer, imageFormat: result.format, warnings }
        }

        mainLog.warn(
          `[browser-pane] ${options.errorPrefix} empty capture attempt instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_CAPTURE_ATTEMPTS} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl}`,
        )

        if (attempt < SCREENSHOT_CAPTURE_ATTEMPTS) {
          await this.waitForScreenshotReadiness(instance.id)
        }
      }
    } else {
      // A window that is not on screen has no surface at all — no attempt inside it can answer
      // (measured: every hidden state missed on every path) — so the shot goes straight to the parked
      // view, which is the only way to a background tab's pixels anyway.
      mainLog.info(`[browser-pane] ${options.errorPrefix} window is not on screen; taking the shot from a parked view instance=${instance.id} mode=${options.mode} tab=${tab.id}`)
    }

    let parked: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
    try {
      parked = await this.captureWhileParked(instance, tab, options.rect, imageOpts)
    } catch (error) {
      if (this.isNoSurfaceCaptureError(error)) {
        sawNoSurface = true
        mainLog.warn(
          `[browser-pane] ${options.errorPrefix} no surface to capture from a parked view instance=${instance.id} mode=${options.mode} tab=${tab.id} url=${tab.currentUrl} detail=${error instanceof Error ? error.message : String(error)}`,
        )
      } else {
        throw error
      }
    }

    if (parked) {
      warnings.push('Capture parked that tab in a window nobody can see for the shot; it was put straight back.')
      return { imageBuffer: parked.buffer, imageFormat: parked.format, warnings }
    }

    mainLog.warn(
      `[browser-pane] ${options.errorPrefix} capture failed after recovery instance=${instance.id} mode=${options.mode} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl}`,
    )

    if (sawNoSurface) {
      throw new Error(
        `Failed to capture ${options.errorPrefix}: the page had no display surface to copy, even from a view of its own. `
        + `Wait for it to paint ("browser_tool wait network-idle") and retry.`
      )
    }

    throw new Error(`Failed to capture ${options.errorPrefix}: empty image buffer`)
  }

  /**
   * Take the shot from a view parked in a window nobody can see.
   *
   * This is where a page gets its first frame. Chromium gives a page a surface when it is first
   * composited, and both cases that need this have none: a window that is not on screen is not
   * composited at all, and a tab opened behind the person's (`activate: false`, how an agent's tab is
   * opened) has never been on screen. Nothing short of putting the view somewhere that gets
   * composited changes that (`setVisible`, `invalidate`, `setBounds`, unthrottling and the window
   * being up all missed; measured in `apps/electron/spike/screenshot-e2e.ts`).
   *
   * "Somewhere that gets composited" does not have to be anywhere a person can see: the view is handed
   * to a window parked outside every display — shown, because a window that is never shown is never
   * composited either — and taken back a frame later. Their own window is not shown, moved or touched;
   * nothing of it appears on screen, on the taskbar or in anyone's focus. Measured: 16ms of wait is
   * enough, ~40ms for the shot from a parked view against ~355ms for the same tab through a revealed
   * window, and the person's window's bounds and stacking unchanged.
   */
  private async captureWhileParked(
    instance: BrowserInstance,
    tab: BrowserTab,
    rect: { x: number; y: number; width: number; height: number } | undefined,
    imageOpts: { dpr?: number; format?: 'png' | 'jpeg'; jpegQuality?: number },
  ): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' } | null> {
    // This tab's own viewport: the page area while it is the one on screen, and the viewport it had
    // the last time it *was* on screen otherwise (`layoutTabView` lays out only the tab on screen).
    // The parking window is built to this size and the view keeps it while it is away, so the page's
    // viewport never changes for a shot — making the window is cheap either way (~5–18ms, measured).
    const own = tab.tabView.getBounds()
    const size = { width: own.width, height: own.height }
    const spot = this.offscreenSpot(size)
    let parking: BrowserWindow | null = null

    try {
      parking = new BrowserWindow({
        x: spot.x,
        y: spot.y,
        width: own.width,
        height: own.height,
        show: false,
        frame: false,
        skipTaskbar: true,
        backgroundColor: getBackgroundColor(nativeTheme.shouldUseDarkColors),
      })
      parking.contentView.addChildView(tab.tabView)
      tab.tabView.setBounds({ x: 0, y: 0, width: own.width, height: own.height })
      parking.showInactive()
      // Shown for one frame and lived in for less than a shot, but it is shown: where it ended up may
      // not be on a display (`keepOffEveryDisplay`).
      this.keepOffEveryDisplay(parking)
      await this.sleep(SCREENSHOT_FIRST_FRAME_MS)

      return await this.capturePageImage({
        tab,
        rect,
        useHiddenCaptureOptions: false,
        ...imageOpts,
      })
    } finally {
      // Handed back to wherever it belongs now, having kept the viewport the shot was taken at: the
      // tab on screen goes back into the window (the person may have resized it while the page was
      // away, and this is the tab they are looking at), and a tab that is not showing goes back to
      // the window it lives in (`parkTab`). The overlay belongs above the page exactly when that page
      // is the locked one, so it is told either way.
      if (!instance.window.isDestroyed() && !tab.tabView.webContents.isDestroyed()) {
        if (instance.activeTabId === tab.id) {
          instance.window.contentView.addChildView(tab.tabView)
          // The window's page area — unless the window has no size right now (it may be minimized,
          // which is exactly how a shot of a hidden window is asked for): then this tab goes back to
          // the viewport it already had, rather than to a made-up one (`windowHasSize`).
          tab.tabView.setBounds(this.windowHasSize(instance) ? this.pageAreaBounds(instance) : own)
        } else {
          this.parkTab(instance, tab, own)
        }
        this.raiseActiveTab(instance)
        this.updateNativeOverlayState(instance)
      }
      if (parking && !parking.isDestroyed()) parking.destroy()
    }
  }

  /**
   * A spot **off every display** for a window of this size, as far out as the desktop will let us ask
   * (`OFFSCREEN_PARK_MARGIN`). Right of the desktop first, then left, then below, then above — the
   * first side that has room off every display, since the desktop caps how far out a window may go
   * and a desktop already at that cap has to be gone round rather than past.
   */
  private offscreenSpot(size: { width: number; height: number }): { x: number; y: number } {
    const displays = screen.getAllDisplays()
    const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
    const left = Math.min(...displays.map((display) => display.bounds.x))
    const top = Math.min(...displays.map((display) => display.bounds.y))
    const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height))

    const candidates = [
      { x: right + OFFSCREEN_PARK_MARGIN, y: top },
      { x: left - OFFSCREEN_PARK_MARGIN - size.width, y: top },
      { x: left, y: bottom + OFFSCREEN_PARK_MARGIN },
      { x: left, y: top - OFFSCREEN_PARK_MARGIN - size.height },
    ]
    for (const candidate of candidates) {
      if (!this.overlapsADisplay({ ...candidate, ...size })) return candidate
    }
    // Every side is already taken by a display whose desktop reaches the cap: go as far out as the
    // desktop allows and let `keepOffEveryDisplay` keep asking.
    return candidates[0]
  }

  /** Whether a rectangle shares any pixel with any display the person has. */
  private overlapsADisplay(rect: { x: number; y: number; width: number; height: number }): boolean {
    return screen.getAllDisplays().some((display) => (
      rect.x < display.bounds.x + display.bounds.width
      && rect.x + rect.width > display.bounds.x
      && rect.y < display.bounds.y + display.bounds.height
      && rect.y + rect.height > display.bounds.y
    ))
  }

  /**
   * Hold a window nobody may see **off every display**: check where it actually is, and put it back
   * out if a display is under it.
   *
   * Nothing about this can be left to the placement that made the window: the person can plug a
   * screen in beside the spot, change scaling (which rescales the coordinates themselves), and the
   * desktop itself will bring a window back onto a screen when it thinks nobody can reach it. So it
   * is called when the displays change and whenever the window moves, and it does nothing at all
   * unless the window is really on a display (one comparison in the ordinary case).
   */
  private keepOffEveryDisplay(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    const rect = window.getBounds()
    if (!this.overlapsADisplay(rect)) {
      this.parkingStuck.delete(window)
      return
    }
    // The desktop would not take it further last time: asking again for the same coordinate would
    // only bounce it back and forth, once per move event.
    if (this.parkingStuck.has(window)) return

    const spot = this.offscreenSpot({ width: rect.width, height: rect.height })
    window.setPosition(spot.x, spot.y)
    const landed = window.getBounds()
    const stillOnADisplay = this.overlapsADisplay(landed)
    if (stillOnADisplay) {
      this.parkingStuck.add(window)
      mainLog.warn(`[browser-pane] a window nobody may see could not be moved clear of the displays: it asked for ${spot.x},${spot.y} and is at ${landed.x},${landed.y}, which a display still covers`)
      return
    }
    mainLog.warn(`[browser-pane] a window nobody may see was on a display at ${rect.x},${rect.y}; moved it back off every display to ${landed.x},${landed.y}`)
  }

  /**
   * Whether a failed capture means "this window has no surface to copy" — the one thing another
   * attempt inside the same window cannot fix, and what the parked view is for.
   *
   * Two symptoms, one cause: Chromium says so in as many words when the surface is gone, and
   * stays silent instead — the promise never settles — when the window is not on screen
   * (`captureWithinBound`, and the spike named there).
   */
  private isNoSurfaceCaptureError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = error.message.toLowerCase()
    return message.includes('current display surface not available for capture')
      || message.includes(SCREENSHOT_CAPTURE_TIMEOUT_MARKER)
  }

  /**
   * One JPEG of a tab, for a recording's first frame.
   *
   * The screenshot path, not the capture: a window that is not on screen has no surface for
   * `capturePage` to copy, and this is the same machinery `screenshot` uses to answer there —
   * including the parked shot it falls back to. `null` when even that cannot be had, because a
   * recording without a first picture is still a recording.
   */
  private async captureRecordingSeed(instance: BrowserInstance, tab: BrowserTab): Promise<Buffer | null> {
    try {
      const captured = await this.capturePageWithRecovery(instance, {
        tab,
        mode: 'raw',
        errorPrefix: 'recording seed',
        format: 'jpeg',
        jpegQuality: 80,
      })
      return captured.imageBuffer
    } catch {
      return null
    }
  }

  /**
   * A capture that cannot hang.
   *
   * On a window that is not on screen, `capturePage` does not fail — it stops answering:
   * the surface it would copy is gone, so the promise never settles at all (measured for
   * every non-visible window state in `apps/electron/spike/capture-methods.cjs`). Awaiting
   * that is what left the screenshot command stuck until the browser was brought up by
   * hand. A capture that has not come back within the bound is therefore reported as a
   * miss, which is a state `capturePageWithRecovery` already knows how to answer.
   */
  private async captureWithinBound(capture: Promise<Electron.NativeImage>, webContentsId: number): Promise<Electron.NativeImage> {
    // A capture that fails only after the bound is not this call's answer anymore, and an
    // unhandled rejection would be noise about a picture nobody is waiting for.
    capture.catch(() => {})

    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = Symbol('capture-timeout')
    const outcome = await Promise.race([
      capture,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.captureTimeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)

    if (outcome === timedOut) {
      mainLog.warn(
        `[browser-pane] capture did not come back within ${this.captureTimeoutMs}ms webContents=${webContentsId} — treating it as no image`,
      )
      throw new Error(`${SCREENSHOT_CAPTURE_TIMEOUT_MARKER} after ${this.captureTimeoutMs}ms`)
    }

    return outcome
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

    const tabView = options.tab.tabView
    const capture = options.rect
      ? tabView.webContents.capturePage(options.rect, captureOpts)
      : tabView.webContents.capturePage(undefined, captureOpts)

    let image = await this.captureWithinBound(capture, tabView.webContents.id)

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
    const tab = this.tabOf(instance, tabId)

    const level = options?.level ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))

    const filtered = level === 'all'
      ? tab.consoleLogs
      : tab.consoleLogs.filter((entry) => entry.level === level)

    return filtered.slice(-limit)
  }

  getNetworkLogs(id: string, options?: BrowserNetworkOptions, tabId?: string): BrowserNetworkEntry[] {
    const instance = this.requireAliveInstance(id)
    const logs = this.tabOf(instance, tabId).networkLogs

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
    const tab = this.tabOf(instance, tabId)

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
        const exists = await tab.tabView.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        )
        return Boolean(exists)
      }, `selector matched: ${selector}`)
    }

    if (args.kind === 'text') {
      const text = args.value?.trim()
      if (!text) throw new Error('browser_wait text requires value')
      return until(async () => {
        const found = await tab.tabView.webContents.executeJavaScript(
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
      const wcId = tab.tabView.webContents.id
      return until(async () => {
        const inflight = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        const last = this.lastNetworkActivityByWebContentsId.get(wcId) ?? started
        return inflight === 0 && (Date.now() - last) >= idleMs
      }, `network idle for ${idleMs}ms`)
    }

    throw new Error(`Unknown wait kind: ${args.kind}`)
  }

  /**
   * `key` — one key press, delivered to this tab wherever it sits.
   *
   * It used to be injected natively (`webContents.sendInputEvent`), which
   * silently delivered nothing: a key event goes to the widget the window has
   * focused, and a browser window the person is not typing in has none. The
   * command still reported success. CDP reaches the tab itself (see
   * browser-key-map.ts).
   */
  async sendKey(id: string, args: BrowserKeyArgs, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    const tab = this.tabOf(instance, tabId)

    const key = args.key?.trim()
    if (!key) throw new Error('browser_key requires key')

    const modifiers = (args.modifiers ?? []) as Array<'shift' | 'control' | 'alt' | 'meta'>
    const { delivered } = await tab.cdp.pressKey(key, modifiers)
    if (delivered === 0) {
      // "Sent" and "arrived" are different facts, and the failure this tool used
      // to have was reporting the first as if it were the second. A frame that
      // holds the focus (an iframe of the page) is the one honest reason a key
      // reaches nothing here — so this warns rather than failing the command.
      mainLog.warn(`[browser-pane] key "${key}": CDP accepted it, but the page received no keydown`)
    } else {
      mainLog.info(`[browser-pane] key "${key}" delivered (page saw ${delivered} keydown)`)
    }
  }

  /**
   * What this window's workspace has downloaded — `downloads` the command.
   *
   * No tab, deliberately: a download is not the tab's (see `downloadsByWorkspace`), so
   * there is nothing to filter and `--tab` names nothing here. The window is resolved
   * because a caller reaches downloads through one, and its workspace is what the list
   * belongs to.
   */
  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const instance = this.requireAliveInstance(id)
    const downloads = this.downloadsFor(instance.workspaceId)

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
      const safePath = await validateFilePath(p, getWorkspaceAllowedDirs(workspaceId, { sessionManager: this.sessionManager ?? undefined }))
      if (!existsSync(safePath)) throw new Error(`File not found: ${p}`)
      safePaths.push(safePath)
    }

    return this.tabOf(instance, tabId).cdp.setFileInputFiles(ref, safePaths)
  }

  /**
   * Give one tab's view a viewport, and — when that tab is the one the person is looking at — grow
   * the window to hold it.
   *
   * **The unit is the view, not the window**. A tab's size is its own: a tab
   * that is not on screen is parked in the parking window at whatever size it had, and an agent
   * working there must be able to set that size without moving the window the person is reading.
   * Measured before this: resizing anything always resized the person's window, so an agent working
   * in a background tab changed what the person saw, and its own tab stayed the size it was.
   *
   * The two cases, and why they differ:
   *
   * - **The tab is on screen**: its viewport *is* the window's page area (`layoutTabView` lays it out
   *   to `pageAreaBounds`), so the only way to give it a size is to size the window. The window
   *   follows, which is what the person sees: their window grows by exactly the chrome they keep —
   *   the bar above, the rail beside, the panel's gutter (`pagePanelInsets`).
   * - **The tab is somewhere else**: it lives in the parking window, so its size is nobody else's
   *   business. The view is sized where it is and the person's window is left alone.
   *
   * Either way the answer is the tab's **actual** viewport — read back from what the view ended up
   * with, so OS window floors (min 700×500, test below) show up as a smaller number rather than a
   * promise that was not kept.
   */
  resizeViewport(id: string, width: number, height: number, tabId?: string): { width: number; height: number } {
    const instance = this.requireAliveInstance(id)
    const tab = this.tabOf(instance, tabId)

    const requestedWidth = Math.max(320, Math.floor(width))
    const requestedHeight = Math.max(240, Math.floor(height))
    const wanted = { width: requestedWidth, height: requestedHeight }

    if (tab.id !== activeTab(instance).id) {
      // Not the tab on screen: resize the view where it is parked. `parkTab` grows the parking window
      // to fit what it holds — a window clips its children, and a clipped view is a view with a
      // smaller viewport — and leaves the person's window out of it entirely.
      this.parkTab(instance, tab, wanted)
      const parked = tab.tabView.getBounds()
      mainLog.info(`[browser-pane] resized a parked tab's view id=${id} tab=${tab.id} to=${parked.width}x${parked.height}`)
      return { width: Math.max(0, Math.floor(parked.width)), height: Math.max(0, Math.floor(parked.height)) }
    }

    // The tab on screen: the window grows by everything that tab does not get — the bar from the
    // top, the rail from the side, and the panel's gutter (`pagePanelInsets`).
    const inset = this.pagePanelInsets()
    instance.window.setContentSize(
      requestedWidth + TAB_RAIL_WIDTH + inset.left + inset.right,
      requestedHeight + TOOLBAR_HEIGHT + inset.top + inset.bottom,
    )

    this.layoutAllViews(instance)

    // Return effective viewport dimensions after OS/window min-size constraints are applied.
    // All of the chrome and the gutter come back off again — the same numbers that were added.
    const page = this.pageAreaBounds(instance)
    return {
      width: Math.max(0, Math.floor(page.width)),
      height: Math.max(0, Math.floor(page.height)),
    }
  }

  /**
   * Hand a design's fresh snapshot to every tab in this workspace that is showing it.
   *
   * The tab is a page with no host, so this is the only way it hears about new data: the
   * snapshot is posted in the bridge's own shape (`craft-designs/v1` + `data`), which the
   * design listens for whether it was opened from the app or typed into a tab. A tab whose
   * address is not this design's — including the diagram editor's origin — is left alone.
   */
  async pushDesignSnapshot(workspaceId: string, label: string, snapshotJson: string): Promise<void> {
    const instance = this.findWindowForWorkspace(workspaceId)
    if (!instance) return
    const tabs = await this.listTabsAsync(instance.id)
    const expression =
      `window.postMessage({ protocol: 'craft-designs/v1', type: 'data', ` +
      `payload: { snapshot: ${snapshotJson} } }, '*')`
    for (const tab of tabs) {
      if (!tab.url || !tab.url.startsWith(`craft-local://${label}/`)) continue
      await this.evaluate(instance.id, expression, tab.id)
    }
  }

  async evaluate(id: string, expression: string, tabId?: string): Promise<unknown> {
    const instance = this.requireAliveInstance(id)
    return this.tabOf(instance, tabId).tabView.webContents.executeJavaScript(expression)
  }

  /**
   * Fetch a url through this tab's **session** — its cookies, and not the page's CORS.
   *
   * The window's own network stack rather than the page's `fetch`, which is the whole reason this
   * exists: a page can display an image from another origin that script is not allowed to read.
   * `referrer`, when given, makes the request look like the page's own — some hosts serve an image
   * only to a request that came from the page it sits on.
   *
   * Answers rather than throws, so one unreachable image does not take a whole capture with it.
   */
  async fetchResource(
    id: string,
    url: string,
    options?: { referrer?: string; maxBytes?: number },
    tabId?: string,
  ): Promise<BrowserFetchedResource> {
    const instance = this.requireAliveInstance(id)
    const requestSession = this.tabOf(instance, tabId).tabView.webContents.session

    try {
      const response = await requestSession.fetch(url, {
        ...(options?.referrer ? { referrer: options.referrer } : {}),
      })
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }

      const bytes = Buffer.from(await response.arrayBuffer())
      const maxBytes = options?.maxBytes ?? MAX_FETCHED_RESOURCE_BYTES
      if (bytes.byteLength > maxBytes) {
        return { ok: false, error: `over ${Math.round(maxBytes / 1048576)} MB` }
      }

      return {
        ok: true,
        base64: bytes.toString('base64'),
        mimeType: response.headers.get('content-type') ?? '',
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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
    // The overlay is drawn in the app's colours, which only this side can resolve.
    return this.tabOf(instance, tabId).cdp.pickElement({
      ...options,
      accent: this.getResolvedAccentColor(),
    })
  }

/** Sample frames out of a recording someone recorded elsewhere. */
  async extractVideoFrames(
    filePath: string,
    options: {
      mode: 'timeline' | 'changes'
      everyMs: number
      maxFrames: number
      changeThreshold?: number
      fromMs?: number
      toMs?: number
      first?: boolean
      last?: boolean
      maxEdge?: number
    },
  ) {
    if (!existsSync(filePath)) {
      throw new Error(`No recording at ${filePath}.`)
    }
    return sampleVideoFrames(filePath, options)
  }

  // ---------------------------------------------------------------------------
  // Recording a tab, for a conversation
  // ---------------------------------------------------------------------------

  /**
   * Start recording one of a conversation's tabs.
   *
   * The tab is resolved inside **that conversation's** window, so a tab id cannot reach another
   * conversation's tab by being typed — the same rule every other tab-scoped call follows.
   */
  async startRecordingForSession(
    sessionId: string,
    args: BrowserStartRecordingArgs,
    options?: { workspaceId?: string | null },
  ): Promise<BrowserStartRecordingResult> {
    // The workspace's window, which is the one every conversation in it works in — asking for it
    // is what every other browser command does, and a conversation with no window has no tab to
    // record anyway (the lookup below is what says so).
    //
    // `workspaceId` has to be carried in rather than left out: it is the whole of a window's
    // identity to `findWindowForWorkspace`, so omitting it drops the lookup into the
    // `workspaceId === null` bucket — a *different* window, which then has none of the caller's
    // tabs and answers `has no tab "…"` about a window the caller never worked in.
    const instanceId = await this.getOrCreateForSessionAsync(sessionId, {
      workspaceId: options?.workspaceId,
    })
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, args.tabId)
    if (!tab) {
      throw new Error(`Browser window "${instance.id}" has no tab "${args.tabId}". "tabs" lists them.`)
    }

    /** What the file's entry looks like to the layer above — its `(owner, tab)` half included. */
    const ref = (state: TabRecordingState): BrowserRecordingRef =>
      ({ tabId: state.tabId, file: state.file, startedAt: state.startedAt, bytes: state.bytes })

    const result = await this.sessionRecordings.start({
      sessionId,
      tabId: tab.id,
      dir: args.dir,
      ttlMs: args.ttlMs,
      source: tab.tabView.webContents,
      // The tab's own CDP session, where the frames come from, and the size its view is at.
      capture: tab.cdp,
      size: tab.tabView.getBounds(),
      // The first frame, taken the way a screenshot is rather than from the capture: a page that
      // is not painting sends the screencast nothing, and a recording of a still page has to
      // show the page it was still on.
      seedFrame: () => this.captureRecordingSeed(instance, tab),
    })

    // Nothing is pushed to the chrome: the toolbar shows the person's recording and only theirs
    // (a conversation's recording is not theirs to display), so nothing it draws has changed.
    if (!result.ok) {
      if (result.reason === 'already-recording') {
        return { started: false, reason: 'already-recording', recording: ref(result.state) }
      }
      return { started: false, reason: result.reason, message: result.message }
    }

    // The page's own half of the observation starts with the recording (`recording-observer.ts`).
    void this.syncRecordingObserver(instance.id, tab.id)

    const recording = ref(result.state)
    const extension = result.state.file.split('.').pop() ?? ''
    if (!args.wait) return { started: true, recording, extension }

    // The two forms, one call: with `wait`, the answer is the ending.
    const finished = await result.finished
    return {
      started: true,
      recording,
      extension,
      ...(finished
        ? {
            finished: {
              tabId: finished.tabId,
              file: finished.file,
              bytes: finished.bytes,
              seconds: finished.seconds,
              reason: 'it ended',
            },
          }
        : {}),
    }
  }

  /** End one early. */
  async stopRecordingForSession(sessionId: string, tabId: string): Promise<BrowserStopRecordingResult> {
    const finished = await this.sessionRecordings.end(sessionId, tabId, 'asked')
    if (!finished) return { stopped: false, reason: 'not-recording' }

    // Silenced only if nothing else still covers this tab — the person may be recording it too.
    void this.syncRecordingObserver(this.findInstanceByTabId(tabId)?.id ?? null, tabId)

    return {
      stopped: true,
      recording: {
        tabId: finished.tabId,
        file: finished.file,
        bytes: finished.bytes,
        seconds: finished.seconds,
        reason: 'asked',
      },
    }
  }

  /**
   * Put the page's observer in place — or take it out — to match whether a recording covers a tab.
   *
   * **Two halves, because a recording is about now and a tweak is about the next document.** The
   * init script reaches documents that do not exist yet; the injection starts the observer in the
   * one in front of the person, who is about to demonstrate something in *that* one. Removing is
   * the same pair in reverse, and the copy already inside a document is silenced rather than
   * abandoned — a listener still reporting to nobody is still a listener in somebody's page.
   *
   * Called after every start and every stop, from both paths (the person's button, a
   * conversation's command): what decides is whether a recording covers the tab afterwards, not
   * which of them asked.
   */
  private async syncRecordingObserver(instanceId: string | null, tabId: string): Promise<void> {
    if (!instanceId) return

    const covered = this.tabRecorder.states().some((state) => state.tabId === tabId)
    try {
      if (covered) {
        const source = buildRecordingObserverSource()
        await this.addInitScript(instanceId, RECORDING_OBSERVER_KEY, source, tabId)
        await this.evaluate(instanceId, source, tabId)
      } else {
        await this.clearInitScripts(instanceId, RECORDING_OBSERVER_KEY, tabId)
        await this.evaluate(instanceId, buildRecordingObserverOffSource(), tabId)
      }
    } catch {
      // The tab may be gone, or the page may refuse the script. A recording without the page's own
      // report is still a recording: the navigations and requests are the host's, not the page's.
    }
  }

  /** The window holding a tab — for a stop, which names the tab and never the window. */
  private findInstanceByTabId(tabId: string): BrowserInstance | null {
    for (const instance of this.instances.values()) {
      if (instance.tabs.some((tab) => tab.id === tabId)) return instance
    }
    return null
  }

  /** End everything a conversation is recording, because it is going away. */
  endRecordingsForSession(sessionId: string): void {
    this.sessionRecordings.endAllFor(sessionId)
  }

  /**
   * Wait for one of a conversation's recordings to end.
   *
   * Answers `null` for a tab that is not being recorded — including one that already finished,
   * since there is no longer anything to wait for and the caller has missed it rather than being
   * owed an answer. Deliberately not a poll: the promise is the one the recording already settles
   * when it ends (`session-recordings.ts`), so this costs a listener and no clock.
   */
  async waitForRecordingEnd(sessionId: string, tabId: string): Promise<BrowserFinishedRecording | null> {
    const finished = await (this.sessionRecordings.waitFor(sessionId, tabId) ?? Promise.resolve(null))
    if (!finished) return null

    return {
      tabId: finished.tabId,
      file: finished.file,
      bytes: finished.bytes,
      seconds: finished.seconds,
      reason: 'it ended',
    }
  }

  /** A `.drawio` document → SVG, an editable SVG, a PNG or a page. */
  async renderDrawio(options: DrawioRenderOptions): Promise<RenderedDrawioFile> {
    return drawioRender.renderDrawio(options)
  }

  /**
   * Register `source` to run in every new document (survives reload/navigation).
   * Re-registering the same key replaces the previous script.
   */
  async addInitScript(id: string, key: string, source: string, tabId?: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return this.tabOf(instance, tabId).cdp.addInitScript(key, source)
  }

  /** Remove every init script whose key starts with `keyPrefix`. */
  async clearInitScripts(id: string, keyPrefix: string, tabId?: string): Promise<string[]> {
    const instance = this.requireAliveInstance(id)
    const tab = this.tabOf(instance, tabId)
    const keys = tab.cdp.listInitScriptKeys().filter((key) => key.startsWith(keyPrefix))
    for (const key of keys) {
      await tab.cdp.removeInitScript(key)
    }
    return keys
  }

  async detectSecurityChallenge(id: string, tabId?: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return { detected: false, provider: 'none', signals: [] }
    const tab = this.tabOf(instance, tabId)

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
      const domSignals = await tab.tabView.webContents.executeJavaScript(`(() => {
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

    // The document first; a wheel at the viewport centre only when it cannot move
    // (that is what scrolls a list inside a frame — see BrowserCDP.scrollBy).
    const { viaWheel, documentMoved } = await this.tabOf(instance, tabId).cdp.scrollBy(deltaX, deltaY)
    if (viaWheel) {
      mainLog.info(
        `[browser-pane] scroll: the document had nowhere to go, so the gesture went to the viewport centre ` +
          `(document moved: ${documentMoved})`,
      )
    }
  }

  /**
   * Let go of everything a session was holding in the browser.
   *
   * Non-destructive: the window stays, because the workspace's window is almost never
   * this session's alone — the next turn, the next conversation or the user picks it up
   * from here. What goes is what this session put there: its driven-by marks (across every
   * window, see `clearDrivenBy`) and its holds — and with the holds, whatever the overlay
   * was drawing for them.
   *
   * The **cursor** stays: this session is still around, and the tab it works from is where
   * its next unnamed command has to land — that is what the cursor is for, and a session
   * that comes back to another tab than it left would be the "the person's click retargeted
   * my work" bug again. Only a session that is *gone* gives its cursors back
   * ({@link destroyForSession}).
   */
  unbindAllForSession(sessionId: string): void {
    this.clearDrivenBy(sessionId)
    this.clearControl(sessionId)
  }

  /**
   * The window a session works in — its **workspace's browser window**.
   *
   * One window per workspace, shared by every conversation in it and by the user, whatever
   * the work is. Resolving it depends on the **workspace** alone; `sessionId` names who is
   * asking, and nothing about the window is written from it — which conversations are working
   * in it is
   * per tab (`BrowserTab.cursorOf` / `heldBy`), because a parent and its child sessions can
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
      mainLog.info(`[browser-pane] Workspace window resolved instance=${existing.id} workspace=${workspaceId ?? 'none'} askedBy=${sessionId ?? 'a person'} tabs=${existing.tabs.length}`)
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
   * identity now that there is one window per workspace: `workspaceId`
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
   * Take one session's driven-by mark off every tab it was driving.
   *
   * Swept across every window: a conversation can drive a tab in a window another one is
   * working in too, and a session being done with the browser has to drop *its* marks
   * wherever they are. A tab that says "driven by X" for a conversation that has stopped is
   * worse than one that says nobody has.
   */
  private clearDrivenBy(sessionId: string): void {
    for (const instance of this.instances.values()) {
      let changed = false
      for (const tab of instance.tabs) {
        if (tab.drivenBy !== sessionId) continue
        tab.drivenBy = null
        changed = true
      }
      if (!changed) continue
      this.pushToolbarState(instance)
      this.emitStateChange(instance)
    }
  }

  /**
   * Take one conversation's cursor off every tab it was working from.
   *
   * The conversation is gone, and a session that no longer exists cannot be anywhere: an id left
   * behind is state about nothing, and it is *read* — the toolbar names a tab by the conversation
   * working in it (`lockedBy ?? cursorOf[0]`) and the downloads folder is
   * resolved from it. Since 第二十四轮 it is no longer a wall (reach does not read cursors), so
   * leaving it would be a quiet lie rather than a locked door; it is dropped here all the same.
   *
   * Called **only** from {@link destroyForSession}, never when a turn (or a burst of turns) ends:
   * between turns the cursor is what makes that conversation's next unnamed command land where it
   * did last time.
   */
  private clearCursors(sessionId: string): void {
    for (const instance of this.instances.values()) {
      let changed = false
      for (const tab of instance.tabs) {
        if (!tab.cursorOf.includes(sessionId)) continue
        tab.cursorOf = tab.cursorOf.filter((session) => session !== sessionId)
        changed = true
      }
      if (!changed) continue
      this.pushToolbarState(instance)
      this.emitStateChange(instance)
    }
  }

  /**
   * Take one session's overlay and tab holds off every window it has them in.
   *
   * The other half of letting go, and swept the same way: a parent and its child sessions
   * share one window (Conductor), so "what this session was holding" is not a fact about a
   * window — it is scattered across the tabs that session claimed.
   */
  private clearControl(sessionId: string): void {
    for (const instance of this.instances.values()) {
      let changed = instance.controlBy.delete(sessionId)
      for (const tab of instance.tabs) {
        if (tab.heldBy !== sessionId) continue
        this.setHeldBy(tab, null)
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
   * Let go of everything a session was holding, because the session is **gone**. Nothing is
   * destroyed.
   *
   * The only window is its workspace's — every conversation in that workspace and the user
   * work in it — so a session being torn down lets go instead of taking the window with it:
   * another conversation or the user may be holding tabs in it right now.
   * There is no second kind of window to destroy, so what is left to give back is
   * what the session put *in* the window: {@link unbindAllForSession} does that part, and
   * this adds the one fact that only a gone session may give back — its **cursors**
   * ({@link clearCursors}).
   *
   * Why the cursor and not only the marks: a conversation that still exists keeps its tab,
   * but one that has been deleted cannot work anywhere again, so the tab it claimed would
   * stay claimed forever — out of reach for every other conversation and drawn nowhere.
   * The tab goes back to being nobody's, which is what it was
   * before that conversation took it over.
   */
  destroyForSession(sessionId: string): void {
    this.unbindAllForSession(sessionId)
    this.clearCursors(sessionId)
    // A conversation that is gone cannot be waiting for its recordings, and a recording outlives
    // nobody: its files live under the session's own folder (which goes with it).
    this.sessionRecordings.endAllFor(sessionId)
  }

  /**
   * Drop this session's overlay and native overlay state, wherever it had them.
   *
   * Called between turns: the session keeps its tabs (`cursorOf` is sticky) and only the
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

  /**
   * The document that draws everything the page's own view cannot: the surface *around* the page,
   * the panel's line there, and the agent's own frame when it holds the tab on screen.
   *
   * Five layers, in this order:
   *
   * - `#mask` fills the **surface** outside the page's rectangle, and nothing inside it. It sits
   *   under the page, so it is the gutter it paints, and where the page's own cut corners are it
   *   is whatever lies behind the page — here, or the window's own background, which is the same
   *   colour. It is deliberately square: the corner's *shape* is the page's cut and only the
   *   page's cut (`#mask` in the stylesheet has why that matters).
   * - `#frame` is the panel's own line — one pixel just outside the page (`PAGE_PANEL_RING`,
   *   the same line the address bar's input wears), visible only through that pixel band while
   *   the overlay is under the page.
   * - `#lock` is the agent's frame, in the resting line's box but with its own weight: 2.5px of
   *   accent, the outer pixel filling the gutter and the inner 1.5px covering the page's edge —
   *   corners included — with the lock's glow inside it. It gets its own element because it is a
   *   different placement of the ink, not just another colour.
   * - `#chip` and `#shield` are the agent's too: what it is doing here, and the lock that stops
   *   the person's input reaching this tab. Both only mean anything with the overlay *over* the
   *   page, which is exactly when the tab is held (`updateNativeOverlayState`).
   *
   * Geometry is baked here because it does not change with the theme or with who is working —
   * only the colours and which frame is shown do, and those are pushed on every update so a
   * theme switch reaches them. It is the **window's** document: loaded once, at `createInstance`,
   * so the ground is up before the first page is.
   */
  private loadNativeOverlay(instance: BrowserInstance): void {
    // A menu of ours was open when the person tapped the page under it: the overlay is over the
    // page exactly then, so the tap lands here rather than on the page — and a click on the page
    // is how a menu is dismissed. One install, because there is one overlay.
    instance.nativeOverlayView.webContents.on('before-input-event', (event, input) => {
      if (!instance.toolbarMenuOverlayActive) return

      const inputType = input.type || ''
      if (inputType === 'mouseDown' || inputType === 'touchStart' || inputType === 'pointerDown') {
        event.preventDefault()
        this.forceCloseToolbarMenu(instance, 'overlay-tap')
      }
    })

    void this.loadNativeOverlayDocument(instance)
  }

  private async loadNativeOverlayDocument(instance: BrowserInstance): Promise<void> {
    const inset = this.pagePanelInsets()

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
      /* The page's rectangle inside the tab area: the same gutter the tab is laid out with
         (see pagePanelInsets in the main process). The surface behind the page is everything
         *outside* this rectangle, filled by the spread shadow, and nothing inside it (the page
         covers that, and where it does not — the notches its own corners are cut out of — the
         window's own background is the same colour).

         Square on purpose, and the one place in this document that does not round anything: the
         page's corner is cut by the page's own view (see applyPageCornerRadius in the main
         process), and a second arc drawn here would be a second copy of that shape computed
         differently (CSS pixels here, the display's metrics there). Where the two disagree the
         page's own paint is what shows through — the page is above this document, so nothing here
         can cover it — and a page that paints white shows a white edge along the corner in dark
         mode, and eats the line's arcs at the four corners. */
      #mask {
        position: fixed;
        left: ${inset.left}px;
        top: ${inset.top}px;
        right: ${inset.right}px;
        bottom: ${inset.bottom}px;
        box-sizing: border-box;
        pointer-events: none;
        box-shadow: 0 0 0 9999px transparent;
      }
      /* The resting panel's line: one pixel *outside* the page's rectangle, with the radius one
         pixel larger. The page sits above this document, so only what falls outside the page's
         own rectangle can be seen — and with the extra pixel the line's inner edge follows the
         page's corner exactly. It is a real border rather than a pseudo-element masked into a
         ring: same pixel, but a border's arcs are anti-aliased by the browser.

         Only ever visible while nothing is happening on this tab: a held tab drops it for the
         agent's own frame below. */
      #frame {
        position: fixed;
        left: ${inset.left - 1}px;
        top: ${inset.top - 1}px;
        right: ${inset.right - 1}px;
        bottom: ${inset.bottom - 1}px;
        border-radius: ${PANEL_RADIUS_INNER + 1}px;
        border: ${PAGE_PANEL_RING.width} solid transparent;
        box-sizing: border-box;
        pointer-events: none;
      }
      /* The agent's frame, while it holds this tab: its own element because it is drawn
         differently, not just in another colour.

         It shares the resting line's box — one pixel *outside* the page, radius one larger, so
         its arcs stay concentric with the page's corner — and then its border is 2.5px: the
         outer 1px lands in the gutter the resting line lives in (so the accent reaches all the
         way to the chrome, with no sliver of surface left beside it) and the inner 1.5px covers
         the page's own edge, corners included. Covering the edge matters: the page's corner is
         cut by its view, a hard edge that nothing outside the page can hide — and the overlay is
         over the page at that moment, so ink here can. */
      #lock {
        position: fixed;
        left: ${inset.left - 1}px;
        top: ${inset.top - 1}px;
        right: ${inset.right - 1}px;
        bottom: ${inset.bottom - 1}px;
        border-radius: ${PANEL_RADIUS_INNER + 1}px;
        border: 2.5px solid transparent;
        box-sizing: border-box;
        pointer-events: none;
        display: none;
      }
      #chip {
        position: fixed;
        top: 8px;
        right: ${inset.right + 8}px;
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
    <div id="mask"></div>
    <div id="frame"></div>
    <div id="lock"></div>
    <div id="chip">Agent is working…</div>
    <div id="shield"></div>
  </body>
</html>`

    try {
      await instance.nativeOverlayView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      instance.nativeOverlayReady = true
      mainLog.info(`[browser-pane] native overlay ready id=${instance.id} pageCorner=${PANEL_RADIUS_INNER} gutter=${inset.left}/${inset.right}/${inset.bottom}`)
      this.updateNativeOverlayState(instance)
    } catch (error) {
      instance.nativeOverlayReady = false
      mainLog.warn(`[browser-pane] native overlay load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Drop the in-page theme check a tab has pending, if any.
   *
   * Per tab rather than per window, like everything else a tab owns: the timer
   * belongs to the view that scheduled it, and leaving it on the window would mean
   * a tab switch could cancel a check the *other* tab was waiting on.
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
   * The rail takes its room off the *side* (`TAB_RAIL_WIDTH`), so this is only the
   * row — and every layout asks `tabAreaBounds`/`pageAreaBounds` rather than doing the
   * sums, so a tab is never laid out over its own chrome, nor over the gutter its panel
   * is inset by.
   */
  private toolbarChromeHeight(): number {
    return TOOLBAR_HEIGHT
  }

  /**
   * Where the tab area is: right of the rail, below the bar.
   *
   * One answer for every reader — the agent overlay's bounds (it covers this and nothing else)
   * and the viewport `viewport-resize` promises — so they cannot disagree about how much window
   * the tab area actually gets. The page *inside* it is smaller still: see
   * {@link pageAreaBounds}.
   */
  private tabAreaBounds(instance: BrowserInstance): { x: number; y: number; width: number; height: number } {
    const [width, height] = instance.window.getContentSize()
    return {
      x: TAB_RAIL_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(200, width - TAB_RAIL_WIDTH),
      height: Math.max(100, height - TOOLBAR_HEIGHT),
    }
  }

  /**
   * The gutter between the tab area's edges and the page panel drawn inside it.
   *
   * The page hugs the chrome it sits against — the rail on its left and the bar above it — with
   * exactly **1px** between them, and keeps `PANEL_EDGE_INSET` from the window's right and bottom
   * edges, where there is nothing to hug (the app insets its own panels by that much).
   *
   * Those 1px are not spacing (the person's call: the page stays flush against the chrome
   * otherwise): the line is drawn just *outside* the page, and both chrome surfaces are views
   * above this one — flush against them the line's top and left lines would be painted behind
   * them and never seen. One pixel is all a line needs, and it is what the app gets for free by
   * drawing its panels' lines in the same document as its chrome.
   */
  private pagePanelInsets(): { left: number; top: number; right: number; bottom: number } {
    return { left: 1, top: 1, right: PANEL_EDGE_INSET, bottom: PANEL_EDGE_INSET }
  }

  /**
   * Where the page is: the tab area inset by the panel's gutter.
   *
   * This is the tab's bounds — what the site sees as its viewport — while the overlay covers
   * the whole tab area, because the overlay is what paints the surface in the gutter and the
   * page's rounded corners over its square ones.
   */
  private pageAreaBounds(instance: BrowserInstance): { x: number; y: number; width: number; height: number } {
    const area = this.tabAreaBounds(instance)
    const inset = this.pagePanelInsets()
    return {
      x: area.x + inset.left,
      y: area.y + inset.top,
      width: area.width - inset.left - inset.right,
      height: area.height - inset.top - inset.bottom,
    }
  }

  /**
   * Both chrome surfaces above the tab, the rail on top.
   *
   * The rail goes last so it is the topmost view in the window: it is the one surface
   * a person must always be able to reach, so nothing — tab, agent overlay, or the
   * bar while its menu is expanded over the tab — gets to sit over it. The tab's own
   * geometry already stops where the rail starts, plus the panel's gutter
   * (`pageAreaBounds`); this is the belt to that pair of braces.
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
   * that reached only one of them would leave the other showing yesterday's tabs,
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
   * it. The bar still expands downwards over the tab while its menu is open; the rail
   * is not part of that, and stays both visible and clickable.
   */
  private layoutToolbarView(instance: BrowserInstance): void {
    const [width] = instance.window.getContentSize()
    const toolbarHeight = this.getToolbarEffectiveHeight(instance)
    const railWidth = Math.min(TAB_RAIL_WIDTH, width)

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
      width: Math.min(TAB_RAIL_WIDTH, width),
      height: Math.max(120, height),
    })
    instance.railView.setAutoResize({ width: false, height: true })
  }

  /**
   * Which tab a conversation works from — the **cursor** on its own.
   *
   * Split out of {@link recordSessionTab} because the two halves of that write do not always
   * belong together: a conversation's own work takes the tab *and* the driven-by mark, while a
   * tab that was nobody's, set up for it by the person (the same terms `assignTab` hands one
   * over on) takes only the cursor. One conversation has one cursor, so pointing at this tab
   * releases whatever tab it meant before — **without** touching the other conversations that
   * work from this one (第二十四轮): the list holds one entry each, and taking the tab never
   * takes anybody else's route away.
   */
  private pointConversationAt(instance: BrowserInstance, tabId: string, sessionId: string): void {
    for (const tab of instance.tabs) {
      if (tab.id === tabId || !tab.cursorOf.includes(sessionId)) continue
      tab.cursorOf = tab.cursorOf.filter((session) => session !== sessionId)
    }
    const target = tabById(instance, tabId)
    if (target && !target.cursorOf.includes(sessionId)) {
      target.cursorOf = [...target.cursorOf, sessionId]
    }
  }

  /**
   * This conversation is now working **from** this tab.
   *
   * One call for one fact, read at three speeds:
   *
   * - the **cursor** (`tab.cursorOf`) is sticky — it answers "which tab does this
   *   conversation's next unnamed command mean", and it survives the turn ending, because
   *   the person clicking around must not move somebody else's target. One entry per
   *   conversation, so the tab can carry several at once and this write takes nothing away
   *   from the others (第二十四轮); it is given back only when the conversation ceases to
   *   exist ({@link clearCursors});
   * - the **driven-by** mark (`tab.drivenBy`) is "who moved it last" — one per tab,
   *   and a conversation may have several, so it is not a claim of its own; swept when the
   *   conversation stops working or the tab changes hands, not at every turn's end (only the
   *   last one, when the queue empties);
   * - the **hold** (`tab.heldBy`) lasts as long as the overlay does — the tab is held while
   *   that session works, and let go when its turn ends or the person releases it (`release`).
   *
   * A session without the overlay on this window gets the first two and not the hold: an
   * overlay is what says "somebody is at the wheel here right now", and a conversation that
   * is not working is not holding anything.
   *
   * This is the write; {@link setSessionTab} is the public verb around it (a window id
   * instead of a live instance) and is what a command reaches for.
   */
  private recordSessionTab(instance: BrowserInstance, tabId: string, sessionId: string): void {
    this.pointConversationAt(instance, tabId, sessionId)
    const target = tabById(instance, tabId)
    if (target) {
      // The tab a conversation works from is the tab it is driving: this is the tab the
      // command is about, so the driven-by mark is written here rather than where the
      // window was resolved. It says "last moved by", not "owned by" — and
      // it is swept when the conversation **stops working**: its queue of turns empties
      // (`unbindAllForSession`), it is force-stopped, or it is deleted — and when the tab
      // changes hands (`assignTab`). A turn ending is that moment only when nothing is
      // queued; the hold, by contrast, is let go at the end of *every* turn
      // (`clearVisualsForSession`) — so the rail can draw the dot without the lock: the dot
      // is this mark on a tab the conversation drove and is not inside right now. Moving the
      // cursor to another tab leaves this one as a tab that conversation did work on.
      target.drivenBy = sessionId
    }

    if (target && instance.controlBy.has(sessionId)) {
      this.holdTab(instance, target.id, sessionId)
    }
  }

  /**
   * The lock on one tab, and the one thing that rides with it.
   *
   * While a conversation holds a tab it is driving that tab, and a driven page is told it is
   * focused — the reading a person's own click would have given it, and no longer than the work
   * lasts (`BrowserCDP.setFocusEmulation`; `spike/anti-bot-fingerprint.ts` round 2 is the
   * measurement behind that choice, and why `webContents.focus()` is not it).
   *
   * The single writer for `heldBy`: the lock is taken in one place and let go in four, and the
   * page's reading has to move with it in all of them, so they come through here rather than
   * each remembering to.
   *
   * @returns whether anything changed — callers only announce a lock that moved.
   */
  private setHeldBy(tab: BrowserTab, sessionId: string | null): boolean {
    if (tab.heldBy === sessionId) return false
    tab.heldBy = sessionId
    void tab.cdp.setFocusEmulation(sessionId !== null)
    return true
  }

  /**
   * This session is holding this tab now — and, being one session, only this one tab.
   *
   * One hold per session (`agentControl.tabId` used to be that single slot, for the whole
   * window): a conversation works from one tab at a time, so claiming a new one lets the
   * old go. Several conversations may each hold their own tab of the same window at once
   * — that is what makes parallel children possible.
   */
  private holdTab(instance: BrowserInstance, tabId: string, sessionId: string): void {
    let changed = false
    for (const tab of instance.tabs) {
      if (tab.id === tabId || tab.heldBy !== sessionId) continue
      if (this.setHeldBy(tab, null)) changed = true
    }
    const target = tabById(instance, tabId)
    if (target && this.setHeldBy(target, sessionId)) changed = true
    if (!changed) return
    this.updateNativeOverlayState(instance)
    mainLog.info(`[browser-pane] Tab held session=${sessionId} instance=${instance.id} tab=${tabId}`)
  }

  /**
   * Let go of a tab that is held — used when the tab is gone, so a lock can never outlive
   * what it locks.
   */
  private releaseHeldTab(instance: BrowserInstance, tabId: string): void {
    const held = tabById(instance, tabId)
    if (!held?.heldBy) return
    this.setHeldBy(held, null)
    this.updateNativeOverlayState(instance)
    mainLog.info(`[browser-pane] tab lock released with its tab instance=${instance.id} tab=${tabId}`)
  }

  /**
   * Draw the page's panel around the tab on screen — and the agent's markings, when it holds
   * that tab.
   *
   * The overlay is up whenever the window is, not only while somebody is working: it is what
   * rings the page (`loadNativeOverlay`), and the page's own corner is cut by the page's view
   * (`applyPageCornerRadius`), so there is nothing else that could. What comes and goes with
   * the work is the **accent** and the shield: while the tab on screen is held, the ring turns
   * accent, the page dims, and the tab stops taking input; on any other tab the panel is just
   * the panel.
   *
   * One overlay for the window, so one position: the tab area of the tab on screen. A tab
   * nobody is looking at draws nothing here for free — there is no view of its own to leave
   * behind (see `BrowserInstance.nativeOverlayView`).
   */
  private updateNativeOverlayState(instance: BrowserInstance): void {
    const heldBy = activeTab(instance).heldBy
    const menuActive = !!instance.toolbarMenuOverlayActive
    // The lock is the tab's, so the accent, the dim and the shield all answer to this one
    // question, and all three belong to the tab on screen alone.
    const locked = heldBy !== null
    // What is being done is named by whoever is at the wheel on the tab on screen — the state
    // is read off that tab, so there is no other conversation it could be reporting.
    const label = this.getAgentControlLabel(heldBy ? instance.controlBy.get(heldBy) : null)
    // The tab on screen is the only one a person can touch, and it takes input back only while
    // that tab is the held one, or a menu of ours is open above it. Switching to another tab
    // therefore hands the keyboard and mouse straight back.
    const shieldActive = locked || menuActive

    const overlay = instance.nativeOverlayView

    if (!instance.nativeOverlayReady || instance.window.isDestroyed()) {
      overlay.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      overlay.setAutoResize({ width: false, height: false })
      if (!instance.window.isDestroyed()) {
        this.raiseChromeViews(instance)
      }
      return
    }

    // The overlay is the tab area, so it is measured off the window the same way the page is — and a
    // window with no size would give it the same made-up 193×93 (`windowHasSize`). Leave it as it is;
    // the window coming back lays it out again.
    if (!this.windowHasSize(instance)) return

    // The overlay covers the whole tab area — the page *and* the gutter the panel is inset by:
    // it is what paints the surface in that gutter and the panel's hairline. The chrome is
    // still not covered by it: the rail and the bar stay the person's, and a person has to be
    // able to switch tabs while it is up.
    const area = this.tabAreaBounds(instance)
    overlay.setBounds(area)
    overlay.setAutoResize({ width: true, height: true })

    // Which of the two is on top is the whole of "is this tab locked or not", and the page is
    // on top whenever it can be: a view covers a rectangle whatever it paints, so an overlay
    // left over the page takes the page's clicks with it — every click, not just the ones near
    // the panel's ink. Everything the overlay draws is *around* the page (the gutter's surface,
    // the panel's hairline) or belongs to a lock, so under the page it is invisible where it
    // would matter and harmless where it is not.
    if (shieldActive) {
      instance.window.setTopBrowserView(overlay)
    } else {
      instance.window.contentView.addChildView(activeTab(instance).tabView)
    }
    this.raiseChromeViews(instance)

    // Resolved on every update rather than baked into the document, because both follow the
    // OS/app theme and the window outlives a theme switch.
    const surface = getBackgroundColor(nativeTheme.shouldUseDarkColors)
    const ring = resolvePagePanelRing(nativeTheme.shouldUseDarkColors)
    const accent = this.getResolvedAccentColor()
    const lockedGlow = `inset 0 0 0 1px color-mix(in oklab, ${accent} 45%, transparent), inset 0 0 24px color-mix(in oklab, ${accent} 28%, transparent)`

    void overlay.webContents.executeJavaScript(`(() => {
      const mask = document.getElementById('mask');
      const frame = document.getElementById('frame');
      const lock = document.getElementById('lock');
      const chip = document.getElementById('chip');
      const shield = document.getElementById('shield');
      if (!mask || !frame || !lock || !chip || !shield) return;

      const locked = ${locked};
      const shieldActive = ${shieldActive};

      // The surface the panel sits on, outside the page's rectangle — the colour the rail and the
      // bar beside it are drawn in, so the panel reads as a panel on this window's surface rather
      // than on a second one. Nothing here decides the corner's shape: that is the page's own cut,
      // and the stylesheet's #mask comment has why it is left to the page.
      mask.style.boxShadow = '0 0 0 9999px ' + ${JSON.stringify(surface)};

      // Which of the two frames is drawn: the resting line outside the page while nothing is
      // happening here, and — once this tab is held — the agent's own frame over the page's edge,
      // with the glow inside it. One or the other and never both: they are two placements of the
      // same ink, and both would be on screen at once.
      frame.style.display = locked ? 'none' : 'block';
      frame.style.borderColor = ${JSON.stringify(ring)};

      lock.style.display = locked ? 'block' : 'none';
      lock.style.borderColor = ${JSON.stringify(accent)};
      lock.style.boxShadow = ${JSON.stringify(lockedGlow)};
      lock.style.background = 'rgba(2, 6, 23, 0.03)';

      if (locked) {
        chip.textContent = ${JSON.stringify(label)};
        chip.style.display = 'inline-flex';
      } else {
        chip.style.display = 'none';
      }

      // The shield takes input for two reasons and no more: this tab is locked by the
      // conversation working on it (the lock is on the tab, so the
      // rail, the address bar and the window's own size stay the person's), or a menu of
      // ours is open above the tab and a click on the tab is how it is dismissed.
      shield.style.pointerEvents = shieldActive ? 'auto' : 'none';
      shield.style.cursor = locked ? 'not-allowed' : 'default';
      shield.style.background = (shieldActive && !locked) ? 'rgba(0, 0, 0, 0.001)' : 'transparent';
    })()`).catch(() => {})
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.destroyInstance(id)
    }
    this.stopWatchingDisplays()
  }

  /**
   * Destroy every browser window of a workspace.
   *
   * The window is the workspace's (not a session's), so this is what "that workspace is
   * off the screen" means for the browser pane: the window has nothing left to belong
   * to, and it never closes itself — left alone it would hold live renderers that nobody
   * can reach, and keep `window-all-closed` from ever firing.
   *
   * A window created with no workspace context (`workspaceId` null) belongs to none and
   * is not touched here.
   */
  destroyForWorkspace(workspaceId: string): void {
    for (const instance of [...this.instances.values()]) {
      if (instance.workspaceId === workspaceId) {
        this.destroyInstance(instance.id)
      }
    }
  }

  private finalizeDestroyedInstance(instance: BrowserInstance, source: 'destroy' | 'closed'): void {
    if (!this.instances.has(instance.id)) {
      return
    }

    this.destroyingIds.delete(instance.id)

    /*
     * **Every step here is allowed to fail, and no step is allowed to stop the next one.** The
     * instance leaving `instances` is the one thing this method owes: while it is in there, callers
     * see a window that no longer exists, and `removedCallback` — how the rest of the app hears a
     * browser window is gone — never runs. Measured: a throwing cleanup step (the overlay's own
     * state push) used to escape from here, so the pages stayed open, the parking window stayed on
     * the desktop and the instance stayed in the map.
     */
    const step = (label: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        mainLog.warn(`[browser-pane] teardown failed instance=${instance.id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }

    step('overlay', () => this.updateNativeOverlayState(instance))
    step('cdp detach', () => activeTab(instance).cdp.detach())

    /*
     * **Every tab's page is closed by name**, because a window being destroyed does not close the
     * `WebContentsView`s inside it.
     *
     * Measured, on the terminate path: the window and its parking window are gone, the chrome's own
     * pages (toolbar, rail, overlay — `BrowserView`s, which the window does own) are closed, and both
     * tab pages were **still running** a few seconds later — the page on screen *and* the one parked
     * in the parking window — closable by hand, so they were live renderers, not stale records. Left
     * alone, every terminated browser window would leave its tabs' processes behind.
     *
     * So this is not tidiness, it is what a terminate *is*: the pages go, and the windows follow. Each
     * page is closed while the window holding its view still exists, and **the parking window's own
     * destruction is the consequence** — it is left holding nothing, and a window left holding nothing
     * must not be left behind on a desktop nobody can see.
     */
    for (const tab of instance.tabs) {
      step(`closing tab ${tab.id}`, () => {
        this.clearInPageThemeTimer(tab)
        // `webContents` is gone from a view whose page has already been closed, not just destroyed:
        // measured, `view.webContents` is `undefined` after `close()` — so a tab that was closed before
        // its window is not an error here, it is a tab with nothing left to close.
        const wc = tab.tabView.webContents
        if (wc && !wc.isDestroyed()) wc.close()
      })
    }

    // The window the tabs that are not on screen live in goes with the window they belong to.
    step('parking window', () => {
      const parking = instance.parkingWindow
      if (parking && !parking.isDestroyed()) parking.destroy()
    })
    instance.parkingWindow = null
    this.instances.delete(instance.id)
    this.removedCallback?.(instance.id)
    mainLog.info(`[browser-pane] Destroyed instance: ${instance.id} (${source})`)
  }

  /**
   * Lay the tab on screen out at the page area, stack it on top, and keep every other tab where it
   * lives.
   *
   * The ones behind are **not** parked at zero size, and not moved out of this window either: a view
   * at zero size or outside a window's rectangle has **no viewport at all** (coordinates, rects and
   * scrolling in it mean nothing, and capturing it returns an empty image), which is what used to
   * make a background tab unusable. They live in the parking window, shown off screen, at the size
   * they had when they were last on screen — see `parkTab`.
   *
   * Switching tabs is therefore: the tab arriving on screen is laid out and raised, the one leaving
   * is parked — one resize for the arrival, and nothing for a tab that stays behind, whatever the
   * person does to the window (measured in `apps/electron/spike/background-viewport.ts`).
   */
  private layoutTabView(instance: BrowserInstance): void {
    // A window with no size of its own has no geometry to hand out: laying anything out from it would
    // write the floors in `tabAreaBounds` into the page — 193×93, which looks like a size rather than
    // a mistake (`windowHasSize`). The window coming back is what lays out again.
    if (!this.windowHasSize(instance)) return

    // The page panel, not the whole tab area: the gutter around it is the overlay's to paint
    // (`pageAreaBounds`), and the page's own corners are cut out of its view
    // (`applyPageCornerRadius`) so the surface behind them shows through.
    const area = this.pageAreaBounds(instance)
    const onScreen = activeTab(instance)

    // **The tab on screen is the only one laid out**, and it is laid out to the window. Every other
    // tab is parked in the window they live in, at the viewport it has — so the person dragging the
    // window is not a reason for an agent's background page to reflow, and the agent measured that
    // page, its elements and their coordinates at the size it has. That a parked tab keeps its
    // viewport is the whole reason it is parked in a *shown* window rather than moved out of this
    // one (`parkTab`, `parkingWindowFor`).
    onScreen.tabView.setBounds(area)
    for (const tab of instance.tabs) {
      if (tab.id === onScreen.id) continue
      this.parkTab(instance, tab)
    }

    this.raiseActiveTab(instance)
    this.updateNativeOverlayState(instance)
  }

  /**
   * The window a tab that is not on screen lives in — outside every display, and **shown**.
   *
   * Shown is the point: a view in a window that is never shown is never composited, and a view that
   * is not composited has **no viewport** — measured, for a view created at negative coordinates or
   * in an unshown window: `innerWidth` 0, `document.hidden`, 0 frames, a `0×0` capture, and CDP
   * input landing nowhere (`apps/electron/spike/background-viewport.ts` section E). So a frozen tab
   * is not "moved out of the window's way"; it is *housed* somewhere it can keep its layout.
   *
   * Off every display (`offscreenSpot`), `skipTaskbar`, shown without being activated: nothing of it
   * is visible, it is never in the taskbar, and it never takes anyone's focus. One per browser window,
   * made when the first tab is parked and destroyed with the window. It **follows the views in it** in
   * both directions — `parkedViewsFit` — because a window clips its children and a clipped view is a
   * view with a smaller viewport, while anything larger than what it holds is space nobody sees.
   *
   * "Off every display" is then **kept true** rather than assumed (`keepOffEveryDisplay`): the spot
   * is only what the desktop was asked for, and the person can change their screens out from under it.
   */
  private parkingWindowFor(instance: BrowserInstance): BrowserWindow {
    const wanted = this.parkedViewsFit(instance)
    const existing = instance.parkingWindow
    if (existing && !existing.isDestroyed()) {
      const [width, height] = existing.getContentSize()
      // Both ways: a view set smaller gives the space back, and one set larger gets room rather than
      // being clipped. The parking window is nobody's to look at, so its size is only ever "what it
      // has to be".
      if (wanted.width !== width || wanted.height !== height) {
        existing.setContentSize(wanted.width, wanted.height)
      }
      this.keepOffEveryDisplay(existing)
      return existing
    }

    const spot = this.offscreenSpot(wanted)
    const parking = new BrowserWindow({
      x: spot.x,
      y: spot.y,
      width: wanted.width,
      height: wanted.height,
      show: false,
      frame: false,
      skipTaskbar: true,
      backgroundColor: getBackgroundColor(nativeTheme.shouldUseDarkColors),
    })
    instance.parkingWindow = parking
    // Shown, or nothing inside it is composited — and never activated, so it cannot take the focus.
    parking.showInactive()
    // Wherever it ended up (the desktop may have capped the spot), it may not be on a display; and it
    // is watched from here on, because it can stop being clear of them without anyone asking us.
    parking.on('move', () => this.keepOffEveryDisplay(parking))
    parking.on('resize', () => this.keepOffEveryDisplay(parking))
    // …and it may not stop being shown either. A window that is not shown is not composited, and a
    // view that is not composited loses its viewport entirely (measured: `background-viewport.ts`
    // section E), which is the one thing this window exists to prevent. Nothing about it is the
    // person's — it is off every display, out of their taskbar, never focused — so a shell-wide
    // "minimize everything" (or a stray `hide()` of ours) is not allowed to leave it that way.
    parking.on('minimize', () => this.keepShowing(parking))
    parking.on('hide', () => this.keepShowing(parking))
    this.keepOffEveryDisplay(parking)
    this.watchDisplays()
    // Where it *is*, not where it was asked to go: the desktop caps that (measured: 16383 DIPs
    // whatever you ask for), and the log is read by people debugging a window they can see.
    const landed = parking.getBounds()
    mainLog.info(`[browser-pane] parking window up instance=${instance.id} at=${landed.x},${landed.y} size=${wanted.width}x${wanted.height}`)
    return parking
  }

  /**
   * Put a window that has to be shown **back on screen** — off every display, never focused, but
   * shown: that is the whole reason the views inside it are real (`background-viewport.ts` section E).
   *
   * Called when something minimizes or hides it. Measured: minimizing the person's own window does
   * **not** reach this one (separate top-level windows, no owner), so this is here for the things
   * that do — a shell-wide "minimize everything", or our own mistake.
   */
  private keepShowing(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    if (window.isMinimized()) {
      window.restore()
      mainLog.warn('[browser-pane] the parking window was minimized; restored it off screen')
    }
    if (!window.isVisible()) {
      window.showInactive()
      mainLog.warn('[browser-pane] the parking window was hidden; showed it again off screen')
    }
    this.keepOffEveryDisplay(window)
  }

  /**
   * Watch the displays, because "off every display" is a relation and the displays move: a screen
   * plugged in beside the parking spot, a scaling change that rescales every coordinate.
   *
   * Registered the first time a parking window exists, and dropped with the last one
   * (`stop`/`destroyAll`), so a manager that never parks anything subscribes to nothing.
   */
  private watchDisplays(): void {
    if (this.displayWatcher) return
    this.displayWatcher = () => {
      for (const instance of this.instances.values()) {
        const parking = instance.parkingWindow
        if (parking && !parking.isDestroyed()) {
          // Whatever the change did to the coordinates, the answer is the same: it stays off every
          // display, and it stays *shown* — it is what makes the views inside it real.
          this.keepShowing(parking)
        }
      }
    }
    screen.on('display-added', this.displayWatcher)
    screen.on('display-removed', this.displayWatcher)
    screen.on('display-metrics-changed', this.displayWatcher)
  }

  /** Stop watching the displays (the instances and their parking windows are gone). */
  private stopWatchingDisplays(): void {
    if (!this.displayWatcher) return
    screen.removeListener('display-added', this.displayWatcher)
    screen.removeListener('display-removed', this.displayWatcher)
    screen.removeListener('display-metrics-changed', this.displayWatcher)
    this.displayWatcher = null
  }

  /**
   * Whether the window has a size to lay anything out to.
   *
   * A **minimized** window on Windows reports `getContentSize()` 0×0 (measured), and the floors in
   * `tabAreaBounds` then turn that into a *plausible* 193×93 (200-7 by 100-7) instead of something
   * obviously broken — so a layout run at that moment writes a fiction into the page's view, and the
   * page stays that small after the window comes back (measured: window 1200×900, page `innerWidth`
   * 193, until the next layout — a tab switch — put it right. The person's report: "怎么用着用着浏览器
   * 窗口会变成一个很小的值 193×93。切换标签界面又恢复了").
   *
   * Nothing laid out while the window is minimized is visible to anyone, so the honest answer is to
   * leave every view exactly as it is — a tab in the parking window keeps its viewport anyway — and
   * lay out when there is a window to lay out into again.
   */
  private windowHasSize(instance: BrowserInstance): boolean {
    if (instance.window.isDestroyed() || instance.window.isMinimized()) return false
    const [width, height] = instance.window.getContentSize()
    return width > 0 && height > 0
  }

  /**
   * The size the parking window has to be: **exactly what it holds**, read off the tabs that are in
   * it.
   *
   * It cannot be smaller than the largest of them — a window clips its children, and a clipped view is
   * a view with a smaller viewport than the one the agent set and measured — and there is no reason
   * for it to be larger, since nobody can see it. So it follows the views both ways: a tab set smaller
   * gives the space back, and a tab set larger gets the room.
   *
   * Read from the views rather than tracked: the bounds of a parked view **are** its viewport
   * (`parkTab`), so there is no second copy of the answer to keep in step. The tab on screen is left
   * out — it is not in this window (`layoutTabView`).
   */
  private parkedViewsFit(instance: BrowserInstance): { width: number; height: number } {
    let width = 1
    let height = 1
    for (const tab of instance.tabs) {
      if (tab.id === activeTab(instance).id) continue
      const bounds = tab.tabView.getBounds()
      width = Math.max(width, Math.ceil(bounds.width))
      height = Math.max(height, Math.ceil(bounds.height))
    }
    return { width, height }
  }

  /**
   * Where a tab that is not on screen lives: **the parking window**, at the size it has.
   *
   * A tab that has never been on screen is *created* here (`attachTab`), at the size the page area
   * had at that moment — that is its viewport until it comes forward, and nothing about the person's
   * window touches it in the meantime (`layoutTabView` only lays out the tab on screen).
   *
   * The view is sized **before** the window is asked for, so the window is fitted to what it will
   * hold at the size it is about to have — including a view the agent just made larger or smaller
   * (`parkedViewsFit`).
   */
  private parkTab(instance: BrowserInstance, tab: BrowserTab, size?: { width: number; height: number }): void {
    // A tab whose page is gone is not parked anywhere: there is nothing left to size, and no reason to
    // make the window that would hold it. (`webContents` is `undefined` once a page has been closed,
    // not a destroyed object, so this cannot be read blindly.)
    const page = tab.tabView.webContents
    if (!page || page.isDestroyed()) return

    const own = size ?? {
      width: tab.tabView.getBounds().width,
      height: tab.tabView.getBounds().height,
    }
    // At the window's corner: parked views sit at the same spot and overlap, which costs the ones
    // underneath their *surface* (Chromium treats a covered view as hidden) and costs none of them
    // their viewport — the layout is what the freeze is for, and a shot of a parked tab is taken in
    // a window of its own anyway (`captureWhileParked`).
    tab.tabView.setBounds({ x: 0, y: 0, width: own.width, height: own.height })
    const parking = this.parkingWindowFor(instance)
    if (parking.isDestroyed()) return
    parking.contentView.addChildView(tab.tabView)
  }

  /**
   * The page's own corners — the one thing the panel look needs from the page's view itself.
   *
   * Every page is rounded, ours and a stranger's alike, and the corner is *cut out of the view*
   * rather than painted over: what shows through it is the overlay underneath (which fills that
   * area with the surface), so nothing sits over the page and the person's clicks reach it. A
   * view's radius is one number, so all four corners take `PANEL_RADIUS_INNER`; the app's own
   * panels draw the corner nearest the window a couple of pixels tighter, which is not worth a
   * second mechanism here.
   */
  private applyPageCornerRadius(tab: BrowserTab): void {
    tab.tabView.setBorderRadius(PANEL_RADIUS_INNER)
  }

  /**
   * Put the page of the tab on screen above the other tabs, and the chrome above everything.
   *
   * The page is raised through `contentView` (it is a `WebContentsView`) while the chrome is
   * raised through `setTopBrowserView` (still a `BrowserView`) — the two share one tree, so the
   * order they are given here holds. The window's overlay is not part of this: whether it sits
   * above or below the page depends on whether the tab on screen is locked, which is
   * `updateNativeOverlayState`'s business.
   */
  private raiseActiveTab(instance: BrowserInstance): void {
    if (instance.window.isDestroyed()) return
    instance.window.contentView.addChildView(activeTab(instance).tabView)
    this.raiseChromeViews(instance)
  }

  private layoutAllViews(instance: BrowserInstance): void {
    this.layoutToolbarView(instance)
    this.layoutRailView(instance)
    this.layoutTabView(instance)
    this.raiseChromeViews(instance)
    this.reassertPageCornerRadii(instance)
  }

  /**
   * Say the page's corner radius again, for every tab.
   *
   * Setting it once at tab creation is not enough: the radius is a native property of the view
   * whose cut is built against the window's current display metrics, and that cut does not
   * survive the window arriving on a different display (moved between monitors, or a display
   * whose scale factor changed) — the corner comes back square. A square corner is not just a
   * cosmetic difference: it lets the page's own paint reach the shape the panel's line follows,
   * so the line's arcs are covered at the four corners, and a page that paints white shows
   * there — which is exactly what is seen in dark mode.
   *
   * Saying it again costs a call and rebuilds the cut, so this is re-asserted from `moved` and
   * from every relayout (which the window's `resize` goes through) rather than tracked.
   */
  private reassertPageCornerRadii(instance: BrowserInstance): void {
    for (const tab of instance.tabs) {
      this.applyPageCornerRadius(tab)
    }
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
    return url.includes(`/${BROWSER_EMPTY_STATE_FILE}`) || url.includes(`\\${BROWSER_EMPTY_STATE_FILE}`)
  }

  private normalizeTabState(url: string, title: string): { url: string; title: string } {
    if (this.isBrowserEmptyStateUrl(url)) {
      return { url: 'about:blank', title: 'New Tab' }
    }
    return { url, title }
  }

  private async loadEmptyStateDocument(instance: BrowserInstance, tab: BrowserTab = activeTab(instance)): Promise<void> {
    if (VITE_DEV_SERVER_URL) {
      await tab.tabView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/${BROWSER_EMPTY_STATE_FILE}`)
      return
    }

    await tab.tabView.webContents.loadFile(join(__dirname, `renderer/${BROWSER_EMPTY_STATE_FILE}`))
  }

  /**
   * Put a document in a tab the moment it is created.
   *
   * A view that has never painted contributes no pixels of its own, and a window's tabs
   * all sit at the same bounds — so a tab created and left empty does not read as "empty",
   * it reads as the tab stacked underneath it: switching to a new tab showed the tab
   * that was there before. Every path that makes a tab therefore
   * leaves one of these behind, and this is the one place it happens.
   *
   * Superseded is the normal outcome, not a failure: a tab created *at* an address
   * (a link, a homepage) is told where to go in the same breath, and that navigation is
   * the document the tab was really made for.
   */
  private startEmptyStateLoad(instance: BrowserInstance, tab: BrowserTab): void {
    void this.loadEmptyStateDocument(instance, tab).catch((error) => {
      const superseded = abortedLoad(error)
      if (superseded) {
        mainLog.info(`[browser-pane] empty-state load superseded id=${instance.id} tab=${tab.id} aborted=${superseded.url ?? 'unknown'}`)
        return
      }
      mainLog.warn(`[browser-pane] empty-state load failed id=${instance.id} tab=${tab.id}: ${error instanceof Error ? error.message : String(error)}`)
    })
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
      await activeTab(instance).tabView.webContents.executeJavaScript(
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
    const title = surface === 'rail' ? 'Browser tab rail failed to load' : 'Browser toolbar failed to load'
    const body = surface === 'rail'
      ? 'The tab area still works, but the tab rail is unavailable. Tabs can still be switched and added from the app, or by the agent.'
      : 'The tab area still works, but toolbar UI is unavailable. Try reopening the browser window.'
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser Toolbar Error</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: ${BACKGROUND_HEX.light}; color: #1f2937; }
      @media (prefers-color-scheme: dark) { html, body { background: ${BACKGROUND_HEX.dark}; color: #e5e7eb; } }
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
   * Names for the conversations that opened some of this window's tabs.
   *
   * The rail groups the tabs by work and names each section — a session's tabs by the
   * conversation, a task's by the task (that name comes from the tab's own `belongsTo`, and
   * needs nothing from here); this map answers the first kind. `sessionId` is an id, and a
   * header reading `session-4f2a…` is not an answer to "whose tabs are these". Only openers
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

  /**
   * The window's downloads, newest first, for the chrome's list.
   *
   * Read from the workspace's log — the same list `getDownloads` answers the agent with,
   * not a copy of it — and reversed for drawing: the log is written oldest-first, and a
   * person asking "what just happened" reads the top of the list. Which tab any of them
   * came from is not part of the answer, because a download is not the tab's.
   */
  private recentDownloads(instance: BrowserInstance): BrowserDownloadEntry[] {
    return this.downloadsFor(instance.workspaceId)
      .slice(-TOOLBAR_DOWNLOAD_LIST_LIMIT)
      .reverse()
  }

  private pushToolbarState(instance: BrowserInstance): void {
    if (instance.window.isDestroyed() || instance.toolbarView.webContents.isDestroyed()) return
    const state = {
      url: activeTab(instance).currentUrl,
      title: activeTab(instance).title,
      isLoading: activeTab(instance).isLoading,
      canGoBack: activeTab(instance).canGoBack,
      canGoForward: activeTab(instance).canGoForward,
      /**
       * Whether the element picker is on for this window.
       *
       * The window's own mode, and the only reason the toolbar can draw it
       * truthfully: the mode also ends from inside the page (Escape), which the
       * toolbar would otherwise never hear about. There is no "has a conversation"
       * flag here any more, because a pick with no conversation to go to opens one.
       */
      picking: instance.picking,
      /**
       * Whether the tab on screen has its developer tools up.
       *
       * Read from the tab rather than remembered from the button: the tools are closed
       * from their own window as often as from here, and the bar has to draw what is
       * true. Only ever true for the tab on screen — switching or closing a tab puts
       * them away (`toggleTabDevTools`).
       */
      devTools: activeTab(instance).tabView.webContents.isDevToolsOpened(),
      /**
       * The window's tabs.
       *
       * `tabs` comes from the window itself rather than from the renderer's own
       * count: the rail is not told "show the tabs", it is told which tabs there
       * are. Whether the rail exists is not a fact to agree about — it is the
       * window's left column, laid out with `TAB_RAIL_WIDTH` before any of this was
       * pushed, so there is no second answer to disagree with.
       */
      tabs: instance.tabs.map((tab) => this.toTabSummary(instance, tab)),
      /**
       * How to name the conversations those tabs came from, for the rail's group
       * headers. Keyed by session id; a missing id is a session with no name yet, and
       * the rail says so generically rather than printing an id.
       */
      sessionLabels: this.sessionLabelsFor(instance),
      /**
       * The recording in progress, if a person started one.
       *
       * `null` is the ordinary state. It is pushed rather than remembered by the button,
       * because a recording also ends from here — the recorded tab is closed, or the
       * window is destroyed — and a button that kept saying "recording" about a file that
       * is finished would be worse than no button.
       */
      recording: this.tabRecorder.state(),
      /**
       * The window's recent downloads, newest first.
       *
       * Here because a download used to be answered with nothing at all: the file was
       * written and the person was told neither that it happened nor where it went. The
       * entries are the workspace's, so a window that is opened later in the same
       * workspace is given what happened while it was away — and the agent reads the very
       * same list through `getDownloads`.
       */
      downloads: this.recentDownloads(instance),
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
     * The window's own tabs, managed from the strip it draws.
     *
     * One channel for all four actions rather than four channels: they are one
     * sentence — "do this to this window's tabs" — sent by a renderer that holds
     * the buttons side by side, and an action that names its target cannot mean
     * anything else. Only `new` carries anything beyond its target, and only when
     * somebody asked for a tab **for** a piece of work rather than one more of their
     * own (the `+` on a section's header).
     */
    ipcMain.handle(
      TOOLBAR_CHANNELS.TABS,
      async (
        _event,
        instanceId: string,
        action: 'activate' | 'close' | 'new' | 'release',
        tabId?: string,
        work?: TabBelongsTo | null,
      ) => {
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
          // The person taking a locked tab back. The overlay is what holds the tab, so
          // dropping the overlay *is* the unlock — and it is the
          // same act as the agent's own `release`, only sent from the other side. No
          // session is named: whoever is working here lets go.
          const result = this.clearAgentControlForInstance(inst.id)
          mainLog.info(
            `[browser-pane] tab lock released by hand instance=${inst.id} tab=${tabId ?? 'unstated'} released=${result.released}${result.reason ? ` reason=${result.reason}` : ''}`,
          )
          return
        }

        // A new tab starts on the empty state — the same document a brand-new window
        // opens with, rather than a white void that says nothing about what this
        // window can do. That is `createTab`'s job rather than this handler's, so
        // every entry point that adds a tab gets it (see `startEmptyStateLoad`).
        //
        // With a `work`, the tab is that piece of work's and the person opened it for
        // it: "here is the page, carry on from it" (see `createTab`'s `openedByPerson`).
        // Appended like any other, which is what puts it **last in that work's section**:
        // sections are drawn where their first tab is and collect their own tabs wherever
        // they sit in the window's list.
        this.createTab(inst.id, {
          activate: true,
          ...(work ? { belongsTo: work, openedByPerson: true } : {}),
        })
      },
    )

    // -------------------------------------------------------------------------
    // Element picking from the panel's own toolbar.
    //
    // The panel cannot resolve this itself: "pick" needs a decision about what
    // the selection is for, which lives in the main window — so the panel reports
    // the action and we forward it there.
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
     * to go.
     */
    ipcMain.handle(TOOLBAR_CHANNELS.PICK_ELEMENT, (_event, instanceId: string, labels?: OverlayLabels) => {
      const inst = findInstance(instanceId)
      if (!inst) return
      this.armPicker(inst, labels)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.CANCEL_PICK, (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return
      this.disarmPicker(inst)
    })

    /**
     * The tab's developer tools, from the bar's button.
     *
     * Only the opening and closing are asked for here; whether they are up is read from
     * the tab on the next state push, which the tab's own `devtools-opened` /
     * `devtools-closed` events trigger (`attachTab`) — closing them from their own
     * window reaches the button the same way.
     */
    ipcMain.handle(TOOLBAR_CHANNELS.DEVTOOLS, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) this.toggleTabDevTools(inst)
    })

    /**
     * The record button.
     *
     * Two commands, because the bytes are not one of them (see `RECORD_CHUNK`): `start`
     * arms a recording and answers with what the button should show, `stop` finishes the
     * file and answers with where it went.
     *
     * What is recorded is **the tab on screen when it starts** — the person pressed the
     * button while looking at the thing they mean. The picture itself is not taken here:
     * the chrome asks for display media, and the display-media handler hands back exactly
     * this tab, which is the only thing it will ever hand back.
     */
    ipcMain.handle(
      TOOLBAR_CHANNELS.RECORD,
      async (_event, instanceId: string, action: 'start' | 'stop', extension?: string) => {
        const inst = findInstance(instanceId)
        if (!inst) return null

        if (action === 'stop') {
          const finished = this.tabRecorder.stop()
          this.pushToolbarState(inst)
          if (!finished) return null
          // Silenced only if nothing else still covers this tab — a conversation may be recording it.
          void this.syncRecordingObserver(inst.id, finished.tabId)

          // An empty file is not a recording: the picture never arrived (the chrome's
          // display-media request was refused, or there was no tab to grab), and a session
          // should not keep an mp4 that shows nothing. `null` is the chrome's "nothing came
          // of it".
          if (finished.bytes === 0) {
            rmSync(finished.file, { force: true })
            return null
          }
          return finished
        }

        const tab = activeTab(inst)
        const state = this.tabRecorder.start({
          // Which tab this is, is part of the recording's identity now: the person and a
          // conversation may each be recording this same tab.
          tabId: tab.id,
          // **One fixed place, the app's own** — not the downloads folder, and not a conversation's.
          // It is still the person's file (a conversation is not what a demo is for), but downloads
          // is where files are handed around, and a recording now carries what was typed into the
          // page as well as the picture. One folder also keeps the film and its record together,
          // so neither can be left behind by the other.
          dir: getPersonRecordsDir(),
          source: tab.tabView.webContents,
          extension: recordingExtension(extension),
        })
        this.pushToolbarState(inst)
        // The page's own half of the observation starts with the recording (`recording-observer.ts`):
        // the person is about to demonstrate something in the tab they just armed.
        void this.syncRecordingObserver(inst.id, tab.id)
        return state
      },
    )

    ipcMain.on(TOOLBAR_CHANNELS.RECORD_CHUNK, (_event, _instanceId: string, chunk: Uint8Array) => {
      if (chunk) this.tabRecorder.append(chunk)
    })

    /**
     * Show a finished download where it landed — the row's click.
     *
     * Revealed rather than opened: what the person needs to know is **where** it went
     * (the file may be one of several, or something to hand on rather than to read), and
     * the file manager answers that without starting an application on it.
     *
     * The path is checked against this window's own download log rather than trusted:
     * the chrome is the only caller, but this ends in a path handed to the OS, so what is
     * revealable is exactly what this window wrote down.
     */
    ipcMain.handle(TOOLBAR_CHANNELS.DOWNLOAD_REVEAL, async (_event, instanceId: string, savePath: string) => {
      const inst = findInstance(instanceId)
      if (!inst || typeof savePath !== 'string' || !savePath) return

      const known = this.downloadsFor(inst.workspaceId).some((entry) => entry.savePath === savePath)
      if (!known) {
        mainLog.warn(`[browser-pane] download reveal refused id=${inst.id} reason=not_a_recorded_download`)
        return
      }

      if (!existsSync(savePath)) {
        // Moved or deleted since: worth a line, and not worth an error the chrome would
        // have to draw — the download itself is unchanged by it.
        mainLog.warn(`[browser-pane] download reveal: nothing at ${savePath}`)
        return
      }

      shell.showItemInFolder(savePath)
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
   * is the workspace's, shared by every session in it, so the workspace
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
   * Electron native references (`window: BrowserWindow`, `tabView: BrowserView`,
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
    // `args`: a request that named somebody else's work would be writing a tab's declaration
    // on their behalf, and "leave other people's tabs alone" is decided from it.
    const work: TabBelongsTo = req.work ?? { kind: 'session', sessionId }
    // The tab every tab-scoped branch below acts on: named by the caller, which is the
    // side that resolved it (`pickCommandTarget` — the conversation's own tab, or the one
    // on screen when it has none), and named *here* rather than looked up, so the tab a
    // command lands on is decided once and in one place. A caller that names none means the
    // tab on screen — the person's own actions, and a window nobody has routed to yet.
    const commandTabId = req.tabId

    switch (req.method) {
      // -- Session-scoped (no instanceId arg, takes a sessionId) ----------------
      //
      // All of these resolve the same thing: the workspace's browser window. A remote
      // agent used to be given a window of its own so it could never touch a window
      // the user had opened; with one window per workspace that distinction is gone
      // by construction — the agent and the user are looking at the same window,
      // which is what "shared" means. What is *not* gone is the workspace
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

      // -- Recording a tab (session-scoped) -----------------------------------
      //
      // Session-scoped like the block above, and the only way the remote caller reaches these:
      // without a case the capability path fell through to `default:` and answered
      // "Unknown browser capability method". `args` carries the caller's own tuple (its
      // `sessionId` first, which is the same id the envelope named) and `workspaceId` is the
      // envelope's — never read from `args`, so a caller cannot pick somebody else's window.
      case 'startRecordingForSession': {
        const [, recordingArgs] = args as [string, BrowserStartRecordingArgs]
        return this.startRecordingForSession(sessionId, recordingArgs, { workspaceId })
      }
      case 'stopRecordingForSession': {
        const [, tabId] = args as [string, string]
        return this.stopRecordingForSession(sessionId, tabId)
      }
      case 'waitForRecordingEnd': {
        const [, tabId] = args as [string, string]
        return this.waitForRecordingEnd(sessionId, tabId)
      }
      case 'endRecordingsForSession':
        this.endRecordingsForSession(sessionId)
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
        const [instanceId, options] = args as [string, { url?: string; activate?: boolean } | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // The opener is the caller, stamped here rather than read off the wire: a
        // request that named somebody else's work would be writing a tab's
        // declaration on their behalf, and "leave other people's tabs alone" is
        // decided from this field.
        return this.createTab(instanceId, { ...options, belongsTo: work })
      }
      case 'activateTab': {
        const [instanceId, tabId] = args as [string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        this.activateTab(instanceId, tabId)
        return undefined
      }
      case 'setSessionTab': {
        const [instanceId, tabId] = args as [string, string, string]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // Same rule as `createTab`: the tab is recorded as the *caller's* cursor
        // and lease, so the id comes from the request's identity rather than from a
        // third argument that could say anything.
        this.setSessionTab(instanceId, tabId, sessionId)
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
      case 'fetchResource': {
        const [instanceId, url, fetchOptions] = args as [
          string, string, { referrer?: string; maxBytes?: number } | undefined,
        ]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // Same gate as evaluation, and for a sharper reason: this is a request made with the
        // person's own cookies, from their machine, to a url an agent chose.
        if (!getAllowRemoteEvaluate()) {
          throw new CodedError('BROWSER_REMOTE_FETCH_BLOCKED',
            'Fetching a url through this client\'s browser session is disabled for remote agents.')
        }
        return this.fetchResource(instanceId, url, fetchOptions, commandTabId)
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
      case 'extractVideoFrames': {
        const [filePath, options] = args as [
          string,
          { mode: 'timeline' | 'changes'; everyMs: number; maxFrames: number },
        ]
        return this.extractVideoFrames(filePath, options)
      }
      case 'renderDrawio': {
        const [options] = args as [DrawioRenderOptions]
        return this.renderDrawio(options)
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
      case 'resizeViewport': {
        const [instanceId, width, height] = args as [string, number, number]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        return this.resizeViewport(instanceId, width, height, commandTabId)
      }
      case 'getDownloads': {
        const [instanceId, options] = args as [string, BrowserDownloadOptions | undefined]
        this.requireInstanceInWorkspace(instanceId, workspaceId)
        // No tab: downloads belong to the workspace the window is of (`getDownloads`).
        return this.getDownloads(instanceId, options)
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
   * tab a session holds is claimed by the command that says which tab it is about
   * (`recordSessionTab`) — a tool start does not know a *new* tab yet. It does hold the tab the
   * session already works from, though: that tab is the one this overlay is about, and waiting for
   * a command to say so again is what let the first command of a turn take a tab without locking it.
   */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void {
    const instance = this.findWindowForWorkspace(options?.workspaceId ?? null)
    if (!instance) return

    // Re-inserted, so the last entry is the one that started working most recently — that is
    // what the window's chip falls back to when the tab on screen is nobody's.
    instance.controlBy.delete(sessionId)
    instance.controlBy.set(sessionId, { displayName: meta.displayName, intent: meta.intent })

    /*
     * A tab this session **already works from** is the tab this overlay is about, so the hold is
     * taken here as well as in `recordSessionTab`.
     *
     * The two facts are started from different places — this one from the session's event stream
     * (`setAgentControl` on a tool start), the other from the tool's own body — so either can arrive
     * first, and when this one arrives second the first command of the turn used to leave the page
     * holding nothing: a tab the *person* opened and the agent carried on in (the takeover case) got
     * the "driven" dot in the rail instead of the lock, and the person could still click into a page
     * the agent was working on. Measured, all three orders, before this: overlay-then-command locked;
     * command-then-overlay locked nothing (the overlay did not either); and a second command after
     * that was what finally locked it.
     */
    const worksFrom = instance.tabs.find((tab) => tab.cursorOf.includes(sessionId))
    if (worksFrom) {
      this.holdTab(instance, worksFrom.id, sessionId)
    }

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
   * is named, which is the person pressing `release` — the hold on the tab on screen.
   *
   * The person's half is deliberately narrower than it used to be: the shield they are
   * looking at covers one tab, so that is the one that comes back. Their other tabs, and
   * the other conversations sharing the window, are not what the button was about.
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

    const tab = activeTab(instance)
    if (!tab.heldBy) {
      return { released: false, reason: 'No active agent overlay on the target window.' }
    }

    this.setHeldBy(tab, null)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] tab lock released by hand instance=${instanceId} tab=${tab.id}`)

    return { released: true }
  }

  /**
   * Extract a theme color from the page using Safari 26-style heuristics.
   * Priority: media-aware theme-color meta → elementsFromPoint (fixed/sticky headers) → body/html bg.
   * All colors pass through (including white/black) — contrast is handled by the renderer.
   * Guards against stale extraction (URL change during async executeJavaScript).
   *
   * Takes the tab it is about: a background tab finishing its load must measure
   * *itself*, not whatever happens to be on screen.
   */
  private async extractThemeColor(instance: BrowserInstance, tab: BrowserTab): Promise<void> {
    if (tab.themeColor) return // already set by did-change-theme-color or observer
    const urlAtStart = tab.currentUrl
    try {
      const color = await tab.tabView.webContents.executeJavaScript(`(${THEME_COLOR_EXTRACTOR_FN})()`)
      // Guard: if user navigated away during extraction, discard stale result
      if (tab.currentUrl !== urlAtStart) return
      if (typeof color === 'string' && color.length > 0) {
        this.applyThemeColor(instance, tab, color)
      }
    } catch {
      // tab destroyed or JS error — ignore
    }
  }

  private applyThemeColor(instance: BrowserInstance, tab: BrowserTab, color: string | null): void {
    if (tab.themeColor === color) return
    tab.themeColor = color
    // Recorded on the tab it belongs to, and read back off the tab **on screen** when
    // the window is described — the top bar's chip for this window is tinted with it.
    // The window's own chrome is deliberately not part of that: chrome is the app's
    // surface, so a page painting its background dark does not get to repaint the
    // address bar or the tab rail next to it.
    this.emitStateChange(instance)
  }

  private installThemeObserver(instance: BrowserInstance, tab: BrowserTab, allowRetry = true): void {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const urlAtInstall = tab.currentUrl
    tab.themeObserverToken = token

    void tab.tabView.webContents.executeJavaScript(`
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
   * Which tab of which window this is, by the tab itself.
   *
   * Every tab, not just the one on screen — the same reason `findInstanceByTabWebContentsId`
   * looks at all of them. A command now runs on the tab its conversation works from, which is
   * usually a tab behind the one the person is looking at, and a request or a download a tab
   * makes belongs to *that* tab's log: reading it through the tab on screen would file it
   * under somebody else's.
   */
  private findTabByWebContentsId(webContentsId: number): { instance: BrowserInstance; tab: BrowserTab } | undefined {
    for (const instance of this.instances.values()) {
      for (const tab of instance.tabs) {
        if (tab.tabView.webContents.id === webContentsId) return { instance, tab }
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

  /**
   * One workspace's downloads, oldest first.
   *
   * A fresh array for a workspace that has none, so every reader can take it as a list
   * without asking whether there is one — the chrome draws nothing for an empty list, and
   * the agent's `downloads` prints `Downloads (0)`.
   */
  private downloadsFor(workspaceId: string | null): BrowserDownloadEntry[] {
    return this.downloadsByWorkspace.get(workspaceId) ?? []
  }

  /**
   * The one place a download is written down.
   *
   * The caller keeps the object it passes and its own `updated`/`done` handlers mutate
   * **that same object** in place (progress while it arrives, then the final state and
   * path), so a download has one description and there is no second copy to keep in step.
   * `MAX_DOWNLOAD_LOG_ENTRIES` is the ceiling: past it the oldest go, which is what keeps
   * a workspace that browses for weeks bounded.
   */
  private pushDownloadLog(workspaceId: string | null, entry: BrowserDownloadEntry): void {
    const downloads = this.downloadsFor(workspaceId)
    downloads.push(entry)
    if (downloads.length > MAX_DOWNLOAD_LOG_ENTRIES) {
      downloads.splice(0, downloads.length - MAX_DOWNLOAD_LOG_ENTRIES)
    }
    this.downloadsByWorkspace.set(workspaceId, downloads)
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

    // Put back the low-entropy client hints the tab's user-agent override leaves behind — the
    // engine's own values, so headers and `navigator.userAgentData` agree (`browser-client-hints.ts`
    // has the whole why). Read once: these are facts about this build, not about the request.
    const clientHintIdentity = currentClientHintIdentity()
    if (clientHintIdentity) {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders }
        applyLowEntropyClientHints(headers, details.url, clientHintIdentity)
        callback({ requestHeaders: headers })
      })
    }

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

      // And into the recording's own log, if this tab is being recorded (`recording-sidecar.ts`).
      this.tabRecorder.noteEvent(located.tab.id, {
        type: 'request',
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: details.statusCode ?? 0,
        resourceType: String(details.resourceType ?? 'unknown'),
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

      // A request that never came back is still something the page did.
      this.tabRecorder.noteEvent(located.tab.id, {
        type: 'request',
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        error: details.error,
      })
    })

    ses.on('will-download', (_event, item, webContents) => {
      const wcId = webContents?.id
      if (typeof wcId !== 'number') return
      const located = this.findTabByWebContentsId(wcId)
      if (!located) return
      const instance = located.instance

      // Auto-save: set a deterministic path so Electron doesn't show a native dialog.
      //
      // The **person's** downloads folder, whoever's tab asked for the file. A download is
      // not the tab's (see `downloadsByWorkspace`): it outlives the tab, the window rather
      // than a tab is what lists it, and the one thing a tab could still say about it —
      // whose work was on screen when it started — is a fact about a click, not about the
      // file. The person is standing right there, and a conversation gets the file the way
      // it gets any other: by being told the path (`savePath`, in the reply and in the
      // record). This is the rule the record button already follows, for the same reason.
      const downloadsDir = app.getPath('downloads')
      const filename = this.uniqueFilename(downloadsDir, item.getFilename())
      const savePath = join(downloadsDir, filename)
      item.setSavePath(savePath)

      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const entry: BrowserDownloadEntry = {
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
      // The workspace's record, not the tab's: hand this object to the workspace log and
      // keep the same reference for the handlers below, so progress is written straight
      // into the entry the chrome and the agent are already reading.
      this.pushDownloadLog(instance.workspaceId, entry)
      // The person clicked, so the bar has to answer: the button appears, and it carries
      // the file that is being fetched while it happens.
      this.pushToolbarState(instance)

      let lastProgressPush = 0
      const onUpdated = (_e: Electron.Event, state: string) => {
        entry.bytesReceived = item.getReceivedBytes()
        entry.totalBytes = item.getTotalBytes()
        if (state === 'interrupted') entry.state = 'interrupted'

        const now = Date.now()
        if (now - lastProgressPush >= TOOLBAR_DOWNLOAD_PROGRESS_MS) {
          lastProgressPush = now
          this.pushToolbarState(instance)
        }
      }

      item.on('updated', onUpdated)

      item.once('done', (_e, state) => {
        item.removeListener('updated', onUpdated)
        entry.bytesReceived = item.getReceivedBytes()
        entry.totalBytes = item.getTotalBytes()
        entry.savePath = item.getSavePath()
        entry.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
        // Where it is and whether it arrived — the half a progress bar cannot say. Pushed
        // for the window that is up, if any: when the person closed it while this was
        // still arriving the push is dropped (`pushToolbarState` returns early), and the
        // entry is left in the workspace's log for the next window of that workspace to
        // report — which is the whole reason the log is not the tab's.
        this.pushToolbarState(instance)
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

    /**
     * Screen capture is the one permission that is not a yes/no for the whole partition.
     *
     * The record button asks for it from our own chrome, and what it gets back is decided
     * by {@link setupDisplayMediaHandler} — so our surface is allowed to ask, and a page
     * in a tab is not (a page that could ask would be a page that could capture the window).
     */
    const mayAsk = (permission: string, webContents: Electron.WebContents | null): boolean =>
      permission === 'display-capture' ? this.isChromeWebContents(webContents) : allow.has(permission)

    if (typeof ses.setPermissionCheckHandler === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ses.setPermissionCheckHandler((webContents, permission: string, requestingOrigin: string, _details: any) => {
        const allowed = mayAsk(permission, webContents)
        if (!allowed) {
          this.logPermissionDecision('check', permission, requestingOrigin)
        }
        return allowed
      })
    }

    if (typeof ses.setPermissionRequestHandler === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ses.setPermissionRequestHandler((webContents, permission: string, callback: (allow: boolean) => void, details: any) => {
        const allowed = mayAsk(permission, webContents)
        if (!allowed) {
          this.logPermissionDecision('request', permission, details?.requestingOrigin ?? 'unknown')
        }
        callback(allowed)
      })
    }
  }

  /**
   * Answer `getDisplayMedia` for this partition — the record button's one door onto a tab.
   *
   * Every request in this partition lands here, ours and a page's alike, and the only
   * thing that answers anything is an **armed recording**: the person pressed the button,
   * which is what picked the tab. Nothing else is ever captured, and a page asking for the
   * screen gets an empty answer rather than a picker.
   */
  private setupDisplayMediaHandler(ses: ElectronSession): void {
    if (this.partitionDisplayMediaInitialized) return
    this.partitionDisplayMediaInitialized = true
    if (typeof ses.setDisplayMediaRequestHandler !== 'function') return

    ses.setDisplayMediaRequestHandler((_request, callback) => {
      const source = this.tabRecorder.armedSource()
      callback(source ? { video: source } : {})
    })
  }

  /** Whether this is one of our own chrome surfaces — the address bar or the tab rail. */
  private isChromeWebContents(webContents: Electron.WebContents | null | undefined): boolean {
    if (!webContents || webContents.isDestroyed()) return false
    for (const instance of this.instances.values()) {
      if (instance.toolbarView.webContents.id === webContents.id) return true
      if (instance.railView.webContents.id === webContents.id) return true
    }
    return false
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
   * Wire the parts of a window that outlive any single tab: the window itself and
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

    /**
     * …and once more when the drag is over.
     *
     * `resize` fires all through a drag, and on Windows the size it reports can be a step
     * behind the window the person has actually ended up with. The chrome never shows it —
     * the bar, the rail and the overlay are `BrowserView`s, which resize themselves natively
     * — but the page does, because the page is the one view that cannot: a `WebContentsView`
     * has no `setAutoResize`, so it is placed from what these handlers read. Saying the
     * layout again once the window has finished is what leaves the page on the size the
     * window has rather than on the size the last event happened to see.
     */
    instance.window.on('resized', () => {
      this.layoutAllViews(instance)
    })

    /**
     * …and again when the window comes back from being minimized.
     *
     * A minimized window reports no size at all on Windows (see `windowHasSize`), so nothing may be
     * laid out from it while it is away — and measured, **restoring it does not lay the page out
     * either**: the window came back at 1200×900 with the page still 193×93 inside it, and only the
     * next layout (a tab switch, for the person who reported it) put it right. So the coming-back is
     * laid out here, explicitly, rather than left to whatever event happens to fire.
     */
    const cameBack = () => {
      this.layoutAllViews(instance)
    }
    instance.window.on('restore', cameBack)
    instance.window.on('maximize', cameBack)
    instance.window.on('unmaximize', cameBack)

    // Arriving on another display: the page's cut corner does not come with it, so it is said
    // again here (`reassertPageCornerRadii`). Only `moved` — `move` fires throughout a drag and
    // the radius only needs rebuilding once the window has landed.
    instance.window.on('moved', () => {
      this.reassertPageCornerRadii(instance)
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
    // `did-finish-load` is where it catches up on the tabs it has to draw.
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
   * Wire one tab.
   *
   * Everything in here belongs to `tab` and writes to `tab` — *not* to whatever is
   * on screen. The events below fire for the view they were installed on, so a
   * background tab loading a page must record its address on itself even while the
   * user is looking at another one; reading through the active tab would quietly
   * write this tab's facts onto that one. Window-level work that these events
   * trigger (state pushes, the toolbar, frame capture) still goes through
   * `instance`, because that is what it is about.
   */
  private attachTab(instance: BrowserInstance, tab: BrowserTab): void {
    const tabWc = tab.tabView.webContents

    // Everything a tab needs to be a tab: a user agent that does not announce Electron or
    // this app (the site's own scripts should not see the frame we put it in), its own
    // background so about:blank does not flash, and its view in the window. Both entry
    // points — `createInstance` and `createTab` — come through here, so a second tab cannot
    // be missing one of these. The overlay is not on this list: it is the window's and is
    // already up (see `BrowserInstance.nativeOverlayView`).
    //
    // Both product tokens are Electron's doing, and both say "not a browser": the app's
    // arrives as `<appName>/<version>` with the spaces taken out of the name — `app.setName`
    // in `index.ts` is what puts "Craft Agents" in, and the UA ends up saying `CraftAgents` —
    // the other as `Electron/<version>`. The token to drop is therefore whatever
    // `app.getName()` flattens to, not a literal: a dev instance is named "Craft Agents [1]".
    const defaultUa = tabWc.userAgent || ''
    const appToken = `${app.getName().replace(/\s+/g, '')}/`
    const sanitizedUa = defaultUa
      .split(' ')
      .filter((part) => !part.startsWith('Electron/') && !part.startsWith(appToken))
      .join(' ')
    if (sanitizedUa && sanitizedUa !== defaultUa) {
      tabWc.setUserAgent(sanitizedUa)
    }

    // The view's own backdrop, so a document that paints nothing — a page with no
    // background of its own — is not a hole: what sits under a tab's view is the window's overlay
    // and the tabs stacked below it, and neither is what this page is meant to look like. What
    // replaces them is the browser's own canvas (`PAGE_VIEW_BACKDROP`), **not** the app's surface:
    // the app's colours belong outside the page's rectangle, and a page that leaves the canvas to
    // the browser is a light page whatever theme the app is wearing.
    tab.tabView.setBackgroundColor(PAGE_VIEW_BACKDROP)
    this.applyPageCornerRadius(tab)

    // A tab is **born at the window's current page area** — a viewport has to exist from the first
    // frame — and where its view goes depends on whether it is the tab on screen. The one on screen
    // goes in the window itself, above the overlay that is already there (everything the overlay
    // draws is *around* the page, so below is where the page belongs; from here on
    // `updateNativeOverlayState` decides which of the two is on top, because that is also what "this
    // tab is locked" means). A tab opened behind the person's (`activate: false`, how an agent's tab
    // is opened) is **created in the parking window** and stays there, at this size, until it comes
    // forward — the window the person sees never holds a page that is not on screen.
    const bornAt = this.pageAreaBounds(instance)
    if (instance.activeTabId === tab.id) {
      tab.tabView.setBounds(bornAt)
      instance.window.contentView.addChildView(tab.tabView)
    } else {
      this.parkTab(instance, tab, bornAt)
    }
    // The chrome stays on top of whatever tab is showing — both surfaces of it.
    this.raiseChromeViews(instance)

    tabWc.on('did-start-loading', () => {
      tab.isLoading = true
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    tabWc.on('did-stop-loading', () => {
      tab.isLoading = false
      tab.canGoBack = tabWc.canGoBack()
      tab.canGoForward = tabWc.canGoForward()
      // Drain in-flight count — all pending requests are settled once loading stops
      this.inFlightRequestsByWebContentsId.set(tabWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(tabWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      void this.extractThemeColor(instance, tab)
      this.updateNativeOverlayState(instance)
    })

    tabWc.on('dom-ready', () => {
      this.installThemeObserver(instance, tab)
      void this.extractThemeColor(instance, tab)
    })

    // A locked tab takes no input from a person. The shield already swallows the mouse;
    // this is the keyboard half — typing into a tab a conversation is driving is the
    // same interruption by another route. Read live rather than captured, so the lock
    // follows the lease: the tab stops refusing input when its turn ends or the overlay
    // goes, and a tab the person switched to is never covered by a lock on another.
    tabWc.on('before-input-event', (event) => {
      if (tab.heldBy !== null) {
        event.preventDefault()
      }
    })

    // The window's own toolbar listener lives in `setupWindowListeners` — one
    // install per window, not per tab. The overlay's own listener is one too, and is
    // installed where that view is (`loadNativeOverlay`).

    tabWc.on('did-navigate', (_event, urlFromEvent) => {
      const url = typeof tabWc.getURL === 'function' ? tabWc.getURL() : (urlFromEvent || tab.currentUrl)
      const previousUrl = tab.currentUrl
      this.clearInPageThemeTimer(tab)
      tab.themeObserverToken = null
      tab.themeColor = null // reset for new page (batched with state push below)
      // The icon belongs to the document that is being replaced, and the only thing
      // that ever writes one is this tab's `page-favicon-updated` — a page that
      // reports no icon reports nothing at all, so without this reset the previous
      // site's icon would stay on the tab after the address bar moved on.
      tab.favicon = null
      const normalized = this.normalizeTabState(url, tabWc.getTitle())
      tab.currentUrl = normalized.url
      tab.title = normalized.title
      mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${tab.currentUrl}`)
      this.tabRecorder.noteEvent(tab.id, { type: 'navigate', url: tab.currentUrl })
      tab.canGoBack = tabWc.canGoBack()
      tab.canGoForward = tabWc.canGoForward()
      // Drain in-flight count — prior page's requests are cancelled on navigation
      this.inFlightRequestsByWebContentsId.set(tabWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(tabWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      this.scheduleEarlyThemeExtraction(instance, tab, url)
      this.updateNativeOverlayState(instance)
      // Committing a page is where Chromium moves the focus: a page that loaded in a tab that
      // is not the one on screen hands it straight back — but only off another **tab**. The
      // address bar and the rail are the person's to type in, and a page committing behind
      // their back is no reason to take that away from them.
      const tabOnScreen = activeTab(instance)
      const anotherTabHoldsIt = instance.tabs.some(
        (candidate) => candidate.id !== tabOnScreen.id && candidate.tabView.webContents.isFocused(),
      )
      if (anotherTabHoldsIt) this.focusTheTabOnScreen(instance, tabOnScreen)
    })

    tabWc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.info(`[browser-pane] did-redirect-navigation id=${instance.id} url=${url} inPlace=${isInPlace}`)
    })

    tabWc.on('did-navigate-in-page', (_event, urlFromEvent) => {
      const url = typeof tabWc.getURL === 'function' ? tabWc.getURL() : (urlFromEvent || tab.currentUrl)
      const normalized = this.normalizeTabState(url, tab.title)
      tab.currentUrl = normalized.url
      tab.title = normalized.title
      tab.canGoBack = tabWc.canGoBack()
      tab.canGoForward = tabWc.canGoForward()
      // A route change is a move worth recording: the address a step ended on is often the whole
      // answer to "where did this leave us" (`recording-sidecar.ts`).
      this.tabRecorder.noteEvent(tab.id, { type: 'navigate', url: tab.currentUrl, inPage: true })

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

    tabWc.on('page-title-updated', (_event, title) => {
      const normalized = this.normalizeTabState(tabWc.getURL(), title)
      tab.title = normalized.title
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    tabWc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] || null
      this.emitStateChange(instance)
      // The rail draws each tab's icon from this state, and the icon only arrives
      // here — after the pushes that came with the navigation. Without this one the
      // rail keeps the iconless snapshot it was last sent.
      void this.pushToolbarState(instance)
    })

    // The bar draws whether this tab's developer tools are up, and they are closed from
    // their own window as often as from the button — so the answer is read when it
    // changes rather than remembered from the click that asked for it.
    tabWc.on('devtools-opened', () => {
      void this.pushToolbarState(instance)
    })

    tabWc.on('devtools-closed', () => {
      void this.pushToolbarState(instance)
    })

    tabWc.on('did-change-theme-color', (_event, color) => {
      this.applyThemeColor(instance, tab, color ?? null)
    })

    tabWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      mainLog.warn(`[browser-pane] did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    tabWc.on('console-message', (_event, level, message) => {
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

      if (message.startsWith(RECORDING_SIGNAL_PREFIX)) {
        // A recorded page reporting what was done to it. Recognised and dropped here for the same
        // reason the theme signal above is: it is a signal, not something the page said
        // (`recording-observer.ts`).
        const reported = parseRecordingSignal(message)
        if (reported) this.tabRecorder.noteEvent(tab.id, reported)
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

    tabWc.on('will-navigate', (event, url) => {
      if (url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
        event.preventDefault()
        void this.handleDeepLinkUrl(url)
      }
    })

    tabWc.setWindowOpenHandler((details) => {
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

      // A tab that wants a window of its own gets a **tab beside the one that asked
      // for it**. Every one of them: `target="_blank"`, `window.open`, a
      // popup, a link on the page. A real second window was how popups used to be
      // played, and it is the one thing the window model does not have room for — a
      // bare Electron window with no toolbar and no chrome of ours, which is somebody
      // else's page dressed up as a window of ours.
      //
      // The cost is stated and real: a tab opened this way has no `window.opener`, so
      // a popup that waits for a `postMessage` from the page that opened it (Google's
      // sign-in is the usual one) will wait forever. `tab.disposition` is where that is
      // recorded, so it is diagnosable rather than mysterious.
      // Whose tab this is: **the tab it was opened from**. No attribution is needed —
      // who clicked is not asked, and could not be told anyway (an agent's click and a
      // person's look the same from here) — because a tab derived from a task's tab
      // belongs to that task. That is what makes a conversation's tabs
      // a group rather than a list of tabs it happened to open: the link it could not
      // follow itself still lands in its group, and `close` cleans up the whole task.
      // A tab opened from a tab nobody owns stays nobody's: no owner is invented.
      const openedTabId = this.createTab(instance.id, {
        url: details.url,
        // A link is clicked in order to be looked at; a tab the site opened in the
        // background asked not to be brought forward.
        activate: details.disposition !== 'background-tab',
        afterTabId: tab.id,
        disposition: details.disposition === 'new-window' ? 'popup' : 'link',
        belongsTo: tab.belongsTo,
      })

      mainLog.info(`[browser-pane] window-open opened as a tab id=${instance.id} tab=${openedTabId} after=${tab.id} url=${details.url}`)
      return { action: 'deny' }
    })

    tabWc.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })
  }

  /**
   * Where one tab is: the part of a tab that outlives the moment it is read.
   *
   * Split out of {@link toTabSummary} because a pick needs exactly these answers
   * about the tab it happened on — and nothing else — and a second producer of
   * "which tab, which URL, which title" is how a picked element and the tab strip would come
   * to disagree about where the user was standing. The id is the first of the three for the
   * same reason it is on the summary: it is the only one a command can be pointed with.
   */
  private describeTabLocation(tab: BrowserTab): PickedElementOrigin {
    // -- Observation: what the tab itself reports --
    return {
      tabId: tab.id,
      url: tab.currentUrl,
      title: tab.title,
    }
  }

  /**
   * One tab, as everything outside this file reads it.
   *
   * **The single place a tab becomes a wire shape**, so the toolbar's strip, the
   * panel's list and the agent's `tabs` command cannot describe the same tab
   * differently. The two halves are kept in the order the type declares them: what
   * the tab reports, then what its opener said about it.
   */
  private toTabSummary(instance: BrowserInstance, tab: BrowserTab): BrowserTabSummary {
    // The location's `tabId` is the summary's `id`: one fact, named once per shape.
    const { tabId, ...location } = this.describeTabLocation(tab)
    return {
      id: tabId,
      ...location,
      favicon: tab.favicon,
      isLoading: tab.isLoading,
      active: tab.id === instance.activeTabId,
      // -- Declaration: whose work it is --
      belongsTo: tab.belongsTo,
      drivenBy: tab.drivenBy,
      // Which conversations work from this tab, if any. A copy, so a
      // reader of the summary cannot edit the tab's own list in place.
      cursorOf: [...tab.cursorOf],
      // -- The lock: who is working on this tab right now, and only while they are --
      lockedBy: tab.heldBy,
      // How the browser asked for it, when it did.
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
      isVisible: instance.isVisible,
      // Any conversation working in this window at all — the window-level indicator. Which
      // tab each one holds is the tab's own answer (`lockedBy`, per tab).
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
