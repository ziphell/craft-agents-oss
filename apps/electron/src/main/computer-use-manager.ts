/**
 * The desktop this application can drive — `device_tool`'s `computer` door, host side.
 *
 * Bindings here are the driver's own, verified against `@trycua/cua-driver@0.28.1`
 * (contract 0.8.0) on Windows:
 *
 * | what | call |
 * | --- | --- |
 * | windows | `listWindows({})` → `{ windows: [{ windowId (u64 string), pid, appName, title, bounds, isOnScreen, minimized, zIndex }] }` |
 * | tree | `getWindowState({ pid, windowId (BigInt), includeAccessibilityTree, maxElements })` → `{ snapshotId, elements: [{ elementToken, role, label, actions, … }], treeMarkdown, degraded, … }` |
 * | element click | `click({ target: ActionTarget.Window, position: ClickPosition.Element({ elementToken }), deliveryMode })` |
 * | typed input | `typeText({ text })`, `pressKey({ key, modifiers })`, `scroll({ direction, amount })` |
 * | lease | `startSession({})` / `endSession({ session })` |
 *
 * Three decisions are ours, not the driver's:
 *
 * 1. **The driver is optional.** Absence is a normal state: no driver means no device advertises
 *    `computer`, and the tool refuses with a sentence a person can act on. Startup never depends on
 *    a native binary.
 * 2. **One desktop, one session.** A machine has one pointer. The first session holds a lease and a
 *    second gets `CUA_DESKTOP_BUSY`; the lease expires on its own, so a crashed session cannot keep
 *    the desktop forever.
 * 3. **Refs are the driver's `elementToken`.** They are snapshot-scoped (`s00000001:12`), which is
 *    exactly what stops a stale index from clicking whatever now sits in that position.
 */

import type {
  ComputerActionMode,
  ComputerActionOutcome,
  ComputerPaneFns,
  ComputerScreenshotResult,
  ComputerSnapshot,
  ComputerTarget,
  ComputerWindowInfo,
} from '@craft-agent/shared/agent'
import { getComputerUseEnabled } from '@craft-agent/shared/config'
import {
  macPermissionGuidance,
  readMacComputerPermissions,
  requestMacComputerPermissions,
} from './computer-use-permissions'

/** How long a session may go without touching the desktop before it loses it. */
const LEASE_MS = 90_000
/** Beyond this the tree answer is a wall of text a model cannot use well. */
const MAX_ELEMENTS = 400
/** The driver's macOS surface is the accessibility API, not a Win32-like window list. */
const IS_MAC = process.platform === 'darwin'

/**
 * Whether this process has a desktop to offer, as the device link should announce it.
 *
 * Fail-closed: false until the driver has actually resolved, because announcing `computer` without
 * a driver hands out a door whose every command fails. A link that reconnects after the probe picks
 * it up.
 */
let computerUseAdvertised = false

export function isComputerUseAdvertised(): boolean {
  // Read the opt-in switch here as well as at probe time: handshakes are rebuilt from this answer,
  // and a device that has just been turned off must not offer `computer` again before its driver
  // is resolved.
  return computerUseAdvertised && getComputerUseEnabled()
}

export function setComputerUseAdvertised(value: boolean): void {
  computerUseAdvertised = value
}

export interface ComputerUseManagerOptions {
  log?: (message: string, details?: Record<string, unknown>) => void
  /** Resolve a driver, or `null` when this build has none. Called once, on first use. */
  loadDriver?: () => Promise<unknown | null>
  leaseMs?: number
  /** Fired when the lease starts or ends — the hook a visible indicator hangs on. */
  onLeaseChange?: (sessionId: string | null) => void
}

export class ComputerDesktopBusyError extends Error {
  readonly code = 'CUA_DESKTOP_BUSY'
  constructor() {
    super('Another session is driving this desktop right now.')
  }
}

interface RawWindow {
  windowId: string
  pid: number
  appName: string
  title: string
  bounds?: { x: number; y: number; width: number; height: number }
  isOnScreen?: boolean
  minimized?: boolean
  zIndex?: string | number | bigint
}

interface RawWindowState {
  snapshotId?: string
  appName?: string
  windowTitle?: string
  elements?: Array<Record<string, unknown>>
  treeMarkdown?: string
  degraded?: boolean
  degradedReason?: string
  truncated?: boolean
  truncationReason?: string
  elementCount?: number
  totalElementCount?: number
  screenshotWidth?: number
  screenshotHeight?: number
  screenshotMimeType?: string
  images?: Array<{ dataBase64?: string; data?: string; mimeType?: string }>
}

export class ComputerUseManager {
  private readonly log: NonNullable<ComputerUseManagerOptions['log']>
  private readonly leaseMs: number
  private readonly loadDriver: NonNullable<ComputerUseManagerOptions['loadDriver']>
  private readonly onLeaseChange: (sessionId: string | null) => void

  private driver: any = null
  private driverState: 'unknown' | 'loading' | 'ready' | 'absent' = 'unknown'
  private loading: Promise<unknown | null> | null = null

  private leaseSession: string | null = null
  /**
   * Whether the driver's own agent cursor is on screen.
   *
   * `unavailable` is a real state, not a failure to report: the embedded host on macOS has no
   * AppKit main-thread adapter to draw the cursor, and pretending it is "on" would make `status`
   * claim a visible signal that does not exist. The app-level pill is the indicator there.
   */
  private cursorState: 'off' | 'on' | 'unavailable' = 'off'
  private cursorUnavailableLogged = false
  private leaseTimer: NodeJS.Timeout | null = null
  private disposed = false

  /** Windows seen by the last `windows()` call, so a snapshot can recover `pid` from an id. */
  private readonly windowIndex = new Map<string, RawWindow>()
  /** `elementToken` → the window it belongs to. Cleared per window on every new snapshot. */
  private readonly tokenOwners = new Map<string, RawWindow>()

  constructor(options: ComputerUseManagerOptions = {}) {
    this.log = options.log ?? (() => {})
    this.leaseMs = options.leaseMs ?? LEASE_MS
    this.loadDriver = options.loadDriver ?? (async () => null)
    this.onLeaseChange = options.onLeaseChange ?? (() => {})
  }

  /** True when this build can drive a desktop. Cheap after the first call. */
  async available(): Promise<boolean> {
    return (await this.ensureDriver()) !== null
  }

  activeSession(): string | null {
    return this.leaseSession
  }

  /**
   * The pane functions for one session.
   *
   * The lease is taken here rather than on the first command: an agent asking for the door has
   * already decided to use it, and answering with functions it cannot call would only hide that.
   */
  async fnsForSession(sessionId: string): Promise<ComputerPaneFns> {
    // The person's switch is the outer gate. Refusing here means no driver resolution, no lease
    // and — on macOS — no system permission prompt from a tool that was turned off.
    if (!getComputerUseEnabled()) {
      throw new Error('Desktop control is turned off in Settings → App → Tools.')
    }
    const driver = await this.ensureDriver()
    if (!driver) throw new Error('This build has no desktop driver, so `computer` is unavailable.')
    await this.takeLease(sessionId, driver)
    // One probe per session: whether this desktop accepts injected input at all. A locked or remote
    // desktop refuses plain capture, and (measured on Windows) injected keys then report success
    // while doing nothing. Gate the injected verbs on the probe rather than on a false "ok".
    const injected = await probeInjectedInput(driver)
    // macOS grants belong to the host application and the embedded driver will not prompt. Ask
    // lazily — on a person's first use of desktop control — and never block the session on it.
    if (IS_MAC) void requestMacComputerPermissions(this.log)
    return this.buildFns(driver, sessionId, injected)
  }

  /** Give the desktop back early. Safe to call when nothing is held. */
  async release(sessionId?: string): Promise<void> {
    if (sessionId && this.leaseSession && sessionId !== this.leaseSession) return
    const session = this.leaseSession
    // Hide the cursor while the driver session it names still exists.
    if (session) await this.showAgentCursor(false, session)
    this.dropLease()
    if (this.driver && session) {
      try {
        await this.driver.endSession({ session })
      } catch (error) {
        this.log('computer-use: endSession failed', { error: String(error) })
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.release()
    try {
      await this.driver?.shutdown?.()
    } catch { /* shutting down anyway */ }
    this.driver = null
    this.driverState = 'absent'
  }

  // --------------------------------------------------------------------------
  // Lease
  // --------------------------------------------------------------------------

  private async takeLease(sessionId: string, driver: any): Promise<void> {
    if (this.leaseSession && this.leaseSession !== sessionId) throw new ComputerDesktopBusyError()
    const changed = this.leaseSession !== sessionId
    // The driver's own session is what keeps two applications from driving one pointer. Our local
    // lease only covers this process, so announce the session here as well. A driver that refuses
    // for another reason (a half-granted TCC, for one) must not take `status` away with it.
    try {
      await driver.startSession?.({ session: sessionId })
    } catch (error) {
      if (isDesktopBusy(error)) throw new ComputerDesktopBusyError()
      this.log('computer-use: startSession failed; holding a local lease only', {
        error: errorText(error),
      })
    }
    this.leaseSession = sessionId
    this.renewLease()
    if (changed) this.onLeaseChange(sessionId)
    void this.showAgentCursor(true, sessionId)
  }

  private renewLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = setTimeout(() => {
      this.log('computer-use: lease expired')
      void this.release()
    }, this.leaseMs)
    this.leaseTimer.unref?.()
  }

  private dropLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = null
    const had = this.leaseSession
    this.leaseSession = null
    if (had) this.onLeaseChange(null)
  }

  /**
   * The visible half of the lease: the driver draws its own cursor on screen while a session holds
   * the desktop, so a person can see that something is driving their machine.
   *
   * Best effort by design. The embedded host on macOS cannot draw it (it has no AppKit main-thread
   * adapter), so the state becomes `unavailable` rather than a lie — the app-level pill still shows
   * the desktop is held.
   */
  private async showAgentCursor(enabled: boolean, sessionId: string): Promise<void> {
    const driver = this.driver
    if (!driver) return
    if (enabled && this.cursorState === 'on') return
    if (!enabled && this.cursorState !== 'on') return
    try {
      // `set_agent_cursor_enabled` names the session it belongs to.
      await tool(driver, 'set_agent_cursor_enabled', { session: sessionId, enabled })
      this.cursorState = enabled ? 'on' : 'off'
      this.log('computer-use: agent cursor', { visible: enabled })
    } catch (error) {
      this.cursorState = enabled ? 'unavailable' : 'off'
      if (enabled && !this.cursorUnavailableLogged) {
        this.cursorUnavailableLogged = true
        this.log('computer-use: agent cursor unavailable', { error: errorText(error), enabled })
      }
    }
  }

  private assertLease(sessionId: string): void {
    if (this.disposed) throw new Error('This application is shutting down.')
    if (this.leaseSession !== sessionId) throw new ComputerDesktopBusyError()
    this.renewLease()
  }

  // --------------------------------------------------------------------------
  // Driver
  // --------------------------------------------------------------------------

  private async ensureDriver(): Promise<any | null> {
    if (this.driverState === 'ready') return this.driver
    if (this.driverState === 'absent') return null
    if (this.loading) return this.loading
    this.driverState = 'loading'
    this.loading = (async () => {
      try {
        const driver = (await this.loadDriver()) as any
        this.driver = driver
        this.driverState = driver ? 'ready' : 'absent'
        const available = driver ? await Promise.resolve(driver.isAvailable?.()) : false
        this.log('computer-use: driver resolved', { available })
        if (driver && available !== false) return driver
        this.driver = null
        this.driverState = 'absent'
        return null
      } catch (error) {
        this.driverState = 'absent'
        this.log('computer-use: driver unavailable', { error: String(error) })
        return null
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  // --------------------------------------------------------------------------
  // Primitives
  // --------------------------------------------------------------------------

  private buildFns(driver: any, sessionId: string, injectedInput: boolean): ComputerPaneFns {
    const guard = () => this.assertLease(sessionId)
    /**
     * The pid of the app the person is actually in, as the driver reports it (`list_apps.active`).
     *
     * Window stacking (`zIndex`) is global to WindowServer and includes windows on other displays
     * and Spaces, so "highest z" is not the same as "the window the person is using". The active
     * app's pid is that answer on a multi-display desk, and it costs one extra call when the list
     * is refreshed.
     */
    let activePid: number | null = null

    const listWindows = async (): Promise<RawWindow[]> => {
      const answer = await driver.listWindows({})
      const windows: RawWindow[] = Array.isArray(answer?.windows) ? answer.windows : []
      this.windowIndex.clear()
      for (const window of windows) this.windowIndex.set(String(window.windowId), window)
      activePid = await activeAppPid(driver)
      return windows
    }

    const snapshotOf = (window: RawWindow, state: RawWindowState): ComputerSnapshot => {
      for (const [token, owner] of this.tokenOwners) {
        if (owner.windowId === window.windowId) this.tokenOwners.delete(token)
      }
      const elements = (state.elements ?? []).map((raw, fallback) => {
        const token = String(raw.elementToken ?? '')
        if (token) this.tokenOwners.set(token, window)
        return {
          index: Number(raw.elementIndex ?? fallback),
          token,
          role: String(raw.role ?? ''),
          label: String(raw.label ?? ''),
          ...(typeof raw.value === 'string' ? { value: raw.value } : {}),
          enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
          ...(raw.selected === undefined ? {} : { selected: Boolean(raw.selected) }),
          actions: normalizeActions(raw.actions),
          ...(raw.frame ? { frame: normalizeFrame(raw.frame) } : {}),
          ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
        }
      })
      const notes = [state.degradedReason, state.truncationReason].filter(Boolean)
      // `list_windows` needs Screen Recording for titles on macOS; the tree's own window node does
      // not, so a snapshot can still name the window it read.
      const axTitle = elements.find((element) =>
        element.role.toLowerCase() === 'axwindow' && element.label)?.label
      const title = String(state.windowTitle || window.title || axTitle || '').trim()
      return {
        snapshotId: String(state.snapshotId ?? ''),
        window: { ...toWindowInfo(window, false), ...(title ? { title } : {}) },
        source: state.degraded ? 'none' : elements.length > 0 ? 'accessibility' : 'none',
        ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
        elements,
      }
    }

    return {
      windows: async (args) => {
        guard()
        const windows = await listWindows()
        // On macOS WindowServer also reports menu-bar strips, cursor overlays and other helper
        // surfaces. Listing them buries the windows a person means by "my windows", and none of
        // them can be driven as an app window.
        // The app's own windows stay in by default — operating Craft itself is a legitimate ask.
        // `exclude-self` is the explicit opt-out (a capture meant for somebody else's screen).
        const listed = windows.filter((window) =>
          isWindowSurface(window) && !(args?.excludeSelf === true && isSelfWindow(window)))
        const ordered = [...listed].sort((a, b) => {
          const aShown = a.isOnScreen && !a.minimized ? 1 : 0
          const bShown = b.isOnScreen && !b.minimized ? 1 : 0
          if (aShown !== bShown) return bShown - aShown
          return Number(b.zIndex ?? 0) - Number(a.zIndex ?? 0)
        })
        const top = activeWindow(
          new Map(ordered.map((window) => [window.windowId, window])),
          false,
          activePid,
        )
        return ordered.map((w) => toWindowInfo(w, w === top))
      },

      snapshot: async (args) => {
        guard()
        // A default read means "the frontmost window", so refresh that answer rather than reusing
        // a list that may predate the person switching apps/displays.
        if (this.windowIndex.size === 0 || !args?.windowId) await listWindows()
        const window = args?.windowId
          ? this.windowIndex.get(String(args.windowId))
          : activeWindow(this.windowIndex, args?.excludeSelf === true, activePid)
        if (!window) {
          throw new Error(args?.windowId
            ? `No window "${args.windowId}". Run \`windows\` first.`
            : args?.excludeSelf === true
              ? 'No window other than this app is on screen to read.'
              : 'No window is on screen to read.')
        }
        const state = await driver.getWindowState({
          pid: window.pid,
          windowId: toWindowId(window.windowId),
          includeAccessibilityTree: true,
          includeScreenshot: false,
          maxElements: MAX_ELEMENTS,
        }) as RawWindowState
        return snapshotOf(window, state)
      },

      clickElement: async (target, options) => {
        guard()
        const owner = this.requireToken(target)
        const result = await tool(driver, 'click', {
          ...scopeOf(owner),
          element_token: target.token,
          delivery_mode: deliveryModeName(options?.mode ?? 'auto'),
        })
        return outcome(result, 'background')
      },

      invoke: async (target, action) => {
        guard()
        const owner = this.requireToken(target)
        const chosen = driverAction(action)
        if (chosen === 'raise') {
          // macOS exposes `AXRaise` on windows; the element-action surface has no raise verb.
          await tool(driver, 'bring_to_front', scopeOf(owner))
          return {
            role: 'Window',
            label: String(owner.title || owner.appName || ''),
            delivered: 'background',
          }
        }
        // The driver's element vocabulary (`press`, `show_menu`, `set_value`, …) is spent through
        // `click`'s `action` argument — there is no separate `invoke` tool.
        const result = await tool(driver, 'click', {
          ...scopeOf(owner),
          element_token: target.token,
          action: chosen,
        })
        return outcome(result, 'background')
      },

      setValue: async (target, value) => {
        guard()
        const owner = this.requireToken(target)
        const result = await tool(driver, 'set_value', {
          ...scopeOf(owner),
          element_token: target.token,
          value,
        })
        return outcome(result, 'background')
      },

      clickAt: async (point, options) => {
        guard()
        if (!injectedInput) throw injectedInputUnavailable()
        if (!point.windowId) await listWindows()
        const owner = point.windowId
          ? this.windowIndex.get(String(point.windowId))
          : activeWindow(this.windowIndex, options?.excludeSelf === true, activePid)
        // Coordinates are window-local, so an opted-out click with no non-Craft window has no
        // frame to land in. Refusing beats silently clicking the app's own window.
        if (!owner && options?.excludeSelf === true) {
          throw new Error('No window other than this app is on screen to click in.')
        }
        await tool(driver, 'click', {
          ...(owner ? scopeOf(owner) : {}),
          x: point.x,
          y: point.y,
          delivery_mode: deliveryModeName(options?.mode ?? 'auto'),
        })
      },

      typeText: async (text, options) => {
        guard()
        if (!options?.token && !options?.windowId) throw untargetedInput('type')
        if (!options?.token && !injectedInput) throw injectedInputUnavailable()
        const owner = options?.token ? this.requireToken({ token: options.token }) : this.windowFor(options?.windowId)
        await tool(driver, 'type_text', {
          ...(owner ? scopeOf(owner) : {}),
          text,
          ...(options?.token ? { element_token: options.token } : {}),
        })
      },

      sendKey: async (keys, options) => {
        guard()
        if (!injectedInput) throw injectedInputUnavailable()
        if (!options?.windowId) throw untargetedInput('key')
        const { key, modifiers } = normalizeKeyCombo(keys)
        const owner = this.windowFor(options?.windowId)
        await tool(driver, 'press_key', {
          ...(owner ? scopeOf(owner) : {}),
          key,
          ...(modifiers.length > 0 ? { modifiers } : {}),
        })
      },

      scroll: async (direction, amount, options) => {
        guard()
        const owner = this.windowFor(options?.windowId)
        await tool(driver, 'scroll', {
          ...(owner ? scopeOf(owner) : {}),
          direction,
          ...(amount != null ? { amount } : {}),
        })
      },

      screenshot: async (args) => {
        guard()
        if (this.windowIndex.size === 0 || !args?.windowId) await listWindows()
        const window = args?.windowId
          ? this.windowIndex.get(String(args.windowId))
          : activeWindow(this.windowIndex, args?.excludeSelf === true, activePid)
        if (!window) {
          throw new Error(args?.excludeSelf === true
            ? 'No window other than this app is on screen to capture.'
            : 'No window is on screen to capture.')
        }
        let state: RawWindowState
        try {
          // Capture at the window's **logical** size: the long edge of the window in points
          // (macOS) / window units (Windows). The driver then emits an image whose pixels are the
          // same unit as element frames and window bounds (1 px = 1 unit), and reverses the Retina
          // backing scale itself. A fixed 1600 px cap, by contrast, made a 1280-point window on a
          // 2× screen arrive at 1568 px — neither points nor native pixels, and impossible to
          // line up with anything. The driver's own long-edge cap still applies on huge displays;
          // `scale` below reports that case.
          const logicalEdge = window.bounds
            ? Math.max(1, Math.ceil(Math.max(window.bounds.width, window.bounds.height)))
            : 1600
          state = await driver.getWindowState({
            pid: window.pid,
            windowId: toWindowId(window.windowId),
            includeAccessibilityTree: false,
            includeScreenshot: true,
            maxDimension: logicalEdge,
          }) as RawWindowState
        } catch (error) {
          throw screenshotFailure(error)
        }
        const image = state.images?.[0]
        // `dataBase64` is the field the driver fills; `data` is accepted too so a minor version
        // rename does not silently produce an empty image.
        const data = image?.dataBase64 ?? image?.data
        if (!data) throw new Error('The driver returned no screenshot data.')
        const mimeType = (image?.mimeType ?? state.screenshotMimeType) === 'image/jpeg'
          ? 'image/jpeg' : 'image/png'
        const width = Number(state.screenshotWidth ?? 0)
        const height = Number(state.screenshotHeight ?? 0)
        const scale = window.bounds && window.bounds.width > 0 && width > 0
          ? Number((width / window.bounds.width).toFixed(3))
          : undefined
        return {
          data,
          mimeType,
          width,
          height,
          windowId: window.windowId,
          ...(scale != null ? { scale } : {}),
        } satisfies ComputerScreenshotResult
      },

      status: async () => {
        guard()
        const meta = (await Promise.resolve(driver.metadata?.())) ?? {}
        const permissions = await tool(driver, 'check_permissions', {})
          .then((answer) => String((answer as { text?: string })?.text ?? '').split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean))
          .catch(() => [] as string[])
        if (IS_MAC) {
          // `check_permissions` reports raw grant names; this is the actionable sentence the model
          // can hand to the person, and it says what still works without each grant.
          const mac = await readMacComputerPermissions()
          if (mac) permissions.push(...macPermissionGuidance(mac))
        }
        const capture = await tool(driver, 'get_desktop_state', {})
          .then(() => 'available')
          .catch((error: unknown) => `unavailable: ${String((error as Error).message ?? error).slice(0, 160)}`)
        const injected = capture === 'available' ? 'available' : 'unavailable (use element actions)'
        if (this.windowIndex.size === 0) await listWindows()
        const listed = [...this.windowIndex.values()].filter(isWindowSurface).length
        return {
          driver: {
            version: String(meta.driverVersion ?? 'unknown'),
            contractVersion: String(meta.contractVersion ?? 'unknown'),
          },
          permissions,
          desktopCapture: capture,
          injectedInput: injected,
          agentCursor: this.cursorState,
          windows: listed || this.windowIndex.size,
        }
      },

      launchApp: async (name) => {
        guard()
        const result = await tool(driver, 'launch_app', { name })
        // The driver answers both a flat object and a `structuredJson` string, depending on the
        // platform build; merge them so `pid`/`windows` are found either way.
        const answer = {
          ...(result && typeof result === 'object' ? result as Record<string, unknown> : {}),
          ...(structuredOf(result) ?? {}),
        }
        const pid = typeof answer.pid === 'number' ? answer.pid : null
        // macOS launches in the background and may report a window that is not created yet. Poll a
        // little, then choose the app's real window rather than its menu-bar strip.
        let window = chooseWindow(answer.windows)
        if (!window && (answer.window_id ?? answer.windowId) != null) {
          // Older platform builds answer the window id flatly instead of as a list.
          window = normalizeWindow({
            window_id: answer.window_id ?? answer.windowId,
            pid,
            app_name: name,
            is_on_screen: true,
          })
        }
        if (!window && pid != null) {
          for (let attempt = 0; attempt < 10 && !window; attempt += 1) {
            await sleep(150)
            const listed = await driver.listWindows({})
            window = chooseWindow(
              (listed?.windows ?? []).filter((w: RawWindow) => Number(w.pid) === pid),
            )
          }
        }
        if (window && pid != null && IS_MAC) {
          try {
            // "launch" in the command language means start *or focus*; the driver's launch is
            // deliberately background-only.
            await tool(driver, 'bring_to_front', { pid, window_id: String(window.windowId) })
          } catch (error) {
            this.log('computer-use: launch could not front the window', { error: errorText(error) })
          }
        }
        return {
          pid,
          ...(window ? { windowId: String(window.windowId) } : {}),
        }
      },

      stop: async () => {
        await this.release(sessionId)
      },
    }
  }

  /** The window an input action goes to: the one named, else the frontmost. */
  private windowFor(windowId?: string): RawWindow | null {
    return windowId ? this.windowIndex.get(String(windowId)) ?? null : activeWindow(this.windowIndex)
  }

  private requireToken(target: ComputerTarget): RawWindow {
    const owner = this.tokenOwners.get(target.token)
    if (!owner) {
      throw new Error('That element token is unknown or stale. Run `snapshot` again.')
    }
    return owner
  }
}

// ============================================================================
// Talking to the driver
//
// Every action goes through `callTool`, the driver's own self-describing surface: `listToolsJson()`
// reports 61 tools with their input schemas, so the names and arguments below are the driver's, not
// a guess. Reads use the typed FFI methods (`listWindows`, `getWindowState`) because they answer
// with structures we can normalize once.
// ============================================================================

/** Window id is u64 on the wire; the typed reader takes it as BigInt. */
function toWindowId(value: string): bigint {
  try {
    return BigInt(String(value))
  } catch {
    throw new Error(`"${value}" is not a window id. Take one from \`windows\`.`)
  }
}

/** `{ pid, window_id }` — how a tool names the window it acts on. */
function scopeOf(window: RawWindow): { pid: number; window_id: string } {
  return { pid: window.pid, window_id: String(window.windowId) }
}

async function tool(driver: any, name: string, args: Record<string, unknown>): Promise<unknown> {
  // `callTool(name, argumentsJson)` — two positional strings; the second is JSON, not an object.
  const result = await driver.callTool(name, JSON.stringify(args))
  // A tool that acted on nothing still answers, with `isError` set. Reporting that as success is
  // how "Sent ctrl+a" once meant "did nothing": the caller must hear it as a failure.
  if (result && typeof result === 'object' && (result as { isError?: boolean }).isError) {
    throw new Error(toolErrorText(result))
  }
  return result
}

/** The sentence inside a failed tool result, without the JSON wrapper. */
export function toolErrorText(result: unknown): string {
  const value = (result ?? {}) as { text?: unknown; rawJson?: unknown }
  if (typeof value.text === 'string' && value.text.trim()) return value.text.trim()
  if (typeof value.rawJson === 'string') {
    try {
      const parsed = JSON.parse(value.rawJson) as { content?: Array<{ text?: unknown }> }
      const first = parsed.content?.find((item) => typeof item.text === 'string')
      if (first && typeof first.text === 'string') return first.text.trim()
    } catch { /* fall through */ }
  }
  return 'The desktop driver refused the command.'
}

/** `auto` means background: accessibility delivery that never moves the pointer. */
function deliveryModeName(mode: ComputerActionMode): 'background' | 'foreground' {
  return mode === 'foreground' ? 'foreground' : 'background'
}

function normalizeFrame(frame: unknown): { x: number; y: number; width: number; height: number } {
  const f = (frame ?? {}) as Record<string, number>
  return {
    x: Number(f.x ?? 0),
    y: Number(f.y ?? 0),
    width: Number(f.width ?? f.w ?? 0),
    height: Number(f.height ?? f.h ?? 0),
  }
}

/** Helper surfaces WindowServer reports that no agent means to drive. */
const MAC_SYSTEM_SURFACES = /^(CursorUIViewService|Window Server|Dock|Control Center|Notification Center)$/i

/**
 * Whether a window record is an app window rather than a strip or overlay.
 *
 * macOS reports the menu bar as a 1440×24 "window" for every foreground app, plus cursor and system
 * overlays. They cannot be read or acted on as windows, so leaving them in the list only makes the
 * real ones harder to find. The guard is macOS-only: a small Windows window is still a window.
 */
function isWindowSurface(window: RawWindow): boolean {
  if (!IS_MAC) return true
  if (MAC_SYSTEM_SURFACES.test(String(window.appName ?? ''))) return false
  const bounds = window.bounds
  if (!bounds) return true
  return bounds.width > 40 && bounds.height > 40
}

/** Accept the driver's structured window shape (`window_id`, `app_name`) as well as the typed one. */
function normalizeWindow(raw: unknown): RawWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const id = w.windowId ?? w.window_id
  if (id == null) return null
  return {
    windowId: String(id),
    pid: Number(w.pid ?? 0),
    appName: String(w.appName ?? w.app_name ?? ''),
    title: String(w.title ?? ''),
    ...(w.bounds && typeof w.bounds === 'object'
      ? { bounds: w.bounds as RawWindow['bounds'] }
      : {}),
    isOnScreen: Boolean(w.isOnScreen ?? w.is_on_screen),
    minimized: Boolean(w.minimized),
    ...(w.zIndex != null || w.z_index != null
      ? { zIndex: String(w.zIndex ?? w.z_index) }
      : {}),
  }
}

/** The app's real, frontmost window from a launch/list answer. */
function chooseWindow(windows: unknown): RawWindow | null {
  const list = Array.isArray(windows) ? windows : []
  const usable = list
    .map(normalizeWindow)
    .filter((window): window is RawWindow => window != null && isWindowSurface(window))
  const shown = usable.filter((window) => window.isOnScreen && !window.minimized)
  const pool = shown.length > 0 ? shown : usable
  return pool.sort((a, b) => Number(b.zIndex ?? 0) - Number(a.zIndex ?? 0))[0] ?? null
}

/**
 * macOS advertises AX action names (`AXPress`, `AXShowMenu`); the driver acts on `press`,
 * `show_menu`, … . Showing the vocabulary an action accepts keeps `snapshot` → `invoke` honest —
 * and an AX action the driver cannot perform (`AXScrollToVisible`, say) is left out rather than
 * offered as if `invoke` would accept it.
 */
function normalizeActions(actions: unknown): string[] {
  const list = Array.isArray(actions) ? actions.map(String) : []
  if (!IS_MAC) return list
  const supported = new Set(['press', 'show_menu', 'pick', 'confirm', 'cancel', 'open', 'raise'])
  const normalized: string[] = []
  for (const action of list) {
    const bare = action.toLowerCase().replace(/^ax/, '')
    const name = bare === 'showmenu' ? 'show_menu' : bare
    if (supported.has(name)) normalized.push(name)
  }
  return normalized
}

/**
 * The action name to send to `click`.
 *
 * macOS exposes `AXPress`, not the Windows-flavoured `invoke`, and its `click.action` enum has no
 * `invoke` member for every verb; the default therefore differs by platform. An explicit
 * `AXRaise` has no element-action equivalent and is served by `bring_to_front` instead.
 */
function driverAction(action?: string): string {
  const raw = (action ?? '').trim()
  if (!raw) return IS_MAC ? 'press' : 'invoke'
  if (!IS_MAC) return raw
  const bare = raw.toLowerCase().replace(/^ax/, '').replace(/[\s_-]/g, '')
  if (bare === 'raise') return 'raise'
  if (bare === 'invoke' || bare === 'press') return 'press'
  if (bare === 'showmenu') return 'show_menu'
  if (['pick', 'confirm', 'cancel', 'open'].includes(bare)) return bare
  return raw
}

/**
 * Key combinations, in the driver's own spelling.
 *
 * macOS modifiers are `cmd` / `option`, not `ctrl` / `alt`; named keys are lowercase (`return`,
 * `escape`). A command written on one platform should not silently mean another on the other.
 */
function normalizeKeyCombo(combo: string): { key: string; modifiers: string[] } {
  const parsed = parseKeyCombo(combo)
  const key = normalizeKeyName(parsed.key)
  const modifiers = parsed.modifiers
    .map(normalizeModifier)
    .filter((modifier): modifier is string => modifier.length > 0)
  return { key, modifiers }
}

function normalizeKeyName(key: string): string {
  if (key.length === 1) return key
  const lower = key.toLowerCase()
  const aliases: Record<string, string> = {
    enter: 'return',
    esc: 'escape',
    spacebar: 'space',
    del: 'delete',
    pgup: 'pageup',
    pgdn: 'pagedown',
  }
  return aliases[lower] ?? lower
}

function normalizeModifier(modifier: string): string {
  const lower = modifier.toLowerCase()
  if (IS_MAC) {
    if (['cmd', 'command', 'meta', 'super', 'win'].includes(lower)) return 'cmd'
    if (['option', 'alt', 'opt'].includes(lower)) return 'option'
    if (lower === 'control') return 'ctrl'
    return lower
  }
  if (['cmd', 'command', 'meta', 'super'].includes(lower)) return 'win'
  if (['option', 'opt'].includes(lower)) return 'alt'
  if (lower === 'control') return 'ctrl'
  return lower
}

/**
 * A window this application owns.
 *
 * The main process creates every `BrowserWindow`, so its pid is the owner pid the platform reports
 * — the conversation window and the "desktop is being driven" pill alike. Used only by the explicit
 * `excludeSelf` opt-in; by default these windows are ordinary targets.
 */
function isSelfWindow(window: RawWindow): boolean {
  return Number(window.pid) === process.pid
}

/** The pid of the frontmost application, or `null` when the driver cannot say. */
async function activeAppPid(driver: any): Promise<number | null> {
  try {
    const answer = await tool(driver, 'list_apps', {})
    const structured = structuredOf(answer)
    const apps = Array.isArray(structured?.apps)
      ? structured.apps as Array<Record<string, unknown>>
      : []
    const active = apps.find((app) => app.active === true)
    return typeof active?.pid === 'number' ? active.pid : null
  } catch {
    return null
  }
}

/**
 * The window a call acts on when none was named: the frontmost **app's** frontmost window.
 *
 * `preferredPid` is the active app from `list_apps`. That matters with several displays: window
 * stacking is global, so the highest `zIndex` can belong to a window on another display that the
 * person is not using. Asking the OS which app is frontmost is the answer a person would give,
 * with a fallback to plain stacking when the driver cannot provide it.
 */
function activeWindow(
  index: Map<string, RawWindow>,
  excludeSelf = false,
  preferredPid?: number | null,
): RawWindow | null {
  const usable = (window: RawWindow) =>
    window.isOnScreen &&
    !window.minimized &&
    isWindowSurface(window) &&
    !(excludeSelf && isSelfWindow(window))
  const frontmost = (windows: RawWindow[]): RawWindow | null =>
    windows.reduce<RawWindow | null>(
      (best, window) =>
        best == null || Number(window.zIndex ?? 0) > Number(best.zIndex ?? 0) ? window : best,
      null,
    )
  const all = [...index.values()]
  if (preferredPid != null) {
    const preferred = frontmost(all.filter((window) =>
      usable(window) && Number(window.pid) === preferredPid))
    if (preferred) return preferred
  }
  const best = frontmost(all.filter(usable))
  if (best) return best
  const fallback = all.find((window) =>
    isWindowSurface(window) && !(excludeSelf && isSelfWindow(window)))
  return fallback ?? (excludeSelf ? null : all[0] ?? null)
}

function toWindowInfo(window: RawWindow, active: boolean): ComputerWindowInfo {
  return {
    id: String(window.windowId),
    title: String(window.title ?? ''),
    app: String(window.appName ?? ''),
    pid: typeof window.pid === 'number' ? window.pid : null,
    active,
    ...(window.bounds ? { bounds: normalizeFrame(window.bounds) } : {}),
  }
}

/** What an element action reports: the driver's role/label, and how it was delivered. */
function outcome(raw: unknown, fallback: 'background' | 'foreground'): ComputerActionOutcome {
  const value = (raw ?? {}) as Record<string, unknown>
  const delivered = value.delivered === 'foreground' || value.delivery_mode === 'foreground'
    ? 'foreground'
    : fallback
  return {
    role: String(value.role ?? 'Element'),
    label: String(value.label ?? ''),
    delivered,
  }
}

/** True when this desktop accepts injected input; measured once per session. */
async function probeInjectedInput(driver: any): Promise<boolean> {
  try {
    await tool(driver, 'get_desktop_state', {})
    return true
  } catch {
    return false
  }
}

/** Injected input is refused where the session cannot confirm it landed. */
function injectedInputUnavailable(): Error {
  return new Error(
    'This session cannot accept injected input (no interactive desktop: locked or remote). ' +
    'Use snapshot + click/invoke/set-value, or type --element for fields.',
  )
}

/**
 * Input that names no window is refused.
 *
 * The driver accepts it and reports success while typing into whatever has focus — which on a
 * locked or remote desktop is nothing at all. A silent no-op is worse than an error: the agent
 * moves on believing the field was filled.
 */
function untargetedInput(verb: string): Error {
  return new Error(
    `\`${verb}\` needs a window: pass --window <id> (and --element <token> for a field). ` +
    'Unfocused input is refused because it cannot be verified.',
  )
}

/** `ctrl+shift+s` -> `{ key: 's', modifiers: ['ctrl','shift'] }`. */
export function parseKeyCombo(combo: string): { key: string; modifiers: string[] } {
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('Empty key combination.')
  return { key: parts[parts.length - 1]!, modifiers: parts.slice(0, -1) }
}

/** A driver result's structured payload, when it has one. */
function structuredOf(result: unknown): Record<string, unknown> | null {
  const value = (result ?? {}) as { structuredJson?: unknown; structuredContent?: unknown }
  if (value.structuredContent && typeof value.structuredContent === 'object') {
    return value.structuredContent as Record<string, unknown>
  }
  if (typeof value.structuredJson === 'string') {
    try {
      const parsed = JSON.parse(value.structuredJson) as unknown
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  return null
}

/** The sentence inside a thrown driver error, including the SDK's wrapped `inner` error. */
function errorText(error: unknown): string {
  const inner = (error as { inner?: { message?: unknown } })?.inner?.message
  if (typeof inner === 'string' && inner.trim()) return inner.trim()
  const message = (error as Error)?.message
  return typeof message === 'string' && message.trim() ? message.trim() : String(error)
}

/** A second application holding the driver's desktop lease. */
function isDesktopBusy(error: unknown): boolean {
  return /CUA_DESKTOP_BUSY/.test(errorText(error))
}

/**
 * A failed window capture, in words a person can act on.
 *
 * On macOS the driver's typed reader wraps the reason (`DriverError.Tool` / `No content produced`),
 * which says nothing about the missing grant. Name the grant rather than hand over the wrapper.
 */
function screenshotFailure(error: unknown): Error {
  const detail = errorText(error)
  if (IS_MAC && /no content produced|screenshot|tcc|permission|capture/i.test(detail)) {
    return new Error(
      'Window screenshots need Screen Recording on macOS ' +
      '(System Settings › Privacy & Security › Screen Recording), then restart the app. ' +
      `Element actions still work. Driver said: ${detail}`,
    )
  }
  return new Error(`Screenshot failed: ${detail}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

// ============================================================================
// Loading the optional driver
// ============================================================================

/**
 * The driver this build ships, when it does.
 *
 * A dynamic import inside a try: `@trycua/cua-driver` is optional (a ~25 MB platform payload), and
 * a build without it must still start.
 */
export async function loadDefaultCuaDriver(
  log: ComputerUseManagerOptions['log'] = () => {},
): Promise<any | null> {
  try {
    const sdk: any = await import('@trycua/cua-driver')
    const driver = await sdk.CuaDriver.create({})
    log('computer-use: driver created', {
      version: driver?.metadata?.()?.driverVersion ?? 'unknown',
    })
    return driver
  } catch (error) {
    log('computer-use: driver package not installed', { error: String(error) })
    return null
  }
}
