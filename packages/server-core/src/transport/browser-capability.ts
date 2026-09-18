/**
 * Wire protocol for the `client:browser:invoke` capability.
 *
 * The remote `RemoteBrowserPaneManager` packages an `IBrowserPaneManager`
 * method call into a `BrowserCapabilityRequest` and the local dispatcher
 * (Electron main IPC) executes it on the real `BrowserPaneManager`.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import type { TabBelongsTo } from '@craft-agent/shared/protocol'

export const BROWSER_CAPABILITY_VERSION = 1

/**
 * Names map 1:1 to `IBrowserPaneManager` methods.
 * Positional `args` carry the method's arguments in declaration order.
 */
export type BrowserCapabilityMethod =
  // Lifecycle / instances
  | 'createForSession'
  | 'getOrCreateForSession'
  | 'focusBoundForSession'
  | 'destroyInstance'
  | 'destroyForSession'
  | 'getInstance'
  | 'listInstances'
  // Tabs
  | 'createTab'
  | 'activateTab'
  | 'setSessionTab'
  | 'closeTab'
  | 'assignTab'
  | 'listTabs'
  | 'unbindAllForSession'
  | 'setAgentControl'
  | 'clearAgentControl'
  | 'clearAgentControlForInstance'
  | 'clearVisualsForSession'
  | 'focus'
  | 'hide'
  // Navigation
  | 'navigate'
  | 'goBack'
  | 'goForward'
  | 'reload'
  // Interaction
  | 'getAccessibilitySnapshot'
  | 'clickElement'
  | 'clickAtCoordinates'
  | 'drag'
  | 'fillElement'
  | 'typeText'
  | 'selectOption'
  | 'sendKey'
  | 'scroll'
  | 'waitFor'
  | 'evaluate'
  | 'pickElement'
  // Persistent injection
  | 'addInitScript'
  | 'clearInitScripts'
  // Video frames
  | 'extractVideoFrames'
  // Network-level mock
  | 'setFetchMock'
  | 'clearFetchMock'
  // Clipboard
  | 'setClipboard'
  | 'getClipboard'
  // Capture / introspection
  | 'screenshot'
  | 'screenshotRegion'
  | 'getConsoleLogs'
  | 'getNetworkLogs'
  | 'windowResize'
  | 'getDownloads'
  | 'uploadFile'
  | 'detectSecurityChallenge'

export interface BrowserCapabilityRequest {
  /** Protocol version. Always `1` for now; bumped on breaking shape changes. */
  v: 1
  method: BrowserCapabilityMethod
  /** Positional args matching `IBrowserPaneManager[method]` signature. */
  args: unknown[]
  /** Owning session — who is asking, and whose cursor and lease a tab is written under. */
  sessionId: string
  /** Owning workspace — the boundary a call may act inside. */
  workspaceId: string
  /**
   * The **work** the asking session is part of (plan §22).
   *
   * Identity next to `sessionId` rather than in `args`, for the same reason `createTab`'s
   * `by` is stamped by the dispatcher rather than read from the wire: a tab's
   * `belongsTo` has to be the caller's own work, and a request that named somebody else's
   * would be writing a tab's declaration on their behalf. A session that is part of no
   * task is its own work — so this is `{ kind: 'session', sessionId }` for an ordinary
   * conversation, and the task's node for a Conductor child.
   */
  work: TabBelongsTo
  /**
   * The tab of the window this call acts on, when the caller resolved one.
   *
   * Routing context, next to `sessionId` and `workspaceId` rather than in `args`, because
   * it says the same kind of thing: not *what* to do but *where*. The caller resolves it
   * with `pickCommandTarget` — the conversation's own tab, and only the tab on screen
   * when it has none — and passes it here, so the dispatcher never has to guess from what
   * the person happens to be looking at (plan §22, 第十轮/第十二轮). Absent means the tab
   * on screen: a caller with no routing (the person's own toolbar calls never come through
   * here at all) and the commands that are about a window rather than a tab.
   */
  tabId?: string
}

/**
 * Wire shape for `screenshot` / `screenshotRegion` results.
 *
 * The local `BrowserScreenshotResult` carries a Node `Buffer` for `imageBuffer`,
 * which doesn't survive structured cloning over WS. The dispatcher converts
 * `Buffer → Uint8Array` here, and `RemoteBrowserPaneManager` converts it back.
 */
export interface ScreenshotResultWire {
  imageFormat: 'png' | 'jpeg'
  imageBytes: Uint8Array
  metadata?: Record<string, unknown>
}
