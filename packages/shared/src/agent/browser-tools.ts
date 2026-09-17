/**
 * Browser Tools (`browser_tool`)
 *
 * Session-scoped tooling that enables the agent to interact with built-in
 * in-app browser windows via a single CLI-like command wrapper.
 * Commands delegate to BrowserPaneFns callbacks wired by Electron's
 * SessionManager to BrowserPaneManager.
 *
 * The session → browser instance mapping is handled by the callback provider
 * (getOrCreateForSession pattern), so commands don't need instance IDs.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BrowserTabSummary, PickedElement } from '../protocol/dto.ts';
import type { PrototypeEntry, PrototypeExportResult } from '../prototypes/export.ts';
import type { CreatedPrototype } from '../prototypes/create.ts';
import type { PrototypeConfig } from '../prototypes/config.ts';
import type { PageKind, PrototypeWindowDescriptor } from '../prototypes/types.ts';
import type { PrototypePagesChange, PrototypePagesResult } from '../prototypes/pages.ts';
import type { PrototypeCommitResult } from '../prototypes/commit.ts';
import type { ContractExportResult } from '../prototypes/contract.ts';
import type { PrototypeStatus } from '../prototypes/status.ts';
import type { AcceptanceDiff, AcceptanceSummary } from '../prototypes/acceptance.ts';
import { executeBrowserToolCommand } from './browser-tool-runtime.ts';

// Tool result type - matches MCP CallToolResult content blocks
type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

const BROWSER_RELEASE_HINT = '\n\nWhen you are done using the browser, call browser_tool with command "close" to close the window entirely, or "release" to dismiss the overlay and let the user continue browsing.';

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
   * Every `prototype-*` command falls back to this when no slug is passed,
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
   * mark which page `/` opens. Same data behind `prototype-status`,
   * `prototype-open --page`, the page name in `snapshot`, and the extension's
   * match patterns.
   */
  setPrototypePages: (slug: string, change: PrototypePagesChange) => Promise<PrototypePagesResult>;
  /** Bind (or unbind, with null) this session's prototype. */
  bindPrototype: (slug: string | null) => Promise<void>;
  /**
   * Declare that `slug` studies `referenceSlug` (plan §14). The two stay separate
   * prototypes, which is what keeps the reference's patches out of `slug`'s
   * deliverable — so this is the only supported way to connect them.
   */
  linkPrototypeReference: (slug: string, referenceSlug: string) => Promise<{ references: string[] }>;
  /** Drop the relation. Idempotent, and how a dangling reference is cleaned up. */
  unlinkPrototypeReference: (slug: string, referenceSlug: string) => Promise<{ references: string[] }>;
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
  /**
   * Fold the delta layer into what owns it (plan §21.3).
   *
   * A page of ours has its css folded into `assets/<page>/committed.css` and its
   * js promoted into `assets/<page>/committed.js`, both referenced from the
   * document; a live page's patches are folded into
   * `patches/<page>/Z-001-upper.css` / `Z-002-upper.js`, which replay last. The
   * patch files that were folded are deleted — which is what makes a commit the
   * one irreversible prototype action, and why there is no command to undo it.
   */
  commitPrototype: (slug: string, options?: { page?: string }) => Promise<PrototypeCommitResult>;
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
   * Start keeping frames of this session's browser window: the screen is compared
   * on an interval and a frame is kept when enough of it has changed.
   *
   * Frames rather than a video, because what reads them is a model: a video would
   * have to be decoded and sampled again, and whoever sampled it would not know
   * where the screen actually changed (plan §20.3).
   */
  startPrototypeFrames: (options: {
    /** How often the screen is compared. Default 400 ms. */
    intervalMs?: number;
    /** Share of the sampled screen that must differ to keep a frame. Default 0.005. */
    threshold?: number;
    /** Ceiling on frames per capture. Default 60. */
    maxFrames?: number;
  }) => Promise<{ startedAt: string; intervalMs: number; threshold: number; maxFrames: number }>;
  /**
   * Stop the capture and write it under `research/frames/` of `slug`. Returns null
   * when no capture was running.
   */
  stopPrototypeFrames: (slug: string) => Promise<{
    /** Absolute path to the session directory. */
    dir: string;
    frames: number;
    files: string[];
    /** True when the capture hit its frame ceiling — a sample, not the whole session. */
    truncated: boolean;
  } | null>;
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
    /** The recording to sample. Omitted by the panel, which asks for a file instead. */
    path?: string;
    /** `timeline` samples on an interval; `changes` keeps only what moved. */
    mode?: 'timeline' | 'changes';
    /** Sampling interval for `timeline`, ms. */
    everyMs?: number;
    /** Ceiling on frames. */
    maxFrames?: number;
  }) => Promise<{
    /** Empty path → the picker was dismissed, and nothing was written. */
    session: string;
    video: string;
    frames: number;
    files: string[];
    truncated: boolean;
    durationMs: number;
  } | null>;
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

export interface BrowserToolsOptions {
  sessionId: string;
  /**
   * Lazy resolver for browser pane functions.
   * Called at execution time to get the current callback from the session registry.
   */
  getBrowserPaneFns: () => BrowserPaneFns | undefined;
  /**
   * The workspace root, for the commands that name a file of the agent's own:
   * `evaluate --file <path>` resolves a relative path against it. Absent means such a
   * path has to be absolute — a file named relative to nothing is a file nobody can find.
   */
  workspaceRootPath?: string;
}

// ============================================================================
// Tool Descriptions
// ============================================================================

const BROWSER_TOOL_DESCRIPTION = `Run browser actions using a CLI-like command (string or array input).

All browser interactions use this single tool with strict validation and actionable feedback.
String mode supports batching with semicolons: \`fill @e1 value; fill @e2 value; click @e3\`
Batch stops after navigation commands (click, navigate, back, forward, reload) since page state may change.

Array mode bypasses string parsing and preserves raw arguments exactly (recommended for semicolons, tabs, and newlines):
- \`["evaluate", "var x = 1; var y = 2; x + y"]\`
- \`["paste", "Name\\tAge\\nAlice\\t30"]\`

\`evaluate --file <path>\` runs a script that is kept in a file instead of in the command (a relative path
counts from the workspace root): write it once — with the Write tool, or as the patch you already wrote —
and name it here, so the same code is never spelled out a second time in a command. Use it for anything
longer than a one-line probe. What it runs is **not registered**, so a reload drops it: a change that has to
survive one is a patch file under \`patches/\`, applied by \`prototype-apply\`.

Prototypes — one per requirement: a folder that holds the prototype's **pages** and its \`patches/\`, plus
whatever the contract needs. A prototype is NOT a project: projects are separate containers that group
sessions, tasks and shared assets, and a prototype is never nested inside one.
A page is one of two kinds, fixed when the page is added:
- **scratch** — a document of ours: \`<name>.html\` in the prototype's directory. The change is an edit to
  that file, and the file *is* the page (writing it is what makes one; the table only orders it).
- **overlay** — patches injected on top of a page that belongs to someone else. That page is never copied
  or frozen: it *is* the live address, with its own JS and its own session, so study it with this tool
  (and have the user sign in here when it needs it) before writing selectors.
One flow may mix both.
**A page's name is its identity on every surface**: \`--page <name>\` on the commands, \`/<name>\` on the
address, \`patches/<name>/\` for its own changes, and the \`page\` a \`snapshot\` reports. It is a short name
chosen when the page is added (\`cart\`, \`pay\`) — not a URL fragment.
The page table gives their order and which page the address root opens: \`prototype-entry <name>\` marks one,
\`prototype-entry none\` goes back to the generated **index** that lists every page — reachable at \`/_index\`
whatever the root opens. Where a patch sits is which page it changes: \`patches/*\` applies to every page,
\`patches/<page>/*\` to that page only (a directory matching no page is reported, never replayed). A shell
shared by the pages of ours may live in \`_layout.html\`, whose \`<slot name="page"></slot>\` is where a page renders.
Prototypes written before pages had kinds are read as this same table: nothing has to be migrated, and a
\`config.json\` holding only \`pages\` is the normal shape.
Export gives a loadable Chrome extension (it ships our documents, applies the patches to the real pages,
and lists every page in its options page) plus a spec a developer translates onto them.
Prototypes are independent — each keeps its own patches, and one can *reference* another without merging
them. Referencing is how you build one thing by studying another. \`prototype-list\` shows every prototype
with its pages, and which ones reference which.
Detailed rules and the full command reference: docs/browser-tools.md for the browser, and
docs/prototypes.md for every \`prototype-*\` command — read the one you are about to use first.

The window is one and its tabs are many: every command can name the tab it acts on with \`--tab <id>\`
(\`tabs\` lists them). Without one it acts on **your** tab — the tab you have been working from, which
\`tabs\` marks as \`your tab\` — and only on the tab on screen when you have none yet; the person
switching tabs does not move your commands. A session spawned by another one is the exception: it works
in the tab it was given (\`tab-assign\`) or opens one with \`tab-new\`, and never takes over the tab on
screen. \`prototype-open\` always opens a tab of its own, which is what lets two prototypes be worked on
at once rather than replacing each other.

There is **one browser window per workspace**, shared by every conversation in it and by the user — so \`open\`
adds a tab to it instead of making a window, and the window is not yours to close: use \`tab-close <id>\` for
the tabs of your task (the ones you opened, the ones handed to you, and the tabs opened from them — a Task's
node tabs included, so a finished DAG can be tidied up), or \`release\` to drop your overlay. \`tabs\` says
what each tab is, whose work it is in and who is working on it — another conversation's tab is refused,
prototype or not, and \`tab-assign <tab-id> <session>\` is how a parent hands a tab to a session it spawned,
so that parallel sessions each work in their own tab. A tab's work outlives the session that opened it: a
Task node's tab belongs to that node, so a re-run of a node finds its predecessor's tab in \`tabs\` — read it
before opening one, because \`tab-new\` always adds a tab. There is no window list to read, because there is
one window. Which prototype a command means is read from the tab it acts on — your own tab first, then the
one in front of you — so several prototypes can be driven from one conversation without binding any of them.

Examples:
- \`--help\`
- \`open\`
- \`navigate https://example.com\`
- \`snapshot\`
- \`find login button\` — search elements by keyword
- \`click @e12\`
- \`click-at 350 200\` — click at pixel coordinates (for canvas elements)
- \`drag 100 200 300 400\` — drag from (100,200) to (300,400)
- \`fill @e5 user@example.com\`
- \`type Hello World\` — type into currently focused element (no ref needed)
- \`select @e3 optionValue\`
- \`select @e75 CNAME --assert-text Target --timeout 3000\`
- \`set-clipboard Name\\tAge\\nAlice\\t30\` — write text to clipboard
- \`get-clipboard\` — read clipboard text content
- \`paste Name\\tAge\\nAlice\\t30\` — set clipboard and trigger Ctrl/Cmd+V
- \`upload @e3 /path/to/file.pdf\` — attach local file(s) to a file input
- \`scroll down 800\`
- \`reload\` — reload this page. A page of ours is rendered from disk, so an edit to it or to a patch it carries shows up on the next render; nothing waits for the load, so \`wait network-idle\` before reading it, and re-\`snapshot\` (every ref is stale)
- \`evaluate document.title\`
- \`evaluate --file prototypes/cart/patches/ui-002-total.js\` — a script kept in a file
- \`pick\` — ask the user to click an element; returns a stable selector + geometry
- \`prototype-list\` — every prototype with its pages and references (both directions)
- \`prototype-create Landing page\` — a container for pages. It starts with none: write \`cart.html\` (or add a live page) and that is the first page
- \`prototype-create Rival checkout --no-bind\` — create one *without* stealing this session's binding (used to make a reference)
- \`prototype-pages\` — the flow's pages, in order, each with its kind. \`--add payment=https://app.example.com/pay\` adds a live page, \`--add cart\` places an existing document, plus \`--rename\` and \`--remove\`
- \`prototype-entry cart\` — make \`cart\` the page the address root opens; \`prototype-entry none\` goes back to the generated index
- \`prototype-target https://staging.example.com/checkout --page cart\` — point one overlay page at the same page in another environment (no \`--page\` means the entry page). Say what goes stale with it: windows already open keep the old page, and the patches were written against the old DOM
- \`prototype-reference rival-checkout\` — study another prototype from the bound one, whatever either is made of. Its patches were written against a different document: read them for intent, never copy them into the bound prototype's patches/ (they would ship silently inside its deliverable)
- \`prototype-bind checkout-flow\` — bind this session (or \`prototype-bind --clear\` to unbind)
- \`prototype-verify\` — run the acceptance checks the PRD puts under its requirements (\`check: selector [data-total]\`, \`check: endpoint GET /api/cart\`) and write \`dist/acceptance.md\`. Page checks need a page open; without one they are reported as skipped, not failed. It says which round this is and what *moved* since the round before (newly red / still red / fixed), so "this change broke it" can be told from "it was already broken", and it hands over the \`about:\` line for each failure
- \`prototype-apply\` — replay the bound prototype's patches (survives reload). Reports each declared \`@target\`: one that matched nothing is named, and one that used to match and does not means the page moved
- \`prototype-apply --file prototypes/cart/patches/ui-002-total.js\` — put one patch on the page, the one just written. The patches already registered stay registered; a page of ours already carries it, so the answer is that the change shows on reload
- \`prototype-apply checkout-flow\` — same, for an explicitly named prototype
- \`prototype-commit\` — fold the delta layer into what owns it: a page of ours takes the changes into \`assets/<page>/committed.*\` (linked from the document), a live page into \`patches/<page>/Z-001-upper.css\` (replaying last). The folded patch files are deleted — irreversible, so commit when the work has stopped moving
- \`prototype-commit --page cart\` — fold only that page's own patches
- \`prototype-clear\` — remove the bound prototype's patches
- \`prototype-record start\` — keep frames of this window: the screen is compared every 400 ms, and a frame is written when more than 0.5% of it changed (\`--interval <ms>\`, \`--threshold <ratio>\`, \`--max <n>\`)
- \`prototype-record stop\` — write them to \`research/frames/<session>/\` as numbered JPEGs plus \`frames.json\` and \`index.md\`, and cite them from a finding's \`evidence:\` line
- \`prototype-record import ~/Desktop/demo.mp4\` — copy a recording into \`research/videos/\` and sample frames from it every 2 s (\`--every 500ms\`, \`--changes\` for only what moved, \`--max 40\`). Chromium does the decoding, so a codec it cannot read fails loudly instead of quietly
- \`prototype-export\` — build the deliverables (a loadable extension + dist/static/ pages of ours as single files) + dist/dev-spec.md. It names anything still outstanding (a requirement nothing implements, a dispute nobody answered, a check that failed) and \`prototype-export --strict\` refuses to build while there is any — use that when nobody is reading the output
- \`prototype-contract-compose\` — fragments → services/<svc>/openapi.yaml
- \`prototype-contract-export\` — dist/openapi.yaml + dist/contract.md + fixtures
- \`prototype-mock-apply\` — serve the contract's x-mock responses
- \`prototype-mock-clear\` — stop serving the mock
- \`prototype-status\` — inspect pages, patches, services, exports, ownership, the disputes that still stand, and the last acceptance round
- \`prototype-open\` — open the prototype (its entry page, or the generated index when there is none)
- \`prototype-open --page cart\` — open one page of it
- \`tabs\` — which tabs this window has, each with what it is and whose work it is in
- \`snapshot --tab tab-3\` — act on a named tab (the window shows it while the command runs)
- \`tab-new https://example.com\` — add a tab to the window
- \`tab-assign tab-3 260915-brave-fox\` — hand a tab to a session you spawned
- \`tab-close tab-2\` — close one tab (closing the last one closes the window)
- \`console 50 error\`
- \`screenshot\` — raw screenshot
- \`screenshot --annotated\` — screenshot with @eN labels overlaid on interactive elements
- \`screenshot-region 100 200 640 480\`
- \`screenshot-region --ref @e12 --padding 8\`
- \`screenshot-region --selector div[data-testid="chart"]\`
- \`window-resize 1440 900\`
- \`network 50 failed\`
- \`wait network-idle 8000\`
- \`key Enter\`
- \`key k meta\`
- \`downloads wait 15000\`
- \`focus [windowId]\` — focus a browser window (no new window)
- \`release [windowId|all]\` — dismiss the agent control overlay when done
- \`close [windowId]\` — close a window of your own; the shared window is refused
- \`hide [windowId]\` — hide the window while preserving state

The prototype-* commands default to the prototype this session is bound to, so a slug is
optional for all of them except list/create/bind.`;

// ============================================================================
// Tool Factories
// ============================================================================

export function createBrowserTools(options: BrowserToolsOptions) {
  function getBrowserFns(): BrowserPaneFns {
    const fns = options.getBrowserPaneFns();
    if (!fns) {
      throw new Error('Browser window controls are not available. This tool requires the desktop app.');
    }
    return fns;
  }

  return [
    // Single CLI-like tool for all browser actions
    tool(
      'browser_tool',
      BROWSER_TOOL_DESCRIPTION,
      {
        command: z.union([
          z.string(),
          z.array(z.string()),
        ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
      },
      async (args) => {
        try {
          const result = await executeBrowserToolCommand({
            command: args.command,
            fns: getBrowserFns(),
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          });

          const text = result.appendReleaseHint
            ? result.output + BROWSER_RELEASE_HINT
            : result.output;

          if (result.image) {
            return {
              content: [
                { type: 'text' as const, text },
                { type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType },
              ],
            };
          }

          return successResponse(text);
        } catch (error) {
          return errorResponse(error instanceof Error ? error.message : String(error));
        }
      },
    ),
  ];
}
