/**
 * RPC channel names — organized by domain namespace.
 * Wire-format strings (values) are the stable API contract.
 * Key paths are internal and may be reorganized freely.
 */
export const RPC_CHANNELS = {
  /**
   * This machine's own generators.
   *
   * A card's ✨ is a request to draw something, not a request to have a conversation about drawing
   * something. These channels are what makes that true in a browser tab as well as on the desktop:
   * the work happens against a configured API account, and the caller only ever sees a path to the
   * file that came out.
   */
  media: {
    /** Draw a picture through a configured *channel* (an API account). */
    GENERATE: 'media:generate',
    /** One generation task, by the path its artifact will take. `null` when nothing is running. */
    TASK: 'media:task',
    /** Start a failed or cancelled task again from the request it stored. */
    RETRY: 'media:task:retry',
    /** A task moved: submitted, still running, landed, failed. Pushed to the workspace. */
    TASK_CHANGED: 'media:taskChanged',
    /** The channels this machine has, so a card can offer them by name. */
    CHANNELS: 'media:channels',
    /** Write the channel list back (the settings page is the only caller). */
    CHANNELS_SAVE: 'media:channels:save',
    /** Ask a channel's account whether its key works and which models it lists. */
    PROBE: 'media:channels:probe',
    /** The object storage that hosts reference files for providers that need a public URL. */
    OBJECT_STORAGE: 'media:objectStorage',
    /** Write the object storage settings back (the secret goes to the credential store). */
    OBJECT_STORAGE_SAVE: 'media:objectStorage:save',
    /** Upload a probe, read it back through the public URL, and remove it. */
    OBJECT_STORAGE_TEST: 'media:objectStorage:test',
    /** What the agent may generate, and where speech runs — the person's choices, not an account. */
    SETTINGS: 'media:settings',
    /** Write those choices back. */
    SETTINGS_SAVE: 'media:settings:save',
  },

  /**
   * Speech to text on this machine.
   *
   * No account and no network: the model is a directory of ONNX files, and the work is done by
   * `asr-tool` in its own process. These channels are what the settings page and the canvas read.
   */
  asr: {
    /** The local engine's settings, where they are read from, and what cannot be read. */
    CONFIG: 'asr:config',
    /** Write the settings back. */
    CONFIG_SAVE: 'asr:config:save',
    /** The models this machine can use, and whether silence is split before recognition. */
    MODELS: 'asr:models',
    /** Fetch a model the app offers, into the machine that will transcribe. */
    DOWNLOAD: 'asr:download',
    /** What that download is doing now — the one job at a time, cleared when a new one starts. */
    DOWNLOAD_STATUS: 'asr:download:status',
    DOWNLOAD_CANCEL: 'asr:download:cancel',
    /** Read a recording back as text. */
    TRANSCRIBE: 'asr:transcribe',
  },

  /**
   * Reading and changing a picture on this machine.
   *
   * Pixel arithmetic (crop, rotate, flip, resize) runs in the renderer, which already decodes every
   * format a person can drop on the board. Reading the words on a picture needs a native OCR
   * runtime, so that half is a bundled tool in its own process — these channels are its door.
   */
  img: {
    /** The words on a picture, read by `img-tool text` (local OCR). */
    OCR: 'img:ocr',
  },

  server: {
    GET_WORKSPACES: 'server:getWorkspaces',
    CREATE_WORKSPACE: 'server:createWorkspace',
    REMOVE_WORKSPACE: 'server:removeWorkspace',
    GET_STATUS: 'server:getStatus',
    GET_HEALTH: 'server:getHealth',
    GET_ACTIVE_SESSIONS: 'server:getActiveSessions',
    GET_DEVICES: 'server:getDevices',
    SET_DEVICE_ALIAS: 'server:setDeviceAlias',
    FORGET_DEVICE: 'server:forgetDevice',
    LIST_DEVICE_TOKENS: 'server:listDeviceTokens',
    CREATE_DEVICE_TOKEN: 'server:createDeviceToken',
    REMOVE_DEVICE_TOKEN: 'server:removeDeviceToken',
    SET_DEVICE_TOKEN_SCOPE: 'server:setDeviceTokenScope',
    SHUTTING_DOWN: 'server:shuttingDown',
    RESTART: 'server:restart',
    STATUS_CHANGED: 'server:statusChanged',
    TOKEN_SCOPE: 'server:tokenScope',
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
    SEARCH_MESSAGES: 'sessions:searchMessages',
    GET_QUESTIONS: 'sessions:getQuestions',
    SEND_MESSAGE: 'sessions:sendMessage',
    NEW_CONVERSATION: 'sessions:newConversation',
    LIST_CONVERSATIONS: 'sessions:listConversations',
    SWITCH_CONVERSATION: 'sessions:switchConversation',
    CANCEL: 'sessions:cancel',
    CANCEL_QUEUED_MESSAGE: 'sessions:cancelQueuedMessage',
    SEND_QUEUED_MESSAGE_NOW: 'sessions:sendQueuedMessageNow',
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
  },
  /**
   * The assistant (Craft Bot): one conversation, and the tasks it handed to workspaces.
   *
   * Deliberately this short, and no more. A Bot panel may read what the work it started produced;
   * it may not read or write files itself. Anything that touches a file happens in a conversation,
   * so there is always one to point at.
   */
  bot: {
    /** The assistant's own conversation (created on first use) and its workspace. */
    SESSION: 'bot:session',
    /** Tasks it started (child conversations), derived from the session tree, not a store. */
    TASKS: 'bot:tasks',
    /** How one delegated task is going: state plus the last thing that session said. */
    RESULT: 'bot:result',
    /** Stop a delegated task. */
    CANCEL: 'bot:cancel',
    /**
     * Push: a task it started changed state (finished, failed, or its status moved).
     *
     * The child has its own conversation, so its events belong to that conversation's window. This
     * is the one small signal the panel gets, so it can stop guessing on a timer.
     */
    CHANGED: 'bot:changed',
  },
  window: {
    GET_WORKSPACE: 'window:getWorkspace',
    GET_MODE: 'window:getMode',
    OPEN_WORKSPACE: 'window:openWorkspace',
    OPEN_SESSION_IN_NEW_WINDOW: 'window:openSessionInNewWindow',
    /** A file in its own window — the works library's "open in its own window". */
    OPEN_FILE_WINDOW: 'window:openFileWindow',
    SWITCH_WORKSPACE: 'window:switchWorkspace',
    CLOSE: 'window:close',
    CLOSE_REQUESTED: 'window:closeRequested',
    CONFIRM_CLOSE: 'window:confirmClose',
    CANCEL_CLOSE: 'window:cancelClose',
    SET_TRAFFIC_LIGHTS: 'window:setTrafficLights',
    FOCUS_STATE: 'window:focusState',
    GET_FOCUS_STATE: 'window:getFocusState',
    /**
     * Whether the window is maximized — pushed on every change and answered on demand.
     *
     * The Windows caption buttons are drawn by the app (the OS's own are not painted over the
     * bar any more), and a maximize button has to say which of the two it is: the icon for
     * "maximize" or the one for "restore". Doubled behavior is the same treatment `FOCUS_STATE`
     * gets: a window that mounts after the last change asks once.
     */
    MAXIMIZED_STATE: 'window:maximizedState',
    GET_MAXIMIZED_STATE: 'window:getMaximizedState',
  },
  file: {
    READ: 'file:read',
    READ_DATA_URL: 'file:readDataUrl',
    READ_PREVIEW_DATA_URL: 'file:readPreviewDataUrl',
    READ_BINARY: 'file:readBinary',
    /** Bytes in, bytes out — the write side of READ_BINARY (documents are not UTF-8). */
    WRITE_BINARY: 'file:writeBinary',
    WRITE: 'file:write',
    /** Remove a cut (`*.reel`). Deliberately not a general file delete. */
    DELETE_EDIT: 'file:deleteEdit',
    OPEN_DIALOG: 'file:openDialog',
    /**
     * Where a copy of the document being edited should go ("Save As", a redaction copy).
     *
     * The counterpart of OPEN_DIALOG, and local for the same reason: a path a person picks in a
     * dialog is on *their* machine, so the question has to be asked of the client, never the host.
     */
    SAVE_DIALOG: 'file:saveDialog',
    READ_ATTACHMENT: 'file:readAttachment',
    READ_USER_ATTACHMENT: 'file:readUserAttachment',
    STORE_ATTACHMENT: 'file:storeAttachment',
    GENERATE_THUMBNAIL: 'file:generateThumbnail',
  },
  fs: {
    SEARCH: 'fs:search',
    LIST_DIRECTORY: 'fs:listDirectory',
    CHECK_DIRECTORY: 'fs:checkDirectory',
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
  /**
   * One prompt in, one answer out.
   *
   * Not streamed: the caller writes the whole answer as a single file.
   */
  llm: {
    COMPLETE: 'llm:complete',
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
  browserProfiles: {
    /** Every profile this app has — the built-in `default` always first. */
    LIST: 'browserProfiles:list',
    CREATE: 'browserProfiles:create',
    RENAME: 'browserProfiles:rename',
    DELETE: 'browserProfiles:delete',
    /**
     * Which profile a conversation works in, and what it is inheriting.
     *
     * The picker needs two facts it cannot derive: the conversation's own pick and its workspace's
     * default. Asking here keeps the resolution in one place (the server, which owns both files).
     */
    RESOLVE: 'browserProfiles:resolve',
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
    GET_COMPUTER_USE_ENABLED: 'tools:getComputerUseEnabled',
    SET_COMPUTER_USE_ENABLED: 'tools:setComputerUseEnabled',
    GET_WEB_SEARCH_PROVIDER: 'tools:getWebSearchProvider',
    SET_WEB_SEARCH_PROVIDER: 'tools:setWebSearchProvider',
    GET_WEB_SEARCH_ENABLED: 'tools:getWebSearchEnabled',
    SET_WEB_SEARCH_ENABLED: 'tools:setWebSearchEnabled',
    GET_WEB_FETCH_ENABLED: 'tools:getWebFetchEnabled',
    SET_WEB_FETCH_ENABLED: 'tools:setWebFetchEnabled',
    GET_WEB_FETCH_MODE: 'tools:getWebFetchMode',
    SET_WEB_FETCH_MODE: 'tools:setWebFetchMode',
    GET_DEEPSEEK_SEARCH_KEY_STATUS: 'tools:getDeepSeekSearchKeyStatus',
    SET_DEEPSEEK_SEARCH_KEY: 'tools:setDeepSeekSearchKey',
    GET_DEEPSEEK_FETCH_KEY_STATUS: 'tools:getDeepSeekFetchKeyStatus',
    SET_DEEPSEEK_FETCH_KEY: 'tools:setDeepSeekFetchKey',
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
  decisions: {
    GET_SETTINGS: 'decisions:getSettings',
    SET_SETTINGS: 'decisions:setSettings',
    GET_STATUS: 'decisions:getStatus',
    SET_API_KEY: 'decisions:setApiKey',
    DELETE_API_KEY: 'decisions:deleteApiKey',
    TEST: 'decisions:test',
    PROBE_SERVER: 'decisions:probeServer',
    GET_USAGE: 'decisions:getUsage',
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
    /**
     * A local file opened as a page, in the workspace's window.
     *
     * A path rather than a URL, so that turning one into the other happens once, where
     * `node:url` is — see the handler. Everything else about it is the same as a create
     * plus a navigate plus a focus, which is what the caller would otherwise spell out
     * three times.
     */
    OPEN_FILE: 'browser-pane:open-file',
    /**
     * A link opened as a page, in the workspace's window.
     *
     * Where a link goes by default: the app's own window is the one surface the agent can
     * keep working on (see `open-file`), so a person's clicks land there unless they asked
     * for their system browser. The caller classifies the URL first — what cannot go
     * anywhere (`javascript:`, `data:`, `blob:`) never reaches this channel.
     */
    OPEN_URL: 'browser-pane:open-url',
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
    /**
     * Give one tab's page a viewport — the size a viewer draws it at.
     *
     * The unit is the tab, not the window: a viewer that wants the page to reflow to its own
     * pane asks for that tab alone (docs/requirements/browser-view-streaming.md). Answers with the size the
     * view actually ended up with, because OS window floors may refuse part of the request.
     */
    RESIZE_VIEWPORT: 'browser-pane:resize-viewport',
    SNAPSHOT: 'browser-pane:snapshot',
    CLICK: 'browser-pane:click',
    FILL: 'browser-pane:fill',
    SELECT: 'browser-pane:select',
    SCREENSHOT: 'browser-pane:screenshot',
    EVALUATE: 'browser-pane:evaluate',
    /**
     * Bytes fetched through the window's own session.
     *
     * Its own network stack, so the session's cookies ride along and the page's CORS does not
     * apply — a page may *display* an image from another origin that script may not *read*, and
     * this is what reads it. Used by `read` to keep a captured article's images.
     */
    FETCH_RESOURCE: 'browser-pane:fetch-resource',
    SCROLL: 'browser-pane:scroll',
    /**
     * Watch one tab, in a viewer that is not the window it lives in.
     *
     * `stream-start` subscribes the calling client to that tab's frames; `stream-stop` ends it;
     * `stream-control` says whether the viewer may send input; `stream-input` sends that input.
     * Frames travel on `stream-frame` to **that one client** — see docs/requirements/browser-view-streaming.md.
     */
    STREAM_START: 'browser-pane:stream-start',
    STREAM_STOP: 'browser-pane:stream-stop',
    STREAM_CONTROL: 'browser-pane:stream-control',
    STREAM_INPUT: 'browser-pane:stream-input',
    /**
     * Where the caret is in the watched tab, so a viewer's input method can put its candidate
     * window at the caret rather than at the last click. `null` when nothing editable has focus.
     */
    STREAM_CARET: 'browser-pane:stream-caret',
    STREAM_FRAME: 'browser-pane:stream-frame',
    /**
     * The stream ended without the viewer asking — its tab or window went away, or the CDP
     * session did. Without this the viewer would sit on the last frame it received.
     */
    STREAM_ENDED: 'browser-pane:stream-ended',
    LAUNCH: 'browser-empty-state:launch',
    STATE_CHANGED: 'browser-pane:state-changed',
    REMOVED: 'browser-pane:removed',
    INTERACTED: 'browser-pane:interacted',
    /**
     * Pushed from the browser panel's own toolbar to the main window, because the
     * panel is a separate render process with no workspace/session context of its
     * own. The main window owns that context, so it decides what a pick actually
     * means.
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
    LAYERS: 'projects:layers',
    /** What this project's files were made from — read off the notes beside them. */
    PROVENANCE: 'projects:provenance',
    /** Recursive file tree of a project's own folder, for the session info panel. */
    FILES: 'projects:getFiles',
    CREATE: 'projects:create',
    UPDATE: 'projects:update',
    DELETE: 'projects:delete',
    LIST_ASSETS: 'projects:listAssets',
    UPLOAD_ASSET: 'projects:uploadAsset',
    DELETE_ASSET: 'projects:deleteAsset',
    /** The asset library: files on disk annotated with the tags people and agents wrote. */
    LIBRARY: 'projects:library',
    /** Change one asset's tags or note. The file itself is never touched. */
    UPDATE_ASSET_META: 'projects:updateAssetMeta',
    CHANGED: 'projects:changed',
    /**
     * Watch the workspace's project tree so editors can follow external changes.
     *
     * A spec is a file in the project folder now, and the editors that follow external
     * edits (`useFileWriter`, `MarkdownDrawioBlock`) need the signal to point there —
     * otherwise following a change would silently stop working.
     */
    WATCH_FILES: 'projects:watchFiles',
    UNWATCH_FILES: 'projects:unwatchFiles',
    FILES_CHANGED: 'projects:filesChanged',
  },
  /**
   * Creations — the works an agent produced, derived from the transcripts.
   *
   * One channel, because there is nothing to mutate: the list is computed from session logs and
   * the filesystem, and asking again *is* the refresh (a session that grew is re-parsed, the rest
   * come from the cache). There is no create, no delete and no id — a creation is its file.
   */
  creations: {
    LIST: 'creations:list',
    /** One poster, made on demand and cached by the host that owns a renderer. */
    THUMBNAIL: 'creations:thumbnail',
    /** Pushed when a session transcript grew — a turn produced something. */
    CHANGED: 'creations:changed',
    /** Write a work out as pdf / docx / md — the file a person hands on. */
    EXPORT: 'creations:export',
    /** What this work looked like before its last few changes (newest first). */
    VERSIONS: 'creations:versions',
    /** Put one of those versions on disk, where the person says. */
    SAVE_VERSION: 'creations:saveVersion',
  },
  // The app's bundled drawio editor. It is not a workspace resource — one
  // directory ships with the app and one origin serves it — which is
  // why there is no per-workspace argument to the address below.
  drawio: {
    /** The origin the vendored editor is served at; throws when it is not installed. */
    GET_ORIGIN: 'drawio:getOrigin',
  },
  // The vendored GenOffice editors (docs/sheets/slides/pdf). Same shape as drawio: one
  // directory per editor ships with the app, so the only thing a caller cannot work out
  // for itself is the origin its label derives.
  office: {
    /** The origin the editors are served at; throws when the build is not installed. */
    GET_ORIGIN: 'office:getOrigin',
    /**
     * An editor started (or stopped) showing a document.
     *
     * The one fact the agent cannot work out for itself: whether a write would land under
     * somebody's open editor. Raised by the renderer as its surfaces mount, lowered as they go,
     * and read by the document tool before it writes.
     */
    SET_DOCUMENT_OPEN: 'office:setDocumentOpen',
    /**
     * A document was just written by the host (an agent's save, a conversion). Carries the absolute
     * path, so an editor or preview showing it can say the file moved instead of waiting for a
     * directory watcher that may not cover this file at all.
     */
    FILE_WRITTEN: 'office:fileWritten',
    /** Unsaved work in an editor showing a path — the question a write guard actually asks. */
    SET_DOCUMENT_DIRTY: 'office:setDocumentDirty',
    /** Print the document to a PDF beside it (or at the caller's path); answers the path written. */
    EXPORT_PDF: 'office:exportPdf',
    /** One PNG per page into a folder (default: `craft-export` beside the document). */
    EXPORT_PAGES: 'office:exportPages',
    /**
     * The deck editor's method table, as one door: `(method, args)` — the document lives in the
     * host, so every call about it lands here rather than in a renderer.
     */
    DECK: 'office:deck',
    /** The workbook editor's method table — the document is parsed by a sidecar process. */
    WORKBOOK: 'office:workbook',
    /** The pdf editor's method table — the renderer edits the bytes, the host writes them. */
    PDF: 'office:pdf',
  },
  tweaks: {
    /** Every tweak in a workspace, as summaries (the list the page needs). */
    GET: 'tweaks:get',
    /** One tweak in full, or null. */
    GET_ONE: 'tweaks:getOne',
    /** The switch, plus name/description/patterns. Returns the updated details. */
    UPDATE: 'tweaks:update',
    /** Remove the folder. Irreversible. */
    DELETE: 'tweaks:delete',
    /** Build the loadable extension into a folder the person picked. */
    EXPORT: 'tweaks:export',
    /** Workspace-scoped push after any mutation, carrying the summaries. */
    CHANGED: 'tweaks:changed',
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

  /**
   * Canvases — a project's one board (`<project>/canvas.json`).
   *
   * A person and an agent edit the same document, so every write goes through the store that owns
   * the revision counter and the undo stack: APPLY is a batch of operations, and the answer says
   * what landed. OPEN/CLOSE are what give a canvas its history — see canvas/store.ts.
   *
   * LIST/CREATE/DELETE are kept for older clients; the app now has one canvas per project and
   * these answer that singleton.
   */
  canvas: {
    /** The project's one canvas, without opening anything. */
    LIST: 'canvas:list',
    /** Create the project's canvas if it does not exist; answers the singleton slug and document. */
    CREATE: 'canvas:create',
    /** The panel is showing a canvas: it owns the document and its undo stack from here. */
    OPEN: 'canvas:open',
    /** The panel stopped showing it. The last one out takes the history with it. */
    CLOSE: 'canvas:close',
    /** Read a canvas without holding it (a preview). The editor's copy wins while one is open. */
    READ: 'canvas:read',
    /** The editor saving what it holds: `{ doc, expectedRevision, ids }`. */
    WRITE: 'canvas:write',
    /** Pan/zoom. Written to the file, never revisioned and never undoable. */
    VIEWPORT: 'canvas:viewport',
    DELETE: 'canvas:delete',
    /** A canvas moved: the editor saved it, or someone wrote it with nobody watching. */
    CHANGED: 'canvas:changed',
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
