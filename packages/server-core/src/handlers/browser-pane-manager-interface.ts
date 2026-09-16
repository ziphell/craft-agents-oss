/**
 * IBrowserPaneManager — interface for browser pane operations used by SessionManager.
 *
 * Covers all 40 methods SessionManager calls on BrowserPaneManager.
 * The concrete BrowserPaneManager in apps/electron implements this.
 *
 * Structurally compatible with BrowserOwnershipReleaser (domain layer)
 * so releaseBrowserOwnershipOnForcedStop() accepts IBrowserPaneManager.
 */

import type { BrowserInstanceInfo, PickedElement } from '@craft-agent/shared/protocol'
import type { MockRoute } from '@craft-agent/shared/prototypes'

// ---------------------------------------------------------------------------
// Supporting types — minimal subsets of BPM's internal types
// ---------------------------------------------------------------------------

/** Subset of BrowserInstance fields accessed by SessionManager */
export interface BrowserInstanceSnapshot {
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  title: string
  currentUrl: string
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

/** How a capture is sampled. Every field has a default, so a caller can pass none. */
export interface FrameCaptureOptions {
  /** How often the screen is compared, ms. */
  intervalMs?: number
  /** Share of the sampled screen that must differ to keep a frame (0.005 = 0.5%). */
  threshold?: number
  /** Ceiling on frames per capture — a session that is left running must not fill a disk. */
  maxFrames?: number
}

export interface FrameCaptureStarted {
  /** ISO timestamp the capture began. */
  startedAt: string
  /** What the capture is actually using, defaults resolved — reported so the caller can say it. */
  intervalMs: number
  threshold: number
  maxFrames: number
}

/**
 * One frame, as it crosses the boundary: the bytes and the coordinates.
 *
 * Bytes rather than a path, because the browser pane has no business knowing
 * where a prototype keeps its research (`shared/prototypes/frames.ts` decides
 * that). The same reasoning as a screenshot's `imageBuffer`.
 */
export interface CapturedFrame {
  index: number
  at: string
  url: string
  reason: 'start' | 'changed' | 'action' | 'result'
  /** What was done, for a frame an action caused. */
  action?: string
  bytes: Uint8Array
}

export interface FrameCaptureResult {
  startedAt: string
  endedAt: string
  intervalMs: number
  threshold: number
  maxFrames: number
  /** Size of the captured image in device pixels, from the first frame. */
  viewport: { width: number; height: number } | null
  /** True when the ceiling was reached: what came back is a sample. */
  truncated: boolean
  frames: CapturedFrame[]
}

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

  /** Create a browser instance for a session (optionally shown) */
  createForSession(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): string

  /**
   * Async equivalent of {@link createForSession}. Required for the remote bridge.
   */
  createForSessionAsync(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): Promise<string>

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

  /** Bind a browser instance to a session */
  bindSession(id: string, sessionId: string, options?: { workspaceId?: string | null }): void

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

  // -- Navigation ----------------------------------------------------------

  navigate(id: string, url: string): Promise<{ url: string; title: string }>
  goBack(id: string): Promise<void>
  goForward(id: string): Promise<void>
  /**
   * Reload the page in an instance.
   *
   * Fire-and-forget, like the toolbar's own reload: nothing waits for a document
   * to finish loading, and a caller that needs to act on the reloaded document
   * reads it afterwards (which is what the auto-replay after a file change does —
   * plan §21.4).
   */
  reload(id: string): void

  // -- Interaction ---------------------------------------------------------

  getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot>
  clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void>
  clickAtCoordinates(id: string, x: number, y: number): Promise<void>
  drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void>
  fillElement(id: string, ref: string, value: string): Promise<void>
  typeText(id: string, text: string): Promise<void>
  selectOption(id: string, ref: string, value: string): Promise<void>
  setClipboard(id: string, text: string): Promise<void>
  getClipboard(id: string): Promise<string>
  scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>
  sendKey(id: string, args: BrowserKeyArgs): Promise<void>
  uploadFile(id: string, ref: string, filePaths: string[]): Promise<unknown>
  evaluate(id: string, expression: string): Promise<unknown>

  /**
   * Prompt the user to click an element on the page. Resolves with the picked
   * element's stable selector + geometry, or `null` on cancel/timeout.
   */
  pickElement(id: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<PickedElement | null>

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
  addInitScript(id: string, key: string, source: string): Promise<string>

  /**
   * Remove every init script whose key starts with `keyPrefix`.
   * @returns the keys that were removed
   */
  clearInitScripts(id: string, keyPrefix: string): Promise<string[]>

  // -- Frame capture --------------------------------------------------------

  /**
   * Start keeping frames of this window.
   *
   * Two things put a frame in the capture, because a screen changes for two
   * different reasons: the screen is compared every `intervalMs` and kept when
   * more than `threshold` of it differs (a stream answering, a list loading, an
   * animation), and every action the agent takes is kept whatever the screen did
   * (a click is a cause, and the reason a frame is here is worth more than the
   * pixels). The second is what lets a reader tell "somebody did this" from "it
   * moved on its own".
   *
   * Frames stay in memory until {@link stopFrameCapture} — a capture is one
   * session, and writing half of it would be a record of nothing.
   */
  startFrameCapture(id: string, options?: FrameCaptureOptions): Promise<FrameCaptureStarted>

  /** Stop the capture and hand back what it kept, or null when none was running. */
  stopFrameCapture(id: string): Promise<FrameCaptureResult | null>

  // -- Video frames ---------------------------------------------------------

  /**
   * Ask the user for a video file; null when the dialog was dismissed.
   *
   * Here rather than in the panel because the panel never sees a path — Electron's
   * dialog is the only party that knows where the user's file actually is, and a
   * path that travels through a renderer is a string from anywhere.
   */
  pickVideoFile(): Promise<string | null>

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
   * Serve `routes` for matching requests at the browser's network layer
   * (CDP Fetch interception), so `fetch`, XHR and every other resource type are
   * covered without patching page globals.
   *
   * @returns the number of routes now being served
   */
  setFetchMock(id: string, routes: MockRoute[]): Promise<number>

  /** Stop intercepting; requests fall through to the real network again. */
  clearFetchMock(id: string): Promise<void>

  // -- Screenshot ----------------------------------------------------------

  screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>
  screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult>

  // -- Monitoring ----------------------------------------------------------

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[]
  windowResize(id: string, width: number, height: number): { width: number; height: number }
  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[]
  waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult>
  getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]>
  detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }>
}
