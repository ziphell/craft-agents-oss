/**
 * The browser pane's capability surface.
 *
 * `BrowserPaneFns` is what the main process implements and what every command on both doors calls
 * (`browser_tool` for the window itself, `prototype_tool` for a prototype's own files and flow).
 * Keeping it in its own module is what lets those two tools be separate files without either of
 * them owning the interface the other depends on.
 */

import type { BrowserTabSummary, PickedElement } from '../protocol/dto.ts';
import type { PrototypeEntry, PrototypeExportResult } from '../prototypes/export.ts';
import type { CreatedPrototype } from '../prototypes/create.ts';
import type { PrototypeConfig } from '../prototypes/config.ts';
import type { PrototypeWindowDescriptor } from '../prototypes/types.ts';
import type { PrototypePagesChange, PrototypePagesResult } from '../prototypes/pages.ts';
import type { ContractExportResult } from '../prototypes/contract.ts';
import type { PrototypeStatus } from '../prototypes/status.ts';
import type { AcceptanceDiff, AcceptanceSummary } from '../prototypes/acceptance.ts';

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
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserWindowResizeArgs {
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
   * not close that window, but it may close the tabs it opened in it (plan §22).
   */
  action: 'closed' | 'pages-closed' | 'hidden' | 'released' | 'noop'
  requestedInstanceId?: string
  resolvedInstanceId?: string
  affectedIds: string[]
  reason?: string
}

/** One tab of this session's window, as `tabs` reports it (plan §22). */
export type BrowserTabInfo = BrowserTabSummary

export interface BrowserTabOpenOptions {
  /** Where the tab starts. Omitted → blank, for a caller that navigates itself. */
  url?: string
  /** Whether the tab comes to the front. Default true. */
  activate?: boolean
  /**
   * The prototype this tab is for, when it is one.
   *
   * The prototype's **own** origin, not the tab's address: an overlay page's
   * document is someone else's, so once it loads there is nothing left in the URL
   * to say which prototype the tab is working on.
   */
  prototype?: { slug: string; origin: string } | null
}

export interface BrowserPaneFns {
  openPanel: (options?: { background?: boolean }) => Promise<{ instanceId: string }>;
  navigate: (url: string) => Promise<{ url: string; title: string }>;
  snapshot: () => Promise<{ url: string; title: string; nodes: Array<{ ref: string; role: string; name: string; value?: string; description?: string; focused?: boolean; checked?: boolean; disabled?: boolean }>; prototype?: PrototypeWindowDescriptor | null }>;
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
  windowResize: (args: BrowserWindowResizeArgs) => Promise<{ width: number; height: number }>;
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
   * to load. It is the other half of "that patch is already inlined here" — a page of ours
   * is rendered from disk, so an edit to it or to a patch it carries shows up on the next
   * render, and a render is what this asks for.
   */
  reload: () => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  /** Prompt the user to click an element; resolves null on cancel/timeout. */
  pick: (options?: { timeoutMs?: number }) => Promise<PickedElement | null>;
  /**
   * The prototype this session is bound to, or null when unbound.
   *
   * Every `prototype_tool` command falls back to this when no slug is passed,
   * which is what lets a bound conversation be driven without naming artifacts.
   */
  getBoundPrototypeSlug?: () => string | null;
  /** Every prototype in the workspace, with its derived status. */
  listPrototypes: () => Promise<PrototypeStatus[]>;
  /** Create a prototype: a container for pages. It gets no page — writing one is how a page exists. */
  createPrototype: (input: {
    name: string;
  }) => Promise<CreatedPrototype>;
  /**
   * Point one overlay page at a different address — the same page in another
   * environment, usually. `page` defaults to the entry page when it is an overlay
   * page, otherwise the first one. Only the page's own rules are enforced; whether
   * the patches still fit the new page is the caller's risk, and saying so is part
   * of the command's output (see target.ts).
   */
  setPrototypePageUrl: (slug: string, url: string, page?: string) => Promise<PrototypeConfig>;
  /**
   * Read, add, remove, rename or re-point one page of a prototype's table, and
   * mark which page `/` opens. Same data behind `prototype_tool status`,
   * `prototype_tool open --page`, the page name in `browser_tool snapshot`, and the
   * extension's match patterns.
   */
  setPrototypePages: (slug: string, change: PrototypePagesChange) => Promise<PrototypePagesResult>;
  /** Bind (or unbind, with null) this session's prototype. */
  bindPrototype: (slug: string | null) => Promise<void>;
  /**
   * Replay a prototype's patches in this session's browser and register
   * them for future documents (so they survive a reload).
   *
   * Patches the page already carries — a page opened from the workbench arrives
   * with them inlined — are left alone and reported in `skipped`, so a JS patch
   * cannot run a second time over a document that already has its effect.
   *
   * `options.file` (absolute) replays one patch instead of the whole set — the
   * file just written. The other registrations are left alone in that case, so
   * the page keeps the patches it was already given.
   */
  applyPrototype: (slug: string, options?: { file?: string }) => Promise<{
    slug: string;
    applied: number;
    files: string[];
    skipped: string[];
    /**
     * Which page's patches were replayed: the one the window is on, or the entry
     * page when the window is elsewhere. Null means only the shared patches
     * (`patches/*`) were applied, because no page of this flow was on screen — a
     * page-scoped patch that did nothing is otherwise indistinguishable from one
     * that belongs to another page.
     */
    page?: string | null;
    /**
     * The one file this apply was narrowed to (`--file`), with the page that brings it
     * (null = every page); null when the whole set was replayed. The page here is the
     * patch's own scope, which is what says whether naming it while another page is open
     * explains targets that matched nothing.
     */
    file?: { name: string; page: string | null } | null;
    /**
     * What each declared `@target` matched (plan §21.1). Every patch that carries
     * a marker is checked, so "matched nothing" can no longer be confused with
     * "changed nothing".
     */
    targets?: Array<{ file: string; target: string; matched: number | null; recorded: boolean }>;
    /** Declared targets that matched nothing and had never matched — a wrong selector. */
    unmatched?: string[];
    /**
     * Targets that matched before and do not now: the page moved. Each carries
     * when it last matched and selectors that resolve to one element now, so the
     * fix is a re-anchor rather than a guess.
     */
    drifted?: Array<{ target: string; lastMatchedAt: string; suggestions: string[] }>;
    /** Patches with no `@target`, so nothing about them could be checked. */
    untargeted?: string[];
  }>;
  /** Remove a prototype's patches from this session's browser. */
  clearPrototype: (slug: string) => Promise<{ slug: string; removed: string[] }>;
  /**
   * Run the acceptance checks the PRD puts under its requirements (plan §20.7):
   * `check: selector <css>` against the page this session's window is on, and
   * `check: endpoint <METHOD> <path>` against the contract.
   *
   * Page checks are `skip` when there is no page to look at — "could not look" is
   * not "not there". Writes `dist/acceptance.md`.
   */
  verifyPrototype: (slug: string) => Promise<{
    slug: string;
    page: string | null;
    /** The page *name* the checks ran against, for `about: page <name>`. */
    pageName: string | null;
    passed: number;
    failed: number;
    skipped: number;
    /** Which run this is; the record lives under `acceptance/` (plan §3.7). */
    round: number;
    /** What changed against the round before. */
    diff: AcceptanceDiff;
    previous: AcceptanceSummary | null;
    reportPath: string;
    statePath: string;
    results: Array<{
      requirementId: string;
      requirementTitle: string;
      kind: string;
      target: string;
      status: string;
      detail: string;
    }>;
  }>;
  /**
   * Sample frames out of a video the user recorded elsewhere, and write them under
   * `research/frames/` (plan §20.5).
   *
   * The video is copied into `research/videos/` first: a capture whose source has
   * since been cleaned up cannot be re-sampled, and re-reading it is most of what
   * having a source is for. Decoding happens in Chromium — no ffmpeg — so a codec
   * Chromium does not implement is reported rather than half-read.
   */
  importPrototypeVideo: (args: {
    slug: string;
    /** The recording to sample. */
    path: string;
    /** `timeline` samples on an interval; `changes` keeps only what moved. */
    mode?: 'timeline' | 'changes';
    /** Sampling interval for `timeline`, ms. */
    everyMs?: number;
    /** Ceiling on frames. */
    maxFrames?: number;
  }) => Promise<{
    session: string;
    video: string;
    frames: number;
    files: string[];
    truncated: boolean;
    durationMs: number;
    /** The frames themselves, in order — the files are the record, these are the reply. */
    images: Array<{ path: string; bytes: Uint8Array }>;
  }>;
  /**
   * Build a prototype's deliverable: one loadable Chrome extension covering the
   * whole flow (our documents shipped in the package, the patches applied to the
   * live pages) plus a change spec.
   * Does not need a browser window — it is a pure file export.
   */
  exportPrototype: (slug: string) => Promise<PrototypeExportResult>;
  /**
   * Compose `services/{svc}/paths/*.yaml` fragments into `services/{svc}/openapi.yaml`.
   * `service` may be omitted when the prototype has exactly one service.
   */
  composeContract: (options: { slug: string; service?: string }) => Promise<{
    service: string;
    endpoints: number;
    conflicts: string[];
    missingFixtures: string[];
  }>;
  /** Write the backend deliverables (`dist/openapi.yaml` + `dist/contract.md` + fixtures). */
  exportContract: (options: { slug: string; service?: string }) => Promise<ContractExportResult>;
  /**
   * Serve the service's `x-mock` responses at the browser's network layer, so
   * the prototype runs before the backend exists.
   */
  applyMock: (options: { slug: string; service?: string }) => Promise<{
    service: string;
    routes: number;
    missingFixtures: string[];
    unmocked: string[];
    /** How many of those routes read or change the contract's state. */
    stateful: number;
    /** Operations the stateful vocabulary cannot express (see `mock-engine.ts`). */
    stateIssues: string[];
    /** Why `state.json` could not be used, when it is there but broken. */
    stateProblem: string | null;
  }>;
  /** Stop serving the mock; requests fall through to the real network. */
  clearMock: () => Promise<void>;
  /**
   * Inspect a prototype: patches, services, contract coverage, exports
   * and ownership violations. Pure file inspection — no browser needed.
   */
  prototypeStatus: (slug: string) => Promise<PrototypeStatus>;
  /**
   * Where a prototype is shown, and whether its patches still have to be
   * replayed: the address of a live page, a document of ours the host renders with
   * its patches already in it, or the generated page index when no page is marked
   * as the entry (plan §19.3).
   */
  prototypeEntry: (options: { slug: string }) => Promise<PrototypeEntry>;
  focusWindow: (instanceId?: string) => Promise<{ instanceId: string; title: string; url: string }>;
  releaseControl: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  closeWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  hideWindow: (instanceId?: string) => Promise<BrowserLifecycleActionResult>;
  /**
   * Add a tab to this session's window — what makes several prototypes workable
   * at once, since the window is one and its tabs are many (plan §22). Returns
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
   * theirs to keep (plan §22, 第十轮/第十二轮). An unknown id throws — running somewhere
   * else is the one outcome a named target exists to prevent.
   */
  targetTab: (tabId: string) => Promise<void>;
  /**
   * Bring a tab up for the person — `tab-show` — and make it the tab this conversation works
   * from, because a tab brought up is one it is about to work on with them.
   *
   * `movedView` is false for a child session: it takes the tab as its own but does not move what
   * the person is looking at (plan §22, Conductor). An unknown id throws.
   */
  activateTab: (tabId: string) => Promise<{ movedView: boolean }>;
  /** Close one tab. Closing a window's last tab closes the window. */
  closeTab: (tabId: string) => Promise<{ remaining: number }>;
  /**
   * Hand one of this conversation's tabs to another conversation — the orchestrator's verb
   * (plan §22, Conductor): a parent gives each of its child sessions a tab of its own.
   */
  assignTab: (tabId: string, targetSessionId: string) => Promise<void>;
  /** This session's window's tabs, in the order they were opened. */
  listTabs: () => Promise<BrowserTabInfo[]>;
  /**
   * The windows this session can reach, with whether each is visible and who is driving it.
   *
   * Not a listing an agent reads — there is **one window per workspace**, shared by every
   * conversation in it and by the person, so "which window" is not a question (plan §22).
   * The app-side flows use it as a *read of the window's state*: `open` waits for a
   * foregrounded window to become visible, `close`/`hide`/`focus` report what changed, and
   * a tab-level question ("which tabs does this window have") is `listTabs`.
   */
  listWindows: () => Promise<Array<{
    id: string;
    title: string;
    /**
     * The tab this window is actually showing. For an overlay that is the live
     * site's own address, never the prototype's.
     */
    url: string;
    /**
     * The prototype this window is working on, when it is one — with its kind
     * (which decides whether the document is ours to edit) and its own address.
     */
    prototype?: PrototypeWindowDescriptor | null;
    isVisible: boolean;
    /**
     * Which conversation is working in it right now, when one is — the window-level
     * indicator. Which tab each conversation holds is per tab (`tabs`, `lockedBy`),
     * because a parent and its child sessions work in one window in parallel.
     */
    agentControlActive?: boolean;
  }>>;
  detectChallenge: () => Promise<{ detected: boolean; provider: string; signals: string[] }>;
}

// ============================================================================
// Tool Factory Options
// ============================================================================

/**
 * What both tool factories are built with: which session they answer for, how to reach that
 * session's pane, and where the workspace is.
 *
 * Named after the pane rather than one of the tools, because `createBrowserTools` and
 * `createPrototypeTools` take the same options — the two are doors onto one window.
 */
export interface BrowserPaneToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for browser pane functions.
   * Called at execution time to get the current callback from the session registry.
   */
  getBrowserPaneFns: () => BrowserPaneFns | undefined;
  /**
   * The workspace root, for the commands that name a file of the agent's own — `evaluate --file`
   * on the browser door, `apply --file` on the prototype one. A relative path counts from here;
   * absent means such a path has to be absolute, because a file named relative to nothing is a
   * file nobody can find.
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
