/**
 * `computer`'s pane surface — the primitives a desktop-driving command runs against.
 *
 * This mirrors `browser-pane.ts` on purpose: a pane is a set of **primitives**, and a door's
 * command language is written once against them. The two panes answer the same shape of question
 * ("what is here", "act on the thing that is here"), so an agent that learned `browser_tool`
 * already knows this one.
 *
 * Two things are deliberately *not* the same as the browser pane:
 *
 * 1. **A target is `(window, element index)`, not a bare ref.** A desktop has several windows and
 *    the accessibility tree is read per window, so an index alone is ambiguous. The command layer
 *    writes refs as `w<windowId>:<index>` and resolves them here.
 * 2. **An action names how it is delivered.** `background` means the driver invokes through the
 *    accessibility API and never moves the pointer — the person keeps their mouse. `foreground`
 *    means real input injection, which does take the pointer for a moment. Callers default to
 *    `auto`: prefer `background`, fall back only when the element cannot be invoked that way.
 */

/** One top-level window the driver can see. */
export interface ComputerWindowInfo {
  /** Stable within one driver session; the `w<id>` part of every ref. */
  id: string
  title: string
  /** Owning application, as the platform reports it (e.g. `chrome.exe`, `TextEdit`). */
  app: string
  pid: number | null
  /** The window the person was last working in. */
  active: boolean
  /** Screen coordinates, when the platform exposes them. */
  bounds?: { x: number; y: number; width: number; height: number }
}

/** One node of a window's accessibility tree. */
export interface ComputerElement {
  index: number
  /**
   * The driver's own ref for this node (`s00000001:12`) — snapshot-scoped, and the only thing an
   * action accepts. Written into the reply so a caller copies it instead of inventing an index.
   */
  token: string
  role: string
  /** Accessible name — what the person would read. Empty is normal for containers. */
  label: string
  value?: string
  description?: string
  enabled: boolean
  selected?: boolean
  /** True when the node belongs to a browser's web content (the driver can reach its DOM). */
  inWebContent?: boolean
  /**
   * Actions this node advertises (`invoke`, `expand`, `collapse`, `setValue`, …).
   *
   * Empty means "act on it by coordinates": the node exists but exposes no action. A caller must
   * not guess an action was performed — check that the list contains what it is about to ask for.
   */
  actions: string[]
  frame?: { x: number; y: number; width: number; height: number }
  depth?: number
}

/** A read of one window's tree. Indexes are only meaningful while this snapshot is the current one. */
export interface ComputerSnapshot {
  /** Opaque id the driver issued; stale ids are refused rather than silently re-resolved. */
  snapshotId: string
  window: ComputerWindowInfo
  elements: ComputerElement[]
  /**
   * How the tree was obtained (`accessibility`, `dom`, `mixed`, `none`). `none` with an empty
   * `elements` is a real answer — a canvas or a game has no tree, and the caller must fall back to
   * the screenshot instead of inventing elements.
   */
  source: 'accessibility' | 'dom' | 'mixed' | 'none'
  /** Anything the driver wanted to say about this read (fallbacks taken, nodes skipped, …). */
  note?: string
}

export interface ComputerScreenshotArgs {
  /** Omit for whatever the person is looking at. */
  windowId?: string
  /** Leave this application's own windows out when choosing the default window. */
  excludeSelf?: boolean
}

/** Which windows to leave out of a list. */
export interface ComputerWindowListArgs {
  /**
   * Leave this application's own windows out — the Craft window the agent runs in, and the
   * "desktop is being driven" pill. Off by default: the app's windows are ordinary targets, so an
   * agent asked to operate Craft itself can. This is the explicit opt-out for when they must not
   * be (a screenshot meant to show somebody else's screen, say).
   */
  excludeSelf?: boolean
}

/** Which window a read acts on. */
export interface ComputerSnapshotArgs {
  /** Omit for the frontmost window. */
  windowId?: string
  /** Leave this application's own windows out when choosing the default window. */
  excludeSelf?: boolean
}

export interface ComputerScreenshotResult {
  /** Base64, no data-uri prefix — the same convention `browser_tool` screenshots use. */
  data: string
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  windowId?: string
  /**
   * Screenshot pixels per window unit (points on macOS, the platform's window unit on Windows).
   *
   * The manager asks for the capture at the window's logical size, so this is normally `1` and a
   * `click-at` coordinate is the same number an element frame or a window bound uses. It is below
   * `1` only when the driver's long-edge cap is tighter than the window (a very large display);
   * the reply then says so, so a caller can convert.
   */
  scale?: number
}

/**
 * How an action reaches the application.
 *
 * - `background` — accessibility invoke / posted messages: the pointer never moves.
 * - `foreground` — real input injection: the pointer moves and the window is raised.
 * - `auto` — prefer background, fall back to foreground only if the element cannot be invoked.
 */
export type ComputerActionMode = 'background' | 'foreground' | 'auto'

/**
 * A resolved target: one element, by the driver's own token.
 *
 * The window is not repeated here — a token already names the snapshot, and a stale one is refused
 * rather than re-resolved against whatever now sits at that position.
 */
export interface ComputerTarget {
  token: string
}

/**
 * What an element action actually did.
 *
 * Returned rather than assumed: the driver knows the node's role and label and how the action was
 * delivered, and a log line built from that is reviewable — `Button "Submit" · delivered=background`
 * says what happened, where `(842, 611)` does not.
 */
export interface ComputerActionOutcome {
  role: string
  label: string
  /** `background` = accessibility invoke (pointer untouched); `foreground` = real input. */
  delivered: 'background' | 'foreground'
}

/**
 * What this session can actually do — read before planning, not after a failure.
 *
 * The three answers are independent: a session can walk the accessibility tree, accept element
 * actions, and still refuse injected input (a locked or remote desktop has no foreground window).
 */
export interface ComputerSessionStatus {
  driver: { version: string; contractVersion: string }
  /** Lines the driver reports about this machine (`check_permissions`). */
  permissions: string[]
  /**
   * Whether a **window** can be captured. Independent of `desktopCapture`: a disconnected RDP
   * session has no desktop surface, yet the windows it owns still paint themselves.
   */
  windowCapture: string
  /** `unavailable: …` when the whole desktop cannot be captured (no display surface). */
  desktopCapture: string
  /** Whether `key` / `click-at` / untargeted `type` can land at all in this session. */
  injectedInput: string
  /** Whether the driver's own cursor is visible on screen while this session holds the desktop. */
  agentCursor: string
  windows: number
}

/**
 * What a device must provide to advertise `computer`.
 *
 * Every method either does the thing or throws — nothing here reports success by convention, so
 * a caller may treat "returned" as "happened".
 */
export interface ComputerPaneFns {
  windows: (args?: ComputerWindowListArgs) => Promise<ComputerWindowInfo[]>
  /** Read a window's tree. `windowId` omitted means the active window. */
  snapshot: (args?: ComputerSnapshotArgs) => Promise<ComputerSnapshot>
  clickElement: (
    target: ComputerTarget,
    options?: { mode?: ComputerActionMode },
  ) => Promise<ComputerActionOutcome>
  /** For nodes that expose no action, and for canvases where no node exists. */
  clickAt: (
    point: { x: number; y: number; windowId?: string },
    options?: { mode?: ComputerActionMode; excludeSelf?: boolean },
  ) => Promise<void>
  /** Perform one of the node's advertised `actions` (default `invoke`). */
  invoke: (target: ComputerTarget, action?: string) => Promise<ComputerActionOutcome>
  setValue: (target: ComputerTarget, value: string) => Promise<ComputerActionOutcome>
  typeText: (text: string, options?: { windowId?: string; token?: string }) => Promise<void>
  /** A key combination, e.g. `ctrl+s`, `alt+Tab`, `Return`. */
  sendKey: (keys: string, options?: { windowId?: string }) => Promise<void>
  scroll: (
    direction: 'up' | 'down' | 'left' | 'right',
    amount?: number,
    options?: { windowId?: string },
  ) => Promise<void>
  screenshot: (args?: ComputerScreenshotArgs) => Promise<ComputerScreenshotResult>
  /**
   * This session's capabilities, including whether injected input will work at all.
   *
   * Cheap enough to call first: an agent that plans on `click-at` in a locked session wastes a turn.
   */
  status: () => Promise<ComputerSessionStatus>
  /** Start or focus an application, answering the window it produced when the platform does. */
  launchApp: (name: string) => Promise<{ pid: number | null; windowId?: string }>
  /**
   * Give the desktop back.
   *
   * The manager holds a lease while a conversation drives the machine; dropping it immediately is
   * how "stop" reads from the agent's side. A caller that never calls this still loses the desktop
   * when the lease expires — this is the eager path, not the only one.
   */
  stop: () => Promise<void>
}
