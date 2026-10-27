/**
 * Channel routing for hybrid local/remote transport.
 *
 * One curated list, one derived complement:
 * - LOCAL_ONLY: always runs on the local Electron server, never proxied. This is the only
 *   question a new channel asks, and the only list anyone maintains by hand.
 * - REMOTE_ELIGIBLE: everything else — it runs on whichever server owns the workspace.
 *
 * Deriving the second set is not a shortcut: `RoutedClient` routes on `isLocalOnly`, so a
 * hand-written remote list could disagree with the actual behaviour without anything failing.
 */

import { RPC_CHANNELS, getAllChannelValues } from './channels'

// ---------------------------------------------------------------------------
// LOCAL_ONLY — fundamentally requires local OS / Electron
// ---------------------------------------------------------------------------

export const LOCAL_ONLY_CHANNELS = new Set<string>([
  // workspaces — the local list (with rootPath) is this machine's; creation and slug checks
  // belong to the server that will own the workspace, so they live in REMOTE_ELIGIBLE.
  RPC_CHANNELS.workspaces.GET,

  // window — Electron window management
  RPC_CHANNELS.window.GET_WORKSPACE,
  RPC_CHANNELS.window.GET_MODE,
  RPC_CHANNELS.window.OPEN_WORKSPACE,
  RPC_CHANNELS.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_CHANNELS.window.OPEN_DESIGN_WINDOW,
  RPC_CHANNELS.window.SWITCH_WORKSPACE,
  RPC_CHANNELS.window.CLOSE,
  RPC_CHANNELS.window.CLOSE_REQUESTED,
  RPC_CHANNELS.window.CONFIRM_CLOSE,
  RPC_CHANNELS.window.CANCEL_CLOSE,
  RPC_CHANNELS.window.SET_TRAFFIC_LIGHTS,
  RPC_CHANNELS.window.FOCUS_STATE,
  RPC_CHANNELS.window.GET_FOCUS_STATE,
  RPC_CHANNELS.window.MAXIMIZED_STATE,
  RPC_CHANNELS.window.GET_MAXIMIZED_STATE,

  // file — native file dialog
  RPC_CHANNELS.file.OPEN_DIALOG,
  // file — draft hydration for user-attached paths. Paths in drafts.json were captured
  // via webUtils.getPathForFile in the renderer, so they point at the user's local machine
  // — even when the workspace itself lives on a remote server. Routing this REMOTE_ELIGIBLE
  // would send the local path to a remote filesystem that can't resolve it.
  RPC_CHANNELS.file.READ_USER_ATTACHMENT,

  // dialog — native folder dialog
  RPC_CHANNELS.dialog.OPEN_FOLDER,

  // auth — local auth state + native dialogs
  RPC_CHANNELS.auth.LOGOUT,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,

  // shell — local OS shell (openFile/showInFolder guarded for remote)
  RPC_CHANNELS.shell.OPEN_URL,
  RPC_CHANNELS.shell.OPEN_FILE,
  RPC_CHANNELS.shell.SHOW_IN_FOLDER,

  // skills — local filesystem actions (guarded for remote)
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,

  // system — local OS info
  RPC_CHANNELS.system.VERSIONS,
  RPC_CHANNELS.system.HOME_DIR,
  RPC_CHANNELS.system.IS_DEBUG_MODE,

  // theme — app/OS-level preferences, not workspace content
  RPC_CHANNELS.theme.GET_SYSTEM_PREFERENCE,
  RPC_CHANNELS.theme.SYSTEM_CHANGED,
  RPC_CHANNELS.theme.APP_CHANGED,
  RPC_CHANNELS.theme.GET_APP,
  RPC_CHANNELS.theme.GET_PRESETS,
  RPC_CHANNELS.theme.LOAD_PRESET,
  RPC_CHANNELS.theme.GET_COLOR_THEME,
  RPC_CHANNELS.theme.SET_COLOR_THEME,
  RPC_CHANNELS.theme.BROADCAST_PREFERENCES,
  RPC_CHANNELS.theme.PREFERENCES_CHANGED,
  RPC_CHANNELS.theme.GET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.SET_WORKSPACE_COLOR_THEME,
  RPC_CHANNELS.theme.GET_ALL_WORKSPACE_THEMES,
  RPC_CHANNELS.theme.BROADCAST_WORKSPACE_THEME,
  RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED,

  // update — local auto-update
  RPC_CHANNELS.update.CHECK,
  RPC_CHANNELS.update.GET_INFO,
  RPC_CHANNELS.update.INSTALL,
  RPC_CHANNELS.update.DISMISS,
  RPC_CHANNELS.update.GET_DISMISSED,
  RPC_CHANNELS.update.AVAILABLE,
  RPC_CHANNELS.update.DOWNLOAD_PROGRESS,

  // releaseNotes — local app info
  RPC_CHANNELS.releaseNotes.GET,
  RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION,

  // badge — local dock badge
  RPC_CHANNELS.badge.REFRESH,
  RPC_CHANNELS.badge.SET_ICON,
  RPC_CHANNELS.badge.DRAW,
  RPC_CHANNELS.badge.DRAW_WINDOWS,

  // menu — local menu events
  RPC_CHANNELS.menu.NEW_CHAT,
  RPC_CHANNELS.menu.NEW_WINDOW,
  RPC_CHANNELS.menu.OPEN_SETTINGS,
  RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS,
  RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE,
  RPC_CHANNELS.menu.TOGGLE_SIDEBAR,
  RPC_CHANNELS.menu.QUIT,
  RPC_CHANNELS.menu.MINIMIZE,
  RPC_CHANNELS.menu.MAXIMIZE,
  RPC_CHANNELS.menu.ZOOM_IN,
  RPC_CHANNELS.menu.ZOOM_OUT,
  RPC_CHANNELS.menu.ZOOM_RESET,
  RPC_CHANNELS.menu.TOGGLE_DEV_TOOLS,
  RPC_CHANNELS.menu.UNDO,
  RPC_CHANNELS.menu.REDO,
  RPC_CHANNELS.menu.CUT,
  RPC_CHANNELS.menu.COPY,
  RPC_CHANNELS.menu.PASTE,
  RPC_CHANNELS.menu.SELECT_ALL,

  // deeplink — local deep link handling
  RPC_CHANNELS.deeplink.NAVIGATE,

  // notification — local OS notifications
  RPC_CHANNELS.notification.SHOW,
  RPC_CHANNELS.notification.NAVIGATE,
  RPC_CHANNELS.notification.GET_ENABLED,
  RPC_CHANNELS.notification.SET_ENABLED,

  // input — local input preferences
  RPC_CHANNELS.input.GET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.SET_SEND_MESSAGE_KEY,
  RPC_CHANNELS.input.GET_SPELL_CHECK,
  RPC_CHANNELS.input.SET_SPELL_CHECK,

  // power — local power management
  RPC_CHANNELS.power.GET_KEEP_AWAKE,
  RPC_CHANNELS.power.SET_KEEP_AWAKE,

  // appearance / caching / rtk / decisions / tools are settings the *agent host* reads, so they
  // live in REMOTE_ELIGIBLE — a remote window must edit the server's policy, not this machine's.

  // browserPane is NOT here: a browser window is the workspace's, like its shell. A local
  // window's calls land on this machine's server and a remote window's on its hub — see the
  // REMOTE_ELIGIBLE block. The client only renders frames and sends input back.

  // drawio — the app's own bundled editor, at an origin this machine hands out. The editor is a
  // client UI asset: a remote window loads its own copy, like a webview bundle.
  RPC_CHANNELS.drawio.GET_ORIGIN,

  // gitbash — Windows-specific local
  RPC_CHANNELS.gitbash.CHECK,
  RPC_CHANNELS.gitbash.BROWSE,
  RPC_CHANNELS.gitbash.SET_PATH,

  // debug — local debug logging
  RPC_CHANNELS.debug.LOG,

  // onboarding — the wizard that still runs here: it starts a loopback callback server on this
  // machine. Whether the *server* needs setup, and recording the answer, live in REMOTE_ELIGIBLE.
  RPC_CHANNELS.onboarding.START_MCP_OAUTH,
  RPC_CHANNELS.settings.GET_NETWORK_PROXY,
  RPC_CHANNELS.settings.SET_NETWORK_PROXY,
])

// ---------------------------------------------------------------------------
// REMOTE_ELIGIBLE — everything LOCAL_ONLY does not claim
// ---------------------------------------------------------------------------

/**
 * A channel runs on whichever server owns the workspace **unless** it is in LOCAL_ONLY.
 *
 * Derived, not listed. This is the same question the router asks at runtime — `RoutedClient`
 * sends anything that is not local to the workspace client — so a second hand-maintained table
 * could only ever disagree with it. Two things went wrong while it was a list: a new channel
 * worked without being classified (nothing to forget, nothing to notice), and a channel missing
 * from the list changed no behaviour while making the table lie about what the protocol does.
 *
 * That leaves one decision per new channel instead of two: *is this fundamentally local?* Say so
 * in LOCAL_ONLY, with the reason. Everything else travels with the server that runs the work:
 *
 * - workspace creation and slug checks happen where the workspace will live, so a remote window
 *   creates on its hub and a local window on this machine;
 * - the server-mode listener is the one this window is on: a remote window edits its hub's
 *   port/TLS, not this machine's (the hub is already trusted with the workspace and the shell —
 *   hiding those fields would be UI preference dressed up as a boundary);
 * - files, fs, git, sources, skills, projects, designs, tweaks, automations, tasks, permissions
 *   and the browser live with the workspace; OAuth exchanges and LLM connection config run where
 *   the credentials will be used;
 * - drawio is the exception that proves the rule: the editor is a UI asset, so windows load their
 *   own copy and the web UI loads the hub's — which is why `drawio:getOrigin` is local.
 */
export const REMOTE_ELIGIBLE_CHANNELS = new Set<string>(
  getAllChannelValues().filter((channel) => !LOCAL_ONLY_CHANNELS.has(channel)),
)

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function isLocalOnly(channel: string): boolean {
  return LOCAL_ONLY_CHANNELS.has(channel)
}

/** The exact complement of `isLocalOnly` — the rule the router actually applies. */
export function isRemoteEligible(channel: string): boolean {
  return !LOCAL_ONLY_CHANNELS.has(channel)
}
