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
 * | element action | `callTool('click', { pid, window_id, element_token, delivery_mode })` → `{ effect, route, delivery: { mode } }` (the envelope's `action` holds the same verdict, with ordinal enums) |
 * | typed input | `callTool('type_text'\|'press_key'\|'scroll', { pid, window_id, … })` → the same `{ effect, route, delivery }` |
 * | lease | `startSession({})` / `endSession({ session })` |
 *
 * An action's reply **never** carries the element's `role`/`label` and never a `delivered` flag; the
 * node's identity comes from the snapshot that minted the token, and delivery from
 * `delivery.mode`. Everything a reply carries is unwrapped by `tool()` and nowhere else.
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
  hasMacComputerPermissions,
  macPermissionGuidance,
  readMacComputerPermissions,
  requestMacComputerPermissions,
} from './computer-use-permissions'
import {
  describeProcessIntegrity,
  isHigherIntegrity,
  readInputDesktop as readWindowsInputDesktop,
  readProcessIntegrity as readWindowsProcessIntegrity,
  type InputDesktopState,
  type ProcessIntegrity,
} from './windows-desktop-state'

/** How long a session may go without touching the desktop before it loses it. */
const LEASE_MS = 90_000
/** Beyond this the tree answer is a wall of text a model cannot use well. */
const MAX_ELEMENTS = 400

/**
 * How much of one label or value is shown.
 *
 * Some applications report a whole document as an element's label (Notepad++ hands its buffer
 * over that way), and this read is answered as text — to the model, and across the device link.
 * A cap keeps one pathological node from spending the budget of the snapshot that found it.
 */
const MAX_LABEL_CHARS = 200

function clip(text: unknown): string {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length > MAX_LABEL_CHARS ? `${value.slice(0, MAX_LABEL_CHARS)}…` : value
}

/** The driver's macOS surface is the accessibility API, not a Win32-like window list. */
const IS_MAC = process.platform === 'darwin'
/** UIPI and the Winlogon desktop are Windows questions; the other platforms have their own. */
const IS_WINDOWS = process.platform === 'win32'

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
  // Two conditions at this level: a driver that answered, and this person's own switch. Whether a
  // *particular server* may use it is a per-connection grant (`computerEnabled` on the saved
  // connection) — a machine-wide "remote" switch would be a third answer to the same question.
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
  /**
   * Windows-only probes, injectable so tests never have to own a token or a desktop.
   *
   * The defaults read the live machine (`windows-desktop-state.ts`); a platform without them
   * answers `unsupported`, which turns both checks off.
   */
  readProcessIntegrity?: (pid: number) => ProcessIntegrity
  readInputDesktop?: () => InputDesktopState
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

/**
 * The node a token points at, kept alongside its window.
 *
 * The action reply never names the element, so this is the only place a reviewable sentence can get
 * `Button "Submit"` from: it was read in the snapshot that minted the token.
 */
interface TokenOwner {
  window: RawWindow
  role: string
  label: string
}

export class ComputerUseManager {
  private readonly log: NonNullable<ComputerUseManagerOptions['log']>
  private readonly leaseMs: number
  private readonly loadDriver: NonNullable<ComputerUseManagerOptions['loadDriver']>
  private readonly onLeaseChange: (sessionId: string | null) => void
  private readonly readProcessIntegrity: (pid: number) => ProcessIntegrity
  private readonly readInputDesktop: () => InputDesktopState

  private driver: any = null
  private driverState: 'unknown' | 'loading' | 'ready' | 'absent' = 'unknown'
  private loading: Promise<unknown | null> | null = null

  /** This process's own integrity, read once: a token's level does not change while it lives. */
  private selfIntegrity: ProcessIntegrity | null = null

  private leaseSession: string | null = null
  /** Whether `onLeaseChange(sessionId)` has fired for the current lease. */
  private leaseAnnounced = false
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
  /** `elementToken` → the node it names. Cleared per window on every new snapshot. */
  private readonly tokenOwners = new Map<string, TokenOwner>()

  constructor(options: ComputerUseManagerOptions = {}) {
    this.log = options.log ?? (() => {})
    this.leaseMs = options.leaseMs ?? LEASE_MS
    this.loadDriver = options.loadDriver ?? (async () => null)
    this.onLeaseChange = options.onLeaseChange ?? (() => {})
    this.readProcessIntegrity = options.readProcessIntegrity ?? readWindowsProcessIntegrity
    this.readInputDesktop = options.readInputDesktop ?? readWindowsInputDesktop
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
    //
    // A **remote** session must never raise that dialog: the request arrives from another machine,
    // where nobody can answer it, and a permission prompt nobody asked for is indistinguishable
    // from something going wrong. Remote work therefore waits until this Mac has been granted
    // locally, and is refused with a sentence that says how to grant it.
    if (IS_MAC) {
      if (sessionId.startsWith('remote:')) {
        const status = await readMacComputerPermissions()
        if (!hasMacComputerPermissions(status)) {
          throw new Error(
            'This Mac has not granted Accessibility and Screen Recording yet. Turn desktop control ' +
            'on here, use it once from this machine, then retry from the server.',
          )
        }
      } else {
        void requestMacComputerPermissions(this.log)
      }
    }
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
    if (changed) this.leaseAnnounced = false
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
    // A secure desktop owns the machine: keep the session so `status` can explain, but do not
    // renew it on every retry and do not paint the agent cursor on a desktop nobody can drive. The
    // lease expires on its own, which is the pause.
    const secure = this.secureDesktop().secure
    if (secure) {
      if (!this.leaseTimer) this.renewLease()
      // The pill says "this desktop is being driven"; while a UAC prompt owns it, that is false.
      if (this.leaseAnnounced) {
        this.leaseAnnounced = false
        this.onLeaseChange(null)
      }
      this.log('computer-use: lease paused on a secure desktop')
    } else {
      this.renewLease()
      void this.showAgentCursor(true, sessionId)
    }
    if (!secure && !this.leaseAnnounced) {
      this.leaseAnnounced = true
      this.onLeaseChange(sessionId)
    }
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
    const announced = this.leaseAnnounced
    this.leaseSession = null
    this.leaseAnnounced = false
    if (had && announced) this.onLeaseChange(null)
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

  /**
   * The answer to "may this app drive that window?" before the driver tries.
   *
   * A higher-integrity target is not a normal failure: Windows drops the posted message and the
   * accessibility surface is partial, so the driver can report success while nothing happens. The
   * refusal names both levels and the one action that changes the answer.
   */
  private assertWindowDrivable(window: RawWindow): void {
    const reason = this.elevationRefusal(window)
    if (reason) throw new Error(reason)
  }

  /** The refusal for a window above this process's integrity, or `null` when it is drivable. */
  private elevationRefusal(window: RawWindow): string | null {
    if (!IS_WINDOWS) return null
    const target = this.readProcessIntegrity(window.pid)
    if (target.kind === 'denied') {
      return (
        `Windows did not allow this app to inspect the process behind ${describeWindow(window)}. ` +
        'It may be elevated or protected. Restart this app as administrator to try, or use a ' +
        'non-elevated copy of the app.'
      )
    }
    if (target.kind !== 'level') return null
    const self = this.selfIntegrityState()
    if (!isHigherIntegrity(target, self)) return null
    return (
      `${describeWindow(window)} belongs to an elevated process (${describeProcessIntegrity(target)}); ` +
      `this app runs at ${describeProcessIntegrity(self)}. Windows blocks accessibility and input ` +
      'across that boundary, so a click or key would report success while doing nothing. Restart ' +
      'this app as administrator to drive it, or use a non-elevated copy of the app.'
    )
  }

  private selfIntegrityState(): ProcessIntegrity {
    if (this.selfIntegrity === null) this.selfIntegrity = this.readProcessIntegrity(process.pid)
    return this.selfIntegrity
  }

  /** The secure desktop in front, if any. Cheap enough for every command. */
  private secureDesktop(): InputDesktopState {
    return this.readInputDesktop()
  }

  private assertLease(sessionId: string, allowWhenSecure = false): void {
    if (this.disposed) throw new Error('This application is shutting down.')
    if (this.leaseSession !== sessionId) throw new ComputerDesktopBusyError()
    if (!allowWhenSecure) {
      const desktop = this.secureDesktop()
      if (desktop.secure) throw secureDesktopRefusal(desktop)
    }
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
    // Every command is refused while a secure desktop is in front, except `status`, which is the
    // one read that can explain why. The lease is not renewed on that path, so it pauses and then
    // expires on its own rather than holding the desktop through a UAC prompt.
    const guard = (options?: { allowWhenSecure?: boolean }) =>
      this.assertLease(sessionId, options?.allowWhenSecure === true)
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

    const snapshotOf = (
      window: RawWindow,
      state: RawWindowState,
      query?: string,
      capped = false,
    ): ComputerSnapshot => {
      for (const [token, owner] of this.tokenOwners) {
        if (owner.window.windowId === window.windowId) this.tokenOwners.delete(token)
      }
      const elements = (state.elements ?? []).map((raw, fallback) => {
        const token = String(raw.elementToken ?? '')
        const role = String(raw.role ?? '')
        // A label can be a whole document — Notepad++ hands its buffer over as one — and this reply
        // travels as text, both to the model and across the device link. Clip here, where the shape
        // is known, rather than letting one pane blow the budget of the read that found it.
        const label = clip(String(raw.label ?? ''))
        const value = typeof raw.value === 'string' ? clip(raw.value) : undefined
        if (token) this.tokenOwners.set(token, { window, role, label })
        return {
          index: Number(raw.elementIndex ?? fallback),
          token,
          role,
          label,
          ...(value !== undefined ? { value } : {}),
          enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
          ...(raw.selected === undefined ? {} : { selected: Boolean(raw.selected) }),
          actions: normalizeActions(raw.actions),
          ...(raw.frame ? { frame: normalizeFrame(raw.frame) } : {}),
          ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
        }
      })
      const notes = [state.degradedReason, state.truncationReason].filter(Boolean)
      // The driver has no way to say "I stopped early": `truncated` is never set, `elements_complete`
      // is always false, and a capped walk reports `element_count` as the count it *did* walk (1412
      // elements answer `267` under a 400 cap). So the cap is ours to admit — otherwise the header
      // says "267 element(s)" and reads like the whole window.
      if (capped) {
        notes.push(
          `read capped at ${MAX_ELEMENTS} elements — the window may hold more, and the driver reports ` +
          'no total for a capped walk. `snapshot --query <text>` searches the whole tree',
        )
      }
      // `list_windows` needs Screen Recording for titles on macOS; the tree's own window node does
      // not, so a snapshot can still name the window it read.
      const axTitle = elements.find((element) =>
        element.role.toLowerCase() === 'axwindow' && element.label)?.label
      const title = String(state.windowTitle || window.title || axTitle || '').trim()
      // How much the window holds, when the read returned less than that: "12 of 340" is the
      // difference between "this window has 12 elements" and "read deeper".
      const total = Number(state.totalElementCount ?? state.elementCount ?? 0)
      return {
        snapshotId: String(state.snapshotId ?? ''),
        window: { ...toWindowInfo(window, false), ...(title ? { title } : {}) },
        // A filtered read that matched nothing still read the tree: `query` is why the list is
        // empty, not a missing accessibility surface.
        source: state.degraded ? 'none' : elements.length > 0 || query ? 'accessibility' : 'none',
        ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
        ...(total > elements.length ? { total } : {}),
        ...(query ? { filtered: query } : {}),
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
        // An elevated window's UIA tree is partial at best and its input is blocked by UIPI. The
        // honest answer is "no accessibility tree", not the single TitleBar the driver may still
        // read — and it keeps `screenshot`, which does work, as the visible route.
        const elevated = this.elevationRefusal(window)
        if (elevated) {
          return {
            snapshotId: '',
            window: toWindowInfo(window, false),
            source: 'none',
            note: `${elevated} Use \`screenshot\` to see the window; there is no readable accessibility tree.`,
            elements: [],
          }
        }
        // A capped walk is what keeps a full tree out of the context; a **filtered** read must not
        // be capped, because the cap cuts the walk itself (measured on one window: `query Craft`
        // finds 48 nodes uncapped, 20 under a 400 cap) — a search that silently misses matches is
        // worse than a long answer, which `total` then reports as "20 of 1046".
        // A query read mints a **new** snapshot, so the previous tokens are gone; `snapshotOf`
        // forgets them too, rather than letting a stale one reach the driver.
        const capped = !args?.query
        const state = await driver.getWindowState({
          pid: window.pid,
          windowId: toWindowId(window.windowId),
          includeAccessibilityTree: true,
          includeScreenshot: false,
          ...(capped ? { maxElements: MAX_ELEMENTS } : {}),
          ...(args?.query ? { query: args.query } : {}),
        }) as RawWindowState
        return snapshotOf(window, state, args?.query, capped)
      },

      clickElement: async (target, options) => {
        guard()
        const owner = this.requireToken(target)
        this.assertWindowDrivable(owner.window)
        const call = await tool(driver, 'click', {
          ...scopeOf(owner.window),
          element_token: target.token,
          delivery_mode: deliveryModeName(options?.mode ?? 'auto'),
        })
        return outcome(call, 'background', owner)
      },

      invoke: async (target, action) => {
        guard()
        const owner = this.requireToken(target)
        this.assertWindowDrivable(owner.window)
        const chosen = elementAction(action)
        if (chosen === 'raise') {
          // macOS exposes `AXRaise` on windows; the element-action surface has no raise verb.
          await tool(driver, 'bring_to_front', scopeOf(owner.window))
          return {
            role: 'Window',
            label: String(owner.window.title || owner.window.appName || ''),
            delivered: 'background',
          }
        }
        if (chosen == null) throw unsupportedElementAction(action)
        // There is no "perform this accessibility action" call. `click` performs the element's
        // default action (UIA Invoke / AXPress); everything else is a tool of its own, which is
        // what `elementAction()` maps onto — passing an `action` argument used to be dropped in
        // silence by the driver.
        const call = await tool(driver, chosen, {
          ...scopeOf(owner.window),
          element_token: target.token,
        })
        return outcome(call, 'background', owner)
      },

      setValue: async (target, value) => {
        guard()
        const owner = this.requireToken(target)
        this.assertWindowDrivable(owner.window)
        const call = await tool(driver, 'set_value', {
          ...scopeOf(owner.window),
          element_token: target.token,
          value,
        })
        return outcome(call, 'background', owner)
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
        if (owner) this.assertWindowDrivable(owner)
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
        const window = options?.token
          ? this.requireToken({ token: options.token }).window
          : this.windowFor(options?.windowId)
        if (window) this.assertWindowDrivable(window)
        await tool(driver, 'type_text', {
          ...(window ? scopeOf(window) : {}),
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
        if (owner) this.assertWindowDrivable(owner)
        await tool(driver, 'press_key', {
          ...(owner ? scopeOf(owner) : {}),
          key,
          ...(modifiers.length > 0 ? { modifiers } : {}),
        })
      },

      scroll: async (direction, amount, options) => {
        guard()
        const owner = this.windowFor(options?.windowId)
        if (owner) this.assertWindowDrivable(owner)
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
        // The one command that still answers while a secure desktop is in front: it is how the
        // model learns that a UAC prompt — not a broken driver — is why nothing can be driven.
        guard({ allowWhenSecure: true })
        const desktop = this.secureDesktop()
        const meta = (await Promise.resolve(driver.metadata?.())) ?? {}
        const permissions = await tool(driver, 'check_permissions', {})
          .then((call) => call.text.split('\n').map((line) => line.trim()).filter(Boolean))
          .catch(() => [] as string[])
        if (IS_MAC) {
          // `check_permissions` reports raw grant names; this is the actionable sentence the model
          // can hand to the person, and it says what still works without each grant.
          const mac = await readMacComputerPermissions()
          if (mac) permissions.push(...macPermissionGuidance(mac))
        }
        if (IS_WINDOWS) {
          const self = this.selfIntegrityState()
          if (self.kind === 'level') {
            const elevated = self.name === 'high' || self.name === 'system'
            permissions.push(
              elevated
                ? `Elevated windows: drivable (this app runs at ${self.name} integrity).`
                : `Elevated windows: refused — this app runs at ${self.name} integrity; restart it ` +
                  'as administrator to drive them.',
            )
          }
        }
        if (desktop.secure) {
          permissions.push(
            `Secure desktop: ${desktop.name ? `"${desktop.name}"` : 'not readable'} in front — ` +
            'a UAC prompt or lock screen; ask the person to respond.',
          )
        }
        // Three questions, three probes. They are not the same question and they do not fail
        // together: a window can be captured while the desktop cannot, and a session can capture
        // everything while accepting no input at all (no foreground window). One probe standing in
        // for another is how a machine ends up telling the model "cannot screenshot" when it can.
        // A secure desktop is the one case where all three are known to be unavailable without
        // asking: the driver would capture the desktop behind the prompt, which is not the screen.
        const secureCapture = desktop.secure
          ? desktop.name
            ? 'unavailable: a UAC prompt or lock screen is in front'
            : 'unavailable: no readable input desktop (UAC, lock screen, or a disconnected session)'
          : null
        const desktopCapture = secureCapture ?? await tool(driver, 'get_desktop_state', {})
          .then(() => 'available')
          .catch((error: unknown) => `unavailable: ${String((error as Error).message ?? error).slice(0, 160)}`)
        if (this.windowIndex.size === 0) await listWindows()
        const captureTarget = activeWindow(this.windowIndex)
        const windowCapture = secureCapture ?? (captureTarget
          ? await tool(driver, 'get_window_state', {
              ...scopeOf(captureTarget),
              include_accessibility_tree: false,
              include_screenshot: true,
              max_dimension: 320,
            })
              .then(() => 'available')
              .catch((error: unknown) => `unavailable: ${String((error as Error).message ?? error).slice(0, 160)}`)
          : 'unavailable: no window to capture')
        const injected = desktop.secure
          ? `unavailable (${desktop.name ? `input desktop "${desktop.name}"` : 'no readable input desktop'}: ` +
            'a UAC prompt, lock screen, or disconnected session is in front)'
          : (await probeInjectedInput(driver))
            ? 'available'
            : 'unavailable (no interactive desktop: use element actions)'
        const listed = [...this.windowIndex.values()].filter(isWindowSurface).length
        return {
          driver: {
            version: String(meta.driverVersion ?? 'unknown'),
            contractVersion: String(meta.contractVersion ?? 'unknown'),
          },
          permissions,
          windowCapture,
          desktopCapture,
          injectedInput: injected,
          agentCursor: this.cursorState,
          windows: listed || this.windowIndex.size,
        }
      },

      launchApp: async (name) => {
        guard()
        // One shape, measured: `{ active, name, pid, running, windows: [{ window_id, title, … }] }`
        // in the driver's snake_case. There is no flat half to merge — `ToolResult` has fixed fields
        // and `pid`/`windows` are not among them.
        const { data: answer } = await tool<{
          pid?: number
          windows?: unknown
          window_id?: number
          windowId?: number
        }>(driver, 'launch_app', { name })
        // A launch that needs elevation puts the UAC consent dialog on the Winlogon desktop while
        // the process stays suspended. The driver cannot answer it, and the window will not appear
        // until the person does — say that instead of reporting a launch with no window.
        const afterLaunch = this.secureDesktop()
        if (afterLaunch.secure) throw uacWaitRefusal(name, afterLaunch)
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
            const waiting = this.secureDesktop()
            if (waiting.secure) throw uacWaitRefusal(name, waiting)
            await sleep(150)
            const listed = await driver.listWindows({})
            window = chooseWindow(
              (listed?.windows ?? []).filter((w: RawWindow) => Number(w.pid) === pid),
            )
          }
        }
        if (!window && pid != null) {
          // The app is running but produced no window this app can name. If it came up elevated,
          // the next action would be refused by UIPI anyway; say why now.
          const target = this.readProcessIntegrity(pid)
          if (target.kind === 'denied' || isHigherIntegrity(target, this.selfIntegrityState())) {
            throw elevatedLaunchRefusal(name, target)
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

  private requireToken(target: ComputerTarget): TokenOwner {
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

/**
 * One driver call, unwrapped once.
 *
 * The SDK answers a `ToolResult` — `{ text, images, structuredJson, isError, errorCode, action,
 * verification, degraded, rawJson }` — and the machine-readable half is *JSON text* in the driver's
 * own snake_case vocabulary. Those field names are the whole contract: an action reply carries
 * `{ effect, route, delivery }`, and `role` / `label` / `delivered` / `delivery_mode` appear on no
 * reply at all (`delivery_mode` is an *input*; measured against 0.28.1 / contract 0.8.0). Reading
 * them off the envelope is therefore one `undefined` away from a silent lie — which is exactly what
 * `outcome()` used to do. Unwrapping here is the only place it can happen once: call sites only ever
 * see objects, and a field-name typo becomes a type error instead of "the desktop has no windows".
 */
export interface DriverCall<T = Record<string, any>> {
  /** The driver's own rendering of what it did — already a sentence for a person. */
  text: string
  /** The structured half, parsed once. Empty when the driver sent none. */
  data: T
  /** Inline captures (screenshots), passed through untouched. */
  images: Array<{ dataBase64?: string; data?: string; mimeType?: string }>
  /** The driver's own "this read is partial" flag. */
  degraded: boolean
  /** How an action landed. Empty when the tool answers none. */
  action: ActionReport
  /**
   * The driver's machine-readable failure code, when the reply carried one.
   *
   * The reply's `verification` field is deliberately **not** carried: nothing reads it, its
   * `elapsedMs`/`samples` are BigInt (a `JSON.stringify` of it throws) and its `status` is an
   * ordinal. Should `verify_state` ever be wired, read the structured half
   * (`{status: "satisfied", predicates: [{observed_json}]}`) — see docs/computer-use.md.
   */
  errorCode?: string
}

async function tool<T = Record<string, any>>(
  driver: any,
  name: string,
  args: Record<string, unknown>,
): Promise<DriverCall<T>> {
  // `callTool(name, argumentsJson)` — two positional strings; the second is JSON, not an object.
  const result: any = await driver.callTool(name, JSON.stringify(args))
  const text = typeof result?.text === 'string' ? result.text : ''
  // A tool that acted on nothing still answers, with `isError` set. Reporting that as success is
  // how "Sent ctrl+a" once meant "did nothing": the caller must hear it as a failure.
  if (result && typeof result === 'object' && result.isError) {
    throw new Error(toolErrorText(result))
  }
  const data = parseStructured(result)
  return {
    text,
    data: data as T,
    images: Array.isArray(result?.images) ? result.images : [],
    degraded: Boolean(result?.degraded),
    action: actionReport(data, result?.action),
    ...(typeof result?.errorCode === 'string' ? { errorCode: result.errorCode } : {}),
  }
}

/**
 * The structured half of a reply, parsed once.
 *
 * On the envelope it is always `structuredJson` — a *string*. (`structuredContent` exists only
 * inside `rawJson`, which is `{ content: [{ type: 'text', text }], structuredContent: … }`: the text
 * half and this half stored once each, so nothing in it is new. Measured: `rawJson.length ≈
 * text.length + structuredJson.length + ~60`.)
 */
function parseStructured(result: unknown): Record<string, any> | null {
  const value = (result ?? {}) as { structuredJson?: unknown }
  if (typeof value.structuredJson === 'string' && value.structuredJson.trim()) {
    try {
      const parsed = JSON.parse(value.structuredJson) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : null
    } catch {
      // A malformed structured half must not fail the call: `text` still carries the answer.
      return null
    }
  }
  return null
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
 * macOS advertises AX action names (`AXPress`, `AXShowMenu`, `AXRaise`); the driver performs those
 * through `click` (the default is press) and `bring_to_front` (raise). An AX action the driver
 * cannot perform (`AXScrollToVisible`, say) is left out rather than offered as if `invoke` would
 * accept it — the old list also advertised `pick` / `confirm` / `cancel` / `open`, which nothing
 * in the driver performs.
 */
function normalizeActions(actions: unknown): string[] {
  const list = Array.isArray(actions) ? actions.map(String) : []
  if (!IS_MAC) return list
  const supported = new Set(['press', 'show_menu', 'raise'])
  const normalized: string[] = []
  for (const action of list) {
    const bare = action.toLowerCase().replace(/^ax/, '')
    const name = bare === 'showmenu' ? 'show_menu' : bare
    if (supported.has(name)) normalized.push(name)
  }
  return normalized
}

/**
 * The element actions `invoke` can actually carry out.
 *
 * There is no "perform this accessibility action" call in the driver: `click`, `double_click`,
 * `right_click` and `set_value` are separate tools, each taking an `element_token`, and `click`
 * performs the element's default action (UIA Invoke / AXPress). The old code sent an `action`
 * argument to `click` instead — a field the driver's schema does not declare and its own
 * description disowns (“The Swift-only `action` / `modifier` / `debug_image_out` schema fields
 * aren't supported yet”), so every name was dropped in silence: `show_menu` performed a plain
 * click and the model was told it had worked.
 */
const ELEMENT_ACTION_TOOLS = {
  '': 'click',
  invoke: 'click',
  press: 'click',
  click: 'click',
  select: 'click',
  double_click: 'double_click',
  doubleclick: 'double_click',
  dblclick: 'double_click',
  right_click: 'right_click',
  rightclick: 'right_click',
  context_menu: 'right_click',
  show_menu: 'right_click',
  showmenu: 'right_click',
  raise: 'raise',
} as const

/** Actions that exist, but as their own command rather than through `invoke`. */
const ELEMENT_ACTION_ELSEWHERE: Record<string, string> = {
  set_value: 'set-value <ref> <text>',
  setvalue: 'set-value <ref> <text>',
  scroll: 'scroll <up|down|left|right>',
}

function actionKey(action?: string): string {
  return (action ?? '').trim().toLowerCase().replace(/^ax/, '').replace(/[\s-]/g, '_')
}

function elementAction(action?: string): 'click' | 'double_click' | 'right_click' | 'raise' | null {
  const key = actionKey(action) as keyof typeof ELEMENT_ACTION_TOOLS
  return ELEMENT_ACTION_TOOLS[key] ?? null
}

/**
 * The refusal for an action the driver cannot perform.
 *
 * Naming the verb that does it turns a dead end into the next step: `set_value` and `scroll` have
 * their own command and say which, while `expand` genuinely has no equivalent and says that too.
 */
function unsupportedElementAction(action?: string): Error {
  const elsewhere = ELEMENT_ACTION_ELSEWHERE[actionKey(action)]
  if (elsewhere) {
    return new Error(
      `\`${String(action)}\` is not an action the driver performs on an element — use \`${elsewhere}\`.`,
    )
  }
  return new Error(
    `The desktop driver has no element action "${String(action)}". What it can do to an element: ` +
    'click it (the default), double-click it, right-click it, set its value (`set-value`), scroll it ' +
    '(`scroll`), or raise its window. Ask for one of those.',
  )
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
    const { data } = await tool<{ apps?: Array<Record<string, unknown>> }>(driver, 'list_apps', {})
    const apps = Array.isArray(data.apps) ? data.apps : []
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

/**
 * What an element action reports.
 *
 * The node's identity is **not** in the reply — the driver's action output is `{ effect, route,
 * delivery }` and nothing else — so `role`/`label` come from the snapshot that minted the token.
 * `delivered` and `effect` come from the reply; a platform build that reports neither falls back to
 * the requested delivery mode rather than dressing a guess up as an answer.
 */
function outcome(
  call: DriverCall,
  fallback: 'background' | 'foreground',
  owner: TokenOwner,
): ComputerActionOutcome {
  const mode = call.action.mode === 'foreground' || call.action.mode === 'background'
    ? call.action.mode
    : fallback
  // The refusal's own sentence is the actionable half. A code alone still beats dropping the
  // verdict entirely; `background_uipi_blocked` names the boundary even without prose.
  const note = call.action.refusal?.detail ?? call.action.reason ?? call.action.refusal?.code
  return {
    role: owner.role || 'Element',
    label: owner.label,
    delivered: mode,
    ...(call.action.effect ? { effect: call.action.effect } : {}),
    ...(call.action.route ? { route: call.action.route } : {}),
    ...(note ? { note } : {}),
  }
}

/**
 * Whether this session has an **interactive desktop** — the thing injected input needs.
 *
 * Two independent signs, in order of cheapness: a cursor position (only an input desktop has one)
 * and a desktop device context. Neither is a screenshot of the screen, which is a *third* question
 * with its own answer: a disconnected RDP session can still capture a window while having no cursor
 * and no foreground window at all.
 */
async function probeInjectedInput(driver: any): Promise<boolean> {
  const cursor = await tool(driver, 'get_cursor_position', {}).then(() => true).catch(() => false)
  if (cursor) return true
  return await tool(driver, 'get_desktop_state', {}).then(() => true).catch(() => false)
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

/** A window named the way a refusal should name it. */
function describeWindow(window: RawWindow): string {
  const app = window.appName || 'This window'
  const title = window.title ? ` — "${clip(window.title)}"` : ''
  return `${app} (w${window.windowId})${title}`
}

/**
 * The refusal while a UAC prompt or lock screen is in front.
 *
 * Both run on a desktop other than `Default`; a user-session process can neither read nor inject
 * into it, and the driver has no primitive that crosses. Naming the state is the only useful answer:
 * the person at the machine is the one who can dismiss it.
 */
function secureDesktopRefusal(desktop: InputDesktopState): Error {
  const detail = desktop.name
    ? `Windows is showing a secure desktop (input desktop "${desktop.name}"): a UAC prompt or ` +
      'the lock screen is in front.'
    : 'Windows is not exposing an interactive desktop: a UAC prompt or the lock screen may be in ' +
      'front, or this session has no input desktop.'
  return new Error(
    `${detail} Nothing on this desktop can be read or driven until the person answers it. Ask ` +
    'them to respond, then retry.',
  )
}

/** A launch that is waiting on the UAC consent dialog. */
function uacWaitRefusal(name: string, desktop: InputDesktopState): Error {
  const where = desktop.name ? ` (input desktop "${desktop.name}")` : ''
  return new Error(
    `Windows is waiting for administrator approval to launch "${name}"${where}. This app cannot ` +
    'answer the UAC dialog or drive the elevated window. Ask the person to approve or cancel it, ' +
    'then retry.',
  )
}

/** A launched app that came up above this process's integrity. */
function elevatedLaunchRefusal(name: string, target: ProcessIntegrity): Error {
  const level = target.kind === 'denied'
    ? 'an integrity level Windows would not disclose'
    : describeProcessIntegrity(target)
  return new Error(
    `"${name}" launched at ${level}, above this app's own integrity. Windows blocks ` +
    'accessibility and input across that boundary. Restart this app as administrator to drive it, ' +
    'or use a non-elevated copy.',
  )
}

/** `ctrl+shift+s` -> `{ key: 's', modifiers: ['ctrl','shift'] }`. */
export function parseKeyCombo(combo: string): { key: string; modifiers: string[] } {
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('Empty key combination.')
  return { key: parts[parts.length - 1]!, modifiers: parts.slice(0, -1) }
}

/** How an action landed, as the driver states it. */
export interface ActionReport {
  /** `confirmed` … `suspected_noop` / `refused`: whether the driver believes anything happened. */
  effect?: ComputerActionOutcome['effect']
  /** `accessibility`, `synthetic_events`, `global_input`, …: what channel carried it. */
  route?: string
  /** Where it landed as far as the platform is concerned. */
  mode?: 'background' | 'foreground' | 'not_applicable' | 'unknown'
  /** Why the driver escalated or gave up, when it did. */
  reason?: string
  /**
   * Why the driver declined, when it did.
   *
   * `background_uipi_blocked`, `window_minimized`, `stale_element_token` … carry the sentence a
   * model needs to change course; dropping it leaves only "Refused by the driver".
   */
  refusal?: Refusal
}

/** The driver's machine-readable refusal: a stable code plus its own explanation. */
export interface Refusal {
  code?: string
  detail?: string
}

/**
 * The driver spells its enums two ways: `structuredJson` carries names, the typed `action` record
 * carries ordinals (`{ effect: 2 }` is `unverifiable`, `{ delivery: { mode: 0 } }` is `background`).
 * These are the FFI's own orders — see `ActionEffect` / `ActionRoute` / `ActionDeliveryMode` in
 * `@trycua/cua-driver/dist/native/cua_driver_contract.js`.
 */
const EFFECT_ORDINALS = ['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused']
const ROUTE_ORDINALS = ['accessibility', 'synthetic_events', 'global_input', 'system_api', 'dom', 'trusted_input']
const DELIVERY_ORDINALS = ['background', 'foreground', 'not_applicable', 'unknown']

function ordinalName(names: readonly string[], value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value.toLowerCase()
  if (typeof value === 'number') return names[value]
  return undefined
}

/**
 * The driver's verdict on an action, read from whichever half of the reply carries it.
 *
 * The structured half is snake_case names (`{"effect":"unverifiable","route":"synthetic_events",
 * "delivery":{"mode":"background"}}`); the typed `action` record on the envelope is the same
 * object with ordinals. Preferring the JSON half keeps one vocabulary, and the ordinal map covers a
 * build that fills only the typed field.
 */
function actionReport(data: any, typed: any): ActionReport {
  const source = data && typeof data === 'object' && ('effect' in data || 'delivery' in data) ? data : {}
  const effect = ordinalName(EFFECT_ORDINALS, source.effect ?? typed?.effect)
  const route = ordinalName(ROUTE_ORDINALS, source.route ?? typed?.route)
  const mode = ordinalName(DELIVERY_ORDINALS, source.delivery?.mode ?? typed?.delivery?.mode)
  const reason = String(source.escalation?.reason ?? typed?.escalation?.reason ?? '')
  const refusal = refusalOf(data, typed)
  return {
    ...(effect ? { effect: effect as ComputerActionOutcome['effect'] } : {}),
    ...(route ? { route } : {}),
    ...(mode ? { mode: mode as ActionReport['mode'] } : {}),
    ...(reason ? { reason } : {}),
    ...(refusal ? { refusal } : {}),
  }
}

/**
 * The refusal, read from either shape the driver has used.
 *
 * Some replies put it on one field (`{"refusal":"background_uipi_blocked","detail":"UIPI: …"}`),
 * others nest it (`{"refusal":{"code":"…","detail":"…"}}`); a build that only carries codes still
 * gets its code through. The detail is the half a model can act on, so it wins over the code.
 */
function refusalOf(data: any, typed: any): Refusal | null {
  const source = data && typeof data === 'object' ? data : {}
  const raw = source.refusal ?? typed?.refusal
  const nested = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const code = firstString(
    typeof raw === 'string' ? raw : undefined,
    nested.code,
    source.refusal_code,
  )
  const detail = firstString(
    nested.detail,
    nested.message,
    source.refusal_detail,
    // A bare `detail` belongs to the refusal only when a refusal is present; otherwise it is some
    // other action detail and must not be reported as why the driver declined.
    source.refusal || source.refusal_code ? source.detail : undefined,
    typed?.refusal_detail,
  )
  return code || detail ? { ...(code ? { code } : {}), ...(detail ? { detail } : {}) } : null
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
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
