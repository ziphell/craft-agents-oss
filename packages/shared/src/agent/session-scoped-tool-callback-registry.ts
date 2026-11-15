/**
 * Session-Scoped Tool Callback Registry
 *
 * Extracted from session-scoped-tools.ts to break the dependency between
 * the callback registry (shared by Claude + Pi paths) and the Claude SDK
 * adapter layer (only used by ClaudeAgent).
 *
 * The registry is a simple Map keyed by sessionId. Each backend registers
 * callbacks when a session starts and merges additional callbacks (e.g.
 * browser pane functions) as they become available.
 */

import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts';
import type { SpawnSessionFn } from './spawn-session-tool.ts';
import type { BrowserPaneFns } from './browser-pane.ts';
import type { DrawioRenderFns } from '../drawio/cli-fns.ts';
import type { RecordingFns } from '../recording/cli-fns.ts';
import type { OfficeEditRequest } from '../office/open-documents.ts';
import type { DeviceToolFns } from './device-tool.ts';
import type { AuthRequest } from '@craft-agent/session-tools-core';
import { debug } from '../utils/debug.ts';

/**
 * Callbacks that can be registered per-session
 */
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted via SubmitPlan tool.
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;

  /**
   * Agent-native LLM query callback for call_llm tool (OAuth path).
   * Each agent backend sets this to its own queryLlm implementation.
   */
  queryFn?: (request: LLMQueryRequest) => Promise<LLMQueryResult>;

  /**
   * Resolve the model that reads images / video frames when a tool is handed
   * pictures and the caller named none (see `resolveImageModel`). Wired by
   * SessionManager so it re-resolves the effective connection + model at call
   * time (the session may switch connection or model between calls); absent
   * means no image-capable model is configured, so image tools refuse.
   */
  getImageModelFn?: () => string | undefined;

  /**
   * Callback for spawn_session tool — creates an independent session and sends initial prompt.
   * Each agent backend delegates to its onSpawnSession callback.
   */
  spawnSessionFn?: SpawnSessionFn;


  /**
   * Browser pane functions for browser_* tools.
   * Set by the Electron session manager — wraps BrowserPaneManager
   * with the session's bound browser instance.
   */
  browserPaneFns?: BrowserPaneFns;

  /**
   * A host that can draw a diagram **without a window** — a hub's launcher.
   *
   * Registered beside `browserPaneFns` rather than instead of it, because the two answer the same
   * question on different hosts: the pane is the desktop's, this is a server's, and `drawio_tool`
   * prefers the pane when it has one.
   */
  drawioRenderFns?: DrawioRenderFns;

  /**
   * A host that can decode a recording **without a window** — a hub's render host.
   *
   * Registered beside `browserPaneFns` rather than instead of it: the pane is the desktop's, this
   * is a server's, and `recording_tool` prefers the pane when it has one (one hop instead of two).
   */
  recordingFns?: RecordingFns;

  /**
   * Deliver a system note into this conversation when background work it started settles.
   *
   * Wired by the session manager: idle sessions are woken with a hidden follow-up so the agent
   * can present the result, while a turn already running is left alone (it can poll). Absent on a
   * host with no session machinery, and the tool then says "poll" instead of "you will be told".
   */
  notifyBackgroundResultFn?: (message: string) => void;

  /**
   * Apply an anchored edit **inside the editor showing a document**.
   *
   * A different thing from writing the file: the change becomes one step of that editor's history,
   * so the person can undo it and their caret stays put. Answers `null` when nothing is showing the
   * document, which the tool reports rather than falling back to a write behind an absent editor.
   */
  officeApplyEditFn?: (path: string, edit: OfficeEditRequest) => Promise<{ ok: boolean; message?: string } | null>;

  /**
   * Draw one page of a document, as its own editor lays it out.
   *
   * The same route a poster takes (`officePageCapture()`), reached by `render` so looking at a page
   * costs 1.5 s instead of printing the whole document. Answers the PNG files written; an empty
   * list means "this host cannot draw", and the command prints the page instead.
   */
  /**
   * Draw an html file in a window nobody sees, and answer the PNG written.
   *
   * Installed by the process that owns a browser (`setOfficeWebShot`), and used by `html_tool shot`:
   * the same picture the `html-preview` reader is — the page, its scripts run, photographed after
   * they have painted.
   */
  /**
   * Draw a markdown file with the app's own renderer, and answer the PNG written.
   *
   * Installed by the process that owns the renderer (`setOfficeMarkdownShot`). Unset on a host with
   * no renderer, and `markdown_tool shot` then says so rather than drawing nothing.
   */
  officeMarkdownShotFn?: (request: { path: string; width: number; height: number; outDir: string }) => Promise<string[]>

  officeWebShotFn?: (request: { path: string; width: number; height: number; outDir: string }) => Promise<string[]>

  officeCapturePagesFn?: (request: {
    path: string
    page: number
    outDir: string
    target?: { sheet?: string; range?: string }
  }) => Promise<string[]>;

  /**
   * Ask every editor holding unsaved work to save it, before the agent touches anything.
   *
   * The file is what the agent reads, and the editors write to it on a debounce — so a document
   * somebody is typing into is ahead of its file by up to a couple of seconds, and ahead of it for
   * as long as they keep typing. Flushing first makes the rest of the step read the screen instead
   * of the recent past. Unset on a host with no clients, which has no editors to ask.
   */
  documentFlushFn?: (paths: string[]) => Promise<{ path: string; ok: boolean; message?: string }[]>;

  /**
   * Device functions for `device_tool` — shell/files/browser on this machine or another one
   * connected to the hub. Set by SessionManager; absent means no device can be reached, and the
   * tool says so instead of guessing.
   */
  deviceFns?: DeviceToolFns;
  /**
   * Whether this hub has ever paired a device (online or offline) — the gate for advertising
   * `device_tool` at all. Read when a tool list is built, so it is a snapshot rather than a live
   * answer: a hub that has never paired a machine does not pay for the tool's brief every turn.
   * Absent means "unknown", and the tool stays offered (tests, hosts without a device registry).
   */
  hasDevicesFn?: () => boolean;
  /** This machine's desktop, for `computer_tool`. Absent on a host without one. */
  getComputerPaneFns?: () => Promise<import('./computer-pane.ts').ComputerPaneFns>;

  /** Set labels on a session (defaults to current). */
  setSessionLabelsFn?: (sessionId: string | undefined, labels: string[]) => void | Promise<void>;
  /** Set status on a session (defaults to current). */
  setSessionStatusFn?: (sessionId: string | undefined, status: string) => void | Promise<void>;
  /** Archive (archived=true) or unarchive (archived=false) a session by ID. */
  archiveSessionFn?: (sessionId: string, archived: boolean) => void | Promise<void>;
  /** Get detailed info about a session (defaults to current). */
  getSessionInfoFn?: (sessionId?: string) => import('@craft-agent/session-tools-core').SessionInfo | null;
  /** List sessions in the workspace with pagination. */
  listSessionsFn?: (options?: import('@craft-agent/session-tools-core').ListSessionsOptions) => import('@craft-agent/session-tools-core').ListSessionsResult;
  /** List background tasks (running + terminal) for a session from the main-process registry. */
  listBackgroundTasksFn?: (sessionId?: string) => import('@craft-agent/session-tools-core').BackgroundTaskInfo[];
  /** Resolve label display names to IDs. */
  resolveLabelsFn?: (labels: string[]) => import('@craft-agent/session-tools-core').ResolvedLabelsResult;
  /** Resolve a status display name to its ID. */
  resolveStatusFn?: (status: string) => import('@craft-agent/session-tools-core').ResolvedStatusResult;
  /** Send a message to another session (inter-session messaging). Resolves with delivery status. */
  sendAgentMessageFn?: (sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>) => Promise<import('@craft-agent/session-tools-core').SendAgentMessageResult>;
  /**
   * Activate a source in the running session (source_test auto-enable flow).
   * Wired by SessionManager to the per-session onSourceActivationRequest callback
   * plus a backend-aware readiness signal (Pi vs Claude).
   */
  activateSourceInSessionFn?: (sourceSlug: string) => Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'immediate' | 'next-turn';
  }>;
  /** Create a Craft Agents Task (board card + task.yaml + orchestrator session) without running it. */
  createTaskFn?: (
    input: import('@craft-agent/session-tools-core').CreateTaskInput
  ) => Promise<import('@craft-agent/session-tools-core').CreateTaskResult>;
  /**
   * Tweaks tools (list/get/create/update/delete/export) — the standing edits that run on
   * pages nobody here owns. Grouped because the operations ship together, and wired the
   * same way.
   */
  tweaks?: import('@craft-agent/session-tools-core').TweakToolCallbacks;
  /**
   * Decision-layer callback for the `decide` tool (Jev / System One). Wired by
   * SessionManager from `@craft-agent/shared/decisions`; gating (Settings switch,
   * feature toggle, key) happens inside the callback at call time.
   */
  decide?: import('@craft-agent/session-tools-core').DecisionToolCallbacks;
}

// Registry of callbacks keyed by sessionId
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * Register callbacks for a specific session
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(sessionId, callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId}`);
}

/**
 * Merge additional callbacks into an existing session's callback set.
 * Used by the Electron session manager to add browser pane functions
 * after the agent has already registered its core callbacks.
 */
export function mergeSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: Partial<SessionScopedToolCallbacks>
): void {
  const existing = sessionScopedToolCallbackRegistry.get(sessionId) ?? {};
  sessionScopedToolCallbackRegistry.set(sessionId, { ...existing, ...callbacks });
  debug('session-scoped-tools', `Merged callbacks for session ${sessionId}`);
}

/**
 * Unregister callbacks for a session
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackRegistry.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * Get callbacks for a session
 */
export function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}
