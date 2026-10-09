/**
 * Session Tools Core - Context Interface
 *
 * Defines the abstract context interface that both Claude (in-process)
 * and Codex (subprocess) implementations must provide.
 *
 * This enables writing tool handlers once and running them in both environments.
 */

import type {
  AuthRequest,
  ToolResult,
  SourceConfig,
  GoogleService,
  SlackService,
  MicrosoftService,
  McpSourceConfig,
} from './types.ts';

// ============================================================
// Source Credential Types
// ============================================================

/**
 * Loaded source with context for credential operations.
 * Note: guide field omitted as credential manager doesn't use it.
 */
export interface LoadedSource {
  config: SourceConfig;
  folderPath: string;
  workspaceRootPath: string;
  workspaceId: string;
}

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks for session tool operations.
 * Both Claude and Codex implement this interface differently:
 * - Claude: Direct function calls via registry
 * - Codex: JSON messages over stderr
 */
export interface SessionToolCallbacks {
  /**
   * Called when a plan is submitted.
   * Claude: calls onPlanSubmitted callback
   * Codex: sends __CALLBACK__ message to stderr
   */
  onPlanSubmitted(planPath: string): void;

  /**
   * Called when authentication is requested.
   * Claude: calls onAuthRequest callback + forceAbort
   * Codex: sends __CALLBACK__ message to stderr
   */
  onAuthRequest(request: AuthRequest): void;
}

// ============================================================
// File System Interface
// ============================================================

/**
 * File system abstraction for portability.
 * Allows mocking in tests and different implementations in different environments.
 */
export interface FileSystemInterface {
  /** Check if file/directory exists */
  exists(path: string): boolean;

  /** Read file as UTF-8 string */
  readFile(path: string): string;

  /** Read file as Buffer (for binary/images) */
  readFileBuffer(path: string): Buffer;

  /** Write file */
  writeFile(path: string, content: string): void;

  /** Check if path is a directory */
  isDirectory(path: string): boolean;

  /** List directory contents */
  readdir(path: string): string[];

  /** Get file stats */
  stat(path: string): { size: number; isDirectory(): boolean };
}

// ============================================================
// Credential Manager Interface
// ============================================================

/**
 * Credential manager abstraction.
 * Claude has full access to credential stores.
 * Codex may have limited or no access (relies on main process).
 */
export interface CredentialManagerInterface {
  /**
   * Check if a source has valid, non-expired credentials
   */
  hasValidCredentials(source: LoadedSource): Promise<boolean>;

  /**
   * Get the current access token for a source (null if expired/missing)
   */
  getToken(source: LoadedSource): Promise<string | null>;

  /**
   * Refresh the access token for a source
   */
  refresh(source: LoadedSource): Promise<string | null>;
}

// ============================================================
// Validator Interface
// ============================================================

/**
 * Config validation interface.
 * Claude uses full Zod validators from packages/shared.
 * Codex uses simplified validators from session-tools-core.
 */
export interface ValidatorInterface {
  validateConfig(): import('./types.js').ValidationResult;
  validateSource(workspaceRootPath: string, sourceSlug: string): import('./types.js').ValidationResult;
  validateAllSources(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateStatuses(workspaceRootPath: string): import('./types.js').ValidationResult;
  validatePreferences(): import('./types.js').ValidationResult;
  validatePermissions(workspaceRootPath: string, sourceSlug?: string): import('./types.js').ValidationResult;
  validateAutomations(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateToolIcons(): import('./types.js').ValidationResult;
  validateAll(workspaceRootPath: string): import('./types.js').ValidationResult;
  validateSkill(workspaceRootPath: string, skillSlug: string): import('./types.js').ValidationResult;
}

// ============================================================
// Session Tool Context
// ============================================================

/**
 * Main context interface for session tools.
 *
 * Claude's implementation (`createClaudeContext()`) has direct access to Electron internals.
 */
export interface SessionToolContext {
  // ============================================================
  // Session Info
  // ============================================================

  /** Unique session identifier */
  sessionId: string;

  /** Absolute path to workspace folder (~/.craft-agent/workspaces/{id}) */
  workspacePath: string;

  /** Path to sources folder within workspace */
  get sourcesPath(): string;

  /** Path to skills folder within workspace */
  get skillsPath(): string;

  /** Path to session's plans folder */
  plansFolderPath: string;

  /** Working directory (project root) for the session, if set */
  workingDirectory?: string;

  // ============================================================
  // Callbacks (transport-agnostic)
  // ============================================================

  callbacks: SessionToolCallbacks;

  // ============================================================
  // File System
  // ============================================================

  fs: FileSystemInterface;

  // ============================================================
  // Validators (optional - may use basic or full)
  // ============================================================

  validators?: ValidatorInterface;

  // ============================================================
  // Optional Capabilities
  // ============================================================

  /**
   * Get credential manager for source authentication checks.
   * Only available in Claude (has keychain access).
   */
  credentialManager?: CredentialManagerInterface;

  /**
   * Load a source config from the workspace.
   */
  loadSourceConfig(sourceSlug: string): SourceConfig | null;

  /**
   * Save a source config to the workspace.
   */
  saveSourceConfig?(source: SourceConfig): void;

  /**
   * Infer Google service from URL.
   */
  inferGoogleService?(url?: string): GoogleService | undefined;

  /**
   * Infer Slack service from URL.
   */
  inferSlackService?(url?: string): SlackService | undefined;

  /**
   * Infer Microsoft service from URL.
   */
  inferMicrosoftService?(url?: string): MicrosoftService | undefined;

  /**
   * Check if Google OAuth is configured.
   */
  isGoogleOAuthConfigured?(clientId?: string, clientSecret?: string): boolean;

  // ============================================================
  // Icon Management (for source_test)
  // ============================================================

  /**
   * Check if a value is a URL that can be used as an icon.
   */
  isIconUrl?(value: string): boolean;

  /**
   * Download an icon from URL to the source folder.
   * Returns the path to the cached icon, or null if download failed.
   */
  downloadSourceIcon?(sourceSlug: string, iconUrl: string): Promise<string | null>;

  /**
   * Derive a service URL from a source config (for favicon fetching).
   */
  deriveServiceUrl?(source: SourceConfig): string | null;

  /**
   * Get a high-quality logo URL from a service URL.
   */
  getHighQualityLogoUrl?(serviceUrl: string, slug: string): Promise<string | null>;

  /**
   * Download an icon to a specific destination path.
   */
  downloadIcon?(destPath: string, url: string, tag: string): Promise<string | null>;

  // ============================================================
  // MCP Connection Validation (for source_test)
  // ============================================================

  /**
   * Validate a stdio MCP connection by spawning the command.
   */
  validateStdioMcpConnection?(config: StdioMcpConfig): Promise<StdioValidationResult>;

  /**
   * Validate an HTTP/SSE MCP connection.
   */
  validateMcpConnection?(config: HttpMcpConfig): Promise<McpValidationResult>;

  // ============================================================
  // API Testing (for source_test)
  // ============================================================

  /**
   * Test an API source connection with full credential handling.
   */
  testApiSource?(source: SourceConfig): Promise<ApiTestResult>;

  /**
   * Test a Google source (OAuth token validation).
   */
  testGoogleSource?(source: SourceConfig): Promise<ApiTestResult>;

  // ============================================================
  // Preferences (for update_user_preferences)
  // ============================================================

  /**
   * Submit developer feedback. Injected by each backend:
   * - Claude: writes JSON files to ~/.craft-agent/feedback/
   * - Pi: could send over IPC or write directly
   */
  submitFeedback?(feedback: import('./types.ts').DeveloperFeedback): void;

  /**
   * Update user preferences. Injected by each backend:
   * - Claude: calls updatePreferences() from config/preferences.ts
   * - Pi: calls updatePreferences() from config/preferences.ts
   */
  updatePreferences?(updates: Record<string, unknown>): void;

  // ============================================================
  // Session Self-Management (for set_session_labels, etc.)
  // ============================================================

  /** Set labels on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionLabels?(sessionId: string | undefined, labels: string[]): void | Promise<void>;

  /** Set status on a session. Defaults to current session if no ID given. Injected by backend. */
  setSessionStatus?(sessionId: string | undefined, status: string): void | Promise<void>;

  /** Archive (archived=true) or unarchive (archived=false) another session by ID. Injected by backend. */
  archiveSession?(sessionId: string, archived: boolean): void | Promise<void>;

  /** Get detailed info about a session. Defaults to current session if no ID given. Injected by backend. */
  getSessionInfo?(sessionId?: string): SessionInfo | null;

  /** List sessions in the workspace with pagination. Injected by backend. */
  listSessions?(options?: ListSessionsOptions): ListSessionsResult;

  /**
   * List background tasks (running + recently-terminal) for a session from the
   * main-process registry. Defaults to the current session if no ID given.
   * Injected by backend (SessionManager). Returns [] in backends that don't
   * track background tasks.
   */
  listBackgroundTasks?(sessionId?: string): BackgroundTaskInfo[];

  /** Resolve label display names to IDs against configured labels. Injected by backend. */
  resolveLabels?(labels: string[]): ResolvedLabelsResult;

  /** Resolve a status display name to its ID against configured statuses. Injected by backend. */
  resolveStatus?(status: string): ResolvedStatusResult;

  /**
   * Create a Craft Agents Task (board card + task.yaml + orchestrator session)
   * WITHOUT running it. Slug derivation, node synthesis, and spec validation
   * happen behind this callback where the task primitives live. Injected by
   * backend (SessionManager); undefined in backends that don't run alongside
   * it (e.g. the Codex MCP subprocess) — the handler degrades gracefully.
   */
  createTask?(input: CreateTaskInput): Promise<CreateTaskResult>;

  /**
   * Tweaks tool callbacks — standing edits to pages nobody here owns, with two carriers
   * (this app's browser window, and a loadable extension). Grouped because the
   * operations ship together. Injected by the backend
   * (SessionManager); undefined elsewhere, where the handlers degrade gracefully.
   */
  tweaks?: TweakToolCallbacks;
  designs?: DesignsToolCallbacks;

  // ============================================================
  // Decision model (decide)
  // ============================================================

  /**
   * Decision-layer callback for the `decide` tool (Jev / System One typed
   * judgments over text or JSON). Injected by the backend (SessionManager)
   * from @craft-agent/shared/decisions; undefined in backends that don't run
   * alongside it — the handler tells the agent how the user can enable it.
   * Answers are hints for the agent and never grant authority.
   */
  decide?: DecisionToolCallbacks;

  // ============================================================
  // Inter-Session Messaging
  // ============================================================

  /**
   * Send a message to another session. Injected by backend (SessionManager).
   * Resolves with how the message was received so the sender can give the model
   * a truthful ack (delivered immediately vs. queued behind a busy turn) instead
   * of an unconditional "message sent".
   */
  sendAgentMessage?(sessionId: string, message: string, attachments?: Array<{ path: string; name?: string }>): Promise<SendAgentMessageResult>;

  /**
   * Activate a source in the running session: add to enabledSourceSlugs,
   * build its MCP/API servers, apply to the agent.
   *
   * Only available in backends that run alongside SessionManager (Claude in-process, Pi subprocess).
   * Codex and other backends leave this undefined — callers should degrade gracefully (restart required).
   *
   * `availability` is always `'next-turn'` when activation succeeds: both Claude SDK
   * (frozen `mcpServers` at `query()` start) and Pi (subprocess reloads proxy tools
   * on the next `handlePrompt`) require the current turn to end before new tools
   * are callable. The backend handles this via the existing source_activated + auto_retry
   * machinery — the current turn is aborted and the renderer resends the user's
   * original message with a `[{slug} activated]` suffix.
   */
  activateSourceInSession?(sourceSlug: string): Promise<{
    ok: boolean;
    reason?: string;
    availability?: 'next-turn';
  }>;

  // ============================================================
  // Session Paths (for transform_data / render_template)
  // ============================================================

  /**
   * Absolute path to the session directory.
   * Used by transform_data for resolving input files.
   */
  sessionPath?: string;

  /**
   * Absolute path to the session's data directory.
   * Used by transform_data and render_template for output files.
   */
  dataPath?: string;
}

// ============================================================
// Session Self-Management Types — Resolution
// ============================================================

/** Result of resolving label names/IDs against configured labels. */
export interface ResolvedLabelsResult {
  /** Resolved label IDs (ready to store) */
  resolved: string[];
  /** Labels that couldn't be matched to any configured label */
  unknown: string[];
  /** All valid label IDs (for error messages) */
  available: string[];
  /**
   * Optional per-input rejection reason, keyed by the original input string.
   * Populated by `resolveSessionLabels()` from `@craft-agent/shared/labels`.
   * Handlers use this to build clearer errors (e.g. "label X doesn't accept a value").
   */
  reasons?: Record<string, string>;
}

/** Result of resolving a status name/ID against configured statuses. */
export interface ResolvedStatusResult {
  /** Matched status ID, or null if unknown */
  resolved: string | null;
  /** All valid status IDs (for error messages) */
  available: string[];
  /**
   * Category of the matched status ('open' | 'closed'), when resolved. Lets the
   * status tool reject agent-driven *closed* transitions (the human owns closure)
   * while still allowing open ones like `needs-review`.
   */
  category?: 'open' | 'closed';
}

// ============================================================
// Session Self-Management Types
// ============================================================

/** Full metadata for a single session (returned by get_session_info). */
/** Input for create_task — structured fields, mapped onto a TaskSpec by the backend. */
export interface CreateTaskInput {
  /** Short task title shown on the board (also drives the slug). */
  title: string;
  /** What the task should accomplish — becomes the task goal and the initial node prompt. */
  description: string;
  /** Freeform rubric the final result is verified against. */
  acceptanceCriteria?: string;
  /** Source slugs enabled on the task's sessions. */
  sources?: string[];
  /** Skill slugs applied to dispatched task prompts. */
  skills?: string[];
  /** LLM connection slug serving `model`. */
  llmConnection?: string;
  /** Model id for the task's sessions (workspace default when omitted). */
  model?: string;
  /** Working directory for the task's sessions. */
  workingDirectory?: string;
  /** Project to bind the task to. Defaults to the invoking session's project. */
  projectId?: string;
}

/** Result of create_task. */
export interface CreateTaskResult {
  slug: string;
  orchestratorSessionId: string;
  taskLabelId?: string;
  /** Fail-soft problems (unknown source/skill slugs, label failure, …). */
  warnings: string[];
}

// ============================================================
// Tweaks (standing edits to pages nobody here owns)
// ============================================================

/** One tweak as the agent sees it in a list. */
export interface TweakToolSummary {
  slug: string;
  name: string;
  description?: string;
  /** Chrome match patterns: the pages this tweak runs on. */
  matches: string[];
  /** Off means it does nothing anywhere — see `create_tweak`. */
  enabled: boolean;
  /** False when the folder has neither tweak.css nor tweak.js, so there is nothing to inject. */
  hasCode: boolean;
  /** Absolute path to the tweak's folder. */
  folderPath: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One selector a tweak declares with `@target`, and what it has matched.
 *
 * `stale` is the whole point of keeping the record: the tweak has been applied since the
 * last time this selector matched, and it did not match — the design moved.
 */
export interface TweakToolTarget {
  selector: string;
  /** Which of the tweak's files declares it. */
  file: string;
  /** When it last matched something, epoch ms. Absent means it never has. */
  lastMatchedAt?: number;
  /** It matched before, and the most recent apply did not see it. */
  stale: boolean;
}

/** Full tweak detail (returned by get_tweak / create_tweak / update_tweak). */
export interface TweakToolDetails extends TweakToolSummary {
  /** Absolute path to tweak.css (whether or not it exists). */
  cssPath: string;
  /** Absolute path to tweak.js (whether or not it exists). */
  jsPath: string;
  /** Which of the two code files are actually there — a path does not say that. */
  hasCss: boolean;
  hasJs: boolean;
  /** Absolute path to hits.json — written by whatever applies the tweak, never by hand. */
  hitsPath: string;
  /**
   * When its javascript runs: what the tweak declares with `@run-at`, or `document_end`.
   * Derived from the code, because that is where it is declared.
   */
  runAt: 'document_start' | 'document_end' | 'document_idle';
  targets: TweakToolTarget[];
  /** When the hit record was last written, or null when nothing has applied it yet. */
  appliedAt: number | null;
}

/** Input for create_tweak. */
export interface CreateTweakToolInput {
  name: string;
  description?: string;
  /** Chrome match patterns — at least one. */
  matches: string[];
  /** Created off unless this is true; see the tool's own description. */
  enabled?: boolean;
  /** Written to tweak.css */
  css?: string;
  /** Written to tweak.js */
  js?: string;
}

/** Patch for update_tweak — only provided fields change; null clears the description. */
export interface UpdateTweakToolPatch {
  name?: string;
  description?: string | null;
  matches?: string[];
  enabled?: boolean;
}

/** Result of delete_tweak. */
export interface DeleteTweakToolResult {
  deleted: true;
}

/**
 * Tweaks tool callbacks, injected by the backend (SessionManager). All storage logic
 * lives behind these — this package never touches tweaks/ directly.
 */
export interface TweakToolCallbacks {
  listTweaks(): TweakToolSummary[] | Promise<TweakToolSummary[]>;
  getTweak(slug: string): TweakToolDetails | null | Promise<TweakToolDetails | null>;
  createTweak(input: CreateTweakToolInput): Promise<TweakToolDetails>;
  updateTweak(slug: string, patch: UpdateTweakToolPatch): Promise<TweakToolDetails>;
  deleteTweak(slug: string): Promise<DeleteTweakToolResult>;
}

// ============================================================
// Designs Types
// ============================================================
// Plain JSON shapes mirroring @craft-agent/core design types — duplicated here
// on purpose so this package stays dependency-free (same rule as
// CreateTaskInput). The backend maps real DesignConfig/LoadedDesign onto these.

/** Scheduled refresh spec for a design (5-field cron → workspace-relative script). */
export interface DesignToolRefreshSpec {
  /** 5-field cron expression evaluated once per minute */
  cron: string;
  /** Script path relative to the workspace root (must stay within it) */
  script: string;
  /** Extra argv appended after the script path */
  args?: string[];
  /** IANA timezone for cron evaluation (system local when omitted) */
  timezone?: string;
  /** Per-run timeout in ms (default 60_000, clamped to [1_000, 900_000]) */
  timeoutMs?: number;
  /** false pauses scheduling without deleting the spec */
  enabled?: boolean;
}

/** Deck presentation hint. Present = the design is a deck. */
export interface DesignToolDeckSpec {
  /** '16:9' | '4:3' | '16:10' | '9:16' */
  aspect?: string;
  /** Template/theme the deck was authored from */
  theme?: string;
}

/** Motion composition hint. Present = the design renders to video. */
export interface DesignToolMotionSpec {
  /** Capture frame rate (1–60) */
  fps?: number;
  /** Piece length in ms (100–600000) */
  durationMs?: number;
  /** '16:9' | '4:3' | '16:10' | '9:16' */
  aspect?: string;
}

/** Compact design entry (returned by list_designs). */
export interface DesignToolSummary {
  slug: string;
  name: string;
  description?: string;
  /** 'webpage' | 'prototype' | 'deck' | 'motion' — what the design is */
  kind: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
  /** Whether index.html exists yet */
  hasContent: boolean;
  refresh?: DesignToolRefreshSpec;
  /** Outcome of the most recent data refresh (scheduled or agent write) */
  lastRefresh?: { at: number; ok: boolean; durationMs: number; error?: string };
  /** Whether the design is currently published (share link exists) */
  shared: boolean;
  /** Deck presentation hint (absent = a plain document) */
  deck?: DesignToolDeckSpec;
  /** Motion composition hint (absent = not a motion composition) */
  motion?: DesignToolMotionSpec;
  /** Absolute path to the design folder (designs/{slug}/) */
  folderPath: string;
}

/** Summary of a design's data snapshot (kv keys + per-series stats, not full points). */
export interface DesignToolDataSummary {
  generatedAt: number;
  kvKeys: string[];
  series: Array<{ name: string; points: number; latest?: { t: number; v: number } }>;
  /** Absolute path to data/snapshot.json — Read it for the full contents */
  snapshotPath: string;
}

/** Full design details (returned by get_design / create_design / update_design). */
export interface DesignToolDetails extends DesignToolSummary {
  id: string;
  /** The design's own address — open it with `browser_tool` to read or drive the page */
  previewUrl?: string;
  /** sha256 hex of index.html (grants and render leases bind to it) */
  contentDigest?: string;
  /** Byte length of index.html when present */
  contentLength?: number;
  /** Absolute path to index.html */
  contentPath: string;
  /** Data snapshot summary, or null when no data has been written yet */
  data: DesignToolDataSummary | null;
  /** Source-action grants (user-approved; stale = digest mismatch or expired) */
  grants: Array<{
    id: string;
    kind: string;
    /** Source slug for api/mcp grants (absent for script grants) */
    sourceSlug?: string;
    /** Workspace-relative script path for script grants (absent otherwise) */
    script?: string;
    description?: string;
    expiresAt: number;
    stale: boolean;
  }>;
  /** Public share URL when published */
  shareUrl?: string;
  /** Full index.html content (only when requested with includeContent) */
  content?: string;
}

/** Input for create_design. */
export interface CreateDesignToolInput {
  name: string;
  description?: string;
  /** 'webpage' | 'prototype' | 'deck' | 'motion' (default: 'webpage'); deck/motion settings imply it */
  kind?: string;
  /** Stable Project ID to bind the design to */
  projectId?: string;
  /** Full self-contained HTML document for index.html */
  content?: string;
  refresh?: DesignToolRefreshSpec;
  /** Deck presentation hint — provide it to make this a deck (see docs/designs.md) */
  deck?: DesignToolDeckSpec;
  /** Motion composition hint — provide it to make this renderable as video (see docs/designs.md) */
  motion?: DesignToolMotionSpec;
}

/** Patch for update_design — only provided fields change; null clears a field. */
export interface UpdateDesignToolPatch {
  name?: string;
  description?: string | null;
  /** 'webpage' | 'prototype' | 'deck' | 'motion' — changing it drops the old kind's settings */
  kind?: string;
  projectId?: string | null;
  /** Replaces index.html entirely (re-digests; existing grants go stale by design) */
  content?: string;
  refresh?: DesignToolRefreshSpec | null;
  /** Deck presentation hint. Pass null to turn the design back into a plain document. */
  deck?: DesignToolDeckSpec | null;
  /** Motion composition hint. Pass null to turn the design back into a plain document. */
  motion?: DesignToolMotionSpec | null;
}

/** Data mutation batch for write_design_data (applied in one transaction). */
export interface DesignDataToolPatch {
  /** KV upserts: key → any JSON value */
  set?: Record<string, unknown>;
  /** KV keys to delete */
  delete?: string[];
  /** Timeseries appends: series name → points ({ t? epoch ms, v number }) */
  appendSeries?: Record<string, Array<{ t?: number; v: number }>>;
  /** Timeseries prunes: series name → deleteBefore timestamp (t < value removed) */
  pruneSeries?: Record<string, number>;
}

/** Result of write_design_data. */
export interface DesignDataWriteSummary {
  slug: string;
  kvCount: number;
  seriesCount: number;
  generatedAt: number;
  snapshotPath: string;
  durationMs: number;
}

/** Result of delete_design. */
export interface DeleteDesignToolResult {
  deleted: true;
  /** True when the design was published and the remote copy may still exist */
  publicCopyMayRemain: boolean;
}

/**
 * Designs tool callbacks, injected by the backend (SessionManager). All storage
 * logic lives behind these — this package never touches designs/ directly.
 */
export interface DesignsToolCallbacks {
  listDesigns(): DesignToolSummary[] | Promise<DesignToolSummary[]>;
  getDesign(slug: string, options?: { includeContent?: boolean }): DesignToolDetails | null | Promise<DesignToolDetails | null>;
  createDesign(input: CreateDesignToolInput): Promise<DesignToolDetails>;
  updateDesign(slug: string, patch: UpdateDesignToolPatch): Promise<DesignToolDetails>;
  writeDesignData(slug: string, patch: DesignDataToolPatch): Promise<DesignDataWriteSummary>;
  deleteDesign(slug: string): Promise<DeleteDesignToolResult>;
}

// ============================================================
// Decision Tool Types (mirror @craft-agent/shared/decisions — this package
// must stay free of that dependency, same rule as designs)
// ============================================================

export type DecisionToolQuestionType = 'choice' | 'score' | 'noul';

/** A sentence, or a small structured object such as { question, focus }. */
export type DecisionToolInstructions = string | Record<string, unknown>;

/**
 * choice: option key → description (string, structured object, or null when self-explanatory).
 * score: ordered array of level descriptions, lowest first.
 * noul: optional { true, false } descriptions.
 */
export type DecisionToolCriteria =
  | Record<string, string | null | Record<string, unknown>>
  | Array<string | Record<string, unknown>>;

export interface DecisionToolQuestion {
  type: DecisionToolQuestionType;
  instructions: DecisionToolInstructions;
  criteria?: DecisionToolCriteria;
}

/** Text, a JSON object, or an array of text values. */
export type DecisionToolState = string | Record<string, unknown> | unknown[];

export interface DecisionToolRequest {
  state: DecisionToolState;
  questions: Record<string, DecisionToolQuestion>;
  /** Wall-clock budget for the call, in ms. */
  deadlineMs?: number;
  /** Caller context written to the decision record (redacted by key name). Never the state. */
  meta?: Record<string, unknown>;
}

export type DecisionToolAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, unknown> }
  | { type: 'noul'; noul: number };

export interface DecisionToolUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Failure the agent may see. Never contains the API key or the state. */
export interface DecisionToolError {
  kind: string;
  message: string;
  status?: number;
}

export type DecisionToolResult =
  | { ok: true; model: string; answers: Record<string, DecisionToolAnswer>; usage: DecisionToolUsage; latencyMs: number; truncated: boolean }
  | { ok: false; error: DecisionToolError };

/**
 * Decision-layer callback, injected by the backend (SessionManager). Network,
 * validation, gating and recording all live behind it.
 */
export interface DecisionToolCallbacks {
  decide(request: DecisionToolRequest): Promise<DecisionToolResult>;
}

export interface SessionInfo {
  id: string;
  name: string;
  labels: string[];
  status: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  llmConnection?: string;
  model?: string;
  isActive: boolean;
}

/** Compact session summary (returned by list_sessions). */
export interface SessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
}

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

/**
 * Result of delivering a cross-session message (send_agent_message).
 * Lets the sender report the truth instead of an unconditional "sent".
 */
export interface SendAgentMessageResult {
  /**
   * - `delivered`: the target was idle, so it will start processing the message now.
   * - `queued`: the target was mid-turn; the message is enqueued and will be
   *   processed after the current turn finishes.
   */
  delivery: 'delivered' | 'queued';
  /** Whether the target session was processing a turn when the message arrived. */
  targetBusy: boolean;
}

/**
 * A background task tracked by the main process (returned by
 * list_background_tasks). This is the cross-subprocess source of truth: the
 * SDK's in-subprocess task tools only see tasks launched in the CURRENT
 * subprocess, so they cannot report a task from a prior turn's (torn-down)
 * subprocess. `status: 'orphaned'` means the owning turn ended before a terminal
 * notification arrived — the task most likely died with its subprocess.
 */
export interface BackgroundTaskInfo {
  taskId: string;
  intent?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned';
  /** ms timestamp when the task was backgrounded */
  startTime: number;
  /** seconds elapsed since start (derived at query time) */
  elapsedSeconds: number;
  /** ms timestamp when the task reached a terminal/orphaned status, if any */
  completedAt?: number;
}

// ============================================================
// MCP Validation Types
// ============================================================

/**
 * Config for stdio MCP connection validation
 */
export interface StdioMcpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Config for HTTP/SSE MCP connection validation.
 * Derived from McpSourceConfig to stay in sync automatically (DRY).
 *
 * `accessToken` is the resolved OAuth / bearer token for sources whose
 * credential lives in the credential store (no `headerNames`). The probe
 * forwards it to the underlying impl, which builds an
 * `Authorization: Bearer …` header — matching the runtime path.
 */
export type HttpMcpConfig = Required<Pick<McpSourceConfig, 'url'>>
  & Pick<McpSourceConfig, 'authType' | 'headers' | 'headerNames' | 'transport'>
  & { accessToken?: string };

/**
 * Result from stdio MCP validation
 */
export interface StdioValidationResult {
  success: boolean;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from HTTP MCP validation
 */
export interface McpValidationResult {
  success: boolean;
  error?: string;
  needsAuth?: boolean;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Result from API source test
 */
export interface ApiTestResult {
  success: boolean;
  status?: number;
  error?: string;
  hint?: string;
}

// ============================================================
// Context Factory Helpers
// ============================================================

/**
 * Create a basic file system implementation using Node.js fs.
 */
export function createNodeFileSystem(): FileSystemInterface {
  // Dynamic import to work in both environments
  const fs = require('node:fs');

  return {
    exists: (path: string) => fs.existsSync(path),
    readFile: (path: string) => fs.readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => fs.readFileSync(path),
    writeFile: (path: string, content: string) => fs.writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => fs.existsSync(path) && fs.statSync(path).isDirectory(),
    readdir: (path: string) => fs.readdirSync(path),
    stat: (path: string) => {
      const stats = fs.statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };
}
