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
import { preventTaskbarPinning } from './windows-prevent-pinning'
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
import { BACKGROUND_HEX, DEFAULT_THEME, getBackgroundColor, loadAppTheme, getAllowRemoteEvaluate, loadPreferences, CONFIG_DIR, DEFAULT_BROWSER_PROFILE_ID, getBrowserProfiles } from '@craft-agent/shared/config'
import { isBrowserUrl } from '@craft-agent/shared/utils/url-safety'
import {
  loadBrowserTabsState,
  saveBrowserTabsState,
  type SavedBrowserTab,
  type SavedBrowserWindowTabs,
} from './browser-tabs-state'
import { CodedError, RPC_CHANNELS, describeWork, sameWork, tabSectionOf } from '@craft-agent/shared/protocol'
import type { PickedElement, PickedElementOrigin, BrowserToolbarAction, BrowserTabSummary, TabBelongsTo, BrowserLoadError } from '@craft-agent/shared/protocol'
import { PAGE_PANEL_RING, resolvePagePanelRing, resolvePagePanelShadow } from '../shared/browser-live-fx'
import { PANEL_EDGE_INSET, PANEL_RADIUS_INNER, TAB_RAIL_WIDTH, TOOLBAR_HEIGHT } from '../shared/panel-geometry'
import { getWindowsBackgroundMaterial } from './window-material'
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
 * The width a browser window's **page** opens at.
 *
 * The window is not the viewport: the rail takes `TAB_RAIL_WIDTH` off the side and the page panel
 * is inset by the gutter (`pageAreaBounds`), so the window opens that much wider — the same sum
 * `resizeViewport` does in reverse, for the size a window is born with.
 */
const DEFAULT_VIEWPORT_WIDTH = 1100
/**
 * The height a browser window is created with — the pair to `DEFAULT_VIEWPORT_WIDTH`.
 *
 * It is read back only for a tab **born** while the window has no size of its own (`attachTab`):
 * the window is created at this height, so that is the viewport such a tab starts at.
 */
const DEFAULT_WINDOW_HEIGHT = 900
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
 * How long a view moved into the parking window for a shot is given to produce its first frame
 * (the parked shot in `capturePageWithRecovery`).
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
/**
 * How long a profile's display name is trusted before the registry is read again.
 *
 * The name travels with every toolbar push (a navigation, a tab switch), and the registry is a file;
 * reading it per push would be a disk read per event. A rename therefore lands in an open window
 * within a couple of seconds rather than instantly — the right trade for a label.
 */
const PROFILE_NAMES_TTL_MS = 2_000
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

/** The browser window's own title, shown in the taskbar and the window switcher. */
const BROWSER_WINDOW_TITLE = 'Craft Browser'

/**
 * The browser window's taskbar identity on Windows.
 *
 * Every window in the process shares one App User Model ID, so the taskbar groups
 * the browser in with the workspace windows — a single button with several
 * previews. A different id puts this window in a taskbar group of its own, so it
 * can be found and switched to on its own (see `setAppDetails` at window
 * creation). Distinct from the packaged app id in electron-builder.yml
 * (`com.lukilabs.craft-agent`), which the rest of the windows share.
 */
const BROWSER_WINDOW_APP_ID = 'com.lukilabs.craft-agent.browser'

/**
 * The browser window's icon: the Craft glyph in blue, so the standalone browser
 * window is told apart from the app's own (purple) one at a glance.
 *
 * Resolved the same way the workspace windows resolve theirs — packaged assets
 * live at `dist/resources/`, dev ones at `resources/` — and per platform, since
 * the formats differ. Returns undefined when the asset is missing, so the window
 * simply falls back to the app icon rather than carrying a broken path. macOS
 * ignores a BrowserWindow icon entirely (it uses the app icon).
 */
function browserWindowIconPath(): string | undefined {
  const name = process.platform === 'win32' ? 'browser-icon.ico' : 'browser-icon.png'
  return [
    join(__dirname, 'resources', name),
    join(__dirname, '../resources', name),
  ].find((candidate) => existsSync(candidate))
}

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

/**
 * Chromium's own code, read out of a `loadURL` rejection.
 *
 * `did-fail-load` normally writes the tab's error first and this is only a fallback — the
 * 30-second timeout has no Chromium event behind it — so the worst case is the generic
 * `ERR_FAILED` rather than nothing at all.
 */
function chromiumErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\b(ERR_[A-Z0-9_]+)\b/.exec(message)?.[1] ?? 'ERR_FAILED'
}

/** A token inside the error page's own URL, so the host can tell what is on screen. */
const ERROR_PAGE_MARKER = 'craft-browser-error'

/** Text placed in our own error page, escaped for HTML. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/**
 * The built-in load-error page.
 *
 * A real page inside the tab rather than an overlay: it replaces the document the
 * browser could not get, the tab keeps the failed address around it, and Back reaches
 * whatever was there before. The copy comes from the toolbar (this process has no
 * i18n); the colours follow the window's theme.
 */
function browserErrorPageHtml(copy: { message: string; url: string; retry: string }): string {
  const dark = nativeTheme.shouldUseDarkColors
  const bg = dark ? '#080a10' : '#f7f8fa'
  const fg = dark ? '#fafafa' : '#1d1d1f'
  const muted = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const faint = dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'
  const iconBg = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'
  const iconFg = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)'
  const buttonBg = dark ? '#fafafa' : '#1d1d1f'
  const buttonFg = dark ? '#111111' : '#ffffff'
  // Through JSON, and `<` escaped so a URL can never close the script element.
  const retryUrl = JSON.stringify(copy.url).replace(/</g, '\\u003c')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Error</title>
<!-- ${ERROR_PAGE_MARKER} -->
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: ${bg}; color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .wrap { max-width: 360px; padding: 0 24px; text-align: center; }
  .icon {
    width: 40px; height: 40px; margin: 0 auto 16px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: ${iconBg}; color: ${iconFg}; font-size: 18px; font-weight: 600;
  }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 4px; font-size: 12px; color: ${muted}; }
  .url { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: ${faint}; word-break: break-all; }
  button {
    margin-top: 24px; border: 0; border-radius: 10px; padding: 8px 16px;
    font-size: 13px; font-weight: 500; cursor: pointer;
    background: ${buttonBg}; color: ${buttonFg};
  }
  button:hover { opacity: 0.85; }
</style></head>
<body><div class="wrap">
  <div class="icon">!</div>
  <h1>${escapeHtml(copy.message)}</h1>
  <p class="url">${escapeHtml(copy.url)}</p>
  <button id="retry">${escapeHtml(copy.retry)}</button>
</div>
<script>
  document.getElementById('retry').addEventListener('click', function () {
    location.href = ${retryUrl}
  })
</script>
</body></html>`
}

/**
 * What `navigate` was asked to open.
 *
 * A supported scheme loads as typed. A bare host (domain, IPv4/IPv6, localhost, optional port)
 * gets `http://` — LAN services commonly have no TLS, and plain HTTP is the standard reading
 * of a bare address; a site that only speaks HTTPS answers with its own redirect. Everything
 * else, including an unknown scheme, becomes a search instead of a load that quietly does
 * nothing.
 */
type AddressTarget = { url: string } | { search: string }

function readAddressTarget(raw: string): AddressTarget {
  const text = raw.trim()
  if (/^(https?|file|about|craft-local):/i.test(text)) {
    return { url: text }
  }
  const looksLikeHost =
    /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(text)
  if (looksLikeHost) {
    return { url: `http://${text}` }
  }
  return { search: text }
}

const searchUrlFor = (query: string): string =>
  `https://duckduckgo.com/?q=${encodeURIComponent(query)}`

/** Whether two addresses belong to the same site (scheme, host and port). */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
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
  /**
   * Render the built-in load-error page into the tab that failed.
   *
   * The copy is the toolbar's (only that document has i18n); this side owns the page and
   * puts it in place of the document that never arrived, the way a browser does.
   */
  SHOW_ERROR_PAGE: 'browser-toolbar:show-error-page',
  FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  /**
   * The window's own caption verbs.
   *
   * The window is chromeless (`frame: false`), so it wears no OS caption buttons on any
   * platform — minimizing and maximizing are things only the bar can ask for. `MAXIMIZE`
   * toggles rather than sets: one button both maximizes and restores, and which it does is
   * read from the window.
   */
  MINIMIZE: 'browser-toolbar:minimize',
  MAXIMIZE: 'browser-toolbar:maximize',
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
  /**
   * Fold the rail away, or bring it back.
   *
   * The person's own toggle in the chrome's top-left. Nothing is sent with it: this flips the
   * window's own flag, because the window — not the renderer — is what has to re-place the page
   * (the rail's room is part of the tab area, `tabAreaBounds`). It is not remembered anywhere
   * outside the window: a window opened later starts with the rail out.
   */
  RAIL_TOGGLE: 'browser-toolbar:rail-toggle',
} as const
export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane'

/**
 * The session partition one browser **profile** runs in.
 *
 * A partition is a Chromium profile: its own cookies, `localStorage`, caches and logins. Keying it
 * by the profile is what makes "which account is this tab signed in as" a fact about the profile
 * rather than about the app or the workspace — two profiles (two windows) can hold two accounts of
 * the same site, and neither can see the other's session.
 *
 * The built-in profile keeps the bare legacy name, because that is the profile every login lived in
 * before profiles existed: an upgrade keeps its sessions instead of signing out.
 */
export function browserPanePartition(profileId: string): string {
  return profileId === DEFAULT_BROWSER_PROFILE_ID
    ? BROWSER_PANE_SESSION_PARTITION
    : `${BROWSER_PANE_SESSION_PARTITION}-${profileId}`
}

/**
 * Every browser partition this app has opened, by name.
 *
 * A partition is created lazily, when a workspace first opens its browser window, so there is no
 * list to read anywhere else — and the proxy layer has to configure **all** of them, including a
 * partition that did not exist when the settings were last applied.
 */
const browserPaneSessions = new Map<string, ElectronSession>()

/** The browser sessions that exist, for layers that must configure every one of them. */
export function listBrowserPaneSessions(): ElectronSession[] {
  return [...browserPaneSessions.values()]
}

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
  /**
   * Whether a document is still arriving, whether or not the bar draws a spinner for it.
   *
   * `isLoading` is what the chrome shows, and loading our own error page deliberately does
   * not flash a spinner over the failure it reports. A reader still has to wait for that
   * document: until it commits, the webContents holds Chromium's blank failure page, which
   * is not what anyone asked to read.
   */
  documentLoading: boolean
  /**
   * Why the page failed to load, or `null` while none has.
   *
   * Kept on the tab because it is that tab's answer to "what is on screen": a failed page
   * still has a URL and a title (often the one asked for), and the chrome drawing those
   * alone is what leaves a person staring at a blank rectangle. Cleared when the next load
   * starts, so a retry that works leaves nothing behind.
   */
  loadError: BrowserLoadError | null
  /**
   * Whether the tab is showing one of our own documents — the built-in error page or
   * the new-tab page.
   *
   * The tab keeps describing its logical address (`currentUrl`, and the toolbar's
   * address): the failed address for an error page, `about:newtab` for the new-tab page.
   * `about:newtab` is a legal address in its own right, which is why this is a marker
   * rather than a URL test.
   */
  internalPage?: 'error' | 'newtab'
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
   * Whether the input being dispatched **right now** came from a command rather than from the
   * person. Set around a command's click or key by the manager, and read by the window-open
   * handler.
   *
   * Two facts decide where a page-requested tab lands, and neither is inferred from the tab's
   * ownership or from what is on screen: this flag, and {@link heldBy}. A held tab takes no input
   * from a person — taking it back is what drops the hold — so anything opening a tab from it is
   * the agent's. The flag covers the one moment the hold cannot: a turn's first command can run
   * before the overlay that takes it arrives.
   */
  commandInput: boolean
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
   * that is not on screen must not be visible whatever size the person's window is — and *kept* out
   * there by `frame: false` + `enableLargerThanScreen`, without which macOS pulls a window it judges
   * unreachable back onto one (`parkingWindowFor`); `skipTaskbar`, because it is not a window of
   * theirs. One per browser window, made when the first tab is parked and destroyed with the window
   * (`parkingWindowFor`).
   */
  parkingWindow: BrowserWindow | null
  /**
   * The window's own chrome, as **one document in one view**: the rail down the left edge and
   * the bar across the top are the same renderer (`renderer/browser-toolbar.tsx`), so they are
   * one surface rather than two panels that have to be kept looking alike.
   *
   * One view over the window's whole rectangle, not the two the L-shape used to need: a
   * `BrowserView` is a rectangle, the chrome is an L, and two rectangles are two documents each
   * painting its own background — which read as two surfaces however identical the colour. The
   * page sits on top of this one, in the slot the document leaves for it.
   */
  chromeView: BrowserView
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
   * How many tabs this window has named.
   *
   * Per window, because a tab is named **in a window**: `tab-3` means the third tab of the window
   * the command was said in, and the caller always knows which window that is — a conversation's
   * commands are resolved against its workspace's window before any tab is looked up
   * (`resolveCommandTarget`), and the chrome speaks for the window it is drawn in. Counting here
   * rather than app-wide is also what keeps the names steady where they are read: a window's first
   * tab is `tab-1` whoever else happens to be running, and a window restored from disk keeps the
   * names it had (`restoreTabs`). One app-wide counter made both depend on what else was open.
   */
  tabCounter: number
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
  /**
   * The browser profile every tab of this window is signed into — part of the window's identity.
   *
   * One workspace holds **one window per profile in use**, so a window answers "which profile am I"
   * with one value: its chrome, its tabs and its downloads all belong to that profile. Two
   * conversations that picked two profiles get two windows rather than one strip holding both.
   */
  profileId: string
  /**
   * The session every view of this window is built on — the workspace's own profile.
   *
   * Held rather than re-derived from {@link workspaceId}, because the partition is a fact of the
   * window: it is chosen once, when the window is created (`browserPanePartition`), and every view
   * that comes later — a new tab, a restored tab — has to land on the profile the window is
   * already signed into rather than on whatever the workspace resolves to by then.
   */
  session: ElectronSession
  /**
   * Whether the window is **up** — shown, and not hidden since.
   *
   * Deliberately not `window.isVisible()`: that one reads false while the window is minimized on both
   * platforms (measured), and a minimized window can still answer a shot from itself — ~15ms on
   * Windows, ~5–18ms on macOS (`spike/capture-methods.cjs`, the `minimized` rows) — so "minimized"
   * must not be mistaken for "away" — but it is not a *home* either, and that question is asked
   * separately rather than through this flag: `tabHome` parks a minimized window's tab, on either
   * platform.
   *
   * What this reads while the window *is* minimized is a fact about the platform's events, and the two
   * do not agree (`hidden-window-usability.cjs`): on macOS `minimize()` emits `hide` a few ms later, so
   * this goes false there; on Windows it emits no `hide` at all, so this stays true — and hiding a
   * *minimized* window, which does emit `hide` on Windows and does not on macOS, is the only thing
   * that takes it false in that state.
   */
  isVisible: boolean
  /**
   * Whether this window has ever been on a display — the moment it acquired a surface.
   *
   * The three states are not the same thing, and only two of them have a surface anywhere:
   *
   * - `visible` — shown now;
   * - `hidden-after-show` — on a display once, hidden since; the surface it got there survives the
   *   hiding, and this is the state a platform's "hidden windows can be captured" claim is about
   *   (`canCaptureHiddenWindows` — which is what macOS answers with, and Windows does not; both are
   *   measured rather than documented now);
   * - `**never shown**` — composited **nowhere**: measured, a capture of one answers at once with
   *   "Current display surface not available for capture", on any platform — Windows and macOS both,
   *   measured (`spike/capture-methods.cjs`, the `never-shown` rows), and a view in one has no viewport at all
   *   (`spike/background-viewport.ts`). So a window born hidden and never shown is not a home for a
   *   tab: the parking window is, because it *is* shown — off every display.
   */
  hasBeenShown: boolean
  isHiding: boolean
  keepAliveOnWindowClose: boolean
  toolbarReady: boolean
  toolbarMenuOpen: boolean
  toolbarMenuHeight: number
  toolbarMenuOverlayActive: boolean
  /**
   * Whether the person has folded the rail away.
   *
   * The rail's room is part of the tab area (`tabAreaBounds`), so this is the window's fact and
   * not the chrome document's: the page has to be placed without it, which is the main process's
   * job. In memory and per window, on purpose — the chrome's toggle is a view of this window now,
   * not a preference, and a window opened tomorrow starts with the rail out.
   */
  railCollapsed: boolean
  /**
   * The window's content size as last reported while it had one.
   *
   * A minimized window reports **no** size on Windows (`windowHasSize`), and minimizing does not
   * change a window's size — only where it is (the person's point). So the last size it did report is
   * kept here and read back when it has none to give (`windowContentSize`), which is what lets a tab
   * **born** while the window is away be created at the size it would have had, with only its
   * position different.
   */
  lastContentSize: { width: number; height: number }
  /**
   * How many times this window has asked for the caret in the address bar.
   *
   * Counted rather than flagged because it is a request, not a state: the bar focuses its
   * input on each new number, so two new tabs in a row are two requests (see
   * {@link focusAddressBar}).
   */
  urlBarFocusToken: number
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
  /**
   * The conversation that asked for the window, when one did — its profile becomes the window's
   * starting profile, so the blank tab a fresh window holds is already the right cookie jar.
   */
  sessionId?: string | null
  /**
   * Which profile's cookies this window's tabs start on.
   *
   * Omitted → the workspace's default, then the built-in one: a person's own window means "whatever
   * this workspace works in", and only a conversation that picked a profile names one.
   */
  profileId?: string
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
  /**
   * Pixel size of the image as it comes back.
   *
   * These are **CSS pixels**, the same units `click-at`/`drag` take: the device-pixel
   * shot is brought back to the page's CSS size in `capturePageImage`, so one image
   * pixel is one page coordinate. Stating the numbers lets a caller notice a shot the
   * model's own vision pipeline may have scaled before it reads a coordinate off it.
   */
  imageWidth: number
  imageHeight: number
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

/**
 * How one remembered window is identified in the tabs file.
 *
 * A workspace holds **one window per profile**, so the pair is the window: `workspaceId` alone would
 * make two profiles' windows overwrite each other's pages on every quit.
 */
function rememberedWindowKey(workspaceId: string | null, profileId: string): string {
  return `${workspaceId ?? ''}\u0000${profileId}`
}

export class BrowserPaneManager implements IBrowserPaneManager {
  private instances: Map<string, BrowserInstance> = new Map()
  private destroyingIds: Set<string> = new Set()
  private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null
  private removedCallback: ((id: string) => void) | null = null
  private interactedCallback: ((id: string) => void) | null = null
  /**
   * The partitions whose one-time session setup is already done, one set per kind of setup.
   *
   * Keyed by the session object because there is now **more than one** browser partition (one per
   * workspace, `browserPanePartition`), and each needs its own permissions, display-media handler
   * and observers. Electron creates a `Session` once per partition name and hands the same object
   * back afterwards, so the object identifies the partition exactly.
   *
   * One boolean per setup said the same thing while the app had a single partition — the setup ran
   * for the first window and every later one skipped it. That is the one reading that is now wrong:
   * a second workspace's window is a *different* session, and skipping it would leave it with no
   * observers (no network log, no `wait network-idle`), no display-media handler (no recording) and
   * no download hook.
   */
  private readonly permissionsReady = new WeakSet<ElectronSession>()
  private readonly displayMediaReady = new WeakSet<ElectronSession>()
  private readonly observersReady = new WeakSet<ElectronSession>()
  /**
   * Applied to each partition as it is created — see {@link setProxyApplier}.
   *
   * A workspace's partition is born the moment its browser window is, which is almost always after
   * the proxy settings were last applied. Without this, such a partition would keep Electron's
   * default routing and quietly bypass a configured proxy.
   */
  private proxyApplier: ((ses: ElectronSession) => void) | null = null
  /**
   * Resolves the browser profile for a conversation (or, with no conversation, for a workspace):
   * the conversation's own pick, its workspace's default, then the built-in profile.
   *
   * Injected (see main/index.ts) so this layer never reads session files. Asked per tab rather than
   * captured, because a conversation can switch profiles while it exists and its next tab has to
   * land on the new one. Omitted → the built-in profile.
   */
  private profileResolver: ((sessionId: string | null, workspaceId: string | null) => string) | null = null
  /** Display names by profile id, re-read at most every {@link PROFILE_NAMES_TTL_MS}. */
  private profileNamesCache: { readAt: number; names: Map<string, string> } | null = null
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
    recorder.onRecordingEnded = (tabId, instanceId) => {
      void this.syncRecordingObserver(instanceId, tabId)
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
   * coming. On macOS Electron does answer for a hidden window — one that has **been on a display**
   * (`hasBeenShown`; a window that was never shown answers nothing on any platform, which is why the
   * parking window is shown at all, so that is a different question from this one) — and that half
   * was measured too rather than taken from the docs: a window that was shown and then hidden answers
   * `capturePage` with its own pixels in 3–12ms, with or without `{stayHidden, stayAwake}`, and
   * `Page.captureScreenshot` answers it as well (`capture-methods.cjs`, the `hidden-after-show` rows,
   * macOS 15.6.1 / Electron 39.2.7). So it gets the first go there and the parked view is the fallback.
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

  /**
   * Injected (see main/index.ts) — how the proxy layer reaches a partition created after its
   * settings were last applied. A partition per workspace is created on first use, so "apply the
   * settings when they change" alone would miss every workspace that opens its browser later.
   */
  setProxyApplier(fn: (ses: ElectronSession) => void): void {
    this.proxyApplier = fn
  }

  /**
   * Injected (see main/index.ts) — how a conversation's profile is answered. A tab is built long
   * after any startup work, so this is the only place the browser layer learns which cookie jar a
   * conversation works in.
   */
  setProfileResolver(fn: (sessionId: string | null, workspaceId: string | null) => string): void {
    this.profileResolver = fn
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
   *
   * The id is the caller's, because numbering is the window's (`BrowserInstance.tabCounter`) and
   * an id has to be settled before the tab exists: a window's first tab is `tab-1`, a restored one
   * keeps the name it was remembered by.
   */
  private buildTab(ses: ElectronSession, id: string): BrowserTab {
    /**
     * The page is a `WebContentsView` rather than the deprecated `BrowserView` for one reason:
     * only the former can round its own corners (`setBorderRadius`). The page's panel look —
     * rounded corners with the surface showing outside them — is otherwise impossible without
     * drawing over the page, and anything drawn over the page swallows the person's clicks,
     * because a view covers a rectangle whatever it paints. See `applyPageCornerRadius`.
     */
    const tabView = new WebContentsView({
      webPreferences: {
        // The partition is named once, where the window's session is created (`createInstance`),
        // and every view of the window takes that session. Naming it again here would be a second
        // copy of the same fact, free to drift — and it is not needed: `partition` is only the
        // string form of the session, and Electron prefers `session` when both are given.
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
      id,
      tabView,
      cdp: new BrowserCDP(tabView.webContents),
      currentUrl: 'about:blank',
      title: 'New Tab',
      favicon: null,
      isLoading: false,
      documentLoading: false,
      loadError: null,
      canGoBack: false,
      canGoForward: false,
      // A tab nobody said they asked for is nobody's: only the opener writes this,
      // and a tab the user opened has no session to name.
      belongsTo: null,
      drivenBy: null,
      cursorOf: [],
      heldBy: null,
      commandInput: false,
      disposition: null,
      themeColor: null,
      inPageThemeTimer: null,
      themeObserverToken: null,
      consoleLogs: [],
      networkLogs: [],
    }
  }

  /**
   * Whether the browser window's tabs are remembered between runs.
   *
   * Read where it matters — a window going away, a window being created — rather than cached:
   * the person turns it on in Settings while the app is running, and the next window they open
   * already obeys it.
   */
  private restoreTabsEnabled(): boolean {
    return loadPreferences().restoreBrowserTabs === true
  }

  /**
   * A window's tabs as they are worth remembering, or `null` when it holds nothing that can be
   * opened again (only blank tabs): a window with no real pages leaves no trace behind.
   */
  private snapshotTabsForRestore(instance: BrowserInstance): SavedBrowserWindowTabs | null {
    const remembered = instance.tabs
      // `isBrowserUrl` is the gate the rest of the app opens a page through (http/https, and
      // the app's own origin). A `file://` a person opened once is deliberately *not* remembered:
      // reopening it here would be the one way in that skips `validateFilePath`.
      .filter((tab) => isBrowserUrl(tab.currentUrl))

    if (remembered.length === 0) return null
    const tabs: SavedBrowserTab[] = remembered.map((tab) => ({ url: tab.currentUrl, title: tab.title }))
    // Which one was on screen — as an index, because the ids are not remembered: the window hands
    // out names again from `tab-1` when it comes back.
    const activeIndex = Math.max(0, remembered.findIndex((tab) => tab.id === instance.activeTabId))
    // The window's size goes with it: a person who resized their browser finds it the size they left
    // it, and a background tab's viewport has a known window to be a fraction of. Read through
    // `windowContentSize`, because a window minimized at this moment reports none of its own.
    const [width, height] = this.windowContentSize(instance)
    return {
      workspaceId: instance.workspaceId,
      // The profile is what makes this entry *one window* rather than one workspace: a workspace
      // holds a window per profile in use, each remembered on its own.
      profileId: instance.profileId,
      tabs,
      activeIndex,
      contentSize: { width, height },
    }
  }

  /**
   * Remember these windows' tabs, leaving every other window's entry alone.
   *
   * One entry per **(workspace, profile)** — one per window, since that is what a window is now —
   * replaced whole: the file is a picture of "what to reopen", so a window with nothing left to
   * reopen drops its entry rather than keeping a stale one.
   */
  private persistInstancesTabsForRestore(instances: Iterable<BrowserInstance>): void {
    if (!this.restoreTabsEnabled()) return

    const byWindow = new Map<string, SavedBrowserWindowTabs>()
    for (const saved of loadBrowserTabsState().windows) {
      byWindow.set(
        rememberedWindowKey(saved.workspaceId, saved.profileId ?? DEFAULT_BROWSER_PROFILE_ID),
        saved,
      )
    }
    for (const instance of instances) {
      const snapshot = this.snapshotTabsForRestore(instance)
      const key = rememberedWindowKey(instance.workspaceId, instance.profileId)
      if (snapshot) byWindow.set(key, snapshot)
      else byWindow.delete(key)
    }
    saveBrowserTabsState({ windows: [...byWindow.values()] })
  }

  /**
   * Forget one window's remembered pages — what closing that window's last tab means.
   *
   * Scoped to the window rather than the workspace: another profile's window in the same workspace
   * is a different set of pages and has to survive this one being emptied.
   *
   * Written regardless of the setting, so a preference turned off and on again cannot resurrect a
   * window the person had emptied.
   */
  private forgetTabsForWindow(workspaceId: string | null, profileId: string): void {
    const state = loadBrowserTabsState()
    const kept = state.windows.filter(
      (saved) => rememberedWindowKey(saved.workspaceId, saved.profileId ?? DEFAULT_BROWSER_PROFILE_ID)
        !== rememberedWindowKey(workspaceId, profileId),
    )
    if (kept.length === state.windows.length) return
    saveBrowserTabsState({ windows: kept })
  }

  /** This window's remembered pages, when there are any and the person asked for them. */
  private restoredTabsForWindow(
    workspaceId: string | null,
    profileId: string,
  ): SavedBrowserWindowTabs | null {
    if (!this.restoreTabsEnabled()) return null
    const saved = loadBrowserTabsState().windows.find(
      (entry) => entry.workspaceId === workspaceId
        && (entry.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId,
    )
    return saved && saved.tabs.length > 0 ? saved : null
  }

  /**
   * Open a window with the pages it had last time.
   *
   * The first tab is already in the window (it was built as `tab-1`); the rest are built and
   * attached here, behind it, the same way a tab opened in the background is. The pages come back
   * in order and are numbered afresh from `tab-1` up: what is remembered is the window's *pages*,
   * not the names they were addressed by, so the numbering cannot creep upwards run after run.
   */
  private restoreTabs(instance: BrowserInstance, saved: SavedBrowserWindowTabs): void {
    const [first, ...rest] = saved.tabs
    // The tab the window was built around is the first remembered one: give it its page back.
    // The address is written **now**, not when the page commits, so a request that opens something
    // in this window in the same breath (a clicked link) reads it as a page rather than as the blank
    // tab it started as — a blank tab is what such a request is allowed to reuse.
    const firstTab = activeTab(instance)
    if (first.title) firstTab.title = first.title
    firstTab.currentUrl = first.url
    this.loadTab(instance, firstTab, first.url)

    for (const page of rest) {
      const tab = this.buildTab(instance.session, `tab-${++instance.tabCounter}`)
      if (page.title) tab.title = page.title
      tab.currentUrl = page.url
      instance.tabs.push(tab)
      this.attachTab(instance, tab)
      this.loadTab(instance, tab, page.url)
    }

    const active = instance.tabs[saved.activeIndex]
    if (active) instance.activeTabId = active.id
    this.layoutAllViews(instance)
    mainLog.info(`[browser-pane] Restored ${saved.tabs.length} tab(s) instance=${instance.id} workspace=${instance.workspaceId ?? 'none'} active=${instance.activeTabId}`)
  }

  /**
   * Which profile a tab built by this call lands on, the caller's explicit pick winning.
   *
   * `sessionId` is the conversation behind the tab, when there is one — the resolver turns that into
   * the conversation's profile, its workspace's default, or the built-in one. A person's own tab has
   * no conversation, so it gets the workspace's answer.
   */
  private resolveProfileId(
    sessionId: string | null,
    workspaceId: string | null,
    explicit?: string | null,
  ): string {
    const picked = explicit?.trim()
    if (picked) return picked
    return this.profileResolver?.(sessionId, workspaceId) ?? DEFAULT_BROWSER_PROFILE_ID
  }

  /** A profile's display name, re-reading the registry at most every {@link PROFILE_NAMES_TTL_MS}. */
  private profileNameFor(profileId: string): string {
    const now = Date.now()
    if (!this.profileNamesCache || now - this.profileNamesCache.readAt > PROFILE_NAMES_TTL_MS) {
      this.profileNamesCache = {
        readAt: now,
        names: new Map(getBrowserProfiles().map((profile) => [profile.id, profile.name])),
      }
    }
    return this.profileNamesCache.names.get(profileId) ?? profileId
  }

  /**
   * Name each window in the operating system's own lists — taskbar, alt-tab, task manager.
   *
   * One window is just "Craft Browser". Several are named after the profile each works in and
   * nothing else: the window already carries this app's icon and group, so a "Craft Browser —"
   * prefix would leave less room for the one word that tells the windows apart (用户报告). The
   * window is frameless, so this is not a title bar anyone sees; it is the name the system shows.
   */
  private syncWindowTitles(): void {
    const alive = Array.from(this.instances.values()).filter((instance) => !instance.window.isDestroyed())
    for (const instance of alive) {
      const title = alive.length > 1
        ? this.profileNameFor(instance.profileId)
        : BROWSER_WINDOW_TITLE
      if (instance.window.getTitle() !== title) instance.window.setTitle(title)
    }
  }

  /**
   * The session one profile's tabs run on, set up the first time that profile is used.
   *
   * A profile is born the moment a tab needs it, which is usually long after the app started — so the
   * session-scoped setup (local origins, permissions, display media, observers, proxy) happens here
   * rather than once at startup. Every piece of it is idempotent per session, and the registry makes
   * the proxy step happen once per partition rather than per tab.
   */
  private ensureProfileSession(profileId: string): ElectronSession {
    const partition = browserPanePartition(profileId)
    let ses = browserPaneSessions.get(partition)
    if (!ses) {
      ses = session.fromPartition(partition)
      browserPaneSessions.set(partition, ses)
      // The partition is almost always born after the proxy settings were last applied, so it goes
      // to the proxy layer now rather than waiting for a settings change that may never come.
      this.proxyApplier?.(ses)
    }
    registerLocalOriginHandler(ses)
    this.setupSessionPermissions(ses)
    this.setupDisplayMediaHandler(ses)
    this.setupSessionObservers(ses)
    return ses
  }

  createInstance(id?: string, options?: CreateBrowserInstanceOptions): string {
    const instanceId = id || `browser-${++instanceCounter}`
    const shouldShow = options?.show ?? false
    const workspaceId = options?.workspaceId ?? null

    if (this.instances.has(instanceId)) {
      mainLog.warn(`[browser-pane] Instance already exists, reusing: ${instanceId}`)
      return instanceId
    }

    // Which profile this window is: one workspace holds one window per profile in use, so this is
    // part of the window's identity rather than a per-tab setting. Every view it builds takes it.
    const profileId = this.resolveProfileId(options?.sessionId ?? null, workspaceId, options?.profileId)
    // The pages this window had last time, when the person asked for them back — this profile's,
    // never another profile's.
    const restored = this.restoredTabsForWindow(workspaceId, profileId)
    const ses = this.ensureProfileSession(profileId)
    // Designs are served on this partition too, so a design can be opened as a tab and read or
    // driven with the browser tools. What a page here may reach is bounded by the host, not by the
    // partition: a design's `data/` is never served (see design-preview-host).

    // Match background to current OS theme to prevent black/white flash on open. The same
    // value paints the page panel's surroundings in the overlay, so the two cannot disagree
    // about what "the surface" is.
    const bgColor = getBackgroundColor(nativeTheme.shouldUseDarkColors)

    // The chrome this window wears is a half-tint (`browser-chrome-surface`), so it is the
    // workspace window's own shell only when the same material sits behind it: vibrancy on macOS,
    // Mica/acrylic on Windows. Without one the tint would be half a colour over nothing, so the
    // flat colour is used instead — see `renderer/browser-toolbar.html`.
    const winMaterial = getWindowsBackgroundMaterial()
    const hasGlassBackdrop = process.platform === 'darwin' || Boolean(winMaterial)

    // Where it opens is left to Electron on purpose (the person's call): a window is something
    // they move, snap and maximise, and a position computed from a work area we read once would
    // fight that — and on a small display it can put the window's top edge off the screen.
    //
    // The size is ours: the one this window had last time when there is one to come back to, and
    // otherwise the size it opens around — a page `DEFAULT_VIEWPORT_WIDTH` wide, plus the rail beside
    // it and the panel's gutter. It is also the first thing `lastContentSize` holds, so a tab born
    // before the window has reported a size of its own still starts at a real viewport.
    const panelInset = this.pagePanelInsets(false)
    const rememberedSize = restored?.contentSize
    const createdContentSize =
      rememberedSize && rememberedSize.width > 0 && rememberedSize.height > 0
        ? { width: rememberedSize.width, height: rememberedSize.height }
        : {
            width: DEFAULT_VIEWPORT_WIDTH + TAB_RAIL_WIDTH + panelInset.left + panelInset.right,
            height: DEFAULT_WINDOW_HEIGHT,
          }
    const window = new BrowserWindow({
      width: createdContentSize.width,
      height: createdContentSize.height,
      minWidth: 700,
      minHeight: 500,
      // Its own name and icon, not the app's: this window is the browser, and it
      // is told apart from the workspace windows by both (taskbar, window switcher).
      title: BROWSER_WINDOW_TITLE,
      icon: browserWindowIconPath(),
      show: false, // Always hidden until toolbar is painted (ready-to-show)
      // `backgroundColor` is opaque and would cover the material, so a glass window leaves it
      // unset — as the workspace window does — and lets the material be the surface. The flat
      // colour is kept only where there is no material to fall back on.
      ...(hasGlassBackdrop ? {} : { backgroundColor: bgColor }),
      ...(process.platform === 'darwin' && {
        vibrancy: 'under-window' as const,
        visualEffectState: 'active' as const,
      }),
      ...(winMaterial && { backgroundMaterial: winMaterial }),
      // Fully chromeless — toolbar is rendered in a dedicated BrowserView
      frame: false,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // Give the window its own taskbar button on Windows. Without this it shares the
    // process's App User Model ID with the workspace windows and the taskbar folds
    // it into their button; a distinct id lifts it into a group of its own, so it can
    // be found and switched to on its own. The icon is repeated because the taskbar
    // draws that group's button from here, not from the window's own icon.
    //
    // A button of its own would otherwise carry a "Pin to taskbar" entry. The
    // window is a place to look at, not an app to launch, so `preventTaskbarPinning`
    // drops that entry — and it has to run first, before the app id is set.
    if (process.platform === 'win32') {
      preventTaskbarPinning(window)
      window.setAppDetails({
        appId: BROWSER_WINDOW_APP_ID,
        appIconPath: browserWindowIconPath(),
        appIconIndex: 0,
      })
    }

    /**
     * The window's chrome — the rail and the bar — in one view over the whole window. Its
     * document lays the rail out down the left edge and the bar across the top, and leaves the
     * page's slot transparent for the page view that sits on top of it (`restackViews`).
     */
    const chromeView = new BrowserView({
      webPreferences: {
        preload: join(__dirname, 'browser-toolbar-preload.cjs'),
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

    // The chrome's own background, so the parts of it a tab does not cover do not flash white.
    // A tab's background is set by `attachTab` — it belongs to the tab.
    chromeView.setBackgroundColor('#00000000')

    /**
     * The ground the page sits on, built here rather than per tab: created before any page
     * exists and loaded once, so a tab opened later has a frame around it from its first
     * frame instead of one that arrives with the document (see
     * {@link BrowserInstance.nativeOverlayView}).
     */
    const nativeOverlayView = new BrowserView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    nativeOverlayView.setBackgroundColor('#00000000')

    // A window is *opened on* something, so it starts with one tab; the tabs a
    // user adds afterwards go through `createTab`. Whatever the window had last time, this one is
    // `tab-1`: the names are handed out afresh here, and `restoreTabs` continues from it.
    const tab = this.buildTab(ses, 'tab-1')

    const instance: BrowserInstance = {
      id: instanceId,
      window,
      parkingWindow: null,
      chromeView,
      nativeOverlayView,
      nativeOverlayReady: false,
      tabs: [tab],
      activeTabId: tab.id,
      // `tab-1` is what the tab built above was named, and the counter is the window's own: it
      // starts here every time the window is built, so names never carry over from a past run.
      tabCounter: 1,
      workspaceId,
      profileId,
      // The profile this window is signed into, fixed at birth — see the interface's own note.
      session: ses,
      isVisible: false,
      hasBeenShown: false,
      isHiding: false,
      keepAliveOnWindowClose: true,
      toolbarReady: false,
      toolbarMenuOpen: false,
      toolbarMenuHeight: 0,
      toolbarMenuOverlayActive: false,
      railCollapsed: false,
      lastContentSize: createdContentSize,
      urlBarFocusToken: 0,
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

    window.addBrowserView(chromeView)
    // The ground goes in before the page does: a tab's page view is added *on top* of it
    // (`attachTab`), which is what makes the panel's line sit under the page's edge.
    window.addBrowserView(nativeOverlayView)
    this.restackViews(instance)

    this.attachTab(instance, tab)

    this.layoutAllViews(instance)

    this.setupWindowListeners(instance)
    this.instances.set(instanceId, instance)
    // A second window makes "which one?" a question the OS asks too (taskbar, alt-tab).
    this.syncWindowTitles()
    // The rest of the remembered pages, once the window is registered and can take tabs.
    if (restored) this.restoreTabs(instance, restored)
    this.loadNativeOverlay(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] toolbar version: v4-react-chromeless`)
    mainLog.info(`[browser-pane] Created instance: ${instanceId} (show=${shouldShow}, workspace=${workspaceId ?? 'none'})`)

    void this.loadChromePage(instance)
      .finally(() => {
        // Safety net: if Electron never fires ready-to-show, still unblock focus/show behavior.
        if (!instance.toolbarReady) {
          this.markToolbarReady(instance, 'toolbar-load-finalized')
        }
      })
    // A restored window is already loading its pages; the empty-state document is what a
    // window with nothing to restore opens with.
    if (!restored) {
      // The window's birth tab is the new-tab page until something navigates it.
      tab.internalPage = 'newtab'
      tab.currentUrl = 'about:newtab'
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
    }

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
      /**
       * The address this tab is being made **for**, when the caller will load it itself.
       *
       * A tab's own address is what says whether it is the new-tab page, and that has to be readable
       * from the moment the tab is made (`isNewTabPage`). `url` records the address *and* loads it
       * here; a caller that must run the load itself — `navigate`, which normalises the input and
       * reports a failure — cannot have it loaded twice, so it says the address with this and loads
       * it in the same breath. Recording only: nothing is loaded here.
       */
      address?: string
      /**
       * Whether the new tab is **put on screen**, and the default is not.
       *
       * The window is shared, so a tab that appears behind the one the person is reading is the
       * ordinary case — an agent's tab, a link followed on an agent's page. Only an act that means
       * "show this" says `true`: the person's own `+` in the tab strip, the bar's new-tab button,
       * and a link clicked on a tab that is nobody's work *and* that nobody works from
       * ({@link attachTab}'s window-open handler). `tab-show` is the verb for bringing one up
       * afterwards, and the rail is always there to click.
       */
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
       * Said by the commands that are the entry point to a page (`navigate`, `tab-new`, the
       * app's "New tab"): they can take the birth tab of a window nobody has seen yet. The
       * browser side is what decides — one empty new-tab page **and** `!hasBeenShown` — so
       * a window the person has ever seen keeps its blank tab; that one may be theirs.
       */
      reuseUntouchedWindow?: boolean
    },
  ): string {
    const instance = this.requireAliveInstance(instanceId)

    // "Untouched" is only ever taken by a caller that **says** it wants *a* tab rather than
    // *another* tab (`reuseUntouchedWindow`); a url alone does not say it. The callers that
    // say it are the entry points to a page — `navigate`, `tab-new` and the app's "New tab" —
    // so a fresh unseen window comes up with one tab instead of an orphan beside the one that
    // was asked for.
    //
    // **One tab, empty, never shown, and not already claimed** is the whole test — not
    // "who caused the window". A window outlives the commands that made it, so its history
    // is not knowable later; but whether the person has ever *seen* it is (`hasBeenShown`).
    // A window born behind them — by `navigate`, or by the turn's control overlay, which
    // brings the workspace's window up before the first browser command so it can show
    // whose work it is — is still untouched: its birth tab is nobody's, and taking it is
    // what keeps a window at one tab instead of leaving an orphan New Tab beside the page.
    // Once shown, that blank tab may be the person's and is never taken.
    //
    // "Not already claimed" matters because a hidden tab can still be named, selected or
    // handed to a conversation (`--tab`, `tab-select`, `tab-assign`) while the window stays
    // unseen. Taking it then would rewrite `belongsTo` and the cursor under that
    // conversation. Only the tab's own prior claims — by the conversation now asking for it
    // (`belongsTo`), or by nobody at all — are allowed.
    const candidate = instance.tabs.length === 1 ? instance.tabs[0] : null
    const asker = options?.belongsTo?.sessionId ?? null
    const claimedBySomebodyElse = candidate !== null && (
      (candidate.belongsTo !== null && candidate.belongsTo.sessionId !== asker)
      || candidate.cursorOf.some((sessionId) => sessionId !== asker)
      || (candidate.heldBy !== null && candidate.heldBy !== asker)
    )
    const unwritten =
      options?.reuseUntouchedWindow === true
      && !options?.afterTabId
      && candidate !== null
      && this.isNewTabPage(candidate)
      && !instance.hasBeenShown
      && !claimedBySomebodyElse
        ? candidate
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
      if (options?.url) {
        // Written with the load, so the tab reads as a page from here (`isNewTabPage`).
        unwritten.internalPage = undefined
        unwritten.currentUrl = options.url
        this.loadTab(instance, unwritten, options.url)
      } else {
        // A named address is a page from here; none leaves it the new-tab page.
        unwritten.internalPage = options?.address ? undefined : 'newtab'
        if (options?.address) unwritten.currentUrl = options.address
        else unwritten.currentUrl = 'about:newtab'
        this.pushToolbarState(instance)
        this.emitStateChange(instance)
      }
      mainLog.info(`[browser-pane] Tab reused instance=${instance.id} tab=${unwritten.id} url=${unwritten.currentUrl}`)
      return unwritten.id
    }

    // A tab is always the window's: one window is one profile, so the tab inherits it — there is no
    // per-tab profile to resolve.
    const tab = this.buildTab(instance.session, `tab-${++instance.tabCounter}`)
    // The address is written **now**, not when the page commits — the same reason `restoreTabs`
    // writes it: the moment this tab is put on screen has to read it as a page rather than as the
    // blank tab it started as (`isNewTabPage`). A caller that loads the address itself says it with
    // `address`; anything else leaves the tab reading as blank, which is what a new tab is.
    if (options?.url) tab.currentUrl = options.url
    else if (options?.address) tab.currentUrl = options.address
    else {
      tab.internalPage = 'newtab'
      tab.currentUrl = 'about:newtab'
    }
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

    if (options?.activate ?? false) {
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
    // A page is about to be here, so the backdrop behind its own paint is the browser's canvas —
    // set as the load begins, before any frame can show the tab's previous backdrop (`tabBackdropFor`).
    tab.tabView.setBackgroundColor(this.tabBackdropFor(tab))
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
      // clicking their own tab means — and nothing about it moves. Where that keyboard goes is the
      // same decision as anywhere the shown tab is named (`focusShownTab`): the bar for a new-tab
      // page, the page otherwise.
      this.focusShownTab(instance, tab)
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
    //
    // The keyboard goes where the tab on screen says it goes: the address bar when it is the
    // new-tab page, the page otherwise (`focusShownTab`). A brand-new tab's empty-state document
    // commits a beat later and hands the page the focus as it does, so `did-navigate` puts the
    // caret back in the bar when that document is the one that arrives.
    this.focusShownTab(instance, tab)
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
  private focusTheTabOnScreen(instance: BrowserInstance, tab: BrowserTab, force = false): void {
    if (instance.window.isDestroyed()) return
    // `force` is for the paths that *are* the window coming forward — `focus` and
    // `markToolbarReady`, which have just asked for the native activation. Reading `isFocused`
    // there would race that activation (and skip the hand-over for no reason); everywhere else
    // the check stays, so a background push cannot pull the window in front.
    if (!force && !instance.window.isFocused()) return
    const tabWc = tab.tabView.webContents
    if (tabWc.isDestroyed() || tabWc.isFocused()) return
    tabWc.focus()
  }

  /**
   * Put the caret in the address bar.
   *
   * A new tab has no page to type into — it exists to be given an address — so the keyboard
   * belongs in the bar rather than in the empty document. That is two moves, because the bar
   * is a webContents of its own: the count in the state push tells the bar's renderer to put
   * the caret in its input, and focusing that webContents is what actually hands the keyboard
   * over. Either alone is not enough — a focused webContents with no focused element still
   * swallows the typing, and a focused element in a webContents nobody handed the keyboard to
   * never sees a keystroke.
   *
   * Left alone for a window nobody is looking at — the same rule the page obeys
   * ({@link focusTheTabOnScreen}): focusing another window's webContents is what brings that
   * window forward, and a caret nobody can see is not worth moving.
   */
  private focusAddressBar(instance: BrowserInstance, force = false): void {
    if (instance.window.isDestroyed() || instance.chromeView.webContents.isDestroyed()) return
    if (!force && !instance.window.isFocused()) return
    instance.urlBarFocusToken += 1
    this.pushToolbarState(instance)
    instance.chromeView.webContents.focus()
  }

  /**
   * Whether a tab is the **new-tab page** — a tab nobody pointed anywhere.
   *
   * A marker rather than an address test: `about:newtab` is a real address, and the
   * empty-state document is our own stand-in, not a page. The marker is
   * written where the tab is made (`createTab` / `createInstance`), so the moment a tab is put
   * on screen ({@link focusShownTab}) already knows, before that document commits — and it
   * survives the fallback to `about:blank` when the empty-state document cannot load.
   */
  private isNewTabPage(tab: BrowserTab): boolean {
    // Both facts: a marker with a real address is a page (a test fixture or a state
    // written by hand), and `about:newtab` without the marker is a page that navigated
    // there on purpose.
    return tab.internalPage === 'newtab' && tab.currentUrl === 'about:newtab'
  }

  /**
   * Whether the keyboard belongs in the address bar rather than in the page.
   *
   * The new-tab page and a real `about:blank` document both have nothing to type into.
   * `about:blank` is deliberately *not* a new tab (it is a real page): this answers only
   * the focus question, while reuse and restore keep asking {@link isNewTabPage}.
   */
  private wantsAddressBarFocus(tab: BrowserTab): boolean {
    return this.isNewTabPage(tab) || tab.currentUrl === 'about:blank'
  }

  /**
   * Where the keyboard belongs when a tab is put on screen.
   *
   * Into the address bar when the tab is the new-tab page — it exists to be given an address, and
   * there is no page to type into — and into the page otherwise. The single decision, so the paths
   * that put a tab on screen (a switch, a close handing over, and the window itself coming up —
   * `focus` / `markToolbarReady`) cannot disagree about it. `force` is passed on by those
   * window-coming-up paths; see {@link focusTheTabOnScreen}.
   */
  private focusShownTab(instance: BrowserInstance, tab: BrowserTab, force = false): void {
    if (this.wantsAddressBarFocus(tab)) this.focusAddressBar(instance, force)
    else this.focusTheTabOnScreen(instance, tab, force)
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
   * Which tab takes over is {@link successorOf}'s to decide — for the display. The conversations
   * that were working in the closed tab are **not** moved with it: a cursor ends with its tab,
   * and one that wants another names it.
   */
  closeTab(instanceId: string, tabId: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance) return
    const index = instance.tabs.findIndex((candidate) => candidate.id === tabId)
    if (index === -1) return

    if (instance.tabs.length === 1) {
      // Closing the last tab is a window emptied by hand: there is nothing to bring back next
      // time, so the remembered pages go with it (`forgetTabs`).
      this.destroyInstance(instanceId, { forgetTabs: true })
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
    this.sessionRecordings.endForTabs(instance.id, [tab.id])

    // A lock never outlives what it locks: closing the tab a session was holding lets go
    // of it here, rather than leaving the window claiming a tab that is gone.
    // The cursor ends with the tab, and is deliberately **not** handed to a successor: a cursor
    // is written by a conversation working somewhere, so moving it here would write one nobody
    // asked for — on the tab that happened to be next, or worse, on whatever is on screen. A
    // conversation whose tab is closed comes back with no tab of its own and is told to name one
    // (`whyThereIsNoWorkingTab`): it may take the person's tab, but it has to say so.
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
        // as `activateTab`: the tab that takes over has just been moved into this window. And, again
        // like `activateTab`, the decision is the shown tab's — the bar for a new-tab page, the page
        // otherwise (`focusShownTab`).
        this.focusShownTab(instance, next)
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
   * therefore only possible for a tab that is **the caller's own work**: a conversation
   * cannot hand on work it does not have, and a tab nobody owns (one the person opened) is
   * not the caller's to transfer — the receiver can name it itself, reaching it as nobody's
   * work. Whether the receiver is a session worth handing to (spawned by the giver, or one of
   * the same task) is `SessionManager`'s call — it is the side that knows the conversations,
   * and it is also the side that can resolve the receiver's **work**, which is why `to` is
   * passed whole rather than as a session id the browser side could only guess a task from.
   *
   * A tab somebody else is holding is refused: the handover would leave the receiver with a
   * tab it cannot use until that turn ends, and the holder working from a tab that just left
   * its reach. On success every other conversation's cursor on the tab is cleared, because the
   * tab's work changed and they may no longer work there; the giver's hold, if any, goes too.
   */
  assignTab(instanceId: string, tabId: string, to: TabBelongsTo, by: TabBelongsTo): void {
    const instance = this.requireAliveInstance(instanceId)
    const tab = tabById(instance, tabId)
    if (!tab) throw new Error(`Browser window "${instanceId}" has no tab "${tabId}".`)
    if (!to?.sessionId) {
      throw new Error('Handing a tab over needs the conversation to hand it to.')
    }
    if (to.sessionId === by.sessionId) {
      throw new Error(`Tab ${tabId} is already ${to.sessionId}'s — there is nothing to hand over.`)
    }
    if (!tab.belongsTo) {
      throw new Error(
        `Tab ${tabId} is the person's, so ${by.sessionId} cannot give it away. The conversation that should work there ` +
        `can name it itself ("tab-select ${tabId}"), or open a tab of its own with "tab-new <url>".`,
      )
    }
    if (!sameWork(tab.belongsTo, by)) {
      throw new Error(
        `Tab ${tabId} is ${describeWork(tab.belongsTo)}'s, so ${by.sessionId} cannot hand it on.`,
      )
    }
    if (tab.heldBy && tab.heldBy !== by.sessionId) {
      throw new Error(
        `Tab ${tabId} is held by ${tab.heldBy} until that turn ends, so it cannot be handed over right now.`,
      )
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
    // The work changed, so every cursor on this tab belonged to someone who may no longer work
    // here — the giver's included. The receiver is the only one left.
    tab.cursorOf = [to.sessionId]

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

  /**
   * Tear a window down for good.
   *
   * This is the last moment its pages exist, so it is where "what comes back next time" is
   * decided. The default is to **remember** them: a window closed in full, left at quit, or
   * whose workspace is going away is one the person expects to find again. `forgetTabs` says
   * the opposite, for the one case that means the opposite — a window **emptied by hand**, by
   * closing its last tab — where there is nothing left to bring back.
   */
  destroyInstance(id: string, options?: { forgetTabs?: boolean }): void {
    const instance = this.instances.get(id)
    if (!instance) {
      mainLog.info(`[browser-pane] destroy requested for missing instance id=${id}`)
      return
    }

    if (options?.forgetTabs) this.forgetTabsForWindow(instance.workspaceId, instance.profileId)
    else this.persistInstancesTabsForRestore([instance])

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
    this.sessionRecordings.endForTabs(instance.id, instance.tabs.map((tab) => tab.id))
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
    options?: { show?: boolean; workspaceId?: string | null; profileId?: string },
  ): Promise<string> {
    return this.createForSession(sessionId, options)
  }

  async getOrCreateForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null; profileId?: string },
  ): Promise<string> {
    return this.getOrCreateForSession(sessionId, options)
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

    const target = readAddressTarget(url)
    const normalizedUrl = 'search' in target ? searchUrlFor(target.search) : target.url

    const timeoutMs = 30_000
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    try {
      const loaded = tab.tabView.webContents.loadURL(normalizedUrl)
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`Navigation to "${normalizedUrl}" timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        )
      })
      await Promise.race([loaded, timeout])
    } catch (error) {
      // A *previous* load's abort is not this navigation failing: Electron hands
      // the abort to whichever `loadURL` promise is current, so the window is
      // already on the page we asked for (see `abortedLoad`). An abort of the URL
      // we asked for is a real "did not get there" — and so is anything else.
      const superseded = abortedLoad(error)
      if (!superseded || superseded.url === normalizedUrl) {
        // The tab's own `did-fail-load` is the better record (it knows Chromium's code);
        // this is the fallback for the failures that never reach it, such as the timeout.
        if (!superseded && !tab.loadError) {
          tab.loadError = { code: chromiumErrorCode(error), url: tab.currentUrl || normalizedUrl }
          this.emitStateChange(instance)
          void this.pushToolbarState(instance)
        }
        throw error
      }
      mainLog.info(
        `[browser-pane] navigation superseded a pending load id=${id} aborted=${superseded.url ?? 'unknown'}`,
      )
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
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
    const tab = this.tabOf(instance, tabId)
    // On the built-in error page "reload" means what the person means: try the address
    // that failed again, not re-render the news about it.
    if (tab.internalPage === 'error' && tab.loadError) {
      void tab.tabView.webContents.loadURL(tab.loadError.url).catch(() => undefined)
      return
    }
    tab.tabView.webContents.reload()
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
    instance.hasBeenShown = true
    this.emitStateChange(instance)
    // Bringing the window up also hands the keyboard to the tab it is showing — the address bar
    // when that is the new-tab page, the page otherwise — the same decision a tab switch makes
    // (`focusShownTab`). Forced, because the activation was just asked for above.
    this.focusShownTab(instance, activeTab(instance), true)
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

    // The window is going away — which is exactly what "remember my tabs" is about, and the
    // pages are still here (hiding keeps them), so this is where they can be read.
    this.persistInstancesTabsForRestore([instance])

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

  /**
   * Run one dispatch of a command's own input with the tab marked as receiving it.
   *
   * The mark lives only for the dispatch — it cannot outlive the command or be read as a claim on
   * the tab — and it is what tells a page-requested tab (a link's `target="_blank"`, a scripted
   * `window.open`) that the agent, not the person, caused it. See {@link BrowserTab.commandInput}.
   */
  private async withCommandInput<T>(tab: BrowserTab, run: () => Promise<T>): Promise<T> {
    tab.commandInput = true
    try {
      return await run()
    } finally {
      tab.commandInput = false
    }
  }

  async clickAtCoordinates(id: string, x: number, y: number, tabId?: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const tab = this.tabOf(instance, tabId)
      await this.withCommandInput(tab, () => tab.cdp.clickAtCoordinates(x, y))
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
      const geometry = await this.withCommandInput(tab, () => tab.cdp.clickElement(ref))
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
        cssSize: { width: viewport.width, height: viewport.height },
        format: options?.format,
        jpegQuality: options?.jpegQuality,
      })

      return {
        imageBuffer: captured.imageBuffer,
        imageFormat: captured.imageFormat,
        imageWidth: captured.imageWidth,
        imageHeight: captured.imageHeight,
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
        cssSize: { width: viewport.width, height: viewport.height },
        format: options?.format,
        jpegQuality: options?.jpegQuality,
      })

      if (captured.warnings.length > 0) {
        warnings.push(...captured.warnings)
      }

      return {
        imageBuffer: captured.imageBuffer,
        imageFormat: captured.imageFormat,
        imageWidth: captured.imageWidth,
        imageHeight: captured.imageHeight,
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
      cssSize: { width: clippedWidth, height: clippedHeight },
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
      imageWidth: captured.imageWidth,
      imageHeight: captured.imageHeight,
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
      cssSize?: { width: number; height: number }
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; imageWidth: number; imageHeight: number; warnings: string[] }> {
    const tab = options.tab
    let sawNoSurface = false
    const warnings: string[] = []
    const imageOpts = { dpr: options.dpr, cssSize: options.cssSize, format: options.format, jpegQuality: options.jpegQuality }

    // Where the view *lives* decides whether it can be copied where it is — and its home is composited
    // by construction (`tabHome`): the parking window is shown and off every display, and a window
    // that holds its page is the one a person is looking at. What remains, and what the fall-through
    // below is for, is a view with no surface **anyway** — a page that has never painted, or a window
    // the platform will not answer for (on Windows that is a *hidden* one — measured, a minimized one
    // answers there while a hidden one does not: `capture-methods.cjs`).
    const livesInTheWindow = this.tabHome(instance, tab) === 'window'

    // A parked tab's view can be under a sibling in its own window, or its window under another
    // workspace's — either leaves it with no surface to copy (`raiseParkedView`). Bring it to the
    // front, and give it the frame that raise needs **before the first look**: a view that was never
    // the top one has never been composited, so a capture taken the instant it is raised is a picture
    // of nothing, and the retry loop below would only be waiting that same frame anyway.
    if (!livesInTheWindow) {
      this.raiseParkedView(instance, tab)
      await this.sleep(SCREENSHOT_FIRST_FRAME_MS)
    }

    // Shot where it lives: a few goes, because a page that has just been painted can still answer
    // empty once. A platform that answers "no surface" is not going to change its mind inside this
    // home — a page nobody has composited has nothing to copy — so that breaks straight through to
    // the parked shot below.
    for (let attempt = 1; attempt <= SCREENSHOT_CAPTURE_ATTEMPTS; attempt += 1) {
      let result: { buffer: Buffer; format: 'png' | 'jpeg'; width: number; height: number } | null = null
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
          break
        }
        throw error
      }

      if (result) {
        if (attempt > 1) {
          warnings.push(`Capture recovered after ${attempt} attempt${attempt === 1 ? '' : 's'}.`)
        }
        return { imageBuffer: result.buffer, imageFormat: result.format, imageWidth: result.width, imageHeight: result.height, warnings }
      }

      mainLog.warn(
        `[browser-pane] ${options.errorPrefix} empty capture attempt instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_CAPTURE_ATTEMPTS} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl}`,
      )

      if (attempt < SCREENSHOT_CAPTURE_ATTEMPTS) {
        await this.waitForScreenshotReadiness(instance.id)
      }
    }

    // No surface where the view is — nothing there has been composited. The parking window is the one
    // place that is composited without being seen, so the view is put there for the shot (a parked tab
    // is already in it) and handed back to its home afterwards. No window is built for this: measured,
    // a view moved into the parking window answers one frame later, and a window built for the shot
    // answers no sooner — the frame is the wait, not the window (`parking-raise-capture.cjs`).
    const own = tab.tabView.getBounds()
    this.parkTabForShot(instance, tab, own)

    let parked: { buffer: Buffer; format: 'png' | 'jpeg'; width: number; height: number } | null = null
    try {
      // Its first frame: a view that has just been moved in has nothing to copy until it is composited.
      await this.sleep(SCREENSHOT_FIRST_FRAME_MS)

      for (let attempt = 1; attempt <= SCREENSHOT_CAPTURE_ATTEMPTS; attempt += 1) {
        let result: { buffer: Buffer; format: 'png' | 'jpeg'; width: number; height: number } | null = null
        try {
          result = await this.capturePageImage({
            tab,
            rect: options.rect,
            useHiddenCaptureOptions: false,
            ...imageOpts,
          })
        } catch (error) {
          if (this.isNoSurfaceCaptureError(error)) {
            sawNoSurface = true
            mainLog.warn(
              `[browser-pane] ${options.errorPrefix} no surface to capture from the parking window instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_CAPTURE_ATTEMPTS} tab=${tab.id} url=${tab.currentUrl} detail=${error instanceof Error ? error.message : String(error)}`,
            )
            break
          }
          throw error
        }

        if (result) {
          parked = result
          break
        }

        mainLog.warn(
          `[browser-pane] ${options.errorPrefix} empty capture attempt from the parking window instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_CAPTURE_ATTEMPTS} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl}`,
        )

        if (attempt < SCREENSHOT_CAPTURE_ATTEMPTS) {
          await this.waitForScreenshotReadiness(instance.id)
        }
      }
    } finally {
      this.putTabBack(instance, tab, own)
    }

    if (parked) {
      warnings.push('Capture parked that tab in the parking window for the shot; it was put straight back.')
      return { imageBuffer: parked.buffer, imageFormat: parked.format, imageWidth: parked.width, imageHeight: parked.height, warnings }
    }

    mainLog.warn(
      `[browser-pane] ${options.errorPrefix} capture failed after recovery instance=${instance.id} mode=${options.mode} isLoading=${tab.isLoading} tab=${tab.id} url=${tab.currentUrl}`,
    )

    if (sawNoSurface) {
      throw new Error(
        `Failed to capture ${options.errorPrefix}: the page had no display surface to copy, even parked in the parking window. `
        + `Wait for it to paint ("browser_tool wait network-idle") and retry.`
      )
    }

    throw new Error(`Failed to capture ${options.errorPrefix}: empty image buffer`)
  }

  /**
   * Put a tab's view in the shared parking window for a shot, at the size it has.
   *
   * The parking window is the one place that is composited without being seen — shown, off every
   * display — so it is where a view with no surface of its own gets one. A parked tab's view is
   * already in it and is only brought to the top; the tab on screen is moved in, and the window is
   * grown to hold it, because `parkedViewsFit` leaves the tab on screen out and would otherwise clip
   * the very view it is being asked to hold.
   *
   * The window is not built here: it is the one every parked tab lives in (`parkingWindowFor`), kept
   * up for as long as the instance is. **Measured** (`parking-raise-capture.cjs`): a view moved into it
   * answers one frame later, and a window built for the shot answers no sooner — the wait is the
   * frame, not the window.
   */
  private parkTabForShot(instance: BrowserInstance, tab: BrowserTab, own: { width: number; height: number }): void {
    const page = tab.tabView.webContents
    if (!page || page.isDestroyed()) return

    tab.tabView.setBounds({ x: 0, y: 0, width: own.width, height: own.height })
    const parking = this.parkingWindowFor(instance)
    if (parking.isDestroyed()) return

    const [width, height] = parking.getContentSize()
    if (own.width > width || own.height > height) {
      parking.setContentSize(Math.max(width, own.width), Math.max(height, own.height))
      this.keepOffEveryDisplay(parking)
    }
    parking.contentView.addChildView(tab.tabView)
    // …and bring it to the front: a sibling parked after it would otherwise be sitting on top, and a
    // view that is never the top one is never composited (see `raiseParkedView`).
    this.raiseParkedView(instance, tab)
  }

  /**
   * Bring a parked tab's view to the front of its parking window, and that window to the front of any
   * other parking window that shares its off-screen spot.
   *
   * Two things can hide a parked view, and either leaves it with **nothing to copy**: a sibling parked
   * on top of it in the same window (every parked view sits at {0,0}), and another workspace's parking
   * window on the same spot (`offscreenSpot` is a function of the size). What is lost is not the
   * picture of a live page but the surface itself — a view that has never been the top one has never
   * been composited, and a view with no surface answers no capture. A covered view that *had* been up
   * before keeps answering, which is what a shot used to rely on by accident (measured in
   * `parking-raise-capture.cjs`: the covered view there had been the only child when the window was
   * first shown).
   *
   * `addChildView` raises a view among its siblings, `moveTop` raises a window among windows, and
   * neither takes focus — the window is off every display, so raising it is invisible.
   */
  private raiseParkedView(instance: BrowserInstance, tab: BrowserTab): void {
    const parking = instance.parkingWindow
    if (!parking || parking.isDestroyed() || tab.tabView.webContents.isDestroyed()) return
    try {
      parking.contentView.addChildView(tab.tabView)
      parking.moveTop()
    } catch {
      // A platform without one of these: nothing to do.
    }
  }

  /**
   * Hand a tab's view back where it belongs, having kept the viewport the shot was taken at: the tab
   * this window holds goes back into it (they may have resized it while the view was away, and this is
   * the tab they are looking at), and every other tab — including the one the window is *on* while it
   * is away — goes back to the window it lives in (`parkTab`). Which of the two is `tabHome`'s
   * answer, the same one the layout uses. The overlay belongs above the page exactly when that page is
   * the locked one, so it is told either way.
   */
  private putTabBack(instance: BrowserInstance, tab: BrowserTab, own: { width: number; height: number }): void {
    if (instance.window.isDestroyed() || tab.tabView.webContents.isDestroyed()) return
    if (this.tabHome(instance, tab) === 'window') {
      instance.window.contentView.addChildView(tab.tabView)
      // The window's page area — the size it has, or the last size it reported while it is minimized
      // (`windowContentSize`), which is the viewport the shot was taken at.
      tab.tabView.setBounds(this.pageAreaBounds(instance))
    } else {
      // Its home is the parking window and it is already there, raised by the shot. Parking it again
      // appends it at the top — the same view, the same place in a stack nobody is looking at.
      this.parkTab(instance, tab, own)
    }
    this.restackViews(instance)
    this.updateNativeOverlayState(instance)
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
   * Take a window nobody may see out of the app's own window surfaces.
   *
   * macOS lists every *shown* window in two places the person reads: the application's Window menu
   * (which the dock's window list mirrors) and Mission Control / "Show All Windows". The parking
   * windows are shown on purpose (`showInactive`), so without this they are a grey rectangle the
   * person can see and do nothing with. The person's report: "显示所有窗口里还是能看到停车窗".
   *
   * `excludedFromShownWindowsMenu` takes it out of the menu. Mission Control hides a window whose
   * AppKit collection behaviour is `transient`, which is the default for any level other than
   * `normal` — hence the float level. Neither call places the window; staying off every display is
   * `enableLargerThanScreen` at construction (`parkingWindowFor`) plus `keepOffEveryDisplay`.
   */
  private hideFromWindowLists(window: BrowserWindow): void {
    window.excludedFromShownWindowsMenu = true
    window.setAlwaysOnTop(true, 'floating')
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
      /**
       * The size the picture should come back at, in CSS pixels — the viewport for a full
       * shot, the region for a clipped one. Given, the image is brought to exactly this
       * size, which is what keeps its pixels the same coordinates `click-at` uses.
       */
      cssSize?: { width: number; height: number }
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ buffer: Buffer; format: 'png' | 'jpeg'; width: number; height: number } | null> {
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

    // Bring the shot back to the page's CSS pixels so its coordinates match `click-at`'s: the
    // known CSS size (the viewport, or the region that was asked for) is used when it is there —
    // the numbers the caller's coordinates already live in — with the device scale as the fallback.
    const dpr = options.dpr ?? 1
    const raw = image.getSize()
    const target = options.cssSize && options.cssSize.width > 0 && options.cssSize.height > 0
      ? { width: Math.round(options.cssSize.width), height: Math.round(options.cssSize.height) }
      : { width: Math.round(raw.width / dpr), height: Math.round(raw.height / dpr) }

    if (target.width > 0 && target.height > 0 && (target.width !== raw.width || target.height !== raw.height)) {
      image = image.resize({ width: target.width, height: target.height, quality: 'best' })
    }

    const size = image.getSize()

    const fmt = options.format ?? 'png'
    const encoded = fmt === 'jpeg'
      ? image.toJPEG(options.jpegQuality ?? 80)
      : image.toPNG()

    if (!encoded || encoded.length === 0) {
      return null
    }

    return { buffer: encoded, format: fmt, width: size.width, height: size.height }
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
    const { delivered } = await this.withCommandInput(tab, () => tab.cdp.pressKey(key, modifiers))
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
   * A **minimized** window is still this tab's window (`tabHome`) and is sized the same way: measured,
   * macOS answers its size and lays the page out to it (`hidden-window-usability.cjs`, the `minimized`
   * rows), so the request lands. Where the window reports no size — Windows minimized — the layout is
   * refused (`windowHasSize`) and the tab keeps the viewport it had, which is what comes back here.
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

    if (this.tabHome(instance, tab) !== 'window') {
      // Not the tab the window holds: resize the view where it lives. `parkTab` grows the parking window
      // to fit what it holds — a window clips its children, and a clipped view is a view with a
      // smaller viewport — and leaves the person's window out of it entirely. This is the agent's
      // ordinary case: the window it works in is hidden, so its tab lives in the parking window.
      this.parkTab(instance, tab, wanted)
      const parked = tab.tabView.getBounds()
      mainLog.info(`[browser-pane] resized a parked tab's view id=${id} tab=${tab.id} to=${parked.width}x${parked.height}`)
      return { width: Math.max(0, Math.floor(parked.width)), height: Math.max(0, Math.floor(parked.height)) }
    }

    // The tab on screen: the window grows by everything that tab does not get — the bar from the
    // top, the rail from the side (while it is out), the panel's gutter (`pagePanelInsets`), and
    // the window's own edge on the side where the rail is not.
    const inset = this.pagePanelInsets(instance.railCollapsed)
    instance.window.setContentSize(
      requestedWidth + (instance.railCollapsed ? 0 : TAB_RAIL_WIDTH) + inset.left + inset.right,
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
    // Every window of the workspace: a design can be open in any profile's window.
    for (const instance of this.windowsForWorkspace(workspaceId)) {
      const tabs = await this.listTabsAsync(instance.id)
      const expression =
        `window.postMessage({ protocol: 'craft-designs/v1', type: 'data', ` +
        `payload: { snapshot: ${snapshotJson} } }, '*')`
      for (const tab of tabs) {
        if (!tab.url || !tab.url.startsWith(`craft-local://${label}/`)) continue
        await this.evaluate(instance.id, expression, tab.id)
      }
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
    options?: { workspaceId?: string | null; profileId?: string },
  ): Promise<BrowserStartRecordingResult> {
    // The window named by `profileId` (the tab's own, when the caller resolved it) or the
    // conversation's own profile — the wrong window would have none of the caller's tabs.
    const instanceId = await this.getOrCreateForSessionAsync(sessionId, {
      workspaceId: options?.workspaceId,
      ...(options?.profileId ? { profileId: options.profileId } : {}),
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
      instanceId: instance.id,
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
    // The window comes from the recording itself: a stop names the tab and never the window.
    void this.syncRecordingObserver(finished.instanceId, tabId)

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

    // Both halves of the name: a tab is `tab-3` **in its window**, and another window's `tab-3`
    // is another tab — one that this recording has nothing to say about.
    const covered = this.tabRecorder
      .states()
      .some((state) => state.instanceId === instanceId && state.tabId === tabId)
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
   * The window a session works in — its workspace's window **for that session's profile**.
   *
   * A workspace holds one window per profile, shared by every conversation working in that profile
   * and by the person. Which window a call resolves to therefore depends on the **profile** the
   * conversation works in (its own pick, its workspace's default, then the built-in one) — a
   * conversation that switched profiles gets another window rather than a window with two profiles.
   * `sessionId` also names who is asking, but nothing about the window is written from it: which
   * conversations are working in it is per tab (`BrowserTab.cursorOf` / `heldBy`), because a parent
   * and its child sessions can be in it at once (Conductor).
   *
   * `sessionId` may be null: opening a browser by hand is the workspace's default profile's window.
   */
  createForSession(
    sessionId: string | null,
    options?: { show?: boolean; workspaceId?: string | null; profileId?: string },
  ): string {
    const workspaceId = options?.workspaceId ?? null
    // A workspace holds one window per profile, so which window a conversation gets is decided by
    // the profile it works in: a conversation that switched profiles lands in (or opens) another one.
    const profileId = this.resolveProfileId(sessionId, workspaceId, options?.profileId)
    const existing = this.findWindow(workspaceId, profileId)

    if (existing) {
      if (options?.show) {
        this.focus(existing.id)
      }
      mainLog.info(`[browser-pane] Window resolved instance=${existing.id} workspace=${workspaceId ?? 'none'} profile=${profileId} askedBy=${sessionId ?? 'a person'} tabs=${existing.tabs.length}`)
      return existing.id
    }

    const id = this.createInstance(undefined, {
      show: options?.show ?? false,
      workspaceId,
      sessionId,
      // Already resolved above: the window is created for exactly the profile this call landed on.
      profileId,
    })
    mainLog.info(`[browser-pane] Window created instance=${id} workspace=${workspaceId ?? 'none'} profile=${profileId} askedBy=${sessionId ?? 'a person'}`)
    return id
  }

  /**
   * The window a conversation would work in, when it already exists — nothing is created.
   *
   * A workspace holds one window per profile, so "is the browser open?" is a question about the
   * caller's profile rather than about the workspace: a conversation on another profile has no
   * window even though one is on screen for somebody else.
   */
  findWindowForSession(sessionId: string | null, workspaceId: string | null): string | null {
    return this.findWindow(workspaceId, this.resolveProfileId(sessionId, workspaceId))?.id ?? null
  }

  /**
   * One window of this workspace for one profile, or null when it has none.
   *
   * Found by the workspace **and the profile** it was stamped with: those two are the window's
   * whole identity, stamped at create-time and never rewritten, so two workspaces' windows and two
   * profiles' windows cannot be confused for each other and neither needs an owner.
   * `workspaceId === null` is a bucket of its own (a caller with no workspace context), which keeps
   * such a window from being handed to a workspace that has none of its own.
   */
  private findWindow(workspaceId: string | null, profileId: string): BrowserInstance | null {
    return this.windowsForWorkspace(workspaceId).find((instance) => instance.profileId === profileId) ?? null
  }

  /**
   * Every browser window this workspace has — one per profile in use.
   *
   * Ordered by instance id, which is creation order: the window that was opened first reads first,
   * so the built-in profile's window (the ordinary case) leads unless a conversation opened another
   * before it.
   */
  private windowsForWorkspace(workspaceId: string | null): BrowserInstance[] {
    const windows: BrowserInstance[] = []
    for (const instance of this.instances.values()) {
      if (instance.workspaceId !== workspaceId) continue
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'windowsForWorkspace')
        continue
      }
      windows.push(instance)
    }
    return windows.sort((a, b) => a.id.localeCompare(b.id))
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
      this.clearControlInInstance(instance, sessionId)
    }
  }

  /**
   * The same release, for **one** window — what `clearAgentControlForInstance` names.
   *
   * Kept apart from {@link clearControl} so that scoping is a fact about the call and not
   * about the caller remembering to iterate: `tab-show` hands over the window whose tab it
   * shows, and a session's other windows (there is one per workspace, but the layer does not
   * assume it) are not part of that hand-over.
   */
  private clearControlInInstance(instance: BrowserInstance, sessionId: string): void {
    let changed = instance.controlBy.delete(sessionId)
    for (const tab of instance.tabs) {
      if (tab.heldBy !== sessionId) continue
      this.setHeldBy(tab, null)
      changed = true
    }
    if (!changed) return
    this.updateNativeOverlayState(instance)
    this.pushToolbarState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] Released session ${sessionId}'s overlay and holds on ${instance.id}`)
  }

  getOrCreateForSession(
    sessionId: string,
    options?: { workspaceId?: string | null; profileId?: string },
  ): string {
    return this.createForSession(sessionId, {
      show: false,
      workspaceId: options?.workspaceId,
      ...(options?.profileId ? { profileId: options.profileId } : {}),
    })
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
    // Baked as the rail-out geometry — what a window is born with — and re-stated on every
    // update, because folding the rail away moves the panel's left edge (`updateNativeOverlayState`).
    const inset = this.pagePanelInsets(instance.railCollapsed)

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
         (see pagePanelInsets in the main process). The surface behind the page is this rectangle
         plus everything outside it — the spread shadow fills the outside, and the rectangle itself
         is filled from updateNativeOverlayState while the overlay is under the page. Filling the
         rectangle is what covers the corners: they are cut out of the page's own view
         (applyPageCornerRadius), and those notches fall *inside* this rectangle. It is left clear
         while the overlay is over the page (a lock, or one of our menus), where a fill would cover
         the page.

         Square on purpose, and the one place in this document that does not round anything: the
         page's corner is cut by the page's own view and a second arc drawn here would be a second
         copy of that shape computed differently (CSS pixels here, the display's metrics there).
         Where the two disagree the page's own paint is what shows through — the page is above this
         document, so nothing here can cover it — and a page that paints white shows a white edge
         along the corner in dark mode, and eats the line's arcs at the four corners. */
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

         The soft layers beneath it are the app's own panel edge (--shadow-middle) — three of them,
         one more than the address bar's field edge (--shadow-minimal) carries — so the page reads a
         touch heavier than the field beside it, the same relation a panel has to a field in the app
         (resolvePagePanelShadow).

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
        box-shadow: ${resolvePagePanelShadow(false)};
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
   * Where the tab area is: right of the rail, below the bar — the whole window when the rail
   * is folded away (`railCollapsed`), because there is nothing on the left to give room to.
   *
   * One answer for every reader — the agent overlay's bounds (it covers this and nothing else)
   * and the viewport `viewport-resize` promises — so they cannot disagree about how much window
   * the tab area actually gets. The page *inside* it is smaller still: see
   * {@link pageAreaBounds}.
   */
  private tabAreaBounds(instance: BrowserInstance): { x: number; y: number; width: number; height: number } {
    const [width, height] = this.windowContentSize(instance)
    const railWidth = instance.railCollapsed ? 0 : TAB_RAIL_WIDTH
    return {
      x: railWidth,
      y: TOOLBAR_HEIGHT,
      width: Math.max(200, width - railWidth),
      height: Math.max(100, height - TOOLBAR_HEIGHT),
    }
  }

  /**
   * The gutter between the tab area's edges and the page panel drawn inside it.
   *
   * The page hugs the chrome it sits against — the rail on its left and the bar above it — with
   * exactly **1px** between them, and keeps `PANEL_EDGE_INSET` from the window's edges where there
   * is nothing to hug (the app insets its own panels by that much): the right and the bottom
   * always, and the left too once the rail is folded away.
   *
   * Those 1px are not spacing (the person's call: the page stays flush against the chrome
   * otherwise): the line is drawn just *outside* the page, and the chrome's own document is on
   * top of the page at that edge — flush against it the line's top and left lines would be
   * painted behind the chrome and never seen. One pixel is all a line needs, and it is what the
   * app gets for free by drawing its panels' lines in the same document as its chrome.
   */
  private pagePanelInsets(railCollapsed: boolean): { left: number; top: number; right: number; bottom: number } {
    return {
      left: railCollapsed ? PANEL_EDGE_INSET : 1,
      top: 1,
      right: PANEL_EDGE_INSET,
      bottom: PANEL_EDGE_INSET,
    }
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
    const inset = this.pagePanelInsets(instance.railCollapsed)
    return {
      x: area.x + inset.left,
      y: area.y + inset.top,
      width: area.width - inset.left - inset.right,
      height: area.height - inset.top - inset.bottom,
    }
  }

  /**
   * Put the window's three layers in order for the state we are in.
   *
   * The order is not fixed, and it is one function because the three places that used to
   * decide it (`raiseActiveTab`, the menu's layout, and `updateNativeOverlayState`) each had
   * their own idea and could disagree:
   *
   * - the **chrome** — one view over the window, the rail and the bar in one document — sits
   *   *under* the page: a view covers a rectangle whatever it paints, so a full-window chrome
   *   left on top would take the page's clicks with it. It is raised above the page only while
   *   one of its menus is open, because the menu is drawn in that same document and hangs down
   *   over the page's slot;
   * - the **page** is over the chrome, and under the overlay while a conversation holds it;
   * - the **overlay** (the gutter's surface, the panel's line, and the agent's frame) is under
   *   the page normally and over it while the tab on screen is held.
   *
   * Each layer is raised in turn, bottom to top, on the two z-order doors there are: the page
   * is a `WebContentsView` (`contentView.addChildView`) and the other two are `BrowserView`s
   * (`setTopBrowserView`). They share one tree, so the order they are given here holds.
   */
  private restackViews(instance: BrowserInstance): void {
    if (instance.window.isDestroyed()) return
    const page = activeTab(instance)
    const overlay = instance.nativeOverlayView
    const chrome = instance.chromeView
    const held = page.heldBy !== null
    const menuUp = instance.toolbarMenuOpen || instance.toolbarMenuOverlayActive
    // A page whose home is the parking window is not this window's to place: `addChildView` here would
    // move it back into a window that cannot hand it a surface (`tabHome`). What is left in that
    // window is the chrome and the overlay — nobody is looking at it, and the coming back lays the
    // page out again.
    const pageHere = this.tabHome(instance, page) === 'window'

    if (menuUp) {
      // overlay < page < chrome: the menu has to be over the page it hangs across.
      instance.window.setTopBrowserView(overlay)
      if (pageHere) instance.window.contentView.addChildView(page.tabView)
      instance.window.setTopBrowserView(chrome)
    } else if (held) {
      // chrome < page < overlay: the agent's frame and shield are over the page.
      instance.window.setTopBrowserView(chrome)
      if (pageHere) instance.window.contentView.addChildView(page.tabView)
      instance.window.setTopBrowserView(overlay)
    } else {
      // overlay < chrome < page: the page is the person's.
      instance.window.setTopBrowserView(overlay)
      instance.window.setTopBrowserView(chrome)
      if (pageHere) instance.window.contentView.addChildView(page.tabView)
    }
  }

  /** Tell the window's chrome something — the rail and the bar, which are one document. */
  private sendToChrome(instance: BrowserInstance, channel: string, payload?: unknown): void {
    if (instance.window.isDestroyed()) return
    const wc = instance.chromeView.webContents
    if (wc.isDestroyed()) return
    wc.send(channel, payload)
  }

  /**
   * The chrome: the window's whole rectangle.
   *
   * One view over the window, not the bar's row and the rail's column as two: the document
   * lays the rail out down the left edge and the bar across the top, and the page's slot is
   * the rest of it. Its size is the window's, so it is one surface from the window's top-left
   * corner to its bottom-right whatever the two bands inside it are.
   */
  private layoutChromeView(instance: BrowserInstance): void {
    const [width, height] = instance.window.getContentSize()
    instance.chromeView.setBounds({
      x: 0,
      y: 0,
      width: Math.max(1, width),
      height: Math.max(1, height),
    })
    instance.chromeView.setAutoResize({ width: true, height: true })
  }

  /**
   * Which tab a conversation works from — the **cursor** on its own.
   *
   * Split out of {@link recordSessionTab} because the two halves of that write do not always
   * belong together: a conversation's own work takes the tab *and* the driven-by mark, while a
   * tab that was nobody's, set up for it by the person, takes only the cursor. One conversation
   * has one cursor, so pointing at this tab
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
    /**
     * Whether the overlay ends up *above* the page — the one question the mask's fill answers.
     *
     * Stated from `restackViews`, which is what decides the order, rather than guessed here: a
     * held tab raises the overlay (the agent's frame and shield have to be over the page), and an
     * open menu of ours takes the top for the chrome, which puts the overlay back *under* the page
     * even while the tab is held. The two used to disagree — the fill followed "a menu is up" and
     * went clear, which is exactly when the overlay is under the page and the fill is what covers
     * the notches the page's cut corners leave in this document.
     */
    const overlayOverPage = locked && !(instance.toolbarMenuOpen || menuActive)

    const overlay = instance.nativeOverlayView

    if (!instance.nativeOverlayReady || instance.window.isDestroyed()) {
      overlay.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      overlay.setAutoResize({ width: false, height: false })
      if (!instance.window.isDestroyed()) {
        this.restackViews(instance)
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

    // Which layer is over which — the overlay over the page while this tab is held, and under it
    // otherwise — is `restackViews`'s one job, so nothing here has its own idea of it.
    this.restackViews(instance)

    // Resolved on every update rather than baked into the document, because both follow the
    // OS/app theme and the window outlives a theme switch.
    //
    // The surface is the **half-tint** the chrome draws (`browser-chrome-surface`): over the
    // window's material the two have to agree exactly, and a solid colour here would read as a
    // second surface beside the rail rather than the same one.
    const surface = `color-mix(in srgb, ${getBackgroundColor(nativeTheme.shouldUseDarkColors)} 50%, transparent)`
    const ring = resolvePagePanelRing(nativeTheme.shouldUseDarkColors)
    const frameShadow = resolvePagePanelShadow(nativeTheme.shouldUseDarkColors)
    const accent = this.getResolvedAccentColor()
    const lockedGlow = `inset 0 0 0 1px color-mix(in oklab, ${accent} 45%, transparent), inset 0 0 24px color-mix(in oklab, ${accent} 28%, transparent)`
    // The gutter the panel is drawn in, restated on every update: its left edge moves when the
    // rail is folded away or brought back (`pagePanelInsets`), and it is the one piece of this
    // document's geometry that is not fixed for the window's life.
    const inset = this.pagePanelInsets(instance.railCollapsed)

    void overlay.webContents.executeJavaScript(`(() => {
      const mask = document.getElementById('mask');
      const frame = document.getElementById('frame');
      const lock = document.getElementById('lock');
      const chip = document.getElementById('chip');
      const shield = document.getElementById('shield');
      if (!mask || !frame || !lock || !chip || !shield) return;

      const locked = ${locked};
      const shieldActive = ${shieldActive};
      const overlayOverPage = ${overlayOverPage};

      // The panel's rectangle and the two frames around it, placed from the gutter above. The
      // frames sit one pixel outside it, so their arcs stay concentric with the page's cut corner.
      const gutter = ${JSON.stringify(inset)};
      for (const [element, delta] of [[mask, 0], [frame, -1], [lock, -1]]) {
        element.style.left = (gutter.left + delta) + 'px';
        element.style.top = (gutter.top + delta) + 'px';
        element.style.right = (gutter.right + delta) + 'px';
        element.style.bottom = (gutter.bottom + delta) + 'px';
      }

      // The surface the panel sits on, outside the page's rectangle — the colour the rail and the
      // bar beside it are drawn in, so the panel reads as a panel on this window's surface rather
      // than on a second one.
      mask.style.boxShadow = '0 0 0 9999px ' + ${JSON.stringify(surface)};

      // …and the rectangle itself is filled while the overlay is *under* the page. The page covers
      // it, but its corners are cut out of the page's own view (applyPageCornerRadius) and those
      // notches fall *inside* this rectangle — filled here, they show this surface; left clear, they
      // would show the window's material behind the whole document, which is not what the panel sits
      // on. Only a held tab with no menu of ours up puts the overlay over the page, and then the
      // rectangle must stay clear, or it would cover the page (overlayOverPage).
      mask.style.background = overlayOverPage ? 'transparent' : ${JSON.stringify(surface)};

      // Which of the two frames is drawn: the resting line outside the page while nothing is
      // happening here, and — once this tab is held — the agent's own frame over the page's edge,
      // with the glow inside it. One or the other and never both: they are two placements of the
      // same ink, and both would be on screen at once.
      frame.style.display = locked ? 'none' : 'block';
      frame.style.borderColor = ${JSON.stringify(ring)};
      // Re-set with the ring, per mode: the blur's opacity is --shadow-blur-opacity, which the app
      // raises in dark mode, and the address bar beside this line is drawn from that same variable.
      frame.style.boxShadow = ${JSON.stringify(frameShadow)};

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
    // Each window remembers its pages as it is destroyed (`destroyInstance`), so a workspace
    // put away comes back the way it was left.
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
    // One fewer window may mean there is nothing left to tell apart by profile.
    this.syncWindowTitles()
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
    const onScreen = activeTab(instance)
    const inTheWindow = this.tabHome(instance, onScreen) === 'window'

    // A window that holds its page is laid out **to** the window — and only that tab is. A window with
    // no size of its own has no geometry to hand out: laying anything out from it would write the
    // floors in `tabAreaBounds` into the page — 193×93, which looks like a size rather than a mistake
    // (`windowHasSize`). The window coming back is what lays out again. Every *other* tab needs
    // nothing from this window, so that check does not gate them: a window that is away is not a home
    // (`tabHome`), and the tab it is on belongs in the parking window with them.
    if (inTheWindow) {
      if (!this.windowHasSize(instance)) return
      // The page panel, not the whole tab area: the gutter around it is the overlay's to paint
      // (`pageAreaBounds`), and the page's own corners are cut out of its view
      // (`applyPageCornerRadius`) so the surface behind them shows through.
      onScreen.tabView.setBounds(this.pageAreaBounds(instance))
    }

    // Everything the window is not holding is parked at the viewport it has — so the person dragging
    // the window is not a reason for an agent's background page to reflow, and the agent measured that
    // page, its elements and their coordinates at the size it has. That a parked tab keeps its
    // viewport is the whole reason it is parked in a *shown* window rather than moved out of this
    // one (`parkTab`, `parkingWindowFor`).
    for (const tab of instance.tabs) {
      if (this.tabHome(instance, tab) === 'window') continue
      this.parkTab(instance, tab)
    }

    this.restackViews(instance)
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
   * is visible, it is never in the taskbar, and it never takes anyone's focus. `frame: false` together
   * with `enableLargerThanScreen` is part of *off every display* rather than a detail of the look: on
   * macOS AppKit's `constrainFrameRect:toScreen:` brings a window it judges unreachable back onto a
   * display, and Electron returns the frame untouched there **only** for a frameless window that set
   * the flag (measured in `electron_ns_window.mm`) — either of the two alone and the OS owns the spot.
   * One per browser window, made when the first tab is parked and destroyed with the window. It
   * **follows the views in it** in both directions — `parkedViewsFit` — because a window clips its
   * children and a clipped view is a view with a smaller viewport, while anything larger than what it
   * holds is space nobody sees.
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
      // Frameless **and** `enableLargerThanScreen`: on macOS these two are what let a window stay
      // where it was put. AppKit's `constrainFrameRect:toScreen:` is what brings a window it judges
      // unreachable back onto a display, and Electron returns the frame untouched there only for a
      // frameless window that asked for this (measured in `electron_ns_window.mm`). Without it the
      // spot below is a request the OS overrules — the person's report: "停车窗被系统拉到可见区域了".
      enableLargerThanScreen: true,
      // AppKit decides a window's default collection behaviour (and so whether Exposé / "Show All
      // Windows" hides it) from its level **when the window is created**; raising the level later is
      // not enough. So the float level is part of the construction, and `hideFromWindowLists` below
      // only repeats it for the Window menu flag.
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: getBackgroundColor(nativeTheme.shouldUseDarkColors),
    })
    instance.parkingWindow = parking
    this.hideFromWindowLists(parking)
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
   * The reported size is the whole test, deliberately: what must never happen is laying a page out
   * from a size the window does not have. A **minimized** window on Windows reports
   * `getContentSize()` 0×0 (measured), and a layout run made from that used to write a fiction into
   * the page's view — the floors in `tabAreaBounds` read as a size (193×93) rather than as a mistake,
   * and the page stayed that small after the window came back (measured: window 1200×900, page
   * `innerWidth` 193, until the next layout — a tab switch — put it right. The person's report:
   * "怎么用着用着浏览器窗口会变成一个很小的值 193×93。切换标签界面又恢复了"). The size a window has
   * while it has none to report is read from what it last reported (`windowContentSize`), so that
   * fiction is impossible from here on: a window that reports nothing is not laid out from.
   *
   * "Minimized" is *not* asked separately any more, because minimized and sizeless are not the same
   * state and only one of them is a reason to refuse. Measured (`hidden-window-usability.cjs`): a
   * minimized window **on macOS** still reports its size — it answers the window branch of
   * `resizeViewport` and lays its page out to it — so refusing it meant an agent's `viewport-resize`
   * went unapplied *silently*, answering with the viewport it had asked for while the page kept the
   * old one (`minimized (today)`: page 900×620, answered 1400×900; `reported-size`: page 1400×900).
   * On Windows the 0×0 answer is what refuses it, exactly as before, and the tab keeps the size it had.
   * Whether the window *holds* its tab is a different question, asked separately and directly
   * (`tabHome` — a minimized window holds nothing, on either platform).
   */
  private windowHasSize(instance: BrowserInstance): boolean {
    if (instance.window.isDestroyed()) return false
    const [width, height] = instance.window.getContentSize()
    return width > 0 && height > 0
  }

  /**
   * The window's content size — the live one when it has one, and the last one it reported when it
   * has none.
   *
   * Minimizing does not change a window's size, only where it is, so a window that reports 0×0 while
   * minimized did have a size a moment ago and still does. Reading it here (and remembering it on the
   * way past, which is also how it is refreshed as the person resizes the window) is what lets a tab
   * **born** into that moment be created at the size it would have had otherwise.
   */
  private windowContentSize(instance: BrowserInstance): [number, number] {
    const [width, height] = instance.window.getContentSize()
    if (width > 0 && height > 0) {
      instance.lastContentSize = { width, height }
      return [width, height]
    }
    return [instance.lastContentSize.width, instance.lastContentSize.height]
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
      if (this.tabHome(instance, tab) === 'window') continue
      const bounds = tab.tabView.getBounds()
      width = Math.max(width, Math.ceil(bounds.width))
      height = Math.max(height, Math.ceil(bounds.height))
    }
    return { width, height }
  }

  /**
   * Where a tab's view belongs: **in the window** when that window is the one showing this tab *and*
   * can hand out a surface for it, and in the parking window otherwise.
   *
   * "Can hand out a surface for it" has two parts, and the second is the one that is easy to get
   * wrong. **First**: a window that has never been on a display has a surface *nowhere*, on any
   * platform — a capture of one answers at once with "no surface" (`capture-methods.cjs`, the
   * `never-shown` rows), which is exactly why the parking window is *shown*. **Second**: a window that
   * has been up and was hidden since keeps the surface it got there, but whether the platform lets it
   * be copied while hidden is not universal — that is `canCaptureHiddenWindows`, and it is the only
   * case that flag is about.
   *
   * Both parts matter here because the agent's window is **born hidden**. Asking only the platform
   * half (true on macOS) would leave the tab in a window that has never been on a display: composited
   * nowhere, so every shot would pay a refusal before being taken from the parking window anyway.
   *
   * **Minimized** is the third way of not being on screen, and it is the one that parks its tab — on
   * both platforms, as one rule. A shot is not the reason: measured, `capturePage` returns the tab's
   * own pixels in ~15ms while the window is minimized, both forms, one row per tab (`capture-methods.cjs`,
   * the `minimized` rows on Windows and on macOS). The reason is that a minimized window is not a home:
   * it is not what the person is looking at, and on Windows it cannot hand out geometry either —
   * measured with a view left inside one (`hidden-window-usability.cjs`), `view.setBounds` moves the
   * view while the page's viewport stays put (no `resize`, the page keeps its size), so a
   * `viewport-resize` asked then is lost and a shot comes back at the old viewport. macOS does follow
   * `setBounds` there, so parking is not *needed* on that platform — it is kept anyway: the move costs
   * the page nothing (the view keeps its size and the parking window grows to fit it, `parkTab`), and
   * one rule is worth more than a behaviour that differs per platform *by accident* (which is what
   * inferring "no size" would have been — only Windows reports none while minimized). The way back is
   * `cameBack`, which lays the tab out again.
   *
   * Which branch below keeps a *hidden* window's tab home is a fact about the platform's events rather
   * than a choice: on macOS `minimize()` emits `hide` too (measured — and on Windows it does not), so it
   * is `canCaptureHiddenWindows` that answers there rather than `isVisible`.
   *
   * This is the agent's ordinary case. The window it works in is born hidden and mostly stays that
   * way, so the tab a command works from is already parked: a shot finds a surface where the tab is
   * instead of moving it in and out around every capture (`parkTabForShot`), and the person's window
   * — when they open it — is the one place the page is *not* until it is asked for.
   */
  private tabHome(instance: BrowserInstance, tab: BrowserTab): 'window' | 'parking' {
    if (instance.activeTabId !== tab.id) return 'parking'
    // A minimized window does not hold its page, on either platform — asked directly rather than
    // inferred from the window reporting no size, which only Windows does while minimized and which
    // would have made this rule platform-shaped by accident.
    if (instance.window.isDestroyed() || instance.window.isMinimized()) return 'parking'
    if (instance.isVisible) return 'window'
    // Hidden — and the two ways of being hidden are not the same state. A window that has never been
    // on a display is composited nowhere: a capture of it answers at once with "no surface", whatever
    // the platform says about hidden windows (`capture-methods.cjs` — `never-shown` errors
    // immediately, while `hidden-after-show` is the state that claim is about). Only for the second
    // kind, and only where the platform answers for it, is a window that is away still a home.
    return instance.hasBeenShown && this.canCaptureHiddenWindows ? 'window' : 'parking'
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
   *
   * Parked views go in at the **top** of the parking window (appended). The order is not a statement
   * about which tab is "current" — nothing here is being looked at — so the simplest rule wins: the
   * tab just parked is the one with a surface, and a shot that raises another tab is allowed to leave
   * it there. The real window is a tab's home; the parking stack is only where its view can stay
   * composited.
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
    // At the window's corner: parked views sit at the same spot and overlap. That costs none of them
    // their viewport — the layout is what the freeze is for — but it does cost the ones underneath
    // their **surface**: a view that never becomes the top one is never composited, and a view with no
    // surface answers no capture. So a shot brings the tab it wants to the front first
    // (`raiseParkedView`) instead of trusting whatever happens to be on top.
    tab.tabView.setBounds({ x: 0, y: 0, width: own.width, height: own.height })
    const parking = this.parkingWindowFor(instance)
    if (parking.isDestroyed()) return
    // Appended, so it is the top one: the tab just parked is the one that gets a surface, and the
    // active tab may be covered by it — the parking stack carries no "current tab" meaning.
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
   * The colour behind a tab's document — what shows until it paints, and wherever it is transparent.
   *
   * The browser's own canvas — white — for a **page**: a page that leaves its background to the
   * browser is a light page whatever theme the app is wearing, so the canvas is the right guess for
   * it. But the **new-tab page is our own document** and paints the app's own surface, and a white
   * canvas behind it is a flash of the wrong colour every time a tab is opened in a dark theme —
   * measured on the empty-state document, whose first paint waits on a remote font stylesheet. The
   * surface is what that document is about to paint, so there is nothing to flash.
   */
  private tabBackdropFor(tab: BrowserTab): string {
    return this.isNewTabPage(tab) ? getBackgroundColor(nativeTheme.shouldUseDarkColors) : PAGE_VIEW_BACKDROP
  }

  /**
   * Lay every view out from the window's current size.
   *
   * The chrome and the overlay size themselves natively (`setAutoResize`), so this is the page's
   * rectangle — it alone cannot (`layoutTabView`) — and then the layers' order, which the resize
   * did not change but the menu state might have (`restackViews`).
   */
  private layoutAllViews(instance: BrowserInstance): void {
    this.layoutChromeView(instance)
    this.layoutTabView(instance)
    this.restackViews(instance)
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
      // A legal new-tab address, and the value every part of the UI hides.
      return { url: 'about:newtab', title: 'New Tab' }
    }
    return { url, title }
  }

  private async loadEmptyStateDocument(instance: BrowserInstance, tab: BrowserTab = activeTab(instance)): Promise<void> {
    // The new-tab page is our own document and paints the app's surface, so the view behind it is
    // that surface too — otherwise a new tab flashes the browser's white canvas until this document
    // paints, which waits on a remote font stylesheet (`tabBackdropFor`).
    tab.tabView.setBackgroundColor(this.tabBackdropFor(tab))
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
   * Load the window's chrome document.
   *
   * Retried, because a chrome that failed to load is a window with a hole in it.
   */
  private async loadChromePage(instance: BrowserInstance): Promise<void> {
    let lastError: unknown = null

    for (let attempt = 0; attempt <= TOOLBAR_LOAD_MAX_RETRIES; attempt++) {
      try {
        if (VITE_DEV_SERVER_URL) {
          await instance.chromeView.webContents.loadURL(
            `${VITE_DEV_SERVER_URL}/browser-toolbar.html?instanceId=${encodeURIComponent(instance.id)}`,
          )
        } else {
          await instance.chromeView.webContents.loadFile(
            join(__dirname, 'renderer/browser-toolbar.html'),
            { query: { instanceId: instance.id } },
          )
        }

        if (attempt > 0) {
          mainLog.info(`[browser-pane] chrome load recovered id=${instance.id} attempt=${attempt + 1}`)
        }
        return
      } catch (error) {
        lastError = error
        const retrying = attempt < TOOLBAR_LOAD_MAX_RETRIES
        mainLog.warn(
          `[browser-pane] chrome load failed id=${instance.id} attempt=${attempt + 1}/${TOOLBAR_LOAD_MAX_RETRIES + 1}: ${error instanceof Error ? error.message : String(error)}${retrying ? ' (retrying)' : ''}`,
        )

        if (retrying) {
          await this.sleep(TOOLBAR_LOAD_RETRY_DELAY_MS)
        }
      }
    }

    const errorText = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
    await this.loadChromeFallback(instance, errorText)
  }

  private async loadChromeFallback(instance: BrowserInstance, reason: string): Promise<void> {
    const safeReason = reason.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] || ch))
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
        <div class="title">Browser chrome failed to load</div>
        <div class="muted">The tab area still works, but the rail and the toolbar are unavailable. Tabs can still be switched and added from the app, or by the agent.</div>
        <div class="muted" style="margin-top: 8px; word-break: break-word;">Reason: ${safeReason}</div>
      </div>
    </div>
  </body>
</html>`

    try {
      await instance.chromeView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      mainLog.warn(`[browser-pane] Loaded chrome fallback id=${instance.id}`)
    } catch (error) {
      mainLog.error(`[browser-pane] Failed to load chrome fallback id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
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
    if (instance.window.isDestroyed() || instance.chromeView.webContents.isDestroyed()) return
    const state = {
      url: activeTab(instance).currentUrl,
      title: activeTab(instance).title,
      // Which profile this window uses — the chrome says so beside the rail's toggle.
      profileName: this.profileNameFor(instance.profileId),
      isLoading: activeTab(instance).isLoading,
      ...(activeTab(instance).loadError ? { error: activeTab(instance).loadError } : {}),
      canGoBack: activeTab(instance).canGoBack,
      canGoForward: activeTab(instance).canGoForward,
      /**
       * Whether the window is maximized, for the bar's maximize/restore button.
       *
       * Read from the window rather than remembered by the button: it can also be maximized
       * from outside the bar — a double-click on the drag region, the OS's own window menu —
       * and the icon has to say which of the two a press will do.
       */
      maximized: instance.window.isMaximized(),
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
       * How many times this window has asked for the caret in the address bar.
       *
       * A number rather than a flag — it is a request, not a state, so two new tabs in a row
       * are two of them (see `focusAddressBar`). Sent with the rest of the state so the bar
       * focuses its input in the same commit that gives it the new tab's address, never
       * before it: focusing early would leave the previous tab's address on screen.
       */
      urlBarFocusToken: instance.urlBarFocusToken,
      /**
       * Whether the rail is folded away.
       *
       * The window's flag rather than the document's: the rail's room is part of the tab area
       * (`tabAreaBounds`), so the page has already been placed without it by the time this is
       * pushed — the chrome is being told what to draw, not asked. In memory and per window: a
       * window opened later starts with the rail out.
       */
      railCollapsed: instance.railCollapsed,
      /**
       * The window's tabs.
       *
       * `tabs` comes from the window itself rather than from the renderer's own
       * count: the rail is not told "show the tabs", it is told which tabs there
       * are. Whether it is out at all is the window's other flag (`railCollapsed`),
       * pushed beside this one — two facts, one push, so they cannot be drawn a
       * beat apart.
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

    /**
     * Render the built-in load-error page into the tab that failed.
     *
     * The page replaces the tab's document, the way a browser's own error page does —
     * the tab still describes the failed address around it (`internalPage`), so the
     * address bar and the rail keep naming where the person was going.
     */
    ipcMain.handle(
      TOOLBAR_CHANNELS.SHOW_ERROR_PAGE,
      async (
        _event,
        instanceId: string,
        copy: { message?: string; url?: string; retry?: string },
      ) => {
        const inst = findInstance(instanceId)
        if (!inst || inst.window.isDestroyed()) return

        const tab = activeTab(inst)
        if (!tab || tab.tabView.webContents.isDestroyed() || !tab.loadError) return
        // Already standing on this failure's page (a replay, or the error restored
        // after a cancelled navigation): do not load it again.
        if (tab.internalPage === 'error' && tab.tabView.webContents.getURL().includes(ERROR_PAGE_MARKER)) {
          return
        }

        tab.internalPage = 'error'
        tab.title = ''
        tab.favicon = null
        const html = browserErrorPageHtml({
          message: String(copy?.message ?? ''),
          url: String(copy?.url ?? tab.loadError.url),
          retry: String(copy?.retry ?? ''),
        })
        try {
          await tab.tabView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        } catch {
          tab.internalPage = undefined
        }
        this.emitStateChange(inst)
        void this.pushToolbarState(inst)
      },
    )

    /**
     * Fold the rail away, or bring it back — the chrome's own toggle.
     *
     * One flag, one relayout: the rail's room is part of the tab area, so the page, the gutter,
     * the overlay and the layer order are all said once here (`layoutAllViews`,
     * `updateNativeOverlayState`) and the chrome is told the new state with them. Nothing is
     * echoed back as an answer — the toggle draws from the push like every other control.
     */
    ipcMain.handle(TOOLBAR_CHANNELS.RAIL_TOGGLE, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst || inst.window.isDestroyed()) return

      inst.railCollapsed = !inst.railCollapsed
      this.layoutAllViews(inst)
      this.updateNativeOverlayState(inst)
      this.pushToolbarState(inst)
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
     * The window's caption verbs, from the bar.
     *
     * The window is chromeless on every platform, so it has no OS buttons: these are the
     * only minimize/maximize it has besides the keyboard and the OS's own window menu. The
     * new maximize state comes back through the `maximize`/`unmaximize` events
     * (`setupWindowListeners`), so nothing is answered here — the button draws from the
     * push, exactly like every other control in the bar.
     */
    ipcMain.handle(TOOLBAR_CHANNELS.MINIMIZE, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (inst) inst.window.minimize()
    })

    ipcMain.handle(TOOLBAR_CHANNELS.MAXIMIZE, async (_event, instanceId: string) => {
      const inst = findInstance(instanceId)
      if (!inst) return
      if (inst.window.isMaximized()) inst.window.unmaximize()
      else inst.window.maximize()
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
          // same act `tab-show` performs when it hands the page over, only sent from the
          // other side. No session is named: whoever is working here lets go.
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
          // conversation may each be recording this same tab. The window is the other half of
          // that name, and it is the one the chrome spoke for.
          tabId: tab.id,
          instanceId: inst.id,
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
   * `chromeView`, ...). When we ship the result back over the `__browser:invoke`
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
      imageWidth: result.imageWidth,
      imageHeight: result.imageHeight,
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
          // Which cookie jar the caller works in travels with the request: the desktop side cannot
          // read a session's profile, and the workspace default is not the answer for a conversation
          // that picked one.
          profileId: req.profileId,
        })
      }
      case 'getOrCreateForSession':
        return this.createForSession(sessionId, {
          show: false,
          workspaceId,
          profileId: req.profileId,
        })
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
        return this.startRecordingForSession(sessionId, recordingArgs, {
          workspaceId,
          ...(req.profileId ? { profileId: req.profileId } : {}),
        })
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
    instance.hasBeenShown = true
    this.emitStateChange(instance)
    // A window being shown is also the tab on screen getting the keyboard (`focusShownTab`):
    // the address bar for a new-tab page, the page for a real one. Forced — the window's own
    // activation was just asked for.
    this.focusShownTab(instance, activeTab(instance), true)

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
    const workspaceId = options?.workspaceId ?? null
    const instance = this.findWindow(workspaceId, this.resolveProfileId(sessionId, workspaceId))
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
   * Called on session/window teardown.
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
      this.clearControlInInstance(instance, sessionId)
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
    if (this.observersReady.has(ses)) return
    this.observersReady.add(ses)

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

      // A 5xx is served, not failed: the page commits with the server's own error body and
      // Chromium reports no `did-fail-load` for it. The status is the only signal, and the
      // person deserves it — "502" is a fact, a blank page is not an explanation.
      if (
        details.resourceType === 'mainFrame' &&
        (details.statusCode ?? 0) >= 500 &&
        // Our error page has no main-frame request of its own; anything arriving now
        // belongs to the attempt it is already reporting.
        located.tab.internalPage !== 'error'
      ) {
        located.tab.loadError = {
          code: 'HTTP_ERROR',
          status: details.statusCode ?? 0,
          url: details.url || located.tab.currentUrl,
        }
        mainLog.info(
          `[browser-pane] page answered ${details.statusCode} id=${located.instance.id} tab=${located.tab.id} url=${details.url}`,
        )
        this.emitStateChange(located.instance)
        void this.pushToolbarState(located.instance)
      }

      // And into the recording's own log, if this tab is being recorded (`recording-sidecar.ts`).
      this.tabRecorder.noteEvent(located.instance.id, located.tab.id, {
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
      this.tabRecorder.noteEvent(located.instance.id, located.tab.id, {
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

  private setupSessionPermissions(ses: ElectronSession): void {
    if (this.permissionsReady.has(ses)) return
    this.permissionsReady.add(ses)

    /**
     * Browser tabs here are driven by automation, so a permission prompt has no one to
     * answer it — a page that asks would simply stall. Every permission is therefore
     * granted outright, which is what lets automated flows use the camera, microphone,
     * geolocation, clipboard, notifications and the rest without a prompt in the way.
     *
     * Screen capture is the one exception on the *source* side: granting the permission
     * does not hand out the desktop. {@link setupDisplayMediaHandler} answers every
     * getDisplayMedia call with a tab — the asking page's own, never the screen.
     */
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(() => true)
    }

    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(true)
      })
    }
  }

  /**
   * Answer `getDisplayMedia` for this partition.
   *
   * Two kinds of caller land here, and neither gets the desktop:
   *
   * - Our own chrome (the record button) asks on behalf of a tab a person armed, so it
   *   gets that tab, and nothing at all when nothing is armed.
   * - A page asking to record gets **itself** — the tab it lives in, which is what a
   *   page-side recorder means by "the screen". The desktop is never on offer here, so a
   *   page can capture its own tab and nothing else.
   *
   * Passing the requesting frame as the video source is Electron's tab capture: it streams
   * that frame's own pixels, not a picked window.
   */
  private setupDisplayMediaHandler(ses: ElectronSession): void {
    if (this.displayMediaReady.has(ses)) return
    this.displayMediaReady.add(ses)
    if (typeof ses.setDisplayMediaRequestHandler !== 'function') return

    ses.setDisplayMediaRequestHandler((request, callback) => {
      if (this.isChromeFrame(request.frame)) {
        const source = this.tabRecorder.armedSource()
        callback(source ? { video: source } : {})
        return
      }
      callback(request.frame ? { video: request.frame } : {})
    })
  }

  /** Whether this frame is our own chrome document — the rail and the bar, which are one. */
  private isChromeFrame(frame: Electron.WebFrameMain | null): boolean {
    if (!frame || frame.detached) return false
    const top = frame.top
    for (const instance of this.instances.values()) {
      if (instance.chromeView.webContents.mainFrame === top) return true
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
   * the chrome. Called once per window — the chrome is shared by every tab, so
   * its listeners must not be installed again when a tab is added.
   */
  private setupWindowListeners(instance: BrowserInstance): void {
    const toolbarWc = instance.chromeView.webContents

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
      // The bar's maximize/restore button draws from `maximized`, and the window can be
      // maximized from outside the bar too (a double-click on the drag region, or the OS's
      // window menu) — so the state is re-sent here rather than only on the button's click.
      this.pushToolbarState(instance)
    }
    instance.window.on('restore', cameBack)
    instance.window.on('maximize', cameBack)
    instance.window.on('unmaximize', cameBack)

    /**
     * …and the tab goes to the parking window when the person minimizes the window.
     *
     * A minimized window is not a home, on either platform (`tabHome`), so this is what moves the tab
     * out; the coming back is `cameBack` above. On macOS a minimize emits `hide` as well, which lays out
     * already — this listener is for the platform where it does not — and laying out twice costs
     * nothing.
     *
     * The move itself cannot be seen — the parking window is off every display — so it is logged. This
     * line is the only evidence that it happened, and the only way to tell it apart from not doing it.
     */
    instance.window.on('minimize', () => {
      this.layoutAllViews(instance)
      const tab = activeTab(instance)
      if (tab) {
        mainLog.info(
          `[browser-pane] minimized id=${instance.id} tab=${tab.id} home=${this.tabHome(instance, tab)}`,
        )
      }
    })

    /**
     * Tell the chrome the pointer has left, on every way the window goes away or comes back.
     *
     * Chromium keeps the pointer where it last saw it and never delivers the `mouseleave` the
     * window going away would have caused, so the button under it keeps its `:hover` — minimising
     * from the bar's own minimise button shows that button hovered again on restore — and a tip
     * stays open. A synthetic DOM event from the renderer does not clear `:hover`; an input event
     * does, which is why it is sent from here.
     */
    const releaseChromePointer = () => {
      const chromeWc = instance.chromeView.webContents
      if (!chromeWc.isDestroyed()) chromeWc.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
    }
    instance.window.on('blur', releaseChromePointer)
    instance.window.on('minimize', releaseChromePointer)
    instance.window.on('hide', releaseChromePointer)
    instance.window.on('restore', releaseChromePointer)
    instance.window.on('show', releaseChromePointer)

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

    instance.window.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })

    instance.window.on('show', () => {
      instance.isVisible = true
      // It has now been on a display, which is the moment this window acquired a surface — and the
      // difference between it and one that has never been shown (`hasBeenShown`, `tabHome`).
      instance.hasBeenShown = true
      // The window can hand out a surface again, so the tab it is on comes back into it (`tabHome`) —
      // laid out before anything below reads the window's state, and before the person can see it.
      this.layoutAllViews(instance)
      this.emitStateChange(instance)
      this.pushToolbarState(instance)
      this.updateNativeOverlayState(instance)
      if (!activeTab(instance).themeColor) {
        void this.extractThemeColor(instance, activeTab(instance))
      }
    })

    instance.window.on('hide', () => {
      instance.isVisible = false
      // …and the tab goes back to the parking window, which is the one place a surface exists for it
      // while the window is away (`tabHome`).
      this.layoutAllViews(instance)
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
    // the browser is a light page whatever theme the app is wearing. This is only the value a view
    // *starts* with — every load re-sets it from the document being loaded, because the new-tab page
    // paints the app's surface and not the canvas (`tabBackdropFor`).
    tab.tabView.setBackgroundColor(PAGE_VIEW_BACKDROP)
    this.applyPageCornerRadius(tab)

    // A tab is **born at the window's current page area** — a viewport has to exist from the first
    // frame — and where its view goes depends on whether that window is the one holding it
    // (`tabHome`): the tab that is both the window's and showable goes in the window itself, above the
    // overlay that is already there (everything the overlay draws is *around* the page, so below is
    // where the page belongs; from here on `updateNativeOverlayState` decides which of the two is on
    // top, because that is also what "this tab is locked" means). Everything else — a tab opened
    // behind the person's (`activate: false`, how an agent's tab is opened), and any tab whose window
    // is not on screen — is **created in the parking window** and stays there at this size until it
    // comes forward.
    //
    // A minimized window reports no size of its own on Windows, and minimizing does not change a
    // window's size — only where it is — so the tab is born at the size the window would hand out if
    // it were not minimized (`windowContentSize` keeps the last size it reported).
    const bornAt = this.pageAreaBounds(instance)
    if (this.tabHome(instance, tab) === 'window') {
      tab.tabView.setBounds(bornAt)
      instance.window.contentView.addChildView(tab.tabView)
    } else {
      this.parkTab(instance, tab, bornAt)
    }
    // The layers go back in order around the new tab — the page over the chrome, and under the
    // overlay while this tab is the one a conversation is holding.
    this.restackViews(instance)

    tabWc.on('did-start-loading', () => {
      // A document is arriving, whoever asked for it.
      tab.documentLoading = true
      // Loading our own error page is not a new attempt at the address: the failure it
      // reports is still true, and the tab must not flash a spinner over it.
      if (tab.internalPage === 'error') {
        tab.canGoBack = tabWc.canGoBack()
        tab.canGoForward = tabWc.canGoForward()
        this.emitStateChange(instance)
        void this.pushToolbarState(instance)
        return
      }
      tab.isLoading = true
      // A load that starts is the end of the previous failure: whatever the new attempt
      // does, it will report for itself.
      tab.loadError = null
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    /**
     * A real navigation away from our error page — the failure is over.
     *
     * The tab then describes the new document again; the error page's title and icon
     * must not follow it. The `data:` document itself is the error page.
     */
    tabWc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return
      const next = String(url ?? '')
      if (!next) return
      // Our new-tab page is a stand-in for `about:newtab`, not an address.
      if (this.isBrowserEmptyStateUrl(next)) return
      // A real navigation away from the new-tab page: it is a document now.
      if (tab.internalPage === 'newtab') tab.internalPage = undefined
      if (tab.internalPage === 'error') {
        if (next.startsWith('data:')) return
        tab.internalPage = undefined
        tab.loadError = null
        tab.title = ''
        tab.favicon = null
      }
      if (next === tab.currentUrl) {
        this.emitStateChange(instance)
        void this.pushToolbarState(instance)
        return
      }
      // The icon belongs to the *site*, not to one of its documents: a same-origin move
      // usually keeps it, so it stays until the new page advertises one (or never
      // does). A different site must not keep the old site's icon.
      const sameSite = sameOrigin(tab.currentUrl, next)
      // The tab now describes where the person asked to go, even if the navigation
      // never commits. `documentUrl` reports the committed document when it differs.
      tab.currentUrl = next
      tab.title = ''
      if (!sameSite) tab.favicon = null
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    /**
     * The page's own refusal to load — a name that does not resolve, a connection
     * refused, a timeout. Chromium answers those with a blank error document and an
     * event; without this the tab would keep the URL and title it asked for and look
     * like it was working. `-3` is `ERR_ABORTED`, which is what a newer navigation
     * hands to the load it replaced — not a failure of the page that stayed.
     */
    tabWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      // Our own error page failing to load says nothing new about the failed address; the
      // new-tab page failing is its own fallback's business, not a page failure.
      if (tab.internalPage === 'error' || tab.internalPage === 'newtab') return
      tab.loadError = {
        code: errorDescription || `ERR_${errorCode}`,
        url: validatedURL || tab.currentUrl,
      }
      mainLog.info(
        `[browser-pane] page load failed id=${instance.id} tab=${tab.id} code=${tab.loadError.code} url=${tab.loadError.url}`,
      )
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
    })

    tabWc.on('did-stop-loading', () => {
      tab.isLoading = false
      tab.documentLoading = false
      // A stopped navigation leaves the previous document on screen — that is what Stop
      // means. The tab must name what is actually there again rather than the address
      // that was cancelled. A failure keeps its address (the error page is its news).
      if (tab.internalPage !== 'error' && !tab.loadError) {
        try {
          // Normalized, because `currentUrl` is the tab's *address*: our empty-state
          // document is a `file:` / dev-server document standing in for `about:newtab`,
          // and writing its real URL here is what made a new tab show that path.
          const normalized = this.normalizeTabState(tabWc.getURL(), tabWc.getTitle())
          if (
            normalized.url
            && !normalized.url.startsWith('about:blank')
            && normalized.url !== tab.currentUrl
          ) {
            tab.currentUrl = normalized.url
            tab.title = normalized.title
          }
        } catch {
          /* the view went away */
        }
      }
      tab.canGoBack = tabWc.canGoBack()
      tab.canGoForward = tabWc.canGoForward()
      // Drain in-flight count — all pending requests are settled once loading stops
      this.inFlightRequestsByWebContentsId.set(tabWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(tabWc.id, Date.now())
      this.emitStateChange(instance)
      void this.pushToolbarState(instance)
      // Our own error page must not repaint the window with its own (neutral) surface.
      if (tab.internalPage !== 'error') void this.extractThemeColor(instance, tab)
      this.updateNativeOverlayState(instance)
    })

    tabWc.on('dom-ready', () => {
      // The error page is ours: it has no site theme to observe.
      if (tab.internalPage === 'error') return
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
      // Our error page is standing in for the failed document: it must not become the
      // tab's address or replace the title/icon that describe the failure.
      if (tab.internalPage === 'error') {
        tab.canGoBack = tabWc.canGoBack()
        tab.canGoForward = tabWc.canGoForward()
        this.emitStateChange(instance)
        void this.pushToolbarState(instance)
        return
      }
      const url = typeof tabWc.getURL === 'function' ? tabWc.getURL() : (urlFromEvent || tab.currentUrl)
      // Our own new-tab document — or the `about:blank` fallback it degrades to — is the
      // new-tab page. Anything else is a real document.
      const isNewTabDocument =
        this.isBrowserEmptyStateUrl(url) || (url === 'about:blank' && tab.internalPage === 'newtab')
      tab.internalPage = isNewTabDocument ? 'newtab' : undefined
      const previousUrl = tab.currentUrl
      this.clearInPageThemeTimer(tab)
      tab.themeObserverToken = null
      tab.themeColor = null // reset for new page (batched with state push below)
      // The icon belongs to the document that is being replaced. A navigation to a
      // different address cleared it when it started; a **reload** keeps it, because
      // Chromium does not re-advertise an unchanged icon. A redirect inside the same
      // origin keeps it too — the site's icon is the same — while a cross-origin
      // redirect clears it.
      if (url !== previousUrl && !sameOrigin(previousUrl, url)) tab.favicon = null
      const normalized = this.normalizeTabState(url, tabWc.getTitle())
      // The `about:blank` fallback used when the empty-state document cannot load is
      // still the new-tab page, and it keeps the new-tab address too.
      tab.currentUrl = tab.internalPage === 'newtab' ? 'about:newtab' : normalized.url
      tab.title = tab.internalPage === 'newtab' ? 'New Tab' : normalized.title
      // The document that arrived decides what backs it: a page by the browser's canvas, the new-tab
      // page by the app's surface (`tabBackdropFor`).
      tab.tabView.setBackgroundColor(this.tabBackdropFor(tab))
      mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${tab.currentUrl}`)
      this.tabRecorder.noteEvent(instance.id, tab.id, { type: 'navigate', url: tab.currentUrl })
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
      // The new-tab page (or a real `about:blank`) has just arrived on the tab on screen,
      // and the commit handed the *page* the keyboard as it did — so the caret goes back
      // where the shown tab says it belongs, the address bar (`focusShownTab`). Read from
      // the tab, not from the document that committed: the address is what says this is
      // the new-tab page, and it is what survives the empty-state document failing to load.
      if (tab.id === tabOnScreen.id && this.wantsAddressBarFocus(tab)) {
        this.focusAddressBar(instance)
        return
      }
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
      this.tabRecorder.noteEvent(instance.id, tab.id, { type: 'navigate', url: tab.currentUrl, inPage: true })

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
      // A `data:` document announces its own URL as the title before its `<title>` is
      // parsed. A tab standing on a failed address is named by that address instead —
      // a real URL, not the stand-in page's own; the new-tab page keeps its name.
      const normalized = this.normalizeTabState(
        tabWc.getURL(),
        tab.internalPage === 'error'
          ? tab.currentUrl
          : tab.internalPage === 'newtab'
            ? 'New Tab'
            : title,
      )
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
        if (reported) this.tabRecorder.noteEvent(instance.id, tab.id, reported)
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
      // Where a page-requested tab lands is decided by **who produced the input**, and that is
      // known rather than inferred. A held tab takes no input from a person — taking it back is
      // what drops the hold — so while the agent works there, anything that opens a tab from it
      // is the agent's and lands behind. `commandInput` covers the one moment the hold cannot: a
      // turn's first command can run before its overlay arrives.
      //
      // Everywhere else the person is the only possible source, so the browser's own answer
      // stands: a `target="_blank"` click comes forward, a `background-tab` request does not.
      // This is what covers `window.open` too, which reads no modifier keys at all.
      const agentDriving = tab.heldBy !== null || tab.commandInput
      const openedTabId = this.createTab(instance.id, {
        url: details.url,
        activate: !agentDriving && details.disposition !== 'background-tab',
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
    // What the webContents actually has, when it is not the address the tab describes:
    // a failed navigation leaves the previous document in place. Our own documents (the
    // error page, the new-tab page) are stand-ins and are never reported as a document;
    // `error` says why an error page is there.
    const live = tab.tabView.webContents.isDestroyed() ? '' : tab.tabView.webContents.getURL()
    const documentUrl = tab.internalPage || !live || live === location.url || live.startsWith('about:blank')
      ? ''
      : live
    return {
      id: tabId,
      // The window's profile: one window is one profile, so every tab in it answers the same.
      profileId: instance.profileId,
      ...location,
      ...(documentUrl ? { documentUrl } : {}),
      favicon: tab.favicon,
      isLoading: tab.isLoading,
      // Only while it is true: an ordinary summary stays the shape it was.
      ...(tab.documentLoading ? { documentLoading: true } : {}),
      // Absent rather than null when the page is fine: the wire shape stays what it was,
      // and a reader that never heard of this field needs nothing new.
      ...(tab.loadError ? { error: tab.loadError } : {}),
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
      ...(activeTab(instance).loadError ? { error: activeTab(instance).loadError } : {}),
      canGoBack: activeTab(instance).canGoBack,
      canGoForward: activeTab(instance).canGoForward,
      tabs: instance.tabs.map((tab) => this.toTabSummary(instance, tab)),
      isVisible: instance.isVisible,
      // Any conversation working in this window at all — the window-level indicator. Which
      // tab each one holds is the tab's own answer (`lockedBy`, per tab).
      agentControlActive: instance.controlBy.size > 0,
      themeColor: activeTab(instance).themeColor,
      workspaceId: instance.workspaceId,
      profileId: instance.profileId,
    }
  }

  private emitStateChange(instance: BrowserInstance): void {
    if (!this.instances.has(instance.id)) {
      return
    }
    this.stateChangeCallback?.(this.toInfo(instance))
  }
}
