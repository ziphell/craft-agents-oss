/**
 * The browser pane's capability surface.
 *
 * `BrowserPaneFns` is what the main process implements and what every command on every door calls
 * (`browser_tool` for the window itself, `video_tool` for frames out of a recording). Keeping it in
 * its own module is what lets those tools be separate files without any of them owning the
 * interface the others depend on.
 */

import type { BrowserTabSummary, PickedElement } from '../protocol/dto.ts';
import type { DrawioPage } from '../drawio/types.ts';

// ============================================================================
// Browser Pane Function Interface
// ============================================================================

/**
 * Abstraction over BrowserPaneManager for use in session-scoped tools.
 * The Electron session manager creates this by binding to a specific session's
 * browser instance via getOrCreateForSession(sessionId).
 */
export interface BrowserScreenshotArgs {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
}

export interface BrowserConsoleArgs {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserScreenshotRegionArgs {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  /**
   * Take the image even when it is incomplete (part of the region was not on screen). Without it, a
   * region bigger than the page has painted is an error — an image missing part of what was asked
   * for is a wrong answer, and nothing in the picture says so.
   */
  force?: boolean
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserViewportResizeArgs {
  width: number
  height: number
}

export interface BrowserNetworkArgs {
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

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadsArgs {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserLifecycleActionResult {
  /**
   * What happened. `pages-closed` is the workspace's-window case: a conversation may
   * not close that window, but it may close the tabs it opened in it.
   */
  action: 'closed' | 'pages-closed' | 'hidden' | 'released' | 'noop'
  requestedInstanceId?: string
  resolvedInstanceId?: string
  affectedIds: string[]
  reason?: string
}

/** One tab of this session's window, as `tabs` reports it. */
export type BrowserTabInfo = BrowserTabSummary

export interface BrowserTabOpenOptions {
  /** Where the tab starts. Omitted → blank, for a caller that navigates itself. */
  url?: string
  /** Whether the tab comes to the front. Default true. */
  activate?: boolean
}

/** One sampled frame: where it is in the recording, its pixels, and the file when it was written. */
export interface SampledVideoFrame {
  /** Position in the recording, ms. */
  offsetMs: number
  /** The frame as JPEG bytes. */
  bytes: Uint8Array
  /** The file it was written to, or null when nothing was written. */
  path: string | null
}

/** A rendered drawio document: the bytes, and what they are. */
export interface RenderedDrawioFile {
  bytes: Uint8Array
  mimeType: string
  /** The suffix the format is written under, `.svg` and friends. */
  extension: string
}

/**
 * What a drawio document can be turned into — **in drawio's own names**, which they keep here on
 * purpose: `xmlsvg` is drawio's *editable* SVG (the drawing with its document inside it), and `xml`
 * is the document itself, written out with its pages uncompressed.
 *
 * The command line an agent speaks is a different vocabulary on purpose — the formats it names are
 * `svg`, `png`, `html` and `drawio`, and the first of those takes `--editable` for what drawio calls
 * an `xmlsvg`. `drawio-commands.ts` is the one place the two are translated (see `drawio-tools.md`).
 */
export type DrawioFormat = 'svg' | 'xmlsvg' | 'png' | 'html' | 'xml'

/**
 * The color scheme a drawing is made for — drawio's own export parameter, and the one thing
 * `drawio_tool` lets a caller say about it (`--theme`).
 *
 * `auto` is the honest default: the drawing keeps both of its colors (`light-dark(...)`) and states
 * `color-scheme: light dark`, so it follows whoever shows it. `light` and `dark` pin it — drawio
 * writes that one scheme on the SVG's root, and every consumer that honours the declaration draws
 * it that way.
 *
 * **A picture has no reader to follow**, so on a PNG `auto` and `light` come out as the same
 * drawing: a raster is drawn *for* a scheme, and this is the scheme named. Only the SVG formats
 * state one in the file, and the two the export cannot state it for (`html`, and the `.drawio`
 * document itself) are refused by the command line rather than quietly given nothing.
 */
export type DrawioTheme = 'auto' | 'light' | 'dark'

/**
 * The suffix a format is written under — one table, because three things name these files: the
 * bytes come back with their metadata, a `--to` path that names no suffix gets one from here, and
 * the reply says what was written.
 *
 * `xml` is `.drawio` rather than `.xml`: the app opens a diagram by that suffix and by nothing else,
 * so the same document under a `.xml` name is only an XML file to it.
 */
export const DRAWIO_EXTENSIONS: Record<DrawioFormat, string> = {
  svg: '.svg',
  xmlsvg: '.svg',
  png: '.png',
  html: '.html',
  xml: '.drawio',
}

/** A recording in flight, as `record-start` and `record-stop` report it. */
export interface BrowserRecordingRef {
  tabId: string
  /** Absolute path the file is being written to. */
  file: string
  startedAt: number
  bytes: number
}

/** A finished recording: where it is, how long it ran, and why it ended. */
export interface BrowserFinishedRecording {
  tabId: string
  file: string
  bytes: number
  seconds: number
  /** Words, because this is reported to whoever asked: `asked`, `deadline`, `the tab went away`… */
  reason: string
}

export interface BrowserStartRecordingArgs {
  /** The tab to record. Named, never guessed — a stop has to be able to match it. */
  tabId: string
  /**
   * The directory the file goes in.
   *
   * Passed in rather than derived here: the pane knows about windows and tabs, not about where a
   * conversation keeps its files. The door that knows the convention computes it
   * (`browser-commands.ts` → the session's `records/`), so the convention has one home.
   */
  dir: string
  /** How long, in ms. Required: it is the only thing that bounds a recording. */
  ttlMs: number
  /**
   * Wait for it to end, and answer with what it left on disk.
   *
   * The two forms a recording has, in one call rather than two: without this, the answer comes
   * back as soon as it is running (and the ending arrives later, as a background event); with
   * it, the answer *is* the ending. Asking twice — start, then poll — would leave a gap in
   * which a short recording could end and its result be lost.
   */
  wait?: boolean
}

export type BrowserStartRecordingResult =
  | { started: true; recording: BrowserRecordingRef; extension: string; finished?: BrowserFinishedRecording }
  | { started: false; reason: 'already-recording'; recording: BrowserRecordingRef }
  | { started: false; reason: 'no-encoder' | 'no-capture'; message: string }

export type BrowserStopRecordingResult =
  | { stopped: true; recording: BrowserFinishedRecording }
  | { stopped: false; reason: 'not-recording' }

/**
 * Bytes a url answered with, when a door asked for them through the window's session.
 *
 * `base64` because it crosses the bridge as one string, and a refusal is an *answer* rather than
 * an error: an image that could not be brought down is something the caller reports and carries
 * on from, not something that should take the whole capture down with it.
 */
export type BrowserFetchedResource =
  | { ok: true; base64: string; mimeType: string }
  | { ok: false; error: string }

export interface BrowserPaneFns {
  openPanel: (options?: { background?: boolean }) => Promise<{ instanceId: string }>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  snapshot: () => Promise<{ url: string; title: string; nodes: Array<{ ref: string; role: string; name: string; value?: string; description?: string; focused?: boolean; checked?: boolean; disabled?: boolean }> }>;
  click: (ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }) => Promise<void>;
  clickAt: (x: number, y: number) => Promise<void>;
  drag: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  fill: (ref: string, value: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  select: (ref: string, value: string) => Promise<void>;
  setClipboard: (text: string) => Promise<void>;
  getClipboard: () => Promise<string>;
  screenshot: (args?: BrowserScreenshotArgs) => Promise<BrowserScreenshotResult>;
  screenshotRegion: (args: BrowserScreenshotRegionArgs) => Promise<BrowserScreenshotResult>;
  getConsoleLogs: (args?: BrowserConsoleArgs) => Promise<Array<{ timestamp: number; level: 'log' | 'info' | 'warn' | 'error'; message: string }>>;
  /**
   * Give the tab this command acts on a viewport — `viewport-resize`.
   *
   * The unit is the **view**, not the window: the tab on screen gets it by sizing the window (its
   * viewport *is* the window's page area), a tab behind the person by sizing its own view where it
   * lives. The answer is the viewport the tab actually ended up with.
   */
  resizeViewport: (args: BrowserViewportResizeArgs) => Promise<{ width: number; height: number }>;
  getNetworkLogs: (args?: BrowserNetworkArgs) => Promise<Array<{ timestamp: number; method: string; url: string; status: number; resourceType: string; ok: boolean }>>;
  waitFor: (args: BrowserWaitArgs) => Promise<{ ok: true; kind: string; elapsedMs: number; detail: string }>;
  sendKey: (args: BrowserKeyArgs) => Promise<void>;
  getDownloads: (args?: BrowserDownloadsArgs) => Promise<Array<{ id: string; timestamp: number; url: string; filename: string; state: string; bytesReceived: number; totalBytes: number; mimeType: string; savePath?: string }>>;
  upload: (ref: string, filePaths: string[]) => Promise<void>;
  scroll: (direction: 'up' | 'down' | 'left' | 'right', amount?: number) => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  /**
   * Reload the page this conversation works from — `reload`.
   *
   * Fire-and-forget, like the browser's own reload button: nothing waits for the document
   * to load. A page of ours is rendered from disk, so an edit to it shows up on the next
   * render, and a render is what this asks for.
   */
  reload: () => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  /**
   * Fetch a url through the window's **own session**.
   *
   * Not the page's `fetch`: this is the network stack behind the window, so it carries that
   * session's cookies and the page's CORS does not apply to it. That is the whole point — a page
   * may *display* an image from another origin that script may not *read*, and this is what reads
   * it. Privileged for exactly that reason, which is why it lives on the pane rather than being
   * something the command layer does for itself.
   *
   * `referrer` asks for the request to look like the page's own, which some hosts require of an
   * image before they will serve it. `maxBytes` is the caller's ceiling: a body over it comes back
   * as a refusal rather than as bytes nobody wanted.
   */
  fetchResource: (
    url: string,
    options?: { referrer?: string; maxBytes?: number },
  ) => Promise<BrowserFetchedResource>;
  /** Prompt the user to click an element; resolves null on cancel/timeout. */
  pick: (options?: { timeoutMs?: number }) => Promise<PickedElement | null>;
  /**
   * Sample frames out of a recording — `video_tool sample`.
   *
   * The decoding is Chromium's: a hidden window loads the file and copies each sample to a
   * canvas, so the only decoder needed is the browser the app already ships — nothing here
   * expects the person to have installed ffmpeg. A codec Chromium does not implement is
   * reported by name rather than half-read.
   *
   * `out` is the whole difference between looking and keeping. Omitted, the frames are the
   * reply and nothing touches the disk; given, each is written as a numbered JPEG under it
   * and `path` comes back on every frame.
   */
  sampleVideo: (args: {
    /** The recording to sample. */
    path: string;
    /** Where to write the frames; omitted means "hand them back and write nothing". */
    out?: string;
    /** `timeline` samples on an interval; `changes` keeps only what moved. */
    mode?: 'timeline' | 'changes';
    /** Sampling interval for `timeline`, ms. */
    everyMs?: number;
    /** Ceiling on frames. */
    maxFrames?: number;
    /**
     * How much has to change for `changes` mode to keep a frame — `(0, 1]`, smaller keeps more.
     *
     * Omitted means the sampler's own default (the thing this mode always did), so passing it is
     * only ever a deliberate loosening or tightening.
     */
    changeThreshold?: number;
    /** Where to start looking, ms. Omitted, from the beginning. */
    fromMs?: number;
    /**
     * Where to stop, ms. **Omitted means to the end.**
     *
     * There is deliberately no "to the end" token: the caller cannot name a duration it has not
     * been told yet, so not passing this is how that is said.
     */
    toMs?: number;
    /**
     * The first frame of the recording, and/or the last, **and nothing else** — `sample` cover and
     * "where did it end up".
     *
     * Not a way of narrowing a scan: a range is sampled on an interval, so `--from 0 --to end` on
     * a 30s recording is fifteen frames, not the two ends. These ask for those two specifically.
     */
    first?: boolean;
    last?: boolean;
    /** Longest edge of each frame, in pixels. Scales down only, aspect preserved. */
    maxEdge?: number;
  }) => Promise<{ durationMs: number; truncated: boolean; frames: SampledVideoFrame[] }>;
  /**
   * A `.drawio` document → SVG, an editable SVG, a PNG or a standalone page — `drawio_tool
   * export` and `render`.
   *
   * Drawing is drawio's too (a hidden window again), so a caller that has never opened a window
   * can still be handed a picture. `out` is the whole difference between looking and keeping:
   * omitted, the bytes are the reply and nothing touches the disk.
   */
  exportDrawio: (args: {
    /** The document to draw: the path of a `.drawio` file. */
    path: string;
    format: DrawioFormat;
    /** Where to write it; omitted means "hand the bytes back and write nothing". */
    out?: string;
    /**
     * Draw this page, by the name the document gives it. Omitted, its first page.
     *
     * A name, not a number, and a name that matches no page — or two — is refused rather than
     * drawn: the drawing is the whole point of the call, so a different diagram than the caller
     * asked for must not come back as a success.
     */
    page?: string;
    /** Pixels per unit in the output. Omitted, drawio's own 1. */
    scale?: number;
    /**
     * What the drawing is made for — see {@link DrawioTheme}. Omitted, `auto`.
     *
     * One axis, and the same one for every format: an SVG *states* it, a PNG is drawn by it.
     */
    theme?: DrawioTheme;
  }) => Promise<RenderedDrawioFile & { path: string | null }>;
  /**
   * The pages of a `.drawio` document, in order — `drawio_tool pages`.
   *
   * File work and nothing else: no window, no engine, nothing drawn. It is here because the
   * workspace is here — the side that has the disk reads the document, as it does for
   * `exportDrawio` — and because a page's **name** has to be findable before it can be asked for:
   * the pages of a file are otherwise only visible to whoever reads its XML.
   */
  listDrawioPages: (args: { path: string }) => Promise<DrawioPage[]>;
  focusWindow: (instanceId?: string) => Promise<{ instanceId: string; title: string; url: string }>;
  releaseControl: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  closeWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  hideWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  /**
   * Add a tab to this session's window — what makes several pages workable
   * at once, since the window is one and its tabs are many. Returns
   * the new tab's id.
   *
   * Opening something into a window that has no tab of its own yet opens *into*
   * that tab rather than beside it, so a fresh window ends up with one tab.
   */
  createTab: (options?: BrowserTabOpenOptions) => Promise<string>;
  /**
   * Make one of this session's tabs the tab it **works from** — without showing it.
   *
   * This is what `--tab` names. The tab becomes the one the rest of the command, the
   * next command, and the command after the person clicks around all land on, and the
   * window does not move: it is shared with the person, and the tab they are reading is
   * theirs to keep. An unknown id throws — running somewhere
   * else is the one outcome a named target exists to prevent.
   */
  targetTab: (tabId: string) => Promise<void>;
  /**
   * Bring a tab up for the person — `tab-show` — and make it the tab this conversation works
   * from, because a tab brought up is one it is about to work on with them.
   *
   * `movedView` is false for a child session: it takes the tab as its own but does not move what
   * the person is looking at. An unknown id throws.
   */
  activateTab: (tabId: string) => Promise<{ movedView: boolean }>;
  /** Close one tab. Closing a window's last tab closes the window. */
  closeTab: (tabId: string) => Promise<{ remaining: number }>;
  /**
   * Hand one of this conversation's tabs to another conversation — the orchestrator's verb:
   * a parent gives each of its child sessions a tab of its own.
   */
  assignTab: (tabId: string, targetSessionId: string) => Promise<void>;
  /** This session's window's tabs, in the order they were opened. */
  listTabs: () => Promise<BrowserTabInfo[]>;
  /**
   * The windows this session can reach, with whether each is visible and who is driving it.
   *
   * Not a listing an agent reads — there is **one window per workspace**, shared by every
   * conversation in it and by the person, so "which window" is not a question.
   * The app-side flows use it as a *read of the window's state*: `open` waits for a
   * foregrounded window to become visible, `close`/`hide`/`focus` report what changed, and
   * a tab-level question ("which tabs does this window have") is `listTabs`.
   */
  listWindows: () => Promise<Array<{
    id: string;
    title: string;
    /** The tab this window is actually showing. */
    url: string;
    isVisible: boolean;
    /**
     * Which conversation is working in it right now, when one is — the window-level
     * indicator. Which tab each conversation holds is per tab (`tabs`, `lockedBy`),
     * because a parent and its child sessions work in one window in parallel.
     */
    agentControlActive?: boolean;
  }>>;
  detectChallenge: () => Promise<{ detected: boolean; provider: string; signals: string[] }>;
  /**
   * Record a tab — `record-start`.
   *
   * A recording belongs to `(this conversation, this tab)`, so the person can be recording the
   * same tab at the same time and neither is the other's business. **What is recorded is
   * whichever tab is named**, and it keeps being that tab: the conversation moving to another
   * tab does not move the recording.
   *
   * Its length is settled here and nothing lengthens it afterwards — `ttlMs` is required, and it
   * is the only bound. See `wait` for the two forms.
   *
   * Optional because recording needs a window with a live renderer and an encoder behind it: a
   * headless runtime has neither, and saying "this runtime cannot record" is better than a
   * method that always throws. `record-start` refuses by name when it is absent.
   */
  startRecording?: (args: BrowserStartRecordingArgs) => Promise<BrowserStartRecordingResult>;
  /** End one early — `record-stop`. `--ttl` is the ordinary end; this is for "it is done now". */
  stopRecording?: (args: { tabId: string }) => Promise<BrowserStopRecordingResult>;
}

// ============================================================================
// Tool Factory Options
// ============================================================================

/**
 * What both tool factories are built with: which session they answer for, how to reach that
 * session's pane, and where the workspace is.
 *
 * Named after the pane rather than one of the tools, because every tool on this runtime —
 * `browser_tool`, `video_tool`, `drawio_tool` — takes the same options: they are doors onto one
 * window.
 */
export interface BrowserPaneToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for browser pane functions.
   * Called at execution time to get the current callback from the session registry.
   */
  getBrowserPaneFns: () => BrowserPaneFns | undefined;
  /**
   * The workspace root, for commands that name a file of the agent's own — `evaluate --file`
   * on the browser door. A relative path counts from here; absent means such a path has to be
   * absolute, because a file named relative to nothing is a file nobody can find.
   */
  workspaceRootPath?: string;
}

/**
 * The pane functions, resolved at execution time — or the error the agent gets when the app
 * cannot provide them. Both tool factories need the same sentence, and neither can act without
 * them: every command on both doors goes through the same capability surface.
 */
export function requireBrowserPaneFns(options: BrowserPaneToolOptions): BrowserPaneFns {
  const fns = options.getBrowserPaneFns();
  if (!fns) {
    throw new Error('Browser window controls are not available. This tool requires the desktop app.');
  }
  return fns;
}
