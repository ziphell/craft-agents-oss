/**
 * IBrowserPaneManager — interface for browser pane operations used by SessionManager.
 *
 * Covers all 46 methods SessionManager calls on BrowserPaneManager.
 * The concrete BrowserPaneManager in apps/electron implements this.
 *
 * Structurally compatible with BrowserLeaseReleaser (domain layer)
 * so releaseBrowserOnForcedStop() accepts IBrowserPaneManager.
 */

import type { BrowserInstanceInfo, BrowserTabPrototype, BrowserTabSummary, PickedElement, TabBelongsTo } from '@craft-agent/shared/protocol'
import type { MockProgram } from '@craft-agent/shared/prototypes'

// ---------------------------------------------------------------------------
// Supporting types — minimal subsets of BPM's internal types
// ---------------------------------------------------------------------------

/** Subset of BrowserInstance fields accessed by SessionManager */
export interface BrowserInstanceSnapshot {
  isVisible: boolean
  title: string
  currentUrl: string
}

/**
 * One tab of a window: what it is (observation), what its opener said about it
 * (declaration), and where it sits in a prototype. Defined with the rest of the
 * wire shapes so the toolbar, the panel and the agent all read the same one.
 */
export type { BrowserTabSummary, BrowserTabPrototype }

export interface BrowserTabCreateOptions {
  /** Where the tab starts. Omitted → `about:blank`, for a caller that navigates. */
  url?: string
  /** Whether the new tab comes to the front. Default true. */
  activate?: boolean
  /** The prototype this tab is for, when it is one. */
  prototype?: BrowserTabPrototype | null
  /**
   * The work this tab is opened *for*, when a conversation opened it — omitted means a
   * person did.
   *
   * The default has to be the one that is never wrong to assume: the whole point of the
   * field is knowing which tabs are not ours to close, and calling somebody else's tab
   * ours is the mistake that loses work.
   *
   * The **work**, not the session (plan §22): a tab outlives the session that opened it, so
   * a DAG node's tab says which task and node it is for, and the node's re-run inherits it
   * instead of orphaning it. `belongsTo.sessionId` is who opened it — the conversation whose
   * cursor and lease the new tab also starts with.
   */
  belongsTo?: TabBelongsTo | null
  /**
   * Where it goes in the strip: right after this tab instead of at the end.
   *
   * Used by the browser's own window-open channel, where the tab that asked for it is
   * the one it belongs beside (plan §22).
   */
  afterTabId?: string
  /** How the browser asked for it, when it was the browser — see `BrowserTabSummary.disposition`. */
  disposition?: 'link' | 'popup' | null
  /**
   * The caller wants *a* tab to use rather than one more tab.
   *
   * A window that has never been used already holds the blank tab such a caller is
   * asking for, so its own tab is the answer (plan §22). Only the caller can say
   * which of the two it means: "New page" from the app opens the window if it is not
   * up, while the rail's `+` is a person asking for one *more* tab in a window they
   * are looking at.
   */
  reuseUntouchedWindow?: boolean
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
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

export interface BrowserConsoleOptions {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
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
  kind: string
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: string
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface AccessibilityNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  focused?: boolean
  checked?: boolean
  disabled?: boolean
}

export interface AccessibilitySnapshot {
  url: string
  title: string
  nodes: AccessibilityNode[]
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** How a video is sampled (plan §20.5). */
export interface VideoFrameOptions {
  /** `timeline` samples on an interval; `changes` keeps only what moved. */
  mode: 'timeline' | 'changes'
  /** Sampling interval, ms. */
  everyMs: number
  /** Ceiling on frames — a long recording must not become a thousand pictures. */
  maxFrames: number
}

export interface ExtractedVideoFrame {
  /** Position in the recording, ms — the coordinate that makes a sampled frame citable. */
  offsetMs: number
  bytes: Uint8Array
}

export interface VideoFrameExtractionResult {
  durationMs: number
  /** The video's size in device pixels, when the decoder reported one. */
  viewport: { width: number; height: number } | null
  /** True when the ceiling was reached: what came back is a sample of the recording. */
  truncated: boolean
  frames: ExtractedVideoFrame[]
}

export interface IBrowserPaneManager {
  // -- Session lifecycle ---------------------------------------------------

  /** Register a callback that resolves session IDs to file paths */
  setSessionPathResolver(fn: (sessionId: string) => string | null): void

  /** Destroy all browser instances bound to a session */
  destroyForSession(sessionId: string): void

  /** Clear agent control overlay and native overlay state for a session */
  clearVisualsForSession(sessionId: string): Promise<void>

  /** Unbind all browser instances from a session (non-destructive) */
  unbindAllForSession(sessionId: string): void

  /** Get or create a browser instance for a session, returning the instance ID */
  getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): string

  /**
   * Async equivalent of {@link getOrCreateForSession}. Required for the remote
   * bridge — the WS round-trip can't fit into a sync return.
   */
  getOrCreateForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string>

  /** Activate or update the agent control overlay for a session */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void

  // -- Instance management -------------------------------------------------

  /**
   * The window a session works in — its **workspace's browser window** (plan §22).
   *
   * One window per workspace, used by every conversation in it and by the user,
   * whatever the work is, so this is no longer "make my window": the caller becomes
   * the window's *driver* for now (a lease, renewed by every call) and gets back the
   * same id whichever session asked.
   *
   * `sessionId` may be null when nothing is driving it yet — opening a browser by
   * hand is the same window with nobody at the wheel.
   */
  createForSession(sessionId: string | null, options?: { show?: boolean; workspaceId?: string | null }): string

  /**
   * Async equivalent of {@link createForSession}. Required for the remote bridge.
   */
  createForSessionAsync(sessionId: string | null, options?: { show?: boolean; workspaceId?: string | null }): Promise<string>

  /** Get instance info by ID (sync; local-only). For remote-aware code use {@link getInstanceAsync}. */
  getInstance(id: string): BrowserInstanceSnapshot | undefined

  /**
   * Async equivalent of {@link getInstance} — required for the remote bridge,
   * which can't synchronously return real data without a WS round-trip.
   */
  getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined>

  /** List all browser instances with their public info (sync; local-only). For remote-aware code use {@link listInstancesAsync}. */
  listInstances(): BrowserInstanceInfo[]

  /**
   * Async equivalent of {@link listInstances} — required for the remote bridge,
   * which can't synchronously return real data without a WS round-trip.
   */
  listInstancesAsync(): Promise<BrowserInstanceInfo[]>

  /** Focus the bound browser instance for a session, creating if needed */
  focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): string

  /** Async equivalent of {@link focusBoundForSession}. */
  focusBoundForSessionAsync(sessionId: string, options?: { workspaceId?: string | null }): Promise<string>

  /** Focus a browser instance window */
  focus(id: string): void

  /** Destroy a browser instance */
  destroyInstance(id: string): void

  /** Hide a browser instance window */
  hide(id: string): void

  /** Clear agent control overlay for all instances in a session */
  clearAgentControl(sessionId: string): void

  /** Clear agent control overlay for a specific instance */
  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string }

  // -- Tabs ----------------------------------------------------------------

  /**
   * Add a tab to a window, and return its id.
   *
   * A window is a container and a tab is the thing in it (plan §22): several
   * prototypes are worked on at once by being several tabs of one window, rather
   * than by being several windows. `prototype` is a tab's identity — the only
   * place it can be recorded for an overlay, whose document is a third-party
   * address, and the reason the address bar keeps naming the prototype after the
   * view has navigated away from it.
   *
   * A window that holds only its own untouched tab — what a freshly created
   * window is made of — has nothing to preserve, so the tab is created *there*
   * instead of beside it: opening something into a new window is one tab, not one
   * tab and a blank one.
   */
  createTab(instanceId: string, options?: BrowserTabCreateOptions): string

  /**
   * Async equivalent of {@link createTab} — required for the remote bridge, whose
   * caller needs the real tab id rather than a sentinel.
   */
  createTabAsync(instanceId: string, options?: BrowserTabCreateOptions): Promise<string>

  /**
   * Put one tab of a window on screen.
   *
   * Everything a window reports — address, title, prototype, console, what its
   * toolbar actions would act on — is read through the tab that is on screen, so
   * this is what "show that tab" means. An unknown tab id throws: the tab was
   * named, so a silent no-op would leave the person looking somewhere else.
   *
   * This is the person's verb (and the agent's explicit `tab-activate`). A command
   * does not go through here: it records where it works from with
   * {@link setSessionTab} and leaves the display alone.
   */
  activateTab(instanceId: string, tabId: string): void

  /**
   * Record that a conversation works **from** this tab, without moving the window.
   *
   * The tab is the one that conversation's next unnamed command lands on, and the one it
   * holds while it works. Written rather than
   * inferred because the tab on screen is the person's, and a command acting on it
   * because they happened to be looking at it is exactly the bug the cursor exists to
   * prevent (plan §22, 第十轮/第十二轮).
   */
  setSessionTab(instanceId: string, tabId: string, sessionId: string): void

  /** Close one tab of a window. Closing a window's last tab closes the window. */
  closeTab(instanceId: string, tabId: string): void

  /**
   * Hand one tab to another conversation: it becomes **that conversation's work**, and the tab
   * it works from (plan §22, Conductor). Only a tab that is the caller's own work or nobody's
   * can be handed on; whether the receiver is a session worth handing to is the session layer's
   * call, which is also where the receiver's work is resolved (`to` carries it).
   */
  assignTab(instanceId: string, tabId: string, to: TabBelongsTo, by: TabBelongsTo): void

  /** A window's tabs, in the order they were opened, with the active one marked. */
  listTabs(instanceId: string): BrowserTabSummary[]

  /** Async equivalent of {@link listTabs} — required for the remote bridge. */
  listTabsAsync(instanceId: string): Promise<BrowserTabSummary[]>

  // -- Navigation ----------------------------------------------------------
  //
  // Every method below that acts on a tab takes a trailing `tabId` — **the tab it acts
  // on** — and every one of them means the tab on screen when it is left out.
  //
  // Named rather than looked up, because the two are no longer the same thing: a window
  // holds several tabs and the person is free to read one while a conversation works on
  // another (plan §22, 第十轮/第十二轮). The caller resolves it once, with
  // `pickCommandTarget` — the conversation's own tab, and only the tab on screen when it
  // has none — and passes it, so there is one decision and one place it is made. The
  // person's own calls (the toolbar) name nothing and get the tab they are looking at.

  navigate(id: string, url: string, tabId?: string): Promise<{ url: string; title: string }>
  goBack(id: string, tabId?: string): Promise<void>
  goForward(id: string, tabId?: string): Promise<void>
  /**
   * Reload the page in an instance.
   *
   * Fire-and-forget, like the toolbar's own reload: nothing waits for a document
   * to finish loading, and a caller that needs to act on the reloaded document
   * reads it afterwards (which is what the auto-replay after a file change does —
   * plan §21.4).
   */
  reload(id: string, tabId?: string): void

  // -- Interaction ---------------------------------------------------------

  getAccessibilitySnapshot(id: string, tabId?: string): Promise<AccessibilitySnapshot>
  clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }, tabId?: string): Promise<void>
  clickAtCoordinates(id: string, x: number, y: number, tabId?: string): Promise<void>
  drag(id: string, x1: number, y1: number, x2: number, y2: number, tabId?: string): Promise<void>
  fillElement(id: string, ref: string, value: string, tabId?: string): Promise<void>
  typeText(id: string, text: string, tabId?: string): Promise<void>
  selectOption(id: string, ref: string, value: string, tabId?: string): Promise<void>
  setClipboard(id: string, text: string, tabId?: string): Promise<void>
  getClipboard(id: string, tabId?: string): Promise<string>
  scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number, tabId?: string): Promise<void>
  sendKey(id: string, args: BrowserKeyArgs, tabId?: string): Promise<void>
  uploadFile(id: string, ref: string, filePaths: string[], tabId?: string): Promise<unknown>
  evaluate(id: string, expression: string, tabId?: string): Promise<unknown>

  /**
   * Prompt the user to click an element on the page. Resolves with the picked
   * element's stable selector + geometry, or `null` on cancel/timeout.
   */
  pickElement(id: string, options?: { timeoutMs?: number; pollMs?: number }, tabId?: string): Promise<PickedElement | null>

  // -- Persistent injection -------------------------------------------------

  /**
   * Register `source` to run in every new document of this instance, before the
   * page's own scripts. This is what makes prototype patches survive a reload.
   *
   * `key` is caller-chosen; re-registering the same key replaces the previous
   * script so re-applying an edited patch is idempotent.
   *
   * @returns the underlying CDP identifier
   */
  addInitScript(id: string, key: string, source: string, tabId?: string): Promise<string>

  /**
   * Remove every init script whose key starts with `keyPrefix`.
   * @returns the keys that were removed
   */
  clearInitScripts(id: string, keyPrefix: string, tabId?: string): Promise<string[]>

  // -- Video frames ---------------------------------------------------------

  /**
   * Sample frames out of a video the user recorded elsewhere (plan §20.5).
   *
   * Decoding is Chromium's, so nothing here depends on ffmpeg being installed —
   * and a codec Chromium does not implement (HEVC, ProRes, some `.mov`) fails with
   * a message that says so rather than producing a truncated capture.
   *
   * The bytes come back with their offsets; where they are written is the
   * caller's business, which is the same shape as `capturePage`.
   */
  extractVideoFrames(filePath: string, options: VideoFrameOptions): Promise<VideoFrameExtractionResult>

  // -- Network-level mock ---------------------------------------------------

  /**
   * Serve the contract's mock for matching requests at the browser's network
   * layer (CDP Fetch interception), so `fetch`, XHR and every other resource type
   * are covered without patching page globals.
   *
   * The program carries the store as well as the routes: a prototype whose
   * contract declares a collection answers from it, and each apply starts that
   * state over.
   *
   * @returns the number of routes now being served
   */
  setFetchMock(id: string, program: MockProgram, tabId?: string): Promise<number>

  /** Stop intercepting; requests fall through to the real network again. */
  clearFetchMock(id: string, tabId?: string): Promise<void>

  // -- Screenshot ----------------------------------------------------------

  screenshot(id: string, options?: BrowserScreenshotOptions, tabId?: string): Promise<BrowserScreenshotResult>
  screenshotRegion(id: string, target: BrowserScreenshotRegionTarget, tabId?: string): Promise<BrowserScreenshotResult>

  // -- Monitoring ----------------------------------------------------------

  getConsoleLogs(id: string, options?: BrowserConsoleOptions, tabId?: string): BrowserConsoleEntry[]
  windowResize(id: string, width: number, height: number): { width: number; height: number }
  getNetworkLogs(id: string, options?: BrowserNetworkOptions, tabId?: string): BrowserNetworkEntry[]
  waitFor(id: string, args: BrowserWaitArgs, tabId?: string): Promise<BrowserWaitResult>
  getDownloads(id: string, options?: BrowserDownloadOptions, tabId?: string): Promise<BrowserDownloadEntry[]>
  detectSecurityChallenge(id: string, tabId?: string): Promise<{ detected: boolean; provider: string; signals: string[] }>
}
