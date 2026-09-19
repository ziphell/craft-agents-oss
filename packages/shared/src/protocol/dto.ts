/**
 * Server DTO types — data shapes used by RPC handlers and SessionManager.
 *
 * These were previously in apps/electron/src/shared/types.ts.
 * Extracted here so handler code in @craft-agent/server-core can import
 * from @craft-agent/shared/protocol without reaching into the app.
 */

import type {
  Message,
  TypedError,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
  PermissionRequest as BasePermissionRequest,
} from '@craft-agent/core/types'
import type { PermissionMode } from '../agent/mode-types'
import type { ThinkingLevel } from '../agent/thinking-levels'
import type { ConnectionModelEntry, CustomEndpointConfig } from '../config/llm-connections'
import type {
  AuthRequest as SharedAuthRequest,
  CredentialInputMode as SharedCredentialInputMode,
  CredentialAuthRequest as SharedCredentialAuthRequest,
} from '../agent/index'

// Re-export generateMessageId for handler convenience
export { generateMessageId } from '@craft-agent/core/types'

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/**
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string

export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled'

/**
 * Electron-specific Session type (includes runtime state).
 * Extends core Session with messages array and processing state.
 */
export interface Session {
  id: string
  workspaceId: string
  workspaceName: string
  name?: string
  /** Preview of first user message (from JSONL header, for lazy-loaded sessions) */
  preview?: string
  lastMessageAt: number
  messages: Message[]
  isProcessing: boolean
  isFlagged?: boolean
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode
  sessionStatus?: SessionStatus
  /** Labels (additive tags, many-per-session — bare IDs or "id::value" entries) */
  labels?: string[]
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  enabledSourceSlugs?: string[]
  workingDirectory?: string
  sessionFolderPath?: string
  sharedUrl?: string
  sharedId?: string
  model?: string
  llmConnection?: string
  thinkingLevel?: ThinkingLevel
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  lastFinalMessageId?: string
  isAsyncOperationOngoing?: boolean
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  currentStatus?: {
    message: string
    statusType?: string
  }
  createdAt?: number
  messageCount?: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  isArchived?: boolean
  archivedAt?: number
  supportsBranching?: boolean
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Prototype slug this session is bound to (undefined = unbound) */
  prototypeSlug?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to. */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator. */
  taskNodeCount?: number
  /** Tasks Conductor: how many `kind: approval` gates of the active run are waiting on a person. */
  taskAwaitingApproval?: number
  /** The writer identity this session writes prototype artifacts as (task.yaml `writes:`, §3.6). */
  taskWrites?: string
  /** Tasks Conductor: generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
}

export interface CreateSessionOptions {
  name?: string
  permissionMode?: PermissionMode
  /**
   * Reasoning/thinking level override. When set, takes precedence over workspace
   * and global defaults. Silently ignored by the underlying SDK on non-reasoning
   * models (e.g. gpt-4o) — provider drivers don't attach the reasoning param to
   * the API request for models with `reasoning: false` in the Pi SDK catalog.
   */
  thinkingLevel?: ThinkingLevel
  /**
   * Working directory for the session:
   * - 'user_default' or undefined: Use workspace's configured default working directory
   * - 'none': No working directory (session folder only)
   * - Absolute path string: Use this specific path
   */
  workingDirectory?: string | 'user_default' | 'none'
  model?: string
  llmConnection?: string
  systemPromptPreset?: 'default' | 'mini' | string
  hidden?: boolean
  sessionStatus?: SessionStatus
  labels?: string[]
  isFlagged?: boolean
  enabledSourceSlugs?: string[]
  /**
   * Message ID to branch from. This is a hard context cutoff:
   * the new session must not include model context from later parent messages.
   */
  branchFromMessageId?: string
  /** Parent session ID used together with branchFromMessageId. */
  branchFromSessionId?: string
  /** Bind the new session to a workspace project (inherits project's workingDirectory). */
  projectId?: string
  /** Bind the new session to a prototype (a slug under the workspace's prototypes/ folder). */
  prototypeSlug?: string
  /** Mark the new session as a subtask of this parent session (undefined = top-level task). */
  parentSessionId?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes). */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** The writer identity this session writes prototype artifacts as (task.yaml `writes:`, §3.6). */
  taskWrites?: string
  /** Tasks Conductor: mark the orchestrator as a generate-time draft (hidden until adopted by createTask). */
  taskDraft?: boolean
  /**
   * Apply the reserved "Task" label (valueType 'number') after creation. Top-level sessions
   * allocate the next task number; sessions with a `parentSessionId` inherit the parent's
   * number (labeling a plain-chat parent in the same pass). Task flows opt in; plain chats don't.
   */
  applyTaskLabel?: boolean
}

export interface RemoteSessionTransferPayload {
  sourceSessionId: string
  name?: string
  sessionStatus?: SessionStatus
  labels?: string[]
  permissionMode?: PermissionMode
  summary: string
}

export interface ImportRemoteSessionTransferResult {
  sessionId: string
}

// ---------------------------------------------------------------------------
// Tasks (Conductor) DTOs — wire contract for the tasks:* channels.
// ---------------------------------------------------------------------------

export interface TaskValidationIssueDto {
  /** Dotted path into the spec, e.g. "nodes.design.depends_on". */
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface TaskValidationResultDto {
  valid: boolean
  errors: TaskValidationIssueDto[]
  warnings: TaskValidationIssueDto[]
  /** Pre-flight estimate: total nodes and how many sessions a run would spawn. */
  estimate?: { nodeCount: number; sessionNodeCount: number }
}

export interface TaskCreateRequest {
  /** task.yaml source text (authoritative). */
  yaml: string
  /**
   * When this YAML was authored by a `tasks:generate` orchestrator, the id of that hidden
   * draft session. tasks:create promotes it in place (clears taskDraft, binds taskSlug)
   * instead of minting a second top-level session — preventing duplicate board tiles (#bug1).
   * Only honored when the draft is still unadopted and its slug matches; otherwise ignored.
   */
  orchestratorSessionId?: string
  /**
   * Edit-mode bind: the id of an existing, board-visible session (e.g. a quick-add tile) that the
   * user is saving this spec onto. tasks:create calls `bindExistingSessionToTask` and HARD-ERRORS
   * if the bind fails — it must never fall through to minting a fresh orchestrator (that would
   * leave a duplicate tile). Distinct from `orchestratorSessionId`, which adopts a hidden draft.
   */
  attachToExistingSession?: string
}

export interface TaskCreateResult {
  /** Empty string when validation failed — inspect `validation`. */
  slug: string
  /** The persistent parent/orchestrator session (author + final verifier). */
  orchestratorSessionId: string
  validation: TaskValidationResultDto
  /**
   * Resolved id of the reserved "Task" label applied to the orchestrator. May differ from the
   * literal 'task' (a user-owned label with that name forces a fresh slug like 'task-2'), so
   * navigation/filtering MUST use this id. Undefined when label application failed (fail-soft).
   */
  taskLabelId?: string
}

export interface TaskGenerateRequest {
  /** Natural-language goal the orchestrator turns into a task.yaml DAG. */
  goal: string
  /** Optional working title for the task / orchestrator session. */
  title?: string
  /** Optional model for the orchestrator session (defaults to the session default). */
  model?: string
  /** Optional working directory for the orchestrator session (defaults to project/workspace cwd). */
  cwd?: string
  /** Project to bind the draft orchestrator to, so it authors against the project's `<project_context>`. */
  projectId?: string
  /**
   * LLM connection slug that serves `model`. Required for non-default (e.g. pi/*) models — without it
   * the authoring turn can't resolve a backend and completes instantly with no output (invalid spec).
   */
  llmConnection?: string
  /** Task-level source slugs the draft orchestrator may author against (omitted → workspace default). */
  enabledSourceSlugs?: string[]
  /** Permission mode for the draft orchestrator, so its authoring turn matches the task's chosen
   *  autonomy from the start instead of running at the workspace default until adoption. */
  permissionMode?: PermissionMode
}

/**
 * Synchronous ack for `tasks:generate`. The orchestrator session is created immediately
 * (cheap) and returned right away; the authored spec arrives later via the `tasks:generated`
 * push event. This keeps the RPC well under the uniform client timeout even when authoring
 * takes longer than the request budget.
 */
export interface TaskGenerateAck {
  /** The persistent orchestrator session, reachable immediately so its work is never lost. */
  orchestratorSessionId: string
}

export interface TaskGenerateResult {
  /** The persistent orchestrator session that authored the spec (also handles revisions). */
  orchestratorSessionId: string
  /** Slug of the authored spec; empty when generation produced an invalid spec. */
  slug: string
  /** Parsed TaskSpec when valid (consumers cast to TaskSpec from @craft-agent/shared/tasks). */
  spec?: unknown
  /** The raw task.yaml the orchestrator produced — shown and editable in the editor. */
  yaml: string
  validation: TaskValidationResultDto
  /** Set when generation failed before producing a spec (e.g. orchestrator turn errored/timed out). */
  error?: string
}

export interface TaskRunRequest {
  slug: string
  runId?: string
  orchestratorSessionId?: string
  params?: Record<string, unknown>
}

export interface TaskNodeRunStateDto {
  id: string
  /** pending | running | done | failed | cancelled | skipped */
  state: string
  sessionId?: string
  attempt: number
}

export interface TaskRunSnapshotDto {
  slug: string
  runId: string
  taskId: string
  /** running | paused | verifying | stopped | completed | failed */
  status: string
  orchestratorSessionId?: string
  nodes: TaskNodeRunStateDto[]
  /** Sum of each child's (input + output) tokens observed at completion. */
  tokensUsed: number
}

export interface TaskGetResult {
  slug: string
  validation: TaskValidationResultDto
  /** The parsed TaskSpec (from @craft-agent/shared/tasks) when valid; consumers cast. */
  spec?: unknown
  /** Active run snapshot when a runId was supplied and known; otherwise null. */
  run?: TaskRunSnapshotDto | null
}

/** One subtask's outcome in a completed/persisted run, for the editor's Results tab. */
export interface TaskResultNodeDto {
  id: string
  title: string
  /** pending | running | awaiting-approval | done | failed | cancelled | skipped */
  state: string
  /** The child session that ran this node, recovered from the run log (drill-in link). */
  sessionId?: string
  /** The node's recorded final output text (from nodes/<id>.json), when present. */
  output?: string
  /** The node's declared structured fields (its `outputs:`), as filed at completion. These are
   *  what a downstream `${nodes.<id>.output.<field>}` — or a `when:` condition — reads. */
  params?: Record<string, unknown>
  /** For a gate node (`kind: approval`) when it is the question put to the person — i.e. what is
   *  being approved. Present whenever `state` is `awaiting-approval`. */
  approvalPrompt?: string
}

/**
 * Storage-backed read of a task run's outcome — verdict + per-node final output, recovered from
 * the persisted run artifacts (run-log.jsonl, nodes/<id>.json, per-run spec.json snapshot). Unlike
 * `TaskRunSnapshotDto` this survives restart and does not require an active in-memory run.
 */
export interface TaskResultsDto {
  slug: string
  /** The run inspected; null when the task has never been run. */
  runId: string | null
  /** All run ids for this task (newest last), for a run picker. */
  runIds: string[]
  /** The most recent verdict (kept for back-compat with single-verdict consumers). */
  verdict?: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }
  /** Every verdict in order (a FAIL→repair loop produces several), for the Results history view. */
  verdicts?: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }[]
  /** Repair-loop accounting: attempts consumed (= count of FAIL verdicts) and the resolved cap. */
  repair?: { used: number; max: number }
  /** Terminal run status recovered from the run-log (completed | failed | stopped | …). */
  runStatus?: string
  /** The run's acceptance criteria (from the per-run spec snapshot), shown above the verdict. */
  acceptanceCriteria?: string
  nodes: TaskResultNodeDto[]
}

export interface PermissionModeState {
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion: number
  changedAt: string
  changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

// ---------------------------------------------------------------------------
// Session events (main → renderer)
// ---------------------------------------------------------------------------

// turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
export type SessionEvent =
  | { type: 'text_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'text_complete'; sessionId: string; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; timestamp?: number; messageId?: string }
  | { type: 'tool_start'; sessionId: string; toolName: string; toolUseId: string; toolInput: Record<string, unknown>; toolIntent?: string; toolDisplayName?: string; toolDisplayMeta?: ToolDisplayMeta; turnId?: string; parentToolUseId?: string; timestamp?: number }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; toolName: string; result: string; turnId?: string; parentToolUseId?: string; isError?: boolean; timestamp?: number }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | { type: 'typed_error'; sessionId: string; error: TypedError; timestamp?: number }
  | { type: 'complete'; sessionId: string; tokenUsage?: Session['tokenUsage']; hasUnread?: boolean; backgroundTasksAlive?: boolean }
  | { type: 'interrupted'; sessionId: string; message?: Message; queuedMessages?: string[] }
  | { type: 'status'; sessionId: string; message: string; statusType?: 'compacting' }
  | { type: 'info'; sessionId: string; message: string; statusType?: 'compaction_complete'; level?: 'info' | 'warning' | 'error' | 'success'; timestamp?: number }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | { type: 'working_directory_changed'; sessionId: string; workingDirectory: string }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'credential_request'; sessionId: string; request: CredentialRequest }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: PermissionModeState['changedBy'] }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'sources_changed'; sessionId: string; enabledSourceSlugs: string[] }
  | { type: 'labels_changed'; sessionId: string; labels: string[] }
  | { type: 'project_id_changed'; sessionId: string; projectId: string | null }
  | { type: 'prototype_slug_changed'; sessionId: string; prototypeSlug: string | null }
  | { type: 'connection_changed'; sessionId: string; connectionSlug: string; supportsBranching?: boolean }
  | { type: 'task_backgrounded'; sessionId: string; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
  | { type: 'shell_backgrounded'; sessionId: string; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; sessionId: string; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'workflow_agent_completed'; sessionId: string; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | { type: 'user_message'; sessionId: string; message: Message; status: 'accepted' | 'queued' | 'processing'; optimisticMessageId?: string }
  | { type: 'session_flagged'; sessionId: string }
  | { type: 'session_unflagged'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | { type: 'session_model_changed'; sessionId: string; model: string | null }
  | { type: 'session_status_changed'; sessionId: string; sessionStatus: SessionStatus }
  | { type: 'session_metadata_changed'; sessionId: string; changes: Partial<Pick<Session, 'taskNodeCount' | 'taskAwaitingApproval' | 'kanbanColumn' | 'taskDraft' | 'taskSlug' | 'projectId' | 'prototypeSlug'>> }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_shared'; sessionId: string; sharedUrl: string }
  | { type: 'session_unshared'; sessionId: string }
  | { type: 'auth_request'; sessionId: string; message: Message; request: SharedAuthRequest }
  | { type: 'auth_completed'; sessionId: string; requestId: string; success: boolean; cancelled?: boolean; error?: string }
  | { type: 'source_activated'; sessionId: string; sourceSlug: string; originalMessage: string }
  | { type: 'usage_update'; sessionId: string; tokenUsage: { inputTokens: number; contextWindow?: number } }
  | { type: 'message_annotations_updated'; sessionId: string; messageId: string; annotations: AnnotationV1[] }
  | { type: 'working_directory_error'; sessionId: string; error: string }

export interface SendMessageOptions {
  skillSlugs?: string[]
  badges?: ContentBadge[]
  optimisticMessageId?: string
  /**
   * When true, the message drives a turn (reaches the model) but is marked
   * `hidden` on the persisted `Message` so it never renders as a transcript
   * bubble. Used for system-generated nudges (e.g. WS2 background-task-completion
   * surfacing) that should wake the agent without looking user-authored.
   */
  hidden?: boolean
}

// ---------------------------------------------------------------------------
// Session commands (consolidated operations)
// ---------------------------------------------------------------------------

export type SessionCommand =
  | { type: 'flag' }
  | { type: 'unflag' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'setSessionStatus'; state: SessionStatus }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'updateWorkingDirectory'; dir: string }
  | { type: 'setSources'; sourceSlugs: string[] }
  | { type: 'setLabels'; labels: string[] }
  | { type: 'setProjectId'; projectId: string | null }
  /** Bind or unbind this session to a prototype. Pass null to unbind. */
  | { type: 'setPrototypeSlug'; prototypeSlug: string | null }
  | { type: 'setKanbanColumn'; column: string | null }
  | { type: 'showInFinder' }
  | { type: 'copyPath' }
  | { type: 'shareToViewer' }
  | { type: 'updateShare' }
  | { type: 'revokeShare' }
  | { type: 'refreshTitle' }
  | { type: 'setConnection'; connectionSlug: string }
  | { type: 'setPendingPlanExecution'; planPath: string; draftInputSnapshot?: string }
  | { type: 'markCompactionComplete' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | { type: 'updateAnnotation'; messageId: string; annotationId: string; patch: Partial<AnnotationV1> }

export interface NewChatActionParams {
  input?: string
  name?: string
}

// ---------------------------------------------------------------------------
// Permission / credential types
// ---------------------------------------------------------------------------

export type { BasePermissionRequest }

/**
 * Permission request with session context (for multi-session Electron app)
 */
export interface PermissionRequest extends BasePermissionRequest {
  sessionId: string
}

export interface PermissionResponseOptions {
  rememberForMinutes?: number
}

// Re-export for handler convenience
export type { SharedCredentialInputMode as CredentialInputMode }
export type CredentialRequest = SharedCredentialAuthRequest
export type { SharedAuthRequest as AuthRequest }

export interface CredentialResponse {
  type: 'credential'
  value?: string
  username?: string
  password?: string
  headers?: Record<string, string>
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// Directory browsing types (remote mode)
// ---------------------------------------------------------------------------

/** Server-side directory listing result (for remote directory browsing). */
export interface DirectoryListingResult {
  /** Normalized absolute path of the listed directory (after resolve(), not symlink-resolved). */
  currentPath: string
  /** Parent directory path, or null if at root. */
  parentPath: string | null
  /** Pre-split breadcrumb segments for display (computed server-side). */
  breadcrumbs: Array<{ name: string; path: string }>
  /** Server platform info. */
  platform: 'win32' | 'darwin' | 'linux'
  /** Whether the server truncated the directory list for safety/performance. */
  truncated: boolean
  /** Total number of matching child directories before truncation. */
  totalEntries: number
  /** Child directory entries. */
  entries: Array<{ name: string; path: string; isSymlink: boolean }>
}

// ---------------------------------------------------------------------------
// File types
// ---------------------------------------------------------------------------

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown'
  path: string
  name: string
  mimeType: string
  base64?: string
  text?: string
  size: number
  thumbnailBase64?: string
}

export interface SessionFile {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: SessionFile[]
}

export interface FileSearchResult {
  name: string
  path: string
  type: 'file' | 'directory'
  relativePath: string
}

// ---------------------------------------------------------------------------
// LLM connection types
// ---------------------------------------------------------------------------

/**
 * Resolved Anthropic OAuth identity (issue #838), captured from the
 * token-exchange response. Shape mirrors `ClaudeOAuthIdentity` in
 * `auth/claude-oauth.ts`; kept in the protocol layer so DTOs stay decoupled
 * from the auth module. All fields optional and fail-soft.
 */
export interface ClaudeOAuthIdentityDto {
  account?: { uuid?: string; emailAddress?: string }
  organization?: { uuid?: string; name?: string }
}

export interface LlmConnectionSetup {
  slug: string
  credential?: string
  baseUrl?: string | null
  defaultModel?: string | null
  /** Explicit small/fast model (title generation, summarization, mini agents). Absent = not picked, `null` = cleared. */
  fastModel?: string | null
  /** Model ids, or ids with per-model parameters for custom endpoints. */
  models?: ConnectionModelEntry[] | null
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** When true, reject setup if the connection doesn't already exist (reauth guard). */
  updateOnly?: boolean
  /** Custom endpoint protocol for arbitrary OpenAI/Anthropic-compatible APIs */
  customEndpoint?: CustomEndpointConfig
  /** IAM credentials for Pi+Bedrock (piAuthProvider='amazon-bedrock') connections */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock connections */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  bedrockAuthMethod?: 'iam_credentials' | 'environment'
  /**
   * Resolved Anthropic OAuth identity (issue #838), threaded through setup so it
   * persists for both new and re-auth connections. Optional and fail-soft.
   */
  oauthIdentity?: ClaudeOAuthIdentityDto
}

export interface TestLlmConnectionParams {
  provider: 'anthropic' | 'pi'
  apiKey: string
  baseUrl?: string
  model?: string
  piAuthProvider?: string
  /** Optional custom endpoint protocol hint so setup tests mirror runtime routing */
  customEndpoint?: CustomEndpointConfig
}

export interface TestLlmConnectionResult {
  success: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Source / skill types
// ---------------------------------------------------------------------------

export interface SkillFile {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: SkillFile[]
}

export interface OAuthResult {
  success: boolean
  error?: string
}

export interface McpValidationResult {
  success: boolean
  error?: string
  tools?: string[]
}

export interface McpToolWithPermission {
  name: string
  description?: string
  allowed: boolean
}

export interface McpToolsResult {
  success: boolean
  error?: string
  tools?: McpToolWithPermission[]
}

// ---------------------------------------------------------------------------
// Search types
// ---------------------------------------------------------------------------

export interface SessionSearchMatch {
  sessionId: string
  lineNumber: number
  snippet: string
}

export interface SessionSearchResult {
  sessionId: string
  matchCount: number
  matches: SessionSearchMatch[]
}

// ---------------------------------------------------------------------------
// Session result types
// ---------------------------------------------------------------------------

export interface UnreadSummary {
  totalUnreadSessions: number
  byWorkspace: Record<string, number>
  hasUnreadByWorkspace: Record<string, boolean>
}

export interface ShareResult {
  success: boolean
  url?: string
  error?: string
}

export interface RefreshTitleResult {
  success: boolean
  title?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string
  description: string
  tools?: string[]
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

export interface Plan {
  id: string
  title: string
  summary?: string
  steps: PlanStep[]
  questions?: string[]
  state?: 'creating' | 'refining' | 'ready' | 'executing' | 'completed' | 'cancelled'
  createdAt?: number
  updatedAt?: number
}

// ---------------------------------------------------------------------------
// System types
// ---------------------------------------------------------------------------

export interface GitBashStatus {
  found: boolean
  path: string | null
  platform: 'win32' | 'darwin' | 'linux'
}

export interface UpdateInfo {
  available: boolean
  currentVersion: string
  latestVersion: string | null
  downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'
  downloadProgress: number
  error?: string
}

// ---------------------------------------------------------------------------
// Workspace types
// ---------------------------------------------------------------------------

export interface WorkspaceSettings {
  name?: string
  model?: string
  permissionMode?: PermissionMode
  cyclablePermissionModes?: PermissionMode[]
  thinkingLevel?: ThinkingLevel
  workingDirectory?: string
  localMcpEnabled?: boolean
  defaultLlmConnection?: string
  enabledSourceSlugs?: string[]
}

// ---------------------------------------------------------------------------
// Auth result types
// ---------------------------------------------------------------------------

export interface ClaudeOAuthResult {
  success: boolean
  token?: string
  error?: string
  /**
   * Resolved Anthropic identity (issue #838), forwarded to the renderer so it
   * can thread it into the SETUP payload (which is what persists it). Present
   * only when the token-exchange response carried identity.
   */
  identity?: ClaudeOAuthIdentityDto
}

// ---------------------------------------------------------------------------
// Automation types
// ---------------------------------------------------------------------------

export type TestAutomationAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel }
  | { type: 'webhook'; url: string; method?: string; headers?: Record<string, string>; bodyFormat?: 'json' | 'form' | 'raw'; body?: unknown; captureResponse?: boolean; auth?: { type: 'basic'; username: string; password: string } | { type: 'bearer'; token: string } }

export interface TestAutomationPayload {
  workspaceId: string
  automationId?: string
  automationName?: string
  actions: TestAutomationAction[]
  permissionMode?: PermissionMode
  labels?: string[]
  /** Forwarded from the matcher; routes test-run sessions into a Telegram topic when paired. */
  telegramTopic?: string
}

export type TestAutomationActionResult =
  | { type: 'prompt'; success: boolean; stderr?: string; sessionId?: string; duration: number }
  | { type: 'webhook'; success: boolean; url: string; statusCode: number; error?: string; duration: number }

export interface TestAutomationResult {
  actions: TestAutomationActionResult[]
}

// ---------------------------------------------------------------------------
// Window types
// ---------------------------------------------------------------------------

export type WindowCloseRequestSource = 'keyboard-shortcut' | 'window-button' | 'unknown'

export interface WindowCloseRequest {
  source: WindowCloseRequestSource
}

// ---------------------------------------------------------------------------
// Browser / navigation types (data shapes used by BroadcastEventMap)
// ---------------------------------------------------------------------------

/**
 * Element picked by the prototype-workbench element picker.
 *
 * Shared across the picker (BrowserCDP), the browser-pane capability wire
 * protocol, and the `browser_tool pick` command — defined once here so the
 * shape cannot drift between the three.
 */
export interface PickedElement {
  /** Stable selector: `data-testid` > `id` > `:nth-of-type` path. */
  selector: string
  /** Lowercase tag name. */
  tag: string
  /** Trimmed text content, truncated to 200 chars. */
  text: string
  /** Viewport-relative bounding box. */
  rect: { x: number; y: number; width: number; height: number }
  /**
   * What the person asked for by the way they picked it (plan §12.7).
   *
   * The picker can show one button under the selection — "add to conversation" —
   * and which button was used is a fact about the gesture, not about the element.
   * It rides along on the element so it travels the existing paths (toolbar
   * action, agent command) instead of needing a second result channel: an element
   * picked that way is still an element, one that was picked *for* something.
   */
  intent?: 'add-to-conversation'
}

/**
 * Where a picked element came from: the tab it was picked on (plan §12.7).
 *
 * The picker belongs to the **window**, and stays armed while the user moves
 * between its tabs — any tab's elements can be picked, and the same gesture on
 * two tabs means two different places to change. So the tab it happened on
 * travels with the element, and the chip and the agent read it from there.
 *
 * The same three answers a tab's summary gives about where it is, which is why
 * both are produced by one function in the pane manager.
 */
export interface PickedElementOrigin {
  /** The address the tab was on when the element was picked. */
  url: string
  /** That tab's title. */
  title: string
  /** The prototype this tab is for, if it is one. */
  prototype: BrowserTabPrototype | null
  /** Which page of that prototype, when the prototype's page table knows. */
  prototypePage: string | null
}

/** One element an edit made in the window's editor acts on. */
export interface BrowserEditTarget {
  selector: string
  /** Lowercase tag name, for a report the person reads. */
  tag: string
}

/**
 * One edit the person made in the window's editor.
 *
 * What the *page* knows, and nothing more: which elements were boxed and what to
 * set on them, or the element whose text was replaced and what it now says. Where
 * the change belongs is not here — a patch of which prototype and which page is a
 * fact about the window the edit came from, and the main window is the side that
 * knows it (`edit-patch.ts` writes the file).
 */
export interface BrowserEdit {
  kind: 'style' | 'text'
  targets: BrowserEditTarget[]
  /** Style edits: what to set, e.g. `{ 'font-weight': '700' }`. */
  declarations?: Record<string, string>
  /** Text edits: the element's new text. */
  text?: string
}

/**
 * An action the browser panel's toolbar forwards to the main window.
 *
 * The panel has no workspace or prototype context of its own (it is a separate
 * render process), so it reports *what the user did* and lets the main window —
 * which owns the binding — decide what it means.
 */
export type BrowserToolbarAction =
  | {
      kind: 'picked'
      instanceId: string
      /** Null when the user pressed Escape or the pick timed out. */
      element: PickedElement | null
    }
  /**
   * The person pressed save in the window's editor: everything they accumulated is
   * on its way to being written down.
   *
   * A list, not one edit: the session's edits are one moment of intent, so the main
   * window writes them as one entry in the change layer (a patch file, or two when
   * the session did both styles and text). Until this arrives, nothing has been
   * written anywhere — which is what makes the draft cheap to take back.
   */
  | { kind: 'edit-requested'; instanceId: string; edits: BrowserEdit[] }
  /**
   * The person used the bar under the highlight: the element goes into a
   * conversation rather than into a prototype patch (plan §12.7).
   *
   * Separate from `picked` because the two do different things with the same
   * element — one opens the prototype's edit flow, the other writes a draft — and
   * this one needs no prototype at all, only a conversation.
   *
   * `origin` is the tab inside the window this pick came from: with the picker
   * resident across the window's tabs, the element alone does not say where it
   * was picked, and that is the part the conversation needs to act on it.
   */
  | { kind: 'add-to-conversation'; instanceId: string; element: PickedElement; origin: PickedElementOrigin }
  /**
   * The user typed one of a prototype's own addresses into the window's address
   * bar.
   *
   * Two shapes, and both are "where the view should actually load": the root names
   * the prototype, so it is opened the way the workbench opens one (its entry
   * page, or the page index) and the bar keeps saying which prototype this is;
   * `page` names one page, which is resolved to that page's own address and loaded
   * directly — the bar is a display of where the window is, not a request the host
   * has to redirect.
   */
  | { kind: 'open-prototype'; instanceId: string; slug: string; page?: string | null }
  | { kind: 'pick-failed'; instanceId: string; message: string }

/**
 * The prototype a tab is for: the prototype, and its own origin
 * (`http://<slug>-<hash>.localhost`).
 *
 * The origin rather than the tab's address, because an overlay's document is
 * someone else's — once the view loads it, nothing in the URL says which
 * prototype the tab is working on.
 */
export interface BrowserTabPrototype {
  slug: string
  origin: string
}

/**
 * The **work a tab is part of** — whose tab it is (plan §22).
 *
 * The subject is the *work*, not the conversation doing it: a conversation is an
 * executor, and executors change while the work stays the same. A DAG node re-run
 * after a FAIL verdict (Conductor's repair loop) is a **new child session** for the
 * **same node**, and it has to inherit the tab its predecessor was working in — with
 * a session id as the subject, that tab would be an orphan the moment the first
 * session stopped, unreachable to the one that replaced it.
 *
 * Two kinds, and the difference is what the tab is a tab *of*:
 *
 * - `session` — a conversation's own work. The tab it opened, and the tabs opened
 *   from them (inheritance), are its task.
 * - `task` — a piece of a Tasks DAG: the whole task (`nodeId: null`, the
 *   orchestrator's own tabs), or one node of it. `taskSlug` + `runId` + `nodeId` are
 *   the node's identity and survive re-runs; `sessionId` is only **who opened it**,
 *   recorded so a person can be told which conversation's tab it was.
 *
 * Every variant carries `sessionId`, because a tab is always opened *by* a
 * conversation — that is the provenance, and the actor identity a command is checked
 * against. It is not part of "the same work": two sessions on the same node are the
 * same work, and two sessions on different nodes of one task are not.
 */
export type TabBelongsTo =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'task'
      /** The task's slug (`task.yaml`) — the same one every node of it carries. */
      taskSlug: string
      /** Which run of it, so two runs do not share tabs. */
      runId: string | null
      /** Which node of the DAG, or `null` for the task itself (the orchestrator's tabs). */
      nodeId: string | null
      /** Who opened this tab — provenance for the person reading the rail. Not identity. */
      sessionId: string
    }

/**
 * Whether two tabs are tabs of the **same work** — the same conversation, or the
 * same node of the same run of the same task (plan §22).
 *
 * The precise question, and the one `reach` is decided by: a tab of another node of
 * my task is not mine to work in. A re-run of a node *is* the same work, which is what
 * lets the replacement session pick up the tab its predecessor left.
 */
export function sameWork(a: TabBelongsTo | null, b: TabBelongsTo | null): boolean {
  if (!a || !b) return false
  if (a.kind === 'session' && b.kind === 'session') return a.sessionId === b.sessionId
  if (a.kind === 'task' && b.kind === 'task') {
    return a.taskSlug === b.taskSlug && a.runId === b.runId && a.nodeId === b.nodeId
  }
  return false
}

/**
 * Whether two tabs are tabs of the same **task**, whatever node and whatever run —
 * the looser question, used for housekeeping (plan §22).
 *
 * Closing is not working in: the orchestrator never opened its nodes' tabs, so a rule
 * that read the precise work would leave a finished run's tabs in the window forever.
 * Every conversation of a task may clean up after that task.
 */
export function sameTask(a: TabBelongsTo | null, b: TabBelongsTo | null): boolean {
  if (!a || !b) return false
  return a.kind === 'task' && b.kind === 'task' && a.taskSlug === b.taskSlug
}

/** The section of the tabs nobody's work owns — see {@link tabSectionOf}. */
export const PERSON_TAB_SECTION = 'person'

/**
 * Which **section of a window's tab list** a tab is drawn in (plan §22).
 *
 * Coarser than `sameWork`, on purpose and not by accident: the rail cuts a window's tabs into
 * one section per conversation and **one per task** — a task's nodes are one piece of work, so
 * their tabs are drawn together — and the tabs nobody's work owns are a section of their own.
 * Two surfaces need to agree on this: the two lists that draw a window's tabs (the rail and the
 * badge's list), and the window itself, which reads it to decide where the display goes when a
 * tab closes — the tab that takes over is a neighbour in the same section if there is one.
 *
 * **Not** an ownership question. A caller that reads this as reach hands one node of a DAG the
 * tabs of another; `sameWork` above is the precise one, and it is what `reach` is decided by.
 */
export function tabSectionOf(work: TabBelongsTo | null): string {
  if (!work) return PERSON_TAB_SECTION
  return work.kind === 'session' ? `session:${work.sessionId}` : `task:${work.taskSlug}`
}

/**
 * The work a conversation is part of, told from the fields a session carries (plan §22).
 *
 * **The one place a session becomes a tab's owner.** A Conductor child says which task, run
 * and node it executes — so the session that runs a node and the one repair spawns to re-run
 * the *same* node are the same work, and the second one inherits the tab rather than opening
 * another. The orchestrator, which carries the task but no node, is the task itself; a
 * conversation that is part of no task is its own work.
 */
export function workOfSession(session: {
  id: string
  taskSlug?: string
  taskRunId?: string
  taskNodeId?: string
}): TabBelongsTo {
  if (!session.taskSlug) return { kind: 'session', sessionId: session.id }
  return {
    kind: 'task',
    taskSlug: session.taskSlug,
    runId: session.taskRunId ?? null,
    nodeId: session.taskNodeId ?? null,
    sessionId: session.id,
  }
}

/**
 * A work, in words — for a message that has to say whose tab something is (plan §22).
 *
 * `"the task checkout-flow's node pay"`, `"session-4f2a…'s"`, or `"nobody's"` — never a bare
 * session id for a task tab, whose opener is provenance rather than the point.
 */
export function describeWork(work: TabBelongsTo | null): string {
  if (!work) return "nobody's"
  if (work.kind === 'session') return `${work.sessionId}'s`
  return work.nodeId ? `the task ${work.taskSlug}'s node ${work.nodeId}` : `the task ${work.taskSlug}`
}

/**
 * One tab of a browser window (plan §22).
 *
 * The fields are in three groups, because they are not equally trustworthy:
 *
 * - **observation** — what the tab itself reports (address, title, favicon,
 *   loading, which prototype and which of its pages it is on). One producer, so
 *   nothing here can disagree with the document it describes.
 * - **declaration** — whose work it is (`belongsTo`). Written once, when the
 *   tab is created, and never changed afterwards: a statement of intent.
 * - **lease** — who is working on it at the moment (`driverSessionId`). Written by
 *   whoever is using the tab and released when their turn ends: it says nothing
 *   about who the tab belongs to.
 *
 * Keeping them apart is the point: a caller that reads a declaration as a
 * measurement is reading somebody's intention as a fact, and one that reads a lease
 * as ownership will close work that is not theirs.
 *
 * `lockedBy` is none of the three: it is the tab's own **hold** — who is mid-work on it
 * right now — which is written while that work lasts and let go when it ends (see the
 * field).
 */
export interface BrowserTabSummary {
  /** Stable across the tab's life; what `--tab` and the toolbar name it by. */
  id: string

  // -- Observation ---------------------------------------------------------
  url: string
  title: string
  favicon: string | null
  isLoading: boolean
  /** Whether this is the tab the window is showing. */
  active: boolean
  /** The prototype this tab is for, or null for an ordinary tab. */
  prototype: BrowserTabPrototype | null
  /**
   * Which page of that prototype is on screen, or null when it cannot be told —
   * no prototype, or a page of it that the prototype's own page table does not
   * describe (a file, an SPA route). Read from the page table, never from the
   * address.
   */
  prototypePage: string | null
  /**
   * How the browser asked for this tab, when the browser asked for it rather than a
   * command opening it: `'link'` for a `target="_blank"`, `'popup'` for a scripted
   * `window.open` with features, `null` for every other way a tab comes to exist
   * (the address bar, `tab-new`, `prototype_tool open`, the panel).
   *
   * Here rather than in the declaration half because nobody *stated* it — the browser
   * reported it, the same way it reports a title. It is worth keeping because both are
   * now played in the same window, which costs the tab its `window.opener`: a popup
   * that waits for a `postMessage` from the tab that opened it (Google's sign-in) will
   * never get one, and this field is how that becomes diagnosable instead of mysterious
   * (plan §22).
   */
  disposition: 'link' | 'popup' | null

  // -- Declaration ---------------------------------------------------------
  /**
   * Which work this tab **belongs to**, or `null` for a person's tab.
   *
   * Written when the tab is created — by the conversation whose tool opened it, or by
   * **inheritance**: a tab derived from another (a `target="_blank"`, a popup, a link on a
   * page of ours) belongs to whatever the tab it came from belongs to (plan §22, 第十一轮).
   * Inheritance is what makes a conversation's tabs a *group* — the link it could not
   * follow itself still lands in its task — without asking who clicked, which could not be
   * answered anyway (an agent's click and a person's look the same from here).
   *
   * The reason it is here rather than derived: an agent must be able to leave other people's
   * tabs alone (plan §22's third rule), and "which of these are mine" is not visible in a
   * URL. It is also the key the tab rail groups by, so a window shows one section per task.
   *
   * The work rather than the conversation, because a tab outlives the session that opened
   * it — see {@link TabBelongsTo}. Which conversation is working here *now* is the lease's
   * answer (`driverSessionId` / `lockedBy`), and those stay session ids.
   */
  belongsTo: TabBelongsTo | null

  // -- Where a conversation works from ------------------------------------
  /**
   * Which conversation **works from this tab**, or `null` when it is no conversation's
   * tab — its cursor (plan §22, 第十轮).
   *
   * One tab per conversation, and it answers the question that otherwise has no answer:
   * *where does my next command go when I name no tab?* Not "wherever the window is
   * showing" — that tab belongs to the person, and it moves the moment they click, which
   * is how a user switching tabs used to silently retarget somebody's work.
   *
   * Sticky across turns, unlike the lease next to it: a conversation that comes back after
   * its turn ended still works from the same tab. It moves only when that conversation
   * names another tab (or opens one), and it is what the tab lock hangs off while its
   * overlay is up.
   */
  cursorOf: string | null

  // -- Lease ---------------------------------------------------------------
  /**
   * Which session is working on this tab **now**, or `null` when nobody is.
   *
   * A lease, per tab (plan §22): a conversation's command reaches the tab it works from —
   * its own cursor, which is written at the same moment — so that tab records who is driving
   * it, and the turn ending releases it. Several conversations sharing the window take turns
   * *here*, tab by tab, and this is what makes "who is moving which tab" answerable
   * instead of guessed.
   */
  driverSessionId: string | null

  // -- The lock ------------------------------------------------------------
  /**
   * Which session is **holding this tab at the moment**, or `null` when nobody is.
   *
   * The tab lock (plan §22, 第九轮): a tab is held while the conversation working on it is
   * mid-work, which is when a person cannot click or type into it and another conversation's
   * commands that name it are refused — narrower than a window-wide lock: the chrome, the
   * other tabs and the window itself stay usable.
   *
   * Per tab, stored on the tab: several conversations share one window (a parent and its
   * child sessions run in parallel — Conductor), each holding its own tab, so a single
   * window-level slot could only ever mean "whoever started last".
   */
  lockedBy: string | null
}

export interface BrowserInstanceInfo {
  id: string
  url: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /**
   * The window's tabs, in the order they were opened, with the active one marked.
   *
   * Optional so a renderer that pre-dates the field keeps working — treat missing
   * as a single-tab window. The window-level fields above stay the *active*
   * tab's, so a reader that only wants "what is on screen" needs nothing here.
   */
  tabs?: BrowserTabSummary[]
  /**
   * The prototype this window is working on, or `null` for a plain browser
   * window. The main process's answer, not something a renderer derives: an
   * overlay's view sits on a third-party address, so the URL cannot say it.
   *
   * Optional so a renderer that pre-dates the field keeps working — treat
   * missing as `null`.
   */
  prototypeSlug?: string | null
  isVisible: boolean
  agentControlActive: boolean
  themeColor: string | null
  /**
   * The workspace whose browser window this is, or `null` for a window opened
   * with no workspace context. It is the **whole** of the boundary: one window per
   * workspace, shared by every conversation in it, and no session owns it — which
   * conversation is working where is a fact about its **tabs** (`lockedBy`,
   * `cursorOf`, `belongsTo`), because a parent and its child sessions can be
   * in it at once (Conductor). Renderers
   * filter the tab strip / status badge by `activeWorkspaceId` so a conversation
   * in workspace A doesn't see windows of workspace B.
   *
   * Missing/null entries always pass the filter — this keeps older renderers
   * and main processes that pre-date the field working unchanged.
   */
  workspaceId?: string | null
}

export interface DeepLinkNavigation {
  view?: string
  tabType?: string
  tabParams?: Record<string, string>
  action?: string
  actionParams?: Record<string, string>
}
