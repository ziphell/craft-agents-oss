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

/** How long a session may go without touching the desktop before it loses it. */
const LEASE_MS = 90_000
/** Beyond this the tree answer is a wall of text a model cannot use well. */
const MAX_ELEMENTS = 400

/**
 * Whether this process has a desktop to offer, as the device link should announce it.
 *
 * Fail-closed: false until the driver has actually resolved, because announcing `computer` without
 * a driver hands out a door whose every command fails. A link that reconnects after the probe picks
 * it up.
 */
let computerUseAdvertised = false

export function isComputerUseAdvertised(): boolean {
  return computerUseAdvertised
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
  zIndex?: string
}

interface RawWindowState {
  snapshotId?: string
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
  /** Whether the driver's own agent cursor is on screen right now. */
  private cursorVisible = false
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
    const driver = await this.ensureDriver()
    if (!driver) throw new Error('This build has no desktop driver, so `computer` is unavailable.')
    this.takeLease(sessionId)
    // One probe per session: whether this desktop accepts injected input at all. A locked or remote
    // desktop refuses plain capture, and (measured on Windows) injected keys then report success
    // while doing nothing. Gate the injected verbs on the probe rather than on a false "ok".
    const injected = await probeInjectedInput(driver)
    return this.buildFns(driver, sessionId, injected)
  }

  /** Give the desktop back early. Safe to call when nothing is held. */
  async release(sessionId?: string): Promise<void> {
    if (sessionId && this.leaseSession && sessionId !== this.leaseSession) return
    const session = this.leaseSession
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

  private takeLease(sessionId: string): void {
    if (this.leaseSession && this.leaseSession !== sessionId) throw new ComputerDesktopBusyError()
    const changed = this.leaseSession !== sessionId
    this.leaseSession = sessionId
    this.renewLease()
    if (changed) this.onLeaseChange(sessionId)
    void this.showAgentCursor(true)
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
    void this.showAgentCursor(false)
  }

  /**
   * The visible half of the lease: the driver draws its own cursor on screen while a session holds
   * the desktop, so a person can see that something is driving their machine.
   *
   * Best effort by design — a session without a real desktop (locked, RDP) simply draws nothing, and
   * that must never fail the lease itself. The app-level indicator (tray/menu bar) is a separate
   * piece and is not built yet.
   */
  private async showAgentCursor(enabled: boolean): Promise<void> {
    const driver = this.driver
    if (!driver) return
    if (this.cursorVisible === enabled) return
    try {
      // Set before the call: `status` must never report "off" while the cursor is already showing.
      this.cursorVisible = enabled
      await tool(driver, 'set_agent_cursor_enabled', { enabled })
      this.log('computer-use: agent cursor', { visible: enabled })
    } catch (error) {
      this.log('computer-use: agent cursor unavailable', { error: String(error), enabled })
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

    const listWindows = async (): Promise<RawWindow[]> => {
      const answer = await driver.listWindows({})
      const windows: RawWindow[] = Array.isArray(answer?.windows) ? answer.windows : []
      this.windowIndex.clear()
      for (const window of windows) this.windowIndex.set(String(window.windowId), window)
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
          actions: Array.isArray(raw.actions) ? raw.actions.map(String) : [],
          ...(raw.frame ? { frame: normalizeFrame(raw.frame) } : {}),
          ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
        }
      })
      const notes = [state.degradedReason, state.truncationReason].filter(Boolean)
      return {
        snapshotId: String(state.snapshotId ?? ''),
        window: toWindowInfo(window, false),
        source: state.degraded ? 'none' : elements.length > 0 ? 'accessibility' : 'none',
        ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
        elements,
      }
    }

    return {
      windows: async () => {
        guard()
        const windows = await listWindows()
        const visible = windows.filter((w) => w.isOnScreen && !w.minimized)
        const top = visible.reduce<RawWindow | null>(
          (best, w) => (best == null || Number(w.zIndex ?? 0) > Number(best.zIndex ?? 0) ? w : best),
          null,
        )
        return windows.map((w) => toWindowInfo(w, w === top))
      },

      snapshot: async (args) => {
        guard()
        if (this.windowIndex.size === 0) await listWindows()
        const window = args?.windowId ? this.windowIndex.get(String(args.windowId)) : activeWindow(this.windowIndex)
        if (!window) {
          throw new Error(args?.windowId
            ? `No window "${args.windowId}". Run \`windows\` first.`
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
        // The driver's element vocabulary (`invoke`, `set_value`, `select`, …) is spent through
        // `click`'s `action` argument — there is no separate `invoke` tool.
        const result = await tool(driver, 'click', {
          ...scopeOf(owner),
          element_token: target.token,
          action: action ?? 'invoke',
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
        const owner = point.windowId ? this.windowIndex.get(String(point.windowId)) : activeWindow(this.windowIndex)
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
        const { key, modifiers } = parseKeyCombo(keys)
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
        if (this.windowIndex.size === 0) await listWindows()
        const window = args?.windowId ? this.windowIndex.get(String(args.windowId)) : activeWindow(this.windowIndex)
        if (!window) throw new Error('No window is on screen to capture.')
        const state = await driver.getWindowState({
          pid: window.pid,
          windowId: toWindowId(window.windowId),
          includeAccessibilityTree: false,
          includeScreenshot: true,
          maxDimension: 1600,
        }) as RawWindowState
        const image = state.images?.[0]
        // `dataBase64` is the field the driver fills; `data` is accepted too so a minor version
        // rename does not silently produce an empty image.
        const data = image?.dataBase64 ?? image?.data
        if (!data) throw new Error('The driver returned no screenshot data.')
        const mimeType = (image?.mimeType ?? state.screenshotMimeType) === 'image/jpeg'
          ? 'image/jpeg' : 'image/png'
        return {
          data,
          mimeType,
          width: Number(state.screenshotWidth ?? 0),
          height: Number(state.screenshotHeight ?? 0),
          windowId: window.windowId,
        } satisfies ComputerScreenshotResult
      },

      status: async () => {
        guard()
        const meta = (await Promise.resolve(driver.metadata?.())) ?? {}
        const permissions = await tool(driver, 'check_permissions', {})
          .then((answer) => String((answer as { text?: string })?.text ?? '').split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean))
          .catch(() => [] as string[])
        const capture = await tool(driver, 'get_desktop_state', {})
          .then(() => 'available')
          .catch((error: unknown) => `unavailable: ${String((error as Error).message ?? error).slice(0, 160)}`)
        const injected = capture === 'available' ? 'available' : 'unavailable (use element actions)'
        if (this.windowIndex.size === 0) await listWindows()
        return {
          driver: {
            version: String(meta.driverVersion ?? 'unknown'),
            contractVersion: String(meta.contractVersion ?? 'unknown'),
          },
          permissions,
          desktopCapture: capture,
          injectedInput: injected,
          agentCursor: this.cursorVisible ? 'on' : 'off',
          windows: this.windowIndex.size,
        }
      },

      launchApp: async (name) => {
        guard()
        const result = await tool(driver, 'launch_app', { name })
        const answer = result as Record<string, unknown> | null
        return {
          pid: typeof answer?.pid === 'number' ? answer.pid : null,
          ...(answer?.window_id ? { windowId: String(answer.window_id) } : {}),
        }
      },

      stop: async () => {
        this.dropLease()
        try {
          await driver.endSession({ session: sessionId })
        } catch { /* already gone */ }
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

/** The window a call acts on when none was named: on-screen, not minimized, frontmost. */
function activeWindow(index: Map<string, RawWindow>): RawWindow | null {
  let best: RawWindow | null = null
  for (const window of index.values()) {
    if (!window.isOnScreen || window.minimized) continue
    if (best == null || Number(window.zIndex ?? 0) > Number(best.zIndex ?? 0)) best = window
  }
  return best ?? index.values().next().value ?? null
}

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
