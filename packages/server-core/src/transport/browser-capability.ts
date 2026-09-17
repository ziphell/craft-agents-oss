/**
 * Wire protocol for the `client:browser:invoke` capability.
 *
 * The remote `RemoteBrowserPaneManager` packages an `IBrowserPaneManager`
 * method call into a `BrowserCapabilityRequest` and the local dispatcher
 * (Electron main IPC) executes it on the real `BrowserPaneManager`.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

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
  | 'setSessionPage'
  | 'closeTab'
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
  // Frame capture
  | 'startFrameCapture'
  | 'stopFrameCapture'
  // Video frames
  | 'pickVideoFile'
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
  /** Owning session — used for owner-key namespacing on the client dispatcher. */
  sessionId: string
  /** Owning workspace — combined with `sessionId` to form the owner-key prefix. */
  workspaceId: string
  /**
   * The page of the window this call acts on, when the caller resolved one.
   *
   * Routing context, next to `sessionId` and `workspaceId` rather than in `args`, because
   * it says the same kind of thing: not *what* to do but *where*. The caller resolves it
   * with `pickCommandTarget` — the conversation's own page, and only the page on screen
   * when it has none — and passes it here, so the dispatcher never has to guess from what
   * the person happens to be looking at (plan §22, 第十轮/第十二轮). Absent means the page
   * on screen: a caller with no routing (the person's own toolbar calls never come through
   * here at all) and the commands that are about a window rather than a page.
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
