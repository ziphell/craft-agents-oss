/**
 * RPC channel names — organized by domain namespace.
 * Wire-format strings (values) are the stable API contract.
 * Key paths are internal and may be reorganized freely.
 */
export const RPC_CHANNELS = {
  remote: {
    TEST_CONNECTION: 'remote:testConnection',
  },
  server: {
    GET_WORKSPACES: 'server:getWorkspaces',
    CREATE_WORKSPACE: 'server:createWorkspace',
    GET_STATUS: 'server:getStatus',
    GET_HEALTH: 'server:getHealth',
    GET_ACTIVE_SESSIONS: 'server:getActiveSessions',
    SHUTTING_DOWN: 'server:shuttingDown',
    STATUS_CHANGED: 'server:statusChanged',
    HOME_DIR: 'server:homeDir',
  },
  sessions: {
    GET: 'sessions:get',
    GET_UNREAD_SUMMARY: 'sessions:getUnreadSummary',
    MARK_ALL_READ: 'sessions:markAllRead',
    UNREAD_SUMMARY_CHANGED: 'sessions:unreadSummaryChanged',
    CREATE: 'sessions:create',
    DELETE: 'sessions:delete',
    GET_MESSAGES: 'sessions:getMessages',
    SEND_MESSAGE: 'sessions:sendMessage',
    CANCEL: 'sessions:cancel',
    KILL_SHELL: 'sessions:killShell',
    RESPOND_TO_PERMISSION: 'sessions:respondToPermission',
    RESPOND_TO_CREDENTIAL: 'sessions:respondToCredential',
    COMMAND: 'sessions:command',
    GET_PENDING_PLAN_EXECUTION: 'sessions:getPendingPlanExecution',
    GET_PERMISSION_MODE_STATE: 'sessions:getPermissionModeState',
    EVENT: 'session:event',
    GET_MODEL: 'session:getModel',
    SET_MODEL: 'session:setModel',
    GET_FILES: 'sessions:getFiles',
    GET_NOTES: 'sessions:getNotes',
    SET_NOTES: 'sessions:setNotes',
    WATCH_FILES: 'sessions:watchFiles',
    UNWATCH_FILES: 'sessions:unwatchFiles',
    FILES_CHANGED: 'sessions:filesChanged',
    SEARCH_CONTENT: 'sessions:searchContent',
    EXPORT: 'sessions:export',
    IMPORT: 'sessions:import',
    EXPORT_REMOTE_TRANSFER: 'sessions:exportRemoteTransfer',
    IMPORT_REMOTE_TRANSFER: 'sessions:importRemoteTransfer',
  },
  transfer: {
    START: 'transfer:start',
    CHUNK: 'transfer:chunk',
    COMMIT: 'transfer:commit',
    ABORT: 'transfer:abort',
  },
  tasks: {
    // Legacy: background-task output (disabled-feature remnant). Kept for back-compat; retire later.
    GET_OUTPUT: 'tasks:getOutput',
    // Conductor — the Tasks DAG runner.
    VALIDATE: 'tasks:validate',
    CREATE: 'tasks:create',
    GENERATE: 'tasks:generate',
    // Push: the authored spec (or an error) for an async tasks:generate, keyed by orchestratorSessionId.
    GENERATED: 'tasks:generated',
    RUN: 'tasks:run',
    PAUSE: 'tasks:pause',
    RESUME: 'tasks:resume',
    STOP: 'tasks:stop',
    GET: 'tasks:get',
    LIST: 'tasks:list',
    // Storage-backed read of a run's outcome (verdict + per-node output). Survives restart.
    GET_RESULTS: 'tasks:getResults',
    // Answer a `kind: approval` gate node — the one step of a run a person, not a session, decides.
    RESOLVE_APPROVAL: 'tasks:resolveApproval',
  },
  workspaces: {
    GET: 'workspaces:get',
    CREATE: 'workspaces:create',
    CHECK_SLUG: 'workspaces:checkSlug',
    UPDATE_REMOTE: 'workspaces:updateRemote',
  },
  window: {
    GET_WORKSPACE: 'window:getWorkspace',
    GET_MODE: 'window:getMode',
    OPEN_WORKSPACE: 'window:openWorkspace',
    OPEN_SESSION_IN_NEW_WINDOW: 'window:openSessionInNewWindow',
    SWITCH_WORKSPACE: 'window:switchWorkspace',
    CLOSE: 'window:close',
    CLOSE_REQUESTED: 'window:closeRequested',
    CONFIRM_CLOSE: 'window:confirmClose',
    CANCEL_CLOSE: 'window:cancelClose',
    SET_TRAFFIC_LIGHTS: 'window:setTrafficLights',
    FOCUS_STATE: 'window:focusState',
    GET_FOCUS_STATE: 'window:getFocusState',
  },
  file: {
    READ: 'file:read',
    READ_DATA_URL: 'file:readDataUrl',
    READ_PREVIEW_DATA_URL: 'file:readPreviewDataUrl',
    READ_BINARY: 'file:readBinary',
    WRITE: 'file:write',
    OPEN_DIALOG: 'file:openDialog',
    READ_ATTACHMENT: 'file:readAttachment',
    READ_USER_ATTACHMENT: 'file:readUserAttachment',
    STORE_ATTACHMENT: 'file:storeAttachment',
    GENERATE_THUMBNAIL: 'file:generateThumbnail',
  },
  fs: {
    SEARCH: 'fs:search',
    LIST_DIRECTORY: 'fs:listDirectory',
  },
  prototypes: {
    WATCH: 'prototypes:watch',
    UNWATCH: 'prototypes:unwatch',
    CHANGED: 'prototypes:changed',
    /** Read-only listing of every prototype in a workspace (drives the panel). */
    LIST: 'prototypes:list',
    /** Where to open a prototype: the origin that renders it, never the exported deliverable. */
    ENTRY: 'prototypes:entry',
    /** Write `dist/*` so the prototype can be handed to developers. */
    EXPORT: 'prototypes:export',
    /** Create a prototype (the panel's "New Prototype"). */
    CREATE: 'prototypes:create',
    /**
     * Copy a prototype into a new one: same page, same patches, its own slug and
     * `config.json` (the list's "Duplicate"). The two are independent afterwards.
     */
    DUPLICATE: 'prototypes:duplicate',
    /**
     * Remove a prototype and everything in it. Irreversible, and the caller is
     * the one that asked the user first — the agent has no command for this.
     */
    DELETE: 'prototypes:delete',
    /** Replay a prototype's patches into a live browser instance. */
    APPLY: 'prototypes:apply',
    /**
     * Write one save from the browser window's editor as a patch of a prototype
     * (`edit-patch.ts`), scoped to the page it was made on.
     *
     * The window reports what the person accumulated — boxed elements and what they
     * set on them, elements whose text they retyped — and this turns that **one
     * moment of intent** into the artifact every other change is: a patch file (two
     * when the session did both styles and text), which the watcher then replays into
     * every window showing the prototype. Nothing is applied by this call.
     */
    EDIT: 'prototypes:edit',
    /**
     * Replay one prototype into every window that is showing it (plan §21.4).
     *
     * Sent after a file change, so an edit made in an external editor shows up in
     * the open window without anyone clicking apply: a page of ours is reloaded
     * (the host re-renders from disk), someone else's page is re-applied.
     */
    REPLAY: 'prototypes:replay',
    /**
     * Change one prototype's page table — add, remove, rename, or mark which page
     * the address root opens (plan §19). The panel's prototype list drives it; the
     * agent reaches the same data through `prototype_tool pages` / `prototype_tool entry`.
     */
    SET_PAGES: 'prototypes:setPages',
    /**
     * Point one live page at the same page in another environment. The address is a
     * fact about where the page is, not a rule of the page's kind, so it is
     * changeable — see target.ts for what goes stale with it. `page` names which
     * page moves; without it the entry page moves when it is a live one.
     */
    SET_TARGET: 'prototypes:setTarget',
  },
  debug: {
    LOG: 'debug:log',
  },
  theme: {
    GET_SYSTEM_PREFERENCE: 'theme:getSystemPreference',
    SYSTEM_CHANGED: 'theme:systemChanged',
    APP_CHANGED: 'theme:appChanged',
    GET_APP: 'theme:getApp',
    GET_PRESETS: 'theme:getPresets',
    LOAD_PRESET: 'theme:loadPreset',
    GET_COLOR_THEME: 'theme:getColorTheme',
    SET_COLOR_THEME: 'theme:setColorTheme',
    BROADCAST_PREFERENCES: 'theme:broadcastPreferences',
    PREFERENCES_CHANGED: 'theme:preferencesChanged',
    GET_WORKSPACE_COLOR_THEME: 'theme:getWorkspaceColorTheme',
    SET_WORKSPACE_COLOR_THEME: 'theme:setWorkspaceColorTheme',
    GET_ALL_WORKSPACE_THEMES: 'theme:getAllWorkspaceThemes',
    BROADCAST_WORKSPACE_THEME: 'theme:broadcastWorkspaceTheme',
    WORKSPACE_THEME_CHANGED: 'theme:workspaceThemeChanged',
  },
  system: {
    VERSIONS: 'system:versions',
    HOME_DIR: 'system:homeDir',
    IS_DEBUG_MODE: 'system:isDebugMode',
  },
  update: {
    CHECK: 'update:check',
    GET_INFO: 'update:getInfo',
    INSTALL: 'update:install',
    DISMISS: 'update:dismiss',
    GET_DISMISSED: 'update:getDismissed',
    AVAILABLE: 'update:available',
    DOWNLOAD_PROGRESS: 'update:downloadProgress',
  },
  shell: {
    OPEN_URL: 'shell:openUrl',
    OPEN_FILE: 'shell:openFile',
    SHOW_IN_FOLDER: 'shell:showInFolder',
  },
  menu: {
    NEW_CHAT: 'menu:newChat',
    NEW_WINDOW: 'menu:newWindow',
    OPEN_SETTINGS: 'menu:openSettings',
    KEYBOARD_SHORTCUTS: 'menu:keyboardShortcuts',
    TOGGLE_FOCUS_MODE: 'menu:toggleFocusMode',
    TOGGLE_SIDEBAR: 'menu:toggleSidebar',
    QUIT: 'menu:quit',
    MINIMIZE: 'menu:minimize',
    MAXIMIZE: 'menu:maximize',
    ZOOM_IN: 'menu:zoomIn',
    ZOOM_OUT: 'menu:zoomOut',
    ZOOM_RESET: 'menu:zoomReset',
    TOGGLE_DEV_TOOLS: 'menu:toggleDevTools',
    UNDO: 'menu:undo',
    REDO: 'menu:redo',
    CUT: 'menu:cut',
    COPY: 'menu:copy',
    PASTE: 'menu:paste',
    SELECT_ALL: 'menu:selectAll',
  },
  deeplink: {
    NAVIGATE: 'deeplink:navigate',
  },
  auth: {
    LOGOUT: 'auth:logout',
    SHOW_LOGOUT_CONFIRMATION: 'auth:showLogoutConfirmation',
    SHOW_DELETE_SESSION_CONFIRMATION: 'auth:showDeleteSessionConfirmation',
  },
  credentials: {
    HEALTH_CHECK: 'credentials:healthCheck',
  },
  onboarding: {
    GET_AUTH_STATE: 'onboarding:getAuthState',
    VALIDATE_MCP: 'onboarding:validateMcp',
    START_MCP_OAUTH: 'onboarding:startMcpOAuth',
    START_CLAUDE_OAUTH: 'onboarding:startClaudeOAuth',
    EXCHANGE_CLAUDE_CODE: 'onboarding:exchangeClaudeCode',
    HAS_CLAUDE_OAUTH_STATE: 'onboarding:hasClaudeOAuthState',
    CLEAR_CLAUDE_OAUTH_STATE: 'onboarding:clearClaudeOAuthState',
    DEFER_SETUP: 'onboarding:deferSetup',
  },
  llmConnections: {
    LIST: 'LLM_Connection:list',
    LIST_WITH_STATUS: 'LLM_Connection:listWithStatus',
    GET: 'LLM_Connection:get',
    GET_API_KEY: 'LLM_Connection:getApiKey',
    SAVE: 'LLM_Connection:save',
    DELETE: 'LLM_Connection:delete',
    TEST: 'LLM_Connection:test',
    SET_DEFAULT: 'LLM_Connection:setDefault',
    SET_WORKSPACE_DEFAULT: 'LLM_Connection:setWorkspaceDefault',
    REFRESH_MODELS: 'LLM_Connection:refreshModels',
    CHANGED: 'LLM_Connection:changed',
  },
  chatgpt: {
    START_OAUTH: 'chatgpt:startOAuth',
    COMPLETE_OAUTH: 'chatgpt:completeOAuth',
    CANCEL_OAUTH: 'chatgpt:cancelOAuth',
    GET_AUTH_STATUS: 'chatgpt:getAuthStatus',
    LOGOUT: 'chatgpt:logout',
  },
  copilot: {
    START_OAUTH: 'copilot:startOAuth',
    CANCEL_OAUTH: 'copilot:cancelOAuth',
    GET_AUTH_STATUS: 'copilot:getAuthStatus',
    LOGOUT: 'copilot:logout',
    DEVICE_CODE: 'copilot:deviceCode',
  },
  settings: {
    SETUP_LLM_CONNECTION: 'settings:setupLlmConnection',
    TEST_LLM_CONNECTION_SETUP: 'settings:testLlmConnectionSetup',
    GET_DEFAULT_THINKING_LEVEL: 'settings:getDefaultThinkingLevel',
    SET_DEFAULT_THINKING_LEVEL: 'settings:setDefaultThinkingLevel',
    GET_NETWORK_PROXY: 'settings:getNetworkProxy',
    SET_NETWORK_PROXY: 'settings:setNetworkProxy',
    GET_SERVER_CONFIG: 'settings:getServerConfig',
    SET_SERVER_CONFIG: 'settings:setServerConfig',
    GET_SERVER_STATUS: 'settings:getServerStatus',
  },
  pi: {
    GET_API_KEY_PROVIDERS: 'pi:getApiKeyProviders',
    GET_PROVIDER_BASE_URL: 'pi:getProviderBaseUrl',
    GET_PROVIDER_MODELS: 'pi:getProviderModels',
  },
  dialog: {
    OPEN_FOLDER: 'dialog:openFolder',
  },
  preferences: {
    READ: 'preferences:read',
    WRITE: 'preferences:write',
  },
  drafts: {
    GET: 'drafts:get',
    SET: 'drafts:set',
    DELETE: 'drafts:delete',
    GET_ALL: 'drafts:getAll',
  },
  sources: {
    GET: 'sources:get',
    CREATE: 'sources:create',
    DELETE: 'sources:delete',
    START_OAUTH: 'sources:startOAuth',
    SAVE_CREDENTIALS: 'sources:saveCredentials',
    CHANGED: 'sources:changed',
    GET_PERMISSIONS: 'sources:getPermissions',
    GET_MCP_TOOLS: 'sources:getMcpTools',
  },
  oauth: {
    START: 'oauth:start',
    COMPLETE: 'oauth:complete',
    CANCEL: 'oauth:cancel',
    REVOKE: 'oauth:revoke',
  },
  workspace: {
    GET_PERMISSIONS: 'workspace:getPermissions',
    READ_IMAGE: 'workspace:readImage',
    WRITE_IMAGE: 'workspace:writeImage',
    SETTINGS_GET: 'workspaceSettings:get',
    SETTINGS_UPDATE: 'workspaceSettings:update',
  },
  permissions: {
    GET_DEFAULTS: 'permissions:getDefaults',
    DEFAULTS_CHANGED: 'permissions:defaultsChanged',
  },
  skills: {
    GET: 'skills:get',
    GET_FILES: 'skills:getFiles',
    DELETE: 'skills:delete',
    OPEN_EDITOR: 'skills:openEditor',
    OPEN_FINDER: 'skills:openFinder',
    CHANGED: 'skills:changed',
  },
  statuses: {
    LIST: 'statuses:list',
    REORDER: 'statuses:reorder',
    CHANGED: 'statuses:changed',
  },
  labels: {
    LIST: 'labels:list',
    CREATE: 'labels:create',
    DELETE: 'labels:delete',
    CHANGED: 'labels:changed',
  },
  views: {
    LIST: 'views:list',
    SAVE: 'views:save',
  },
  toolIcons: {
    GET_MAPPINGS: 'toolIcons:getMappings',
  },
  logo: {
    GET_URL: 'logo:getUrl',
  },
  notification: {
    SHOW: 'notification:show',
    NAVIGATE: 'notification:navigate',
    GET_ENABLED: 'notification:getEnabled',
    SET_ENABLED: 'notification:setEnabled',
  },
  input: {
    GET_AUTO_CAPITALISATION: 'input:getAutoCapitalisation',
    SET_AUTO_CAPITALISATION: 'input:setAutoCapitalisation',
    GET_SEND_MESSAGE_KEY: 'input:getSendMessageKey',
    SET_SEND_MESSAGE_KEY: 'input:setSendMessageKey',
    GET_SPELL_CHECK: 'input:getSpellCheck',
    SET_SPELL_CHECK: 'input:setSpellCheck',
  },
  power: {
    GET_KEEP_AWAKE: 'power:getKeepAwake',
    SET_KEEP_AWAKE: 'power:setKeepAwake',
  },
  appearance: {
    GET_RICH_TOOL_DESCRIPTIONS: 'appearance:getRichToolDescriptions',
    SET_RICH_TOOL_DESCRIPTIONS: 'appearance:setRichToolDescriptions',
  },
  tools: {
    GET_BROWSER_TOOL_ENABLED: 'tools:getBrowserToolEnabled',
    SET_BROWSER_TOOL_ENABLED: 'tools:setBrowserToolEnabled',
  },
  caching: {
    GET_EXTENDED_PROMPT_CACHE: 'caching:getExtendedPromptCache',
    SET_EXTENDED_PROMPT_CACHE: 'caching:setExtendedPromptCache',
    GET_ENABLE_1M_CONTEXT: 'caching:getEnable1MContext',
    SET_ENABLE_1M_CONTEXT: 'caching:setEnable1MContext',
  },
  rtk: {
    GET_ENABLED: 'rtk:getEnabled',
    SET_ENABLED: 'rtk:setEnabled',
    GET_STATUS: 'rtk:getStatus',
    GET_GAIN: 'rtk:getGain',
  },
  badge: {
    REFRESH: 'badge:refresh',
    SET_ICON: 'badge:setIcon',
    DRAW: 'badge:draw',
    DRAW_WINDOWS: 'badge:draw-windows',
  },
  releaseNotes: {
    GET: 'releaseNotes:get',
    GET_LATEST_VERSION: 'releaseNotes:getLatestVersion',
  },
  git: {
    GET_BRANCH: 'git:getBranch',
  },
  gitbash: {
    CHECK: 'gitbash:check',
    BROWSE: 'gitbash:browse',
    SET_PATH: 'gitbash:setPath',
  },
  browserPane: {
    CREATE: 'browser-pane:create',
    DESTROY: 'browser-pane:destroy',
    LIST: 'browser-pane:list',
    NAVIGATE: 'browser-pane:navigate',
    GO_BACK: 'browser-pane:go-back',
    GO_FORWARD: 'browser-pane:go-forward',
    RELOAD: 'browser-pane:reload',
    STOP: 'browser-pane:stop',
    FOCUS: 'browser-pane:focus',
    /**
     * Manage one window's own tabs — switch, close, add.
     *
     * One channel with an action rather than three, for the same reason the
     * toolbar's own strip uses one: the three buttons sit together and address the
     * same window.
     */
    TAB_ACTION: 'browser-pane:tab-action',
    SNAPSHOT: 'browser-pane:snapshot',
    CLICK: 'browser-pane:click',
    FILL: 'browser-pane:fill',
    SELECT: 'browser-pane:select',
    SCREENSHOT: 'browser-pane:screenshot',
    EVALUATE: 'browser-pane:evaluate',
    SCROLL: 'browser-pane:scroll',
    LAUNCH: 'browser-empty-state:launch',
    STATE_CHANGED: 'browser-pane:state-changed',
    REMOVED: 'browser-pane:removed',
    INTERACTED: 'browser-pane:interacted',
    /**
     * Pushed from the browser panel's own toolbar to the main window, because the
     * panel is a separate render process with no workspace/session context of its
     * own. The main window owns the prototype binding, so it decides what a pick
     * or an apply actually means.
     */
    TOOLBAR_ACTION: 'browser-pane:toolbar-action',
  },
  automations: {
    GET: 'automations:get',
    TEST: 'automations:test',
    SET_ENABLED: 'automations:setEnabled',
    DUPLICATE: 'automations:duplicate',
    DELETE: 'automations:delete',
    GET_HISTORY: 'automations:getHistory',
    GET_LAST_EXECUTED: 'automations:getLastExecuted',
    REPLAY: 'automations:replay',
    CHANGED: 'automations:changed',
  },
  resources: {
    EXPORT: 'resources:export',
    IMPORT: 'resources:import',
  },
  projects: {
    GET: 'projects:get',
    GET_ONE: 'projects:getOne',
    CREATE: 'projects:create',
    UPDATE: 'projects:update',
    DELETE: 'projects:delete',
    LIST_ASSETS: 'projects:listAssets',
    UPLOAD_ASSET: 'projects:uploadAsset',
    DELETE_ASSET: 'projects:deleteAsset',
    CHANGED: 'projects:changed',
  },
  websites: {
    GET: 'websites:get',
    GET_ONE: 'websites:getOne',
    CREATE: 'websites:create',
    UPDATE: 'websites:update',
    DELETE: 'websites:delete',
    GET_CONTENT: 'websites:getContent',
    SET_CONTENT: 'websites:setContent',
    GET_DATA: 'websites:getData',
    LIST_GRANTS: 'websites:listGrants',
    ISSUE_GRANT: 'websites:issueGrant',
    REVOKE_GRANT: 'websites:revokeGrant',
    CREATE_LEASE: 'websites:createLease',
    RELEASE_LEASE: 'websites:releaseLease',
    EXECUTE_ACTION: 'websites:executeAction',
    CANCEL_ACTION: 'websites:cancelAction',
    GET_SHARE_CAPABILITIES: 'websites:getShareCapabilities',
    GET_SHARE_DATA_SCAN: 'websites:getShareDataScan',
    PUBLISH: 'websites:publish',
    SET_PUBLICATION_PASSWORD: 'websites:setPublicationPassword',
    UNPUBLISH: 'websites:unpublish',
    GET_THUMBNAIL: 'websites:getThumbnail',
    REGENERATE_THUMBNAIL: 'websites:regenerateThumbnail',
    CHANGED: 'websites:changed',
  },
  messaging: {
    // WhatsApp subprocess → Gateway (subprocess invokes on server)
    WA_REGISTER: 'messaging:wa:register',
    WA_INCOMING: 'messaging:wa:incoming',
    WA_BUTTON_PRESS: 'messaging:wa:buttonPress',
    WA_STATUS: 'messaging:wa:status',
    WA_QR: 'messaging:wa:qr',
    // Gateway → WhatsApp subprocess (server invokes on client)
    WA_SEND: 'messaging:wa:send',
    WA_SEND_BUTTONS: 'messaging:wa:sendButtons',
    WA_SEND_TYPING: 'messaging:wa:sendTyping',
    WA_SEND_FILE: 'messaging:wa:sendFile',
    WA_CONNECT: 'messaging:wa:connect',
    WA_DISCONNECT: 'messaging:wa:disconnect',
    // Gateway → UI clients (broadcast)
    BINDING_CHANGED: 'messaging:bindingChanged',
    PLATFORM_STATUS: 'messaging:platformStatus',
    /** Broadcast when the workspace's pending-senders list mutates. */
    PENDING_CHANGED: 'messaging:pendingChanged',
    // UI ↔ Server (config/binding CRUD)
    GET_CONFIG: 'messaging:getConfig',
    UPDATE_CONFIG: 'messaging:updateConfig',
    TEST_TELEGRAM: 'messaging:testTelegram',
    SAVE_TELEGRAM: 'messaging:saveTelegram',
    TEST_LARK: 'messaging:testLark',
    SAVE_LARK: 'messaging:saveLark',
    DISCONNECT: 'messaging:disconnect',
    FORGET: 'messaging:forget',
    GET_BINDINGS: 'messaging:getBindings',
    GENERATE_CODE: 'messaging:generateCode',
    UNBIND: 'messaging:unbind',
    UNBIND_BINDING: 'messaging:unbindBinding',
    /** Workspace-supergroup pairing (Telegram forum support). UI ↔ Server. */
    GENERATE_SUPERGROUP_CODE: 'messaging:generateSupergroupCode',
    GET_SUPERGROUP: 'messaging:getSupergroup',
    UNBIND_SUPERGROUP: 'messaging:unbindSupergroup',
    // UI ↔ Server — WhatsApp pairing/connection flow (Baileys subprocess adapter)
    WA_START_CONNECT: 'messaging:wa:startConnect',
    WA_SUBMIT_PHONE: 'messaging:wa:submitPhone',
    /** Broadcast to UI clients: QR string, pairing code, status, unavailable, error. */
    WA_UI_EVENT: 'messaging:wa:uiEvent',
    // UI ↔ Server — Access control (per-platform owners + per-binding allow-list)
    GET_PLATFORM_OWNERS: 'messaging:access:getOwners',
    SET_PLATFORM_OWNERS: 'messaging:access:setOwners',
    GET_PLATFORM_ACCESS_MODE: 'messaging:access:getMode',
    SET_PLATFORM_ACCESS_MODE: 'messaging:access:setMode',
    GET_PENDING_SENDERS: 'messaging:access:getPending',
    DISMISS_PENDING_SENDER: 'messaging:access:dismissPending',
    ALLOW_PENDING_SENDER: 'messaging:access:allowPending',
    SET_BINDING_ACCESS: 'messaging:access:setBindingAccess',
  },
} as const

// IPC_CHANNELS compat alias removed — all consumers now use RPC_CHANNELS

/**
 * Flatten all channel string values from the nested RPC_CHANNELS object.
 * Used by the exhaustive routing test to ensure every channel is classified.
 */
export function getAllChannelValues(): string[] {
  const values: string[] = []
  for (const namespace of Object.values(RPC_CHANNELS)) {
    for (const channel of Object.values(namespace)) {
      values.push(channel)
    }
  }
  return values
}
