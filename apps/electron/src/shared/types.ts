// =============================================================================
// Protocol re-exports (channels, DTOs, events, wire types)
// =============================================================================
export * from '@craft-agent/shared/protocol'

// =============================================================================
// Package re-exports (convenience for renderer imports)
// =============================================================================

// Core types
import type {
  Message as CoreMessage,
  MessageRole as CoreMessageRole,
  TypedError,
  TokenUsage as CoreTokenUsage,
  WorkspaceInfo as CoreWorkspaceInfo,
  Workspace as CoreWorkspace,
  SessionMetadata as CoreSessionMetadata,
  StoredAttachment as CoreStoredAttachment,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
} from '@craft-agent/core/types';

// Mode types from dedicated subpath export (avoids pulling in SDK)
import type { PermissionMode } from '@craft-agent/shared/agent/modes';
export type { PermissionMode };
export { PERMISSION_MODE_CONFIG } from '@craft-agent/shared/agent/modes';

// Thinking level types
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
export type { ThinkingLevel };
export { THINKING_LEVELS, DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels';

export type {
  CoreMessage as Message,
  CoreMessageRole as MessageRole,
  TypedError,
  CoreTokenUsage as TokenUsage,
  CoreWorkspaceInfo as WorkspaceInfo,
  CoreWorkspace as Workspace,
  CoreSessionMetadata as SessionMetadata,
  CoreStoredAttachment as StoredAttachment,
  ContentBadge,
  ToolDisplayMeta,
  AnnotationV1,
};

// Auth types for onboarding
import type { AuthState, SetupNeeds } from '@craft-agent/shared/auth/types';
import type { AuthType } from '@craft-agent/shared/config/types';
import type { ClientConfig, RemoteConnection } from '@craft-agent/shared/config/client-config';
export type { AuthState, SetupNeeds, AuthType, ClientConfig, RemoteConnection };

// Credential health types
import type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType } from '@craft-agent/shared/credentials/types';
export type { CredentialHealthStatus, CredentialHealthIssue, CredentialHealthIssueType };

// Source types for session source selection
import type { LoadedSource, FolderSourceConfig, SourceConnectionStatus } from '@craft-agent/shared/sources/types';
export type { LoadedSource, FolderSourceConfig, SourceConnectionStatus };

// Skill types
import type { LoadedSkill, SkillMetadata } from '@craft-agent/shared/skills/types';
export type { LoadedSkill, SkillMetadata };

// Resource bundle types (cross-workspace export/import)
import type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult } from '@craft-agent/shared/resources';
export type { ExportResourcesOptions, ExportResult, ResourceImportMode, ResourceBundle, ResourceImportResult };

// LLM connection types
import type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxyMode, NetworkProxySettings, BrowserProfile } from '@craft-agent/shared/config';
export type { LlmConnection, LlmConnectionWithStatus, LlmAuthType, LlmProviderType, NetworkProxyMode, NetworkProxySettings };
import type {
  DecisionLayerSettings,
  DecisionLayerSettingsPatch,
  DecisionLayerStatus,
  DecisionProviderId,
  DecisionServerProbe,
  DecisionTestResult,
} from '@craft-agent/shared/decisions';
export type { DecisionLayerSettings, DecisionLayerSettingsPatch, DecisionLayerStatus, DecisionProviderId, DecisionServerProbe, DecisionTestResult };

// =============================================================================
// GUI-only types (not used by server/handler code)
// =============================================================================

/**
 * Browser toolbar window IPC channels (preload <-> BrowserPaneManager).
 * Kept separate from RPC_CHANNELS because these are scoped to toolbar windows.
 */
export const BROWSER_TOOLBAR_CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  OPEN_MENU: 'browser-toolbar:open-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
  /** Manage this window's own tabs from the strip it draws: switch, close, add. */
  TABS: 'browser-toolbar:tabs',
} as const

/** Tool icon mapping entry from tool-icons.json (with icon resolved to data URL) */
export interface ToolIconMapping {
  id: string
  displayName: string
  /** Data URL of the icon (e.g., data:image/png;base64,...) */
  iconDataUrl: string
  commands: string[]
}

/**
 * Browser pane creation options
 */
/**
 * The page a create / open actually landed on.
 *
 * An address opened on a server is not on this machine's screen, so the caller that asked for
 * it also has to be able to *show* it: the viewer needs the window and the tab, not just the
 * fact that the call succeeded.
 */
export interface BrowserOpenedPage {
  instanceId: string
  /** Null when the window has no tab to show — nothing to watch, but the page did open. */
  tabId: string | null
}

export interface BrowserPaneCreateOptions {
  id?: string
  show?: boolean
  bindToSessionId?: string
  /**
   * Which profile's window to open, by id.
   *
   * The window is the profile (one per workspace and profile), so this says *which* window
   * the person asked for. Left out, the workspace's own answer is used — the same window
   * "Open browser" has always brought up.
   */
  profileId?: string
  /**
   * Give me a tab to use, opening the window if it is not up yet.
   *
   * *A* tab, not *another* tab: a window that has never been used already holds the
   * blank tab this is asking for, so its own tab is the answer and nothing is added
   * beside it — otherwise "New tab" on a browser that was not open yet would come up
   * with two identical blank tabs. A window that is in use gets a real new
   * tab. The rail's own `+` is the other intent and does not come through here: there
   * a person is looking at the window and asking for one more tab.
   */
  newTab?: boolean
}

/**
 * Manage one browser window's own tabs from the main window.
 *
 * The window is named because a tab only means something inside one; the action is one
 * of four because the four buttons that send it sit together, and `tabId` is absent only
 * for `new`, which has no target yet.
 */
export interface BrowserPaneTabAction {
  instanceId: string
  /**
   * `activate` / `close` / `new` manage the tabs. `release` is the person dismissing their
   * own half of a locked tab's overlay: the purple ring, the dim and the input shield go away
   * so they can work in the page, while the agent's hold — and every agent-to-agent rule that
   * reads it — stays exactly as it was.
   */
  action: 'activate' | 'close' | 'new' | 'release'
  tabId?: string
}

/**
 * Empty-state launch request from the browser empty-state renderer.
 */
export interface BrowserEmptyStateLaunchPayload {
  route: string
  token?: string
}

/**
 * Result of browser empty-state launch handling.
 */
export interface BrowserEmptyStateLaunchResult {
  ok: boolean
  handled: boolean
  reason?: string
}

export type TransportMode = 'local' | 'remote'

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind
  message: string
  code?: string
}

export interface TransportCloseInfo {
  code?: number
  reason?: string
  wasClean?: boolean
}

export interface TransportConnectionState {
  mode: TransportMode
  status: TransportConnectionStatus
  url: string
  attempt: number
  nextRetryInMs?: number
  lastError?: TransportConnectionError
  lastClose?: TransportCloseInfo
  updatedAt: number
}

// =============================================================================
// ElectronAPI — type-safe IPC API exposed to renderer
// =============================================================================

// Re-import types for ElectronAPI
import type { WorkspaceInfo, Workspace, SessionMetadata, StoredAttachment as StoredAttachmentType } from '@craft-agent/core/types';

// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type {
  Session,
  UnreadSummary,
  CreateSessionOptions,
  TaskValidationResultDto,
  TaskCreateRequest,
  TaskCreateResult,
  TaskGenerateRequest,
  TaskGenerateAck,
  TaskGenerateResult,
  TaskRunRequest,
  TaskRunSnapshotDto,
  TaskGetResult,
  TaskResultsDto,
  FileAttachment,
  SendMessageOptions,
  SessionEvent,
  PermissionResponseOptions,
  CredentialResponse,
  SessionCommand,
  ShareResult,
  RefreshTitleResult,
  FileSearchResult,
  SessionSearchResult,
  LlmConnectionSetup,
  TestLlmConnectionParams,
  TestLlmConnectionResult,
  SkillFile,
  SessionFile,
  OAuthResult,
  McpToolsResult,
  GitBashStatus,
  ClaudeOAuthResult,
  UpdateInfo,
  WorkspaceSettings,
  PermissionModeState,
  BrowserInstanceInfo,
  BrowserLoadError,
  BrowserStreamFrame,
  BrowserStreamInput,
  BrowserCaretRect,
  BrowserStreamStartRequest,
  BrowserStreamStartResult,
  BrowserToolbarAction,
  DeepLinkNavigation,
  TestAutomationPayload,
  TestAutomationResult,
  WindowCloseRequest,
  DirectoryListingResult,
  RemoteSessionTransferPayload,
  ImportRemoteSessionTransferResult,
  ConnectedClientInfo,
} from '@craft-agent/shared/protocol'

/** One device `device_tool` can name — also what Server → Devices lists. */
export type { DeviceToolInfo } from '@craft-agent/shared/agent/device-tool'
import type { DeviceToolInfo } from '@craft-agent/shared/agent/device-tool'

/**
 * What one window is connected to.
 *
 * Connection is a **window** property, not an install-wide mode: a window can be local while
 * another one talks to a hub. The saved connection holds the URL and token; a window carries the
 * resolved target for as long as it is open.
 */
export interface RemoteWindowTarget {
  /** The saved connection this window was opened on. */
  connectionId: string
  /** Resolved from the saved connection when the window is created or restored. */
  url: string
  token: string
  workspaceId?: string
  /** Display name of the hub, when known (shown in the tray and the title). */
  name?: string
}

/** This window's connection state, read by the server settings page and Connect to Server… */
export interface ClientModeInfo {
  /** Every server this app can open a window on. */
  connections: RemoteConnection[]
  /** The remote server **this window** is connected to (`null` = this window is local). */
  running: RemoteWindowTarget | null
  /** Server Mode is enabled in the local config. */
  serverEnabled: boolean
}

export interface ClientModeTestResult {
  ok: boolean
  error?: string
  serverVersion?: string
  workspaces?: Array<{ id: string; name: string }>
}

/** One saved server's reachability right now (`unknown` = no link yet). */
export interface RemoteConnectionStatus {
  id: string
  status: TransportConnectionStatus | 'unknown'
}

/** Stable identity of this install, as advertised on the WS handshake. */
export interface ClientIdentity {
  deviceId: string
  name: string
  platform: string
}

export interface ElectronAPI {
  // Session management
  getSessions(): Promise<Session[]>
  getUnreadSummary(): Promise<UnreadSummary>
  markAllSessionsRead(workspaceId: string): Promise<void>
  getSessionMessages(sessionId: string): Promise<Session | null>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachmentType[], options?: SendMessageOptions): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  cancelQueuedMessage(sessionId: string, messageId: string, content?: string): Promise<{ cancelled: boolean }>
  sendQueuedMessageNow(
    sessionId: string,
    messageId: string,
  ): Promise<{ sent: boolean; reason?: 'not-processing' | 'not-queued' | 'compacting' }>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>

  // Tasks (Conductor)
  validateTask(workspaceId: string, yaml: string): Promise<TaskValidationResultDto>
  createTask(workspaceId: string, req: TaskCreateRequest): Promise<TaskCreateResult>
  generateTask(workspaceId: string, req: TaskGenerateRequest): Promise<TaskGenerateAck>
  /** Async generate result (or error), keyed by orchestratorSessionId. Subscribe before/after generateTask. */
  onTaskGenerated(callback: (workspaceId: string, result: TaskGenerateResult) => void): () => void
  runTask(workspaceId: string, req: TaskRunRequest): Promise<TaskRunSnapshotDto>
  pauseTask(workspaceId: string, slug: string, runId: string): Promise<void>
  resumeTask(workspaceId: string, slug: string, runId: string): Promise<void>
  stopTask(workspaceId: string, slug: string, runId: string): Promise<void>
  getTask(workspaceId: string, slug: string, runId?: string): Promise<TaskGetResult>
  listTasks(workspaceId: string): Promise<string[]>
  getTaskResults(workspaceId: string, slug: string, runId?: string): Promise<TaskResultsDto>
  /** Answer a `kind: approval` gate node (a step a person decides, not a session). */
  resolveTaskApproval(
    workspaceId: string,
    slug: string,
    runId: string,
    nodeId: string,
    approved: boolean,
    note?: string,
  ): Promise<TaskRunSnapshotDto>

  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: PermissionResponseOptions): Promise<boolean>
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>

  // Consolidated session command handler
  sessionCommand(sessionId: string, command: Extract<SessionCommand, { type: 'markPendingPlanExecutionDispatched' }>): Promise<boolean>
  sessionCommand(sessionId: string, command: Exclude<SessionCommand, { type: 'markPendingPlanExecutionDispatched' }>): Promise<void | ShareResult | RefreshTitleResult | { count: number } | { reordered: boolean }>

  // Server info (REMOTE_ELIGIBLE — returns data from whichever server owns the workspace)
  getServerHomeDir(): Promise<string>

  // Server mode configuration
  getServerConfig(): Promise<import('@craft-agent/shared/config/server-config').ServerConfig>
  setServerConfig(config: import('@craft-agent/shared/config/server-config').ServerConfig): Promise<void>
  getServerStatus(): Promise<import('@craft-agent/shared/config/server-config').ServerStatus>
  /** Restart the server this window is on (the hub, in a remote window). */
  restartServer(): Promise<{ ok: boolean }>
  /** Devices other than this machine that this hub can drive (one row per machine). */
  getConnectedDevices(): Promise<DeviceToolInfo[]>
  /** Persist the hub-side switch for one device and return its updated row. */
  setDeviceUse(deviceId: string, use: boolean): Promise<DeviceToolInfo>
  /** Forget an offline device record. */
  forgetDevice(deviceId: string): Promise<void>

  // Remote connections (per window — direct IPC, works while connected to a remote server)
  getClientMode(): Promise<ClientModeInfo>
  /** Add or update a server this app can open windows on. */
  saveRemoteConnection(connection: RemoteConnection): Promise<RemoteConnection>
  removeRemoteConnection(connectionId: string): Promise<void>
  /** Open a window on a saved server, on `workspaceId` when given. */
  connectToRemoteConnection(connectionId: string, workspaceId?: string): Promise<void>
  testClientModeConnection(serverUrl: string, token: string): Promise<ClientModeTestResult>
  /**
   * Browse a **saved server's** filesystem, whichever server this window is on.
   *
   * Workspace creation is two-level (host, then folder): the host may be a server this window is
   * not connected to, so these take the connection explicitly instead of riding the window's client.
   */
  listRemoteDirectories(connectionId: string, dirPath: string, options?: { includeFiles?: boolean }): Promise<DirectoryListingResult>
  getRemoteHomeDir(connectionId: string): Promise<string>
  /** The workspaces a saved server owns — the second level of the workspace dropdown. */
  listRemoteWorkspaces(connectionId: string): Promise<WorkspaceInfo[]>
  /** Reachability of every saved server, shown next to its name. */
  getRemoteConnectionStatuses(): Promise<RemoteConnectionStatus[]>
  /**
   * Name this window's title. Only remote windows use it: their workspace is on the hub, so the
   * main process cannot resolve its name; `null` hands the title back to the automatic rule.
   */
  setWindowTitle(title: string | null): Promise<void>
  checkRemoteWorkspaceSlug(connectionId: string, slug: string): Promise<{ exists: boolean; path: string }>
  /** Register a workspace on that server. Opening an existing folder there is the same call. */
  createRemoteWorkspace(connectionId: string, folderPath: string, name: string): Promise<Workspace>
  /** Open a window connected to the saved remote server (or the one this window is on). */
  openRemoteWindow(workspaceId?: string): Promise<void>
  /**
   * Switch **this** remote window to another workspace on its hub, in place.
   *
   * The window and its connection stay; only the workspace the connection speaks for changes —
   * a remote folder re-opened in the same window. Throws when this window is not a remote one
   * (a local window switches with `switchWorkspace`).
   */
  switchRemoteWorkspace(workspaceId: string): Promise<void>
  /**
   * Point **this** window at a saved server, in place.
   *
   * Works from a local window as well: the hub connection is built and this window becomes a
   * remote one, the way VS Code reconnects a window to another host without opening a second one.
   */
  switchRemoteServer(connectionId: string, workspaceId?: string): Promise<void>
  /**
   * Bring **this** window back to this machine's server, in place.
   *
   * The inverse of `switchRemoteServer`: the hub connection is released and the window answers
   * from this machine again. Throws when the window is already local.
   */
  switchLocalWorkspace(workspaceId: string): Promise<void>
  /**
   * This machine's workspaces, whatever this window is currently on.
   *
   * `getWorkspaces` answers for the window's own server (the hub, in a remote window); the
   * workspace dropdown needs this one to offer "back to this machine".
   */
  getLocalWorkspaces(): Promise<Workspace[]>
  /** Open a window on this machine's own server. */
  openLocalWindow(): Promise<void>
  /** Electron webContents id of this window — used to mark "this window" in client lists. */
  getWebContentsId(): number
  /** This install's stable device identity — used to mark "this device" in browser-host pickers. */
  getClientIdentity(): ClientIdentity
  /**
   * Where this window now points: a saved server (edited, joined, or switched to) or `null` when
   * it is on this machine again. The transport has already been re-pointed; this only tells the
   * renderer which scope its UI should answer for.
   */
  onRemoteTargetChanged(callback: (target: RemoteWindowTarget | null) => void): () => void

  // App lifecycle
  relaunchApp(): Promise<void>
  removeWorkspace(workspaceId: string): Promise<boolean>

  // Remote session transfer (main-process orchestrated, supports chunked upload)
  transferSessionToWorkspace(sessionId: string, targetWorkspaceId: string, sessionIndex?: number, sessionCount?: number): Promise<{ sessionId: string }>
  onTransferProgress(callback: (progress: { sessionIndex: number; sessionCount: number; chunkSent: number; chunkTotal: number }) => void): () => void

  // Session export/import (cross-workspace transfer)
  exportSession(sessionId: string): Promise<unknown>
  importSession(targetWorkspaceId: string, bundle: unknown, mode: 'move' | 'fork'): Promise<{ sessionId: string; warnings?: string[] }>
  exportRemoteSessionTransfer(sessionId: string): Promise<RemoteSessionTransferPayload>
  importRemoteSessionTransfer(targetWorkspaceId: string, payload: RemoteSessionTransferPayload): Promise<ImportRemoteSessionTransferResult>

  // Pending plan execution (for reload recovery)
  getPendingPlanExecution(sessionId: string): Promise<{ planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null>
  // Permission mode reconciliation
  getSessionPermissionModeState(sessionId: string): Promise<PermissionModeState | null>

  // Workspace management
  getWorkspaces(): Promise<Workspace[]>
  createWorkspace(folderPath: string, name: string): Promise<Workspace>
  checkWorkspaceSlug(slug: string): Promise<{ exists: boolean; path: string }>

  // Server-level workspace operations (for remote window discovery)
  getServerWorkspaces(): Promise<WorkspaceInfo[]>
  createServerWorkspace(name: string): Promise<WorkspaceInfo>

  // Window management
  getWindowWorkspace(): Promise<string | null>
  getWindowMode(): Promise<string | null>
  openWorkspace(workspaceId: string): Promise<void>
  openSessionInNewWindow(workspaceId: string, sessionId: string): Promise<void>
  /** Open a design in its own window, or focus the one already showing it. */
  openDesignWindow(workspaceId: string, designSlug: string): Promise<void>
  switchWorkspace(workspaceId: string): Promise<void>
  closeWindow(): Promise<void>
  confirmCloseWindow(): Promise<void>
  /** Cancel a pending close request (renderer handled it by closing a modal/panel). */
  cancelCloseWindow(): Promise<void>
  /** Listen for close requests and receive source metadata. Returns cleanup function. */
  onCloseRequested(callback: (request: WindowCloseRequest) => void): () => void
  /** Show/hide macOS traffic light buttons (for fullscreen overlays) */
  setTrafficLightsVisible(visible: boolean): Promise<void>

  // Event listeners
  onSessionEvent(callback: (event: SessionEvent) => void): () => void
  onUnreadSummaryChanged(callback: (summary: UnreadSummary) => void): () => void

  // File operations
  readFile(path: string): Promise<string>
  /** Read a file as binary data (Uint8Array) */
  readFileBinary(path: string): Promise<Uint8Array>
  /** Read a file as a data URL (data:{mime};base64,...) for binary preview (images, PDFs) */
  readFileDataUrl(path: string): Promise<string>
  /** Read an image file as a size-bounded preview data URL for lightweight thumbnail rendering. */
  readFilePreviewDataUrl(path: string, maxSize?: number): Promise<string>
  /** Write UTF-8 content to a file. Bounded by this workspace's own folders. */
  writeFile(path: string, content: string): Promise<{ path: string }>
  openFileDialog(): Promise<string[]>
  readFileAttachment(path: string): Promise<FileAttachment | null>
  /** Re-read a user-attached file by absolute path (bypasses workspace-dir validation).
   *  Used only by draft hydration for paths the user explicitly picked via OS dialog / drag. */
  readUserAttachment(path: string): Promise<FileAttachment | null>
  storeAttachment(sessionId: string, attachment: FileAttachment): Promise<import('../../../../packages/core/src/types/index.ts').StoredAttachment>
  generateThumbnail(base64: string, mimeType: string): Promise<string | null>
  /** Returns the absolute filesystem path for a File (only works for file-picker / OS-drag Files). */
  getFilePath(file: File): string | null

  // Filesystem search (for @ mention file selection)
  searchFiles(basePath: string, query: string): Promise<FileSearchResult[]>

  // Server filesystem browsing (remote mode)
  listServerDirectory(dirPath: string, options?: { includeFiles?: boolean }): Promise<DirectoryListingResult>
  /** Whether `dirPath` currently exists as a directory on the server. */
  checkServerDirectory(dirPath: string): Promise<boolean>
  // Debug: send renderer logs to main process log file
  debugLog(...args: unknown[]): void

  // Theme
  getSystemTheme(): Promise<boolean>
  onSystemThemeChange(callback: (isDark: boolean) => void): () => void

  // System
  getVersions(): { node: string; chrome: string; electron: string }
  /** Returns the renderer host environment without going through RPC. */
  getRuntimeEnvironment(): 'electron' | 'web'
  getHomeDir(): Promise<string>
  isDebugMode(): Promise<boolean>

  // Transport connection status (preload-local, not RPC channels)
  getTransportConnectionState(): Promise<TransportConnectionState>
  onTransportConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void
  reconnectTransport(): Promise<void>

  /** Fired after a WebSocket reconnect. isStale=true means buffer was evicted — full refresh needed. */
  onReconnected(callback: (isStale: boolean) => void): () => void

  /** Check whether the server registered a handler for a given RPC channel. */
  isChannelAvailable(channel: string): boolean

  // Auto-update
  checkForUpdates(): Promise<UpdateInfo>
  getUpdateInfo(): Promise<UpdateInfo>
  installUpdate(): Promise<void>
  dismissUpdate(version: string): Promise<void>
  getDismissedUpdateVersion(): Promise<string | null>
  onUpdateAvailable(callback: (info: UpdateInfo) => void): () => void
  onUpdateDownloadProgress(callback: (progress: number) => void): () => void

  // Release notes
  getReleaseNotes(): Promise<string>
  getLatestReleaseVersion(): Promise<string | undefined>

  // System warnings (startup checks)
  getSystemWarnings(): Promise<{ vcredistMissing: boolean; downloadUrl?: string }>

  // Shell operations
  openUrl(url: string): Promise<void>
  openFile(path: string): Promise<void>
  showInFolder(path: string): Promise<void>

  // Menu event listeners
  onMenuNewChat(callback: () => void): () => void
  onMenuOpenSettings(callback: () => void): () => void
  onMenuKeyboardShortcuts(callback: () => void): () => void
  onMenuToggleFocusMode(callback: () => void): () => void
  onMenuToggleSidebar(callback: () => void): () => void

  // Deep link navigation listener (for external craftagents:// URLs)
  onDeepLinkNavigate(callback: (nav: DeepLinkNavigation) => void): () => void

  // Auth
  showLogoutConfirmation(): Promise<boolean>
  showDeleteSessionConfirmation(name: string): Promise<boolean>
  logout(): Promise<void>

  // Credential health check (startup validation)
  getCredentialHealth(): Promise<CredentialHealthStatus>

  // Onboarding
  getAuthState(): Promise<AuthState>
  getSetupNeeds(): Promise<SetupNeeds>
  startWorkspaceMcpOAuth(mcpUrl: string): Promise<OAuthResult & { clientId?: string }>
  // Claude OAuth (two-step flow)
  startClaudeOAuth(): Promise<{ success: boolean; authUrl?: string; error?: string }>
  exchangeClaudeCode(code: string, connectionSlug: string): Promise<ClaudeOAuthResult>
  hasClaudeOAuthState(): Promise<boolean>
  clearClaudeOAuthState(): Promise<{ success: boolean }>
  /** Defer onboarding setup — user chose "Setup later" */
  deferSetup(): Promise<{ success: boolean }>

  // ChatGPT OAuth (for Codex chatgptAuthTokens mode)
  startChatGptOAuth(connectionSlug: string): Promise<{ success: boolean; error?: string }>
  cancelChatGptOAuth(): Promise<{ success: boolean }>
  getChatGptAuthStatus(connectionSlug: string): Promise<{ authenticated: boolean; expiresAt?: number; hasRefreshToken?: boolean }>
  chatGptLogout(connectionSlug: string): Promise<{ success: boolean }>

  // GitHub Copilot OAuth
  startCopilotOAuth(connectionSlug: string): Promise<{ success: boolean; error?: string }>
  cancelCopilotOAuth(): Promise<{ success: boolean }>
  getCopilotAuthStatus(connectionSlug: string): Promise<{ authenticated: boolean }>
  copilotLogout(connectionSlug: string): Promise<{ success: boolean }>
  onCopilotDeviceCode(callback: (data: { userCode: string; verificationUri: string }) => void): () => void

  /** Unified LLM connection setup */
  setupLlmConnection(setup: LlmConnectionSetup): Promise<{ success: boolean; error?: string }>
  /** Unified connection test — spawns a lightweight agent subprocess to validate credentials */
  testLlmConnectionSetup(params: TestLlmConnectionParams): Promise<TestLlmConnectionResult>
  // Pi provider discovery (main process only — Pi SDK can't run in renderer)
  getPiApiKeyProviders(): Promise<Array<{ key: string; label: string; placeholder: string }>>
  getPiProviderBaseUrl(provider: string): Promise<string | undefined>
  getPiProviderModels(provider: string): Promise<{ models: Array<{ id: string; name: string; costInput: number; costOutput: number; contextWindow: number; reasoning: boolean }>; totalCount: number }>

  // Session-specific model (overrides global)
  getSessionModel(sessionId: string, workspaceId: string): Promise<string | null>
  setSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>

  // Workspace Settings (per-workspace configuration)
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null>
  updateWorkspaceSetting<K extends keyof WorkspaceSettings>(workspaceId: string, key: K, value: WorkspaceSettings[K]): Promise<void>

  // Folder dialog
  openFolderDialog(): Promise<string | null>

  // User Preferences
  readPreferences(): Promise<{ content: string; exists: boolean; path: string }>
  writePreferences(content: string): Promise<{ success: boolean; error?: string }>

  // Session Drafts (persisted composer state — text + attachment refs)
  getDraft(sessionId: string): Promise<import('@craft-agent/shared/config').SessionDraft | null>
  setDraft(sessionId: string, draft: import('@craft-agent/shared/config').SessionDraft): Promise<void>
  deleteDraft(sessionId: string): Promise<void>
  getAllDrafts(): Promise<Record<string, import('@craft-agent/shared/config').SessionDraft>>

  // Session Info Panel
  getSessionFiles(sessionId: string): Promise<SessionFile[]>
  getSessionNotes(sessionId: string): Promise<string>
  setSessionNotes(sessionId: string, content: string): Promise<void>
  watchSessionFiles(sessionId: string): Promise<void>
  unwatchSessionFiles(): Promise<void>
  onSessionFilesChanged(callback: (sessionId: string) => void): () => void

  // Project files (workspace-level)
  watchProjectFiles(): Promise<void>
  unwatchProjectFiles(): Promise<void>
  onProjectFilesChanged(callback: (workspaceId: string, file: string | null) => void): () => void

  /**
   * A link clicked where React cannot see it — a sandboxed preview frame navigates the top
   * window, so main catches it and hands the URL here. The renderer decides where it opens.
   */
  onBrowserOpenLink(callback: (url: string) => void): () => void

  // Sources
  getSources(workspaceId: string): Promise<LoadedSource[]>
  createSource(workspaceId: string, config: Partial<FolderSourceConfig>): Promise<FolderSourceConfig>
  deleteSource(workspaceId: string, sourceSlug: string): Promise<void>
  startSourceOAuth(workspaceId: string, sourceSlug: string): Promise<{ success: boolean; error?: string }>
  saveSourceCredentials(workspaceId: string, sourceSlug: string, credential: string): Promise<void>
  getSourcePermissionsConfig(workspaceId: string, sourceSlug: string): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>
  getWorkspacePermissionsConfig(workspaceId: string): Promise<import('@craft-agent/shared/agent').PermissionsConfigFile | null>
  getDefaultPermissionsConfig(): Promise<{ config: import('@craft-agent/shared/agent').PermissionsConfigFile | null; path: string }>
  getMcpTools(workspaceId: string, sourceSlug: string): Promise<McpToolsResult>

  // OAuth (server-owned credentials, client-orchestrated flow)
  performOAuth(args: { sourceSlug: string; sessionId?: string; authRequestId?: string }): Promise<{ success: boolean; error?: string; email?: string }>
  oauthRevoke(sourceSlug: string): Promise<{ success: boolean }>

  // Session content search (full-text search via ripgrep)
  searchSessionContent(workspaceId: string, query: string, searchId?: string): Promise<SessionSearchResult[]>

  // Sources change listener (live updates when sources are added/removed)
  onSourcesChanged(callback: (workspaceId: string, sources: LoadedSource[]) => void): () => void

  // Default permissions change listener (live updates when default.json changes)
  onDefaultPermissionsChanged(callback: () => void): () => void

  // Skills
  getSkills(workspaceId: string, workingDirectory?: string): Promise<LoadedSkill[]>
  getSkillFiles?(workspaceId: string, skillSlug: string): Promise<SkillFile[]>
  deleteSkill(workspaceId: string, skillSlug: string): Promise<void>
  openSkillInEditor(workspaceId: string, skillSlug: string): Promise<void>
  openSkillInFinder(workspaceId: string, skillSlug: string): Promise<void>

  // Skills change listener (live updates when skills are added/removed/modified)
  onSkillsChanged(callback: (workspaceId: string, skills: LoadedSkill[]) => void): () => void

  // Statuses (workspace-scoped)
  listStatuses(workspaceId: string): Promise<import('@craft-agent/shared/statuses').StatusConfig[]>
  reorderStatuses(workspaceId: string, orderedIds: string[]): Promise<void>
  onStatusesChanged(callback: (workspaceId: string) => void): () => void

  // Labels (workspace-scoped)
  listLabels(workspaceId: string): Promise<import('@craft-agent/shared/labels').LabelConfig[]>
  createLabel(workspaceId: string, input: import('@craft-agent/shared/labels').CreateLabelInput): Promise<import('@craft-agent/shared/labels').LabelConfig>
  deleteLabel(workspaceId: string, labelId: string): Promise<{ stripped: number }>
  onLabelsChanged(callback: (workspaceId: string) => void): () => void

  // LLM connections change listener
  onLlmConnectionsChanged(callback: () => void): () => void

  // Views (workspace-scoped, stored in views.json)
  listViews(workspaceId: string): Promise<import('@craft-agent/shared/views').ViewConfig[]>
  saveViews(workspaceId: string, views: import('@craft-agent/shared/views').ViewConfig[]): Promise<void>

  // Generic workspace image loading/saving
  readWorkspaceImage(workspaceId: string, relativePath: string): Promise<string>
  writeWorkspaceImage(workspaceId: string, relativePath: string, base64: string, mimeType: string): Promise<void>

  // Tool icon mappings
  getToolIconMappings(): Promise<ToolIconMapping[]>

  // Theme (app-level default)
  getAppTheme(): Promise<import('@config/theme').ThemeOverrides | null>
  loadPresetThemes(): Promise<import('@config/theme').PresetTheme[]>
  loadPresetTheme(themeId: string): Promise<import('@config/theme').PresetTheme | null>
  getColorTheme(): Promise<string>
  setColorTheme(themeId: string): Promise<void>
  getWorkspaceColorTheme(workspaceId: string): Promise<string | null>
  setWorkspaceColorTheme(workspaceId: string, themeId: string | null): Promise<void>
  getAllWorkspaceThemes(): Promise<Record<string, string | undefined>>

  // Theme change listeners
  onAppThemeChange(callback: (theme: import('@config/theme').ThemeOverrides | null) => void): () => void

  // Logo URL resolution
  getLogoUrl(serviceUrl: string, provider?: string): Promise<string | null>

  // Notifications
  showNotification(title: string, body: string, workspaceId: string, sessionId: string): Promise<void>
  getNotificationsEnabled(): Promise<boolean>
  setNotificationsEnabled(enabled: boolean): Promise<void>

  // Input settings
  getSendMessageKey(): Promise<'enter' | 'cmd-enter'>
  setSendMessageKey(key: 'enter' | 'cmd-enter'): Promise<void>
  getSpellCheck(): Promise<boolean>
  setSpellCheck(enabled: boolean): Promise<void>

  // Power settings
  getKeepAwakeWhileRunning(): Promise<boolean>
  setKeepAwakeWhileRunning(enabled: boolean): Promise<void>

  // Tools settings
  getBrowserToolEnabled(): Promise<boolean>
  setBrowserToolEnabled(enabled: boolean): Promise<void>

  // Appearance settings
  getRichToolDescriptions(): Promise<boolean>
  setRichToolDescriptions(enabled: boolean): Promise<void>

  // Prompt caching & context
  getExtendedPromptCache(): Promise<boolean>
  setExtendedPromptCache(enabled: boolean): Promise<void>
  getEnable1MContext(): Promise<boolean>
  setEnable1MContext(enabled: boolean): Promise<void>

  // RTK token optimization
  getRtkEnabled(): Promise<boolean>
  setRtkEnabled(enabled: boolean): Promise<void>
  getRtkStatus(opts?: { forceRecheck?: boolean }): Promise<{ installed: boolean; path: string | null; version: string | null }>
  getRtkGain(): Promise<{ totalCommands: number; totalInput: number; totalOutput: number; totalSaved: number; avgSavingsPct: number; totalTimeMs: number; avgTimeMs: number } | null>

  // Decision model (Jev / TypeSafe System One) — opt-in decision layer
  getDecisionLayerSettings(): Promise<DecisionLayerSettings>
  setDecisionLayerSettings(patch: DecisionLayerSettingsPatch): Promise<DecisionLayerSettings>
  getDecisionLayerStatus(): Promise<DecisionLayerStatus>
  setDecisionApiKey(provider: DecisionProviderId, apiKey: string): Promise<void>
  deleteDecisionApiKey(provider: DecisionProviderId): Promise<boolean>
  testDecisionConnection(options?: { settings?: DecisionLayerSettingsPatch; apiKey?: string }): Promise<DecisionTestResult>
  /** GET {baseUrl}/health of the configured local decision server (Laya / custom). Never rejects for network errors. */
  probeDecisionServer(options?: { baseUrl?: string }): Promise<DecisionServerProbe>

  // Network proxy settings
  getNetworkProxySettings(): Promise<NetworkProxySettings | undefined>
  setNetworkProxySettings(settings: NetworkProxySettings): Promise<void>

  refreshBadge(): Promise<void>
  setDockIconWithBadge(dataUrl: string, count?: number): Promise<void>
  onBadgeDraw(callback: (data: { count: number; iconDataUrl: string }) => void): () => void
  onBadgeDrawWindows(callback: (data: { count: number }) => void): () => void
  getWindowFocusState(): Promise<boolean>
  onWindowFocusChange(callback: (isFocused: boolean) => void): () => void
  /** Whether this window is maximized — the app draws the Windows caption buttons itself. */
  getWindowMaximizedState(): Promise<boolean>
  onWindowMaximizedChange(callback: (isMaximized: boolean) => void): () => void
  onNotificationNavigate(callback: (data: { workspaceId: string; sessionId: string }) => void): () => void

  // Theme preferences sync across windows
  broadcastThemePreferences(preferences: { mode: string; colorTheme: string; font: string }): Promise<void>
  onThemePreferencesChange(callback: (preferences: { mode: string; colorTheme: string; font: string }) => void): () => void

  // Workspace theme sync across windows
  broadcastWorkspaceThemeChange(workspaceId: string, themeId: string | null): Promise<void>
  onWorkspaceThemeChange(callback: (data: { workspaceId: string; themeId: string | null }) => void): () => void

  // Git operations
  getGitBranch(dirPath: string): Promise<string | null>

  // Git Bash (Windows)
  checkGitBash(): Promise<GitBashStatus>
  browseForGitBash(): Promise<string | null>
  setGitBashPath(path: string): Promise<{ success: boolean; error?: string }>

  // Menu actions (from renderer to main)
  menuQuit(): Promise<void>
  menuNewWindow(): Promise<void>
  menuMinimize(): Promise<void>
  menuMaximize(): Promise<void>
  menuZoomIn(): Promise<void>
  menuZoomOut(): Promise<void>
  menuZoomReset(): Promise<void>
  menuToggleDevTools(): Promise<void>
  menuUndo(): Promise<void>
  menuRedo(): Promise<void>
  menuCut(): Promise<void>
  menuCopy(): Promise<void>
  menuPaste(): Promise<void>
  menuSelectAll(): Promise<void>

  /**
   * Browser profiles — the named Chromium sessions a browser window can be signed into.
   *
   * `default` is always present and cannot be removed: it owns the session every login lived in
   * before profiles existed.
   */
  browserProfiles: {
    list(): Promise<BrowserProfile[]>
    create(name: string): Promise<BrowserProfile>
    rename(id: string, name: string): Promise<void>
    delete(id: string): Promise<void>
    /**
     * Which profile a conversation works in — its own pick, and what it would inherit.
     * `sessionProfileId` is null when the conversation follows its project or workspace.
     */
    resolve(sessionId: string): Promise<{
      sessionProfileId: string | null
      projectProfileId: string | null
      workspaceDefaultProfileId: string | null
      effectiveProfileId: string
    }>
  }

  // Browser pane management
  browserPane: {
    create(input?: string | BrowserPaneCreateOptions): Promise<string>
    destroy(id: string): Promise<void>
    list(): Promise<BrowserInstanceInfo[]>
    navigate(id: string, url: string): Promise<{ url: string; title: string }>
    /**
     * Open a local file as a page, in a new tab of the workspace's browser window.
     *
     * A path, not a URL: main turns it into the file's own address (see the channel).
     * A design belongs in that window because that is the surface the agent can keep
     * working on — `browser_tool` drives tabs, not frames inside this app.
     */
    openFile(path: string, sessionId?: string | null): Promise<BrowserOpenedPage>
    /**
     * Open a link as a page, in a new tab of the workspace's browser window.
     *
     * Where a link the person clicked goes by default — see `openInAppBrowser` in their
     * preferences, which is what the caller reads before choosing this over `openUrl`. Its
     * sibling for a file is `openFile`.
     *
     * `sessionId` is the conversation the click came from, when there was one: it picks the
     * profile, so a conversation that overrides the workspace profile keeps the page in its
     * own window (the one its `browser_tool` commands work in). Omitted — a link clicked
     * outside any conversation — falls back to the workspace's default profile.
     */
    openUrl(url: string, sessionId?: string | null): Promise<BrowserOpenedPage>
    goBack(id: string): Promise<void>
    goForward(id: string): Promise<void>
    reload(id: string): Promise<void>
    stop(id: string): Promise<void>
    focus(id: string): Promise<void>
    /** Manage this window's tabs: switch, close, add (see `BrowserPaneTabAction`). */
    tabAction(input: BrowserPaneTabAction): Promise<void>
    /**
     * Give one tab's page a viewport — the size a viewer draws it at.
     *
     * Optional `tabId` names a background tab; it is sized where it lives and the person's
     * window is left alone. The answer is the size the view actually ended up with, because
     * OS window floors can refuse part of the request (see `resizeViewport`).
     */
    resizeViewport(
      id: string,
      width: number,
      height: number,
      tabId?: string,
    ): Promise<{ width: number; height: number }>
    /**
     * Watch one tab from outside its window — a viewer in webui, or another machine.
     *
     * Frames arrive on `onStreamFrame`, only to the client that asked (docs/browser-view-streaming.md).
     * One capture per tab, one stream per viewer: a second viewer joins the same capture rather
     * than starting another. A tab that is being recorded is refused — the recorder owns a
     * second CDP session, and the manager does not hand out a viewer on top of it.
     */
    streamStart(input: BrowserStreamStartRequest): Promise<BrowserStreamStartResult>
    streamStop(streamId: string): Promise<void>
    /**
     * Whether this viewer may send input to the tab it is watching.
     *
     * Input is refused until the viewer has control. A free tab is claimed as soon as the
     * stream exists, so this is a permission check rather than a step a person has to perform.
     * A tab an agent holds is refused while that hold lasts — unless the person has dismissed
     * their own half of the lock (`overlayDismissed`), which unlocks input without touching
     * the agent's claim. Control ends with the stream; there is no "give back" step.
     */
    streamControl(streamId: string, controlled: boolean): Promise<void>
    /** Pointer/keyboard back to the tab being watched. Coordinates are the tab's CSS pixels. */
    streamInput(streamId: string, events: BrowserStreamInput[]): Promise<void>
    /**
     * Where the caret is in the watched tab, in that tab's CSS pixels.
     *
     * A viewer's invisible input parks its IME candidate window at this point, which is the only
     * way to put it where the person is actually typing: the caret belongs to a field on the
     * server. `null` when nothing editable has focus (or the stream is gone).
     */
    streamCaret(streamId: string): Promise<BrowserCaretRect | null>
    /** Frames for the stream this client started. Returns cleanup. */
    onStreamFrame(callback: (frame: BrowserStreamFrame) => void): () => void
    /**
     * The stream ended without being asked — its tab or window is gone, or capture stopped.
     * A viewer that does nothing here stays on the last frame it received.
     */
    onStreamEnded(callback: (streamId: string, reason: string) => void): () => void
    emptyStateLaunch(payload: BrowserEmptyStateLaunchPayload): Promise<BrowserEmptyStateLaunchResult>
    onStateChanged(callback: (info: BrowserInstanceInfo) => void): () => void
    onRemoved(callback: (id: string) => void): () => void
    onInteracted(callback: (id: string) => void): () => void
    /** Actions forwarded from a browser panel's own toolbar (pick / apply). */
    onToolbarAction(callback: (action: BrowserToolbarAction) => void): () => void
  }

  // LLM Connections (provider configurations)
  listLlmConnections(): Promise<LlmConnection[]>
  listLlmConnectionsWithStatus(): Promise<LlmConnectionWithStatus[]>
  getLlmConnection(slug: string): Promise<LlmConnection | null>
  getLlmConnectionApiKey(slug: string): Promise<string | null>
  saveLlmConnection(connection: LlmConnection): Promise<{ success: boolean; error?: string }>
  deleteLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  testLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  setDefaultLlmConnection(slug: string): Promise<{ success: boolean; error?: string }>
  getDefaultThinkingLevel(): Promise<ThinkingLevel>
  setDefaultThinkingLevel(level: ThinkingLevel): Promise<{ success: boolean; error?: string }>
  setWorkspaceDefaultLlmConnection(workspaceId: string, slug: string | null): Promise<{ success: boolean; error?: string }>

  // Projects (workspace-scoped)
  getProjects(workspaceId: string): Promise<unknown>
  getProject(workspaceId: string, projectIdOrSlug: string): Promise<unknown | null>
  getProjectLayers(workspaceId: string, projectSlug: string): Promise<import('@craft-agent/shared/projects').WorkLayers>
  /** Recursive file tree of a project's own folder (project files tab in the session info panel). */
  getProjectFiles(workspaceId: string, projectSlug: string): Promise<SessionFile[]>
  createProject(workspaceId: string, input: import('@craft-agent/shared/projects/types').CreateProjectInput): Promise<import('@craft-agent/shared/projects/types').ProjectConfig>
  updateProject(workspaceId: string, projectSlug: string, patch: Partial<Omit<import('@craft-agent/shared/projects/types').ProjectConfig, 'id' | 'slug' | 'createdAt'>>): Promise<import('@craft-agent/shared/projects/types').ProjectConfig>
  deleteProject(workspaceId: string, projectSlug: string): Promise<void>
  listProjectAssets(workspaceId: string, projectSlug: string): Promise<unknown>
  uploadProjectAsset(workspaceId: string, projectSlug: string, input: { filename: string; base64?: string; text?: string; sourcePath?: string }): Promise<import('@craft-agent/shared/projects/types').ProjectAsset>
  deleteProjectAsset(workspaceId: string, projectSlug: string, filename: string): Promise<void>
  onProjectsChanged(callback: (workspaceId: string, projects: unknown) => void): () => void

  // drawio (the app's own bundled editor, served at an origin of its own)
  /**
   * The origin the bundled editor is served at. Rejects when the bundle is not
   * installed, or when this host cannot serve an origin at all.
   */
  getDrawioOrigin(): Promise<string>

  // Tweaks (standing edits, authored by the agent — the UI only reads and toggles)
  getTweaks(workspaceId: string): Promise<import('@craft-agent/shared/tweaks').TweakSummary[]>
  getTweak(workspaceId: string, tweakSlug: string): Promise<import('@craft-agent/shared/tweaks').TweakDetails | null>
  /** The switch, plus name/description/patterns. Returns the updated details. */
  updateTweak(workspaceId: string, tweakSlug: string, patch: import('@craft-agent/shared/tweaks').UpdateTweakPatch): Promise<import('@craft-agent/shared/tweaks').TweakDetails | null>
  deleteTweak(workspaceId: string, tweakSlug: string): Promise<void>
  /** Build the loadable extension into a folder the person picked. */
  exportTweaks(workspaceId: string, destParent: string, tweakSlug: string, overwrite?: boolean): Promise<import('@craft-agent/shared/tweaks').TweaksExportResult>
  onTweaksChanged(callback: (workspaceId: string, tweaks: import('@craft-agent/shared/tweaks').TweakSummary[]) => void): () => void

  // Designs (workspace-scoped mini web pages)
  getDesigns(workspaceId: string): Promise<import('@craft-agent/shared/designs/types').LoadedDesign[]>
  getDesign(workspaceId: string, designIdOrSlug: string): Promise<import('@craft-agent/shared/designs/types').LoadedDesign | null>
  createDesign(workspaceId: string, input: import('@craft-agent/shared/designs/types').CreateDesignInput): Promise<import('@craft-agent/shared/designs/types').DesignConfig>
  /** Optional fields (projectId, description, refresh) accept explicit null = clear (undefined is dropped by the JSON transport). */
  updateDesign(workspaceId: string, designSlug: string, patch: Partial<Omit<import('@craft-agent/shared/designs/types').DesignConfig, 'id' | 'slug' | 'createdAt' | 'contentDigest' | 'lastRefresh' | 'grants' | 'share' | 'projectId' | 'description' | 'refresh'>> & { projectId?: string | null; description?: string | null; refresh?: import('@craft-agent/shared/designs/types').DesignRefreshSpec | null }): Promise<import('@craft-agent/shared/designs/types').DesignConfig>
  deleteDesign(workspaceId: string, designSlug: string): Promise<{ publicCopyMayRemain: boolean }>
  getDesignContent(workspaceId: string, designSlug: string): Promise<{ content: string | null; contentDigest?: string }>
  setDesignContent(workspaceId: string, designSlug: string, content: string): Promise<import('@craft-agent/shared/designs/types').DesignConfig>
  getDesignData(workspaceId: string, designSlug: string): Promise<import('@craft-agent/shared/designs/types').DesignDataSnapshot | null>
  listDesignGrants(workspaceId: string, designSlug: string): Promise<import('@craft-agent/shared/designs/types').DesignActionGrant[]>
  issueDesignGrant(workspaceId: string, designSlug: string, input: { action: import('@craft-agent/shared/designs/types').DesignActionDescriptor; description?: string; ttlMs?: number }): Promise<import('@craft-agent/shared/designs/types').DesignActionGrant>
  revokeDesignGrant(workspaceId: string, designSlug: string, grantId: string): Promise<boolean>
  createDesignLease(workspaceId: string, designSlug: string): Promise<{ lease: import('@craft-agent/shared/designs/types').DesignRenderLease; content: string; previewUrl?: string }>
  releaseDesignLease(workspaceId: string, leaseId: string): Promise<void>
  executeDesignAction(workspaceId: string, request: import('@craft-agent/shared/designs/types').DesignActionRequest): Promise<import('@craft-agent/shared/designs/types').DesignActionResult>
  cancelDesignAction(workspaceId: string, requestId: string): Promise<boolean>
  getDesignShareCapabilities(): Promise<{ sharingEnabled: boolean }>
  /** What `includeData` would publish + key paths that look credential-bearing (warn-only). */
  getDesignShareDataScan(workspaceId: string, designSlug: string): Promise<{ snapshotBytes: number | null; secretCandidates: string[] }>
  publishDesign(workspaceId: string, designSlug: string, options: { includeData: boolean; password?: string; viewOnlyAcknowledged?: boolean }): Promise<import('@craft-agent/shared/designs/types').DesignConfig>
  setDesignPublicationPassword(workspaceId: string, designSlug: string, password: string | null): Promise<import('@craft-agent/shared/designs/types').DesignConfig>
  unpublishDesign(workspaceId: string, designSlug: string): Promise<{ config: import('@craft-agent/shared/designs/types').DesignConfig; warning?: 'remote-copy-may-remain' }>
  /** Read a design's cached poster as a data URL — only returns when fresh (digest matches current content). */
  getDesignThumbnail(workspaceId: string, designSlug: string): Promise<{ dataUrl: string; digest: string } | null>
  /** Request a (re)capture of a design's poster (no-op on hosts without a capturer). */
  regenerateDesignThumbnail(workspaceId: string, designSlug: string): Promise<boolean>
  /**
   * Export a design to a file the person picks. Opens the native picker, then
   * writes it — PDF/PNG/video need the desktop app's hidden-window renderer, so
   * they throw on a host that has none (HTML/ZIP work anywhere).
   *
   * When the caller is not on the exporting machine (webui, thin client) the result carries a
   * `download` instead of a path; `saveDesignExport` fetches it.
   */
  exportDesign(workspaceId: string, designSlug: string, format: import('@craft-agent/shared/designs/types').DesignExportFormat): Promise<import('@craft-agent/shared/designs/types').DesignExportResult>
  /**
   * Fetch a hub-produced export and put it where the person asks.
   *
   * Electron: a native save dialog, then a streamed download from the window's hub. Web: the
   * browser's own download of the same URL.
   */
  saveDesignExport(download: import('@craft-agent/shared/designs/types').DesignExportDownload): Promise<{ canceled: true } | { canceled: false; path: string }>
  onDesignsChanged(callback: (workspaceId: string, pages: import('@craft-agent/shared/designs/types').LoadedDesign[]) => void): () => void

  // Automations
  getAutomations(workspaceId: string): Promise<unknown>

  // Automation testing (manual trigger)
  testAutomation(payload: TestAutomationPayload): Promise<TestAutomationResult>

  // Automation state management
  setAutomationEnabled(workspaceId: string, eventName: string, matcherIndex: number, enabled: boolean): Promise<void>
  duplicateAutomation(workspaceId: string, eventName: string, matcherIndex: number): Promise<void>
  deleteAutomation(workspaceId: string, eventName: string, matcherIndex: number): Promise<void>
  getAutomationHistory(workspaceId: string, automationId: string, limit?: number): Promise<Array<{ id: string; ts: number; ok: boolean; sessionId?: string; prompt?: string; error?: string; webhook?: { method: string; url: string; statusCode: number; durationMs: number; attempts?: number; error?: string; responseBody?: string } }>>
  getAutomationLastExecuted(workspaceId: string): Promise<Record<string, number>>
  replayAutomation(workspaceId: string, automationId: string, eventName: string): Promise<{ results: Array<{ type: string; url: string; statusCode: number; success: boolean; error?: string; duration: number }> }>

  // Automations change listener
  onAutomationsChanged(callback: (workspaceId: string) => void): () => void

  // Language
  changeLanguage(lang: string): Promise<void>

  // Resources (cross-workspace export/import)
  exportResources(workspaceId: string, options: ExportResourcesOptions): Promise<ExportResult>
  importResources(workspaceId: string, bundle: ResourceBundle, mode: ResourceImportMode): Promise<ResourceImportResult>

  // Messaging gateway — workspaceId is taken from the client handshake (ctx.workspaceId)
  getMessagingConfig(): Promise<{
    enabled: boolean
    platforms: Record<string, { enabled: boolean; accessMode?: MessagingPlatformAccessMode; owners?: MessagingPlatformOwnerInfo[] } | undefined>
    runtime: Record<string, MessagingPlatformRuntimeInfo | undefined>
  } | null>
  updateMessagingConfig(config: Record<string, unknown>): Promise<void>
  testTelegramToken(token: string): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }>
  saveTelegramToken(token: string): Promise<void>
  testLarkCredentials(creds: { appId: string; appSecret: string; domain: 'lark' | 'feishu' }): Promise<{ success: boolean; botName?: string; error?: string }>
  saveLarkCredentials(creds: { appId: string; appSecret: string; domain: 'lark' | 'feishu' }): Promise<void>
  disconnectMessagingPlatform(platform: string): Promise<void>
  forgetMessagingPlatform(platform: string): Promise<void>
  getMessagingBindings(): Promise<Array<{ id: string; workspaceId: string; sessionId: string; platform: string; channelId: string; threadId?: number; channelName?: string; enabled: boolean; createdAt: number; accessMode?: MessagingBindingAccessMode; allowedSenderIds?: string[] }>>
  generateMessagingPairingCode(sessionId: string, platform: string): Promise<{ code: string; expiresAt: number; botUsername?: string }>
  /** Telegram supergroup pairing — returns a code typed in the supergroup to capture its chatId. */
  generateMessagingSupergroupCode(platform: string): Promise<{ code: string; expiresAt: number; botUsername?: string }>
  /** Read the workspace's currently paired Telegram supergroup, if any. */
  getMessagingSupergroup(): Promise<{ chatId: string; title: string; capturedAt: number } | null>
  /** Forget the paired Telegram supergroup (existing topic bindings stay on disk but stop matching). */
  unbindMessagingSupergroup(): Promise<{ success: boolean }>
  unbindMessagingSession(sessionId: string, platform?: string): Promise<void>
  unbindMessagingBinding(bindingId: string): Promise<{ success: boolean }>
  onMessagingBindingChanged(callback: (workspaceId: string) => void): () => void
  onMessagingPlatformStatus(callback: (workspaceId: string, platform: string, status: MessagingPlatformRuntimeInfo) => void): () => void
  // WhatsApp (subprocess-based Baileys adapter)
  startWhatsAppConnect(): Promise<{ success: boolean }>
  submitWhatsAppPhone(phoneNumber: string): Promise<{ success: boolean }>
  onWhatsAppEvent(callback: (payload: { workspaceId: string; event: WhatsAppUiEvent }) => void): () => void
  // Messaging access control (Phase 3)
  getMessagingPlatformOwners(platform: string): Promise<MessagingPlatformOwnerInfo[]>
  setMessagingPlatformOwners(platform: string, owners: MessagingPlatformOwnerInfo[]): Promise<MessagingPlatformOwnerInfo[]>
  getMessagingPlatformAccessMode(platform: string): Promise<MessagingPlatformAccessMode>
  setMessagingPlatformAccessMode(platform: string, mode: MessagingPlatformAccessMode): Promise<{ success: boolean }>
  getMessagingPendingSenders(platform?: string): Promise<MessagingPendingSenderInfo[]>
  dismissMessagingPendingSender(platform: string, userId: string, opts?: { reason?: MessagingPendingRejectReason; bindingId?: string }): Promise<{ success: boolean }>
  allowMessagingPendingSender(
    platform: string,
    userId: string,
    entryKey?: { reason?: MessagingPendingRejectReason; bindingId?: string },
  ): Promise<{ owners: MessagingPlatformOwnerInfo[]; bindingId?: string }>
  setMessagingBindingAccess(bindingId: string, access: { mode: MessagingBindingAccessMode; allowedSenderIds?: string[] }): Promise<{ success: boolean }>
  onMessagingPendingChanged(callback: (workspaceId: string) => void): () => void
}

export interface MessagingPlatformRuntimeInfo {
  platform: string
  configured: boolean
  connected: boolean
  state: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
  identity?: string
  lastError?: string
  updatedAt: number
}

/**
 * Workspace-level access policy for a messaging platform.
 * Mirrors the canonical type in `@craft-agent/messaging-gateway`.
 */
export type MessagingPlatformAccessMode = 'open' | 'owner-only'

/** Per-binding access policy. */
export type MessagingBindingAccessMode = 'inherit' | 'allow-list' | 'open'

export interface MessagingPlatformOwnerInfo {
  userId: string
  displayName?: string
  username?: string
  addedAt: number
}

export type MessagingPendingRejectReason = 'not-owner' | 'not-on-binding-allowlist'

export interface MessagingPendingSenderInfo {
  platform: string
  userId: string
  displayName?: string
  username?: string
  lastAttemptAt: number
  attemptCount: number
  reason?: MessagingPendingRejectReason
  bindingId?: string
  sessionId?: string
  channelId?: string
  threadId?: number
}

/** Event payloads broadcast from the WhatsApp subprocess to the UI. */
export type WhatsAppUiEvent =
  | { type: 'qr'; qr: string }
  | { type: 'pairing_code'; code: string }
  | { type: 'connected'; jid?: string; name?: string }
  | { type: 'disconnected'; loggedOut: boolean; reason?: string }
  | { type: 'unavailable'; reason: string; message: string }
  | { type: 'error'; message: string }

// =============================================================================
// Navigation types (renderer-only)
// =============================================================================

/**
 * Right sidebar panel types
 */
export type RightSidebarPanel =
  | { type: 'files'; path?: string }
  | { type: 'history' }
  | { type: 'none' }

/**
 * Session filter options
 */
export type SessionFilter =
  | { kind: 'allSessions' }
  | { kind: 'flagged' }
  | { kind: 'state'; stateId: string }
  | { kind: 'label'; labelId: string }
  | { kind: 'view'; viewId: string }
  | { kind: 'archived' }

/**
 * Settings subpage options - re-exported from settings-registry (single source of truth)
 */
export type { SettingsSubpage } from './settings-registry'
import { isValidSettingsSubpage, type SettingsSubpage } from './settings-registry'

/**
 * Sessions navigation state
 */
export interface SessionsNavigationState {
  navigator: 'sessions'
  filter: SessionFilter
  details: { type: 'session'; sessionId: string } | null
  rightSidebar?: RightSidebarPanel
  /**
   * Presentation mode for the sessions navigator. `'board'` renders the Kanban
   * board (all sessions, grouped into To Do / In Progress / Done columns) in the
   * content area instead of the list + chat. Absent/`'list'` is the default.
   */
  viewMode?: 'list' | 'board'
}

/**
 * Source type filter for sources navigation
 */
export interface SourceFilter {
  kind: 'type'
  sourceType: 'api' | 'mcp' | 'local' | 'web'
}

/**
 * Automation type filter for automations navigation
 */
export interface AutomationFilter {
  kind: 'type'
  automationType: 'scheduled' | 'event' | 'agentic'
}

/**
 * Sources navigation state
 */
export interface SourcesNavigationState {
  navigator: 'sources'
  filter?: SourceFilter
  details: { type: 'source'; sourceSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Settings navigation state
 *
 * `subpage: null` means the bare `settings` route — navigator-only view in compact
 * mode. On desktop, the content panel falls back to the App design so it isn't empty.
 * Sources/Skills/Automations use `details: null` for the same purpose.
 */
export interface SettingsNavigationState {
  navigator: 'settings'
  subpage: SettingsSubpage | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Skills navigation state
 */
export interface SkillsNavigationState {
  navigator: 'skills'
  details: { type: 'skill'; skillSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Automations navigation state
 */
export interface AutomationsNavigationState {
  navigator: 'automations'
  filter?: AutomationFilter
  details: { type: 'automation'; automationId: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Projects navigation state
 */
export interface ProjectsNavigationState {
  navigator: 'projects'
  details: { type: 'project'; projectSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Tweaks navigation state
 *
 * Bare `tweaks` (details: null) shows the library list — it never
 * auto-selects one, and the middle navigator collapses while a tweaks route is active.
 */
export interface TweaksNavigationState {
  navigator: 'tweaks'
  details: { type: 'tweak'; tweakSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Designs navigation state
 *
 * Bare `designs` (details: null) shows the library grid — it never auto-selects
 * one, and the middle navigator collapses while a designs route is active.
 */
export interface DesignsNavigationState {
  navigator: 'designs'
  details: { type: 'design'; designSlug: string } | null
  rightSidebar?: RightSidebarPanel
}

/**
 * Unified navigation state
 */
export type NavigationState =
  | SessionsNavigationState
  | SourcesNavigationState
  | SettingsNavigationState
  | SkillsNavigationState
  | AutomationsNavigationState
  | ProjectsNavigationState
  | TweaksNavigationState
  | DesignsNavigationState

export const isSessionsNavigation = (
  state: NavigationState
): state is SessionsNavigationState => state.navigator === 'sessions'

export const isSourcesNavigation = (
  state: NavigationState
): state is SourcesNavigationState => state.navigator === 'sources'

export const isSettingsNavigation = (
  state: NavigationState
): state is SettingsNavigationState => state.navigator === 'settings'

export const isSkillsNavigation = (
  state: NavigationState
): state is SkillsNavigationState => state.navigator === 'skills'

export const isAutomationsNavigation = (
  state: NavigationState
): state is AutomationsNavigationState => state.navigator === 'automations'

export const isProjectsNavigation = (
  state: NavigationState
): state is ProjectsNavigationState => state.navigator === 'projects'

export const isTweaksNavigation = (
  state: NavigationState
): state is TweaksNavigationState => state.navigator === 'tweaks'

export const isDesignsNavigation = (
  state: NavigationState
): state is DesignsNavigationState => state.navigator === 'designs'

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
}

export const getNavigationStateKey = (state: NavigationState): string => {
  if (state.navigator === 'sources') {
    if (state.details) {
      return `sources/source/${state.details.sourceSlug}`
    }
    return 'sources'
  }
  if (state.navigator === 'skills') {
    if (state.details?.type === 'skill') {
      return `skills/skill/${state.details.skillSlug}`
    }
    return 'skills'
  }
  if (state.navigator === 'automations') {
    if (state.details?.type === 'automation') {
      return `automations/automation/${state.details.automationId}`
    }
    return 'automations'
  }
  if (state.navigator === 'projects') {
    if (state.details?.type === 'project') {
      return `projects/project/${state.details.projectSlug}`
    }
    return 'projects'
  }
  if (state.navigator === 'tweaks') {
    if (state.details?.type === 'tweak') {
      return `tweaks/tweak/${state.details.tweakSlug}`
    }
    return 'tweaks'
  }
  if (state.navigator === 'designs') {
    if (state.details?.type === 'design') {
      return `designs/design/${state.details.designSlug}`
    }
    return 'designs'
  }
  if (state.navigator === 'settings') {
    if (state.subpage === null) return 'settings'
    return `settings:${state.subpage}`
  }
  // Chats
  const f = state.filter
  let base: string
  if (f.kind === 'state') base = `state:${f.stateId}`
  else if (f.kind === 'label') base = `label:${f.labelId}`
  else if (f.kind === 'view') base = `view:${f.viewId}`
  else base = f.kind
  if (state.details) {
    return `${base}/chat/${state.details.sessionId}`
  }
  return base
}

export const parseNavigationStateKey = (key: string): NavigationState | null => {
  // Handle sources
  if (key === 'sources') return { navigator: 'sources', details: null }
  if (key.startsWith('sources/source/')) {
    const sourceSlug = key.slice(15)
    if (sourceSlug) {
      return { navigator: 'sources', details: { type: 'source', sourceSlug } }
    }
    return { navigator: 'sources', details: null }
  }

  // Handle skills
  if (key === 'skills') return { navigator: 'skills', details: null }
  if (key.startsWith('skills/skill/')) {
    const skillSlug = key.slice(13)
    if (skillSlug) {
      return { navigator: 'skills', details: { type: 'skill', skillSlug } }
    }
    return { navigator: 'skills', details: null }
  }

  // Handle automations
  if (key === 'automations') return { navigator: 'automations', details: null }
  if (key.startsWith('automations/automation/')) {
    const automationId = key.slice(23)
    if (automationId) {
      return { navigator: 'automations', details: { type: 'automation', automationId } }
    }
    return { navigator: 'automations', details: null }
  }

  // Handle projects
  if (key === 'projects') return { navigator: 'projects', details: null }
  if (key.startsWith('projects/project/')) {
    const projectSlug = key.slice(17)
    if (projectSlug) {
      return { navigator: 'projects', details: { type: 'project', projectSlug } }
    }
    return { navigator: 'projects', details: null }
  }

  // Handle tweaks
  if (key === 'tweaks') return { navigator: 'tweaks', details: null }
  if (key.startsWith('tweaks/tweak/')) {
    const tweakSlug = key.slice(13)
    if (tweakSlug) {
      return { navigator: 'tweaks', details: { type: 'tweak', tweakSlug } }
    }
    return { navigator: 'tweaks', details: null }
  }

  // Handle designs
  if (key === 'designs') return { navigator: 'designs', details: null }
  if (key.startsWith('designs/design/')) {
    const designSlug = key.slice(15)
    if (designSlug) {
      return { navigator: 'designs', details: { type: 'design', designSlug } }
    }
    return { navigator: 'designs', details: null }
  }

  // Handle settings
  if (key === 'settings') return { navigator: 'settings', subpage: null }
  if (key.startsWith('settings:')) {
    const subpage = key.slice(9)
    if (isValidSettingsSubpage(subpage)) {
      return { navigator: 'settings', subpage }
    }
  }

  // Handle sessions
  const parseSessionsKey = (filterKey: string, sessionId?: string): NavigationState | null => {
    let filter: SessionFilter
    if (filterKey === 'allSessions') filter = { kind: 'allSessions' }
    else if (filterKey === 'flagged') filter = { kind: 'flagged' }
    else if (filterKey === 'archived') filter = { kind: 'archived' }
    else if (filterKey.startsWith('state:')) {
      const stateId = filterKey.slice(6)
      if (!stateId) return null
      filter = { kind: 'state', stateId }
    } else if (filterKey.startsWith('label:')) {
      const labelId = filterKey.slice(6)
      if (!labelId) return null
      filter = { kind: 'label', labelId }
    } else if (filterKey.startsWith('view:')) {
      const viewId = filterKey.slice(5)
      if (!viewId) return null
      filter = { kind: 'view', viewId }
    } else {
      return null
    }
    return {
      navigator: 'sessions',
      filter,
      details: sessionId ? { type: 'session', sessionId } : null,
    }
  }

  // Check for session details
  if (key.includes('/session/')) {
    const [filterPart, , sessionId] = key.split('/')
    return parseSessionsKey(filterPart, sessionId)
  }

  // Simple filter key
  return parseSessionsKey(key)
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
