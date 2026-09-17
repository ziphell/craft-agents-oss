/**
 * RemoteBrowserPaneManager
 *
 * Thin proxy that implements `IBrowserPaneManager` for a single remote session.
 * Every method packages its args into a `BrowserCapabilityRequest` and ships it
 * to the user's desktop client via `server.invokeClient(...)`. The local
 * `BrowserPaneManager` dispatcher (in `apps/electron`) executes the call and
 * returns the result through the same WS RPC channel.
 *
 * One instance per (sessionId, workspaceId). Stored on `SessionManager` in a
 * `Map<sessionId, RemoteBrowserPaneManager>` and torn down on session destroy.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import { CodedError } from '@craft-agent/shared/protocol'
import type { BrowserInstanceInfo, PickedElement, TabBelongsTo } from '@craft-agent/shared/protocol'
import type { MockProgram } from '@craft-agent/shared/prototypes'
import type {
  IBrowserPaneManager,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserScreenshotResult,
  FrameCaptureOptions,
  FrameCaptureResult,
  FrameCaptureStarted,
  VideoFrameExtractionResult,
  VideoFrameOptions,
  BrowserConsoleOptions,
  BrowserConsoleEntry,
  BrowserNetworkOptions,
  BrowserNetworkEntry,
  BrowserKeyArgs,
  BrowserWaitArgs,
  BrowserWaitResult,
  BrowserDownloadOptions,
  BrowserDownloadEntry,
  BrowserInstanceSnapshot,
  BrowserTabCreateOptions,
  BrowserTabSummary,
  AccessibilitySnapshot,
} from '../handlers/browser-pane-manager-interface'
import {
  CLIENT_BROWSER_INVOKE,
  requestClientBrowserInvoke,
  type BrowserCapabilityMethod,
  type ScreenshotResultWire,
} from '../transport'
import type { RpcServer } from '../transport/types'

export interface RemoteBrowserPaneManagerDeps {
  readonly sessionId: string
  readonly workspaceId: string
  readonly rpcServer: RpcServer
  /**
   * Resolves the desktop client that should host this session's browser.
   * Returns null when no capable client is connected. SessionManager handles
   * pin + fallback selection so the bridge stays agnostic of routing policy.
   */
  readonly getHostClient: () => string | null
  /**
   * The **work** this session is part of — its task and node when it is a Conductor child,
   * itself otherwise (plan §22).
   *
   * Asked per call rather than captured once, because it can change: a session can be bound
   * to a task after it exists (`bindExistingSessionToTask`), and a page opened before that is
   * still the same conversation's. Omitted → the session is its own work, which is what an
   * ordinary conversation is.
   */
  readonly getWork?: () => TabBelongsTo | null
}

export class RemoteBrowserPaneManager implements IBrowserPaneManager {
  private readonly sessionId: string
  private readonly workspaceId: string
  private readonly rpcServer: RpcServer
  private readonly getHostClient: () => string | null
  private readonly getWork: () => TabBelongsTo | null

  constructor(deps: RemoteBrowserPaneManagerDeps) {
    this.sessionId = deps.sessionId
    this.workspaceId = deps.workspaceId
    this.rpcServer = deps.rpcServer
    this.getHostClient = deps.getHostClient
    this.getWork = deps.getWork ?? (() => null)
  }

  /** Who is asking: the session, and the work it is part of (plan §22). */
  private work(): TabBelongsTo {
    return this.getWork() ?? { kind: 'session', sessionId: this.sessionId }
  }

  // ---------------------------------------------------------------------------
  // Internal: package and ship one IBrowserPaneManager call.
  // ---------------------------------------------------------------------------

  private async invoke<T>(method: BrowserCapabilityMethod, args: unknown[], tabId?: string): Promise<T> {
    const clientId = this.getHostClient()
    if (!clientId) {
      throw new CodedError(
        'BROWSER_NO_CAPABLE_CLIENT',
        'No connected desktop client supports browser tools for this session. ' +
        'Open this workspace from the Craft Agent desktop app and try again.',
      )
    }
    if (!this.rpcServer.hasClientCapability(clientId, CLIENT_BROWSER_INVOKE)) {
      throw new CodedError(
        'CAPABILITY_UNAVAILABLE',
        `Client ${clientId} does not advertise the ${CLIENT_BROWSER_INVOKE} capability.`,
      )
    }
    return await requestClientBrowserInvoke<T>(this.rpcServer, clientId, {
      v: 1,
      method,
      args,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      // The caller's work travels as identity, not in `args`: the far side stamps a new
      // page's `belongsTo` from it rather than from a value the caller could name
      // (plan §22). Asked per call — a session can be bound to a task later.
      work: this.work(),
      // Carried beside the session and workspace rather than inside `args`: it is routing,
      // and the page a command acts on is the caller's decision to state
      // (plan §22, 第十二轮).
      tabId,
    })
  }

  /** Synchronous methods on IBPM are emulated by awaiting in callers; here we
   * preserve a `void` return for fire-and-forget paths used by SessionManager. */
  private invokeSync(method: BrowserCapabilityMethod, args: unknown[], tabId?: string): void {
    this.invoke<unknown>(method, args, tabId).catch(() => {
      // Swallow — callers like setAgentControl / unbindAllForSession don't await.
      // The remote agent will surface the error on the next awaited call if
      // something is genuinely broken.
    })
  }

  // ---------------------------------------------------------------------------
  // IBrowserPaneManager — session lifecycle
  // ---------------------------------------------------------------------------

  setSessionPathResolver(_fn: (sessionId: string) => string | null): void {
    // No-op: path resolution belongs to the remote server, not the client BPM.
    // Calls into this method from the server side are still useful locally for
    // metadata, but the BPM itself doesn't need them on a remote bridge.
  }

  destroyForSession(sessionId: string): void {
    this.invokeSync('destroyForSession', [sessionId])
  }

  async clearVisualsForSession(sessionId: string): Promise<void> {
    await this.invoke<void>('clearVisualsForSession', [sessionId])
  }

  unbindAllForSession(sessionId: string): void {
    this.invokeSync('unbindAllForSession', [sessionId])
  }

  /**
   * IBPM declares `getOrCreateForSession` as synchronous. The async work is
   * fired-and-forgot here; SessionManager's tool runtime always follows with
   * an awaited call (navigate, screenshot, …) that surfaces real errors.
   *
   * Callers that need the actual instanceId should use the async-friendly
   * `createForSession` path via the browser-tool-runtime, which awaits.
   */
  getOrCreateForSession(sessionId: string, _options?: { workspaceId?: string | null }): string {
    // The remote bridge can't synchronously block on a WS round-trip. Return
    // an opaque sentinel — async-aware callers should use `getOrCreateForSessionAsync`.
    // workspaceId is carried on the wire via `BrowserCapabilityRequest.workspaceId`
    // (set from `this.workspaceId`), so the dispatcher already knows it.
    this.invokeSync('getOrCreateForSession', [sessionId])
    return `remote-pending:${sessionId}`
  }

  async getOrCreateForSessionAsync(sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> {
    return await this.invoke('getOrCreateForSession', [sessionId])
  }

  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    _options?: { workspaceId?: string | null },
  ): void {
    this.invokeSync('setAgentControl', [sessionId, meta])
  }

  // ---------------------------------------------------------------------------
  // IBrowserPaneManager — instance management
  // ---------------------------------------------------------------------------

  createForSession(sessionId: string | null, options?: { show?: boolean; workspaceId?: string | null }): string {
    this.invokeSync('createForSession', [sessionId, options])
    return `remote-pending:${sessionId ?? 'workspace'}`
  }

  async createForSessionAsync(sessionId: string | null, options?: { show?: boolean; workspaceId?: string | null }): Promise<string> {
    return await this.invoke('createForSession', [sessionId, options])
  }

  getInstance(_id: string): BrowserInstanceSnapshot | undefined {
    // Synchronous accessor — bridge cannot make a WS round-trip here. Callers
    // who need this info should use the async-friendly `getInstanceAsync`.
    return undefined
  }

  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    return await this.invoke('getInstance', [id])
  }

  listInstances(): BrowserInstanceInfo[] {
    // Sync surface returns []; remote-aware code uses `listInstancesAsync`.
    return []
  }

  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    return await this.invoke('listInstances', [])
  }

  focusBoundForSession(sessionId: string, _options?: { workspaceId?: string | null }): string {
    this.invokeSync('focusBoundForSession', [sessionId])
    return `remote-pending:${sessionId}`
  }

  async focusBoundForSessionAsync(sessionId: string, _options?: { workspaceId?: string | null }): Promise<string> {
    return await this.invoke('focusBoundForSession', [sessionId])
  }

  focus(id: string): void {
    this.invokeSync('focus', [id])
  }

  destroyInstance(id: string): void {
    this.invokeSync('destroyInstance', [id])
  }

  hide(id: string): void {
    this.invokeSync('hide', [id])
  }

  clearAgentControl(sessionId: string): void {
    this.invokeSync('clearAgentControl', [sessionId])
  }

  clearAgentControlForInstance(
    instanceId: string,
    sessionId?: string,
  ): { released: boolean; reason?: string } {
    // Synchronous IBPM return — fire-and-forget the actual call. Callers in
    // forced-stop flows treat a successful local cleanup as best-effort.
    this.invokeSync('clearAgentControlForInstance', [instanceId, sessionId])
    return { released: true }
  }

  // ---------------------------------------------------------------------------
  // IBrowserPaneManager — tabs
  // ---------------------------------------------------------------------------

  createTab(instanceId: string, _options?: BrowserTabCreateOptions): string {
    // Synchronous IBPM return over a WS round-trip: the real id exists only on
    // the far side. Callers that need it use `createTabAsync`, which is every
    // caller that does anything with the new page.
    this.invokeSync('createTab', [instanceId, _options])
    return ''
  }

  async createTabAsync(instanceId: string, options?: BrowserTabCreateOptions): Promise<string> {
    return await this.invoke('createTab', [instanceId, options])
  }

  activateTab(instanceId: string, tabId: string): void {
    this.invokeSync('activateTab', [instanceId, tabId])
  }

  setSessionPage(instanceId: string, tabId: string, sessionId: string): void {
    this.invokeSync('setSessionPage', [instanceId, tabId, sessionId])
  }

  closeTab(instanceId: string, tabId: string): void {
    this.invokeSync('closeTab', [instanceId, tabId])
  }

  assignTab(instanceId: string, tabId: string, to: TabBelongsTo, by: TabBelongsTo): void {
    // `to` travels in `args` (the far side cannot resolve the receiver's task), while `by`
    // is the request's own identity — the same split `createTab` makes (plan §22).
    this.invokeSync('assignTab', [instanceId, tabId, to, by])
  }

  listTabs(_instanceId: string): BrowserTabSummary[] {
    // Sync surface returns []; remote-aware code uses `listTabsAsync`.
    return []
  }

  async listTabsAsync(instanceId: string): Promise<BrowserTabSummary[]> {
    return await this.invoke('listTabs', [instanceId])
  }

  // ---------------------------------------------------------------------------
  // Async methods — these are the ones that actually matter to the agent.
  //
  // Each page-scoped one takes the page it acts on (`tabId`) and ships it as routing
  // context on the request: the local manager is shared by every conversation, so "which
  // page" has to travel with the call (plan §22, 第十二轮).
  // ---------------------------------------------------------------------------

  async navigate(id: string, url: string, tabId?: string): Promise<{ url: string; title: string }> {
    return await this.invoke('navigate', [id, url], tabId)
  }
  async goBack(id: string, tabId?: string): Promise<void> {
    await this.invoke('goBack', [id], tabId)
  }
  async goForward(id: string, tabId?: string): Promise<void> {
    await this.invoke('goForward', [id], tabId)
  }
  reload(id: string, tabId?: string): void {
    // Not awaited, for the same reason the toolbar's reload is not: nothing waits
    // for a document to load. A round-trip that fails means the page did not
    // reload, which the next state push makes visible.
    void this.invoke('reload', [id], tabId).catch(() => {})
  }

  async getAccessibilitySnapshot(id: string, tabId?: string): Promise<AccessibilitySnapshot> {
    return await this.invoke('getAccessibilitySnapshot', [id], tabId)
  }
  async clickElement(
    id: string, ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number },
    tabId?: string,
  ): Promise<void> {
    await this.invoke('clickElement', [id, ref, options], tabId)
  }
  async clickAtCoordinates(id: string, x: number, y: number, tabId?: string): Promise<void> {
    await this.invoke('clickAtCoordinates', [id, x, y], tabId)
  }
  async drag(id: string, x1: number, y1: number, x2: number, y2: number, tabId?: string): Promise<void> {
    await this.invoke('drag', [id, x1, y1, x2, y2], tabId)
  }
  async fillElement(id: string, ref: string, value: string, tabId?: string): Promise<void> {
    await this.invoke('fillElement', [id, ref, value], tabId)
  }
  async typeText(id: string, text: string, tabId?: string): Promise<void> {
    await this.invoke('typeText', [id, text], tabId)
  }
  async selectOption(id: string, ref: string, value: string, tabId?: string): Promise<void> {
    await this.invoke('selectOption', [id, ref, value], tabId)
  }
  async setClipboard(id: string, text: string, tabId?: string): Promise<void> {
    await this.invoke('setClipboard', [id, text], tabId)
  }
  async getClipboard(id: string, tabId?: string): Promise<string> {
    return await this.invoke('getClipboard', [id], tabId)
  }
  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number, tabId?: string): Promise<void> {
    await this.invoke('scroll', [id, direction, amount], tabId)
  }
  async sendKey(id: string, args: BrowserKeyArgs, tabId?: string): Promise<void> {
    await this.invoke('sendKey', [id, args], tabId)
  }
  async uploadFile(_id: string, _ref: string, _filePaths: string[], _tabId?: string): Promise<unknown> {
    throw new CodedError(
      'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
      'File upload from a remote agent is not supported. ' +
      'Ask the user to attach the file to the session instead.',
    )
  }
  async evaluate(id: string, expression: string, tabId?: string): Promise<unknown> {
    return await this.invoke('evaluate', [id, expression], tabId)
  }

  async pickElement(
    id: string,
    options?: { timeoutMs?: number; pollMs?: number },
    tabId?: string,
  ): Promise<PickedElement | null> {
    return await this.invoke<PickedElement | null>('pickElement', [id, options], tabId)
  }

  async addInitScript(id: string, key: string, source: string, tabId?: string): Promise<string> {
    return await this.invoke<string>('addInitScript', [id, key, source], tabId)
  }

  async clearInitScripts(id: string, keyPrefix: string, tabId?: string): Promise<string[]> {
    return await this.invoke<string[]>('clearInitScripts', [id, keyPrefix], tabId)
  }

  async startFrameCapture(id: string, options?: FrameCaptureOptions, tabId?: string): Promise<FrameCaptureStarted> {
    return await this.invoke<FrameCaptureStarted>('startFrameCapture', [id, options], tabId)
  }

  async stopFrameCapture(id: string): Promise<FrameCaptureResult | null> {
    return await this.invoke<FrameCaptureResult | null>('stopFrameCapture', [id])
  }

  async pickVideoFile(): Promise<string | null> {
    return await this.invoke<string | null>('pickVideoFile', [])
  }

  async extractVideoFrames(
    filePath: string,
    options: VideoFrameOptions,
  ): Promise<VideoFrameExtractionResult> {
    return await this.invoke<VideoFrameExtractionResult>('extractVideoFrames', [filePath, options])
  }

  async setFetchMock(id: string, program: MockProgram, tabId?: string): Promise<number> {
    return await this.invoke<number>('setFetchMock', [id, program], tabId)
  }

  async clearFetchMock(id: string, tabId?: string): Promise<void> {
    await this.invoke<void>('clearFetchMock', [id], tabId)
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions, tabId?: string): Promise<BrowserScreenshotResult> {
    const wire = await this.invoke<ScreenshotResultWire>('screenshot', [id, options], tabId)
    return this.fromScreenshotWire(wire)
  }
  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget, tabId?: string): Promise<BrowserScreenshotResult> {
    const wire = await this.invoke<ScreenshotResultWire>('screenshotRegion', [id, target], tabId)
    return this.fromScreenshotWire(wire)
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions, tabId?: string): BrowserConsoleEntry[] {
    // IBPM declares sync. The async result is awaited inside the runtime layer
    // that consumes consoleLogs; returning [] here keeps the sync surface intact.
    void this.invoke<BrowserConsoleEntry[]>('getConsoleLogs', [id, options], tabId).catch(() => {})
    return []
  }
  windowResize(id: string, width: number, height: number): { width: number; height: number } {
    void this.invoke<{ width: number; height: number }>('windowResize', [id, width, height]).catch(() => {})
    return { width, height }
  }
  getNetworkLogs(id: string, options?: BrowserNetworkOptions, tabId?: string): BrowserNetworkEntry[] {
    void this.invoke<BrowserNetworkEntry[]>('getNetworkLogs', [id, options], tabId).catch(() => {})
    return []
  }
  async waitFor(id: string, args: BrowserWaitArgs, tabId?: string): Promise<BrowserWaitResult> {
    return await this.invoke('waitFor', [id, args], tabId)
  }
  async getDownloads(id: string, options?: BrowserDownloadOptions, tabId?: string): Promise<BrowserDownloadEntry[]> {
    return await this.invoke('getDownloads', [id, options], tabId)
  }
  async detectSecurityChallenge(id: string, tabId?: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    return await this.invoke('detectSecurityChallenge', [id], tabId)
  }

  // ---------------------------------------------------------------------------
  // Wire conversions
  // ---------------------------------------------------------------------------

  private fromScreenshotWire(wire: ScreenshotResultWire): BrowserScreenshotResult {
    const bytes = wire.imageBytes
    // Structured clone on the WS layer may deliver this as a Uint8Array or as
    // a serialized object with `data` field — accept both.
    let buffer: Buffer
    if (bytes instanceof Uint8Array) {
      buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } else if (bytes && typeof bytes === 'object' && 'data' in (bytes as object)) {
      buffer = Buffer.from((bytes as { data: number[] }).data)
    } else {
      buffer = Buffer.from(bytes as unknown as ArrayBufferLike)
    }
    return {
      imageBuffer: buffer,
      imageFormat: wire.imageFormat,
      metadata: wire.metadata,
    }
  }
}
