/**
 * The two macOS TCC grants a desktop driver needs, and the one place that asks for them.
 *
 * The driver runs **inside this process**, so the grants belong to this application: Accessibility
 * for the AX tree and element actions, Screen Recording for window screenshots. In embedded mode
 * the driver deliberately does not prompt — "status reflects the HOST app's TCC grant" — which
 * means a host that never asks leaves the capability half-dead: elements work, screenshots fail
 * with `No content produced`.
 *
 * The order matters and is the one a person can complete:
 *
 * 1. **Accessibility** is requested with `systemPreferences.isTrustedAccessibilityClient(true)`,
 *    which opens the pane and adds the app to the list. There is no completion callback, so this
 *    polls (bounded) instead of guessing.
 * 2. **Screen Recording** is requested only after Accessibility is settled — the SDK's combined
 *    request would raise both prompts at once, and the person can only act on one.
 *
 * Everything here is lazy and best-effort: no Electron, no SDK, or a user who declines all leave
 * the manager running with `status` reporting what is missing.
 */

export interface MacComputerPermissions {
  accessibility: boolean
  screenRecording: boolean
}

type Log = (message: string, details?: Record<string, unknown>) => void

/** How long the Accessibility prompt may stay open before we stop watching. */
const ACCESSIBILITY_WAIT_MS = 120_000
/** Let the person finish in System Settings before the next native prompt appears. */
const BETWEEN_PROMPTS_MS = 1_500

let sdkPromise: Promise<any | null> | null = null
let requestInFlight: Promise<void> | null = null
/** One automatic prompt per process: a person who dismissed it should not meet it every session. */
let requestAttempted = false

/** The SDK's permission probes run in this process, so TCC attributes them to this app. */
function permissionSdk(): Promise<any | null> {
  if (!sdkPromise) {
    sdkPromise = import('@trycua/cua-driver')
      .then((sdk: any) =>
        typeof sdk?.currentMacOsPermissionStatus === 'function' ? sdk : null)
      .catch(() => null)
  }
  return sdkPromise
}

/** What this application currently holds. `null` off macOS or without the driver package. */
export async function readMacComputerPermissions(): Promise<MacComputerPermissions | null> {
  if (process.platform !== 'darwin') return null
  const sdk = await permissionSdk()
  try {
    const status = sdk?.currentMacOsPermissionStatus?.()
    if (!status) return null
    return {
      accessibility: Boolean(status.accessibility),
      screenRecording: Boolean(status.screenRecording),
    }
  } catch {
    return null
  }
}

export function hasMacComputerPermissions(status: MacComputerPermissions | null): boolean {
  return Boolean(status?.accessibility && status?.screenRecording)
}

/** One action line a person (or the model relaying to them) can follow. */
export function macPermissionGuidance(status: MacComputerPermissions): string[] {
  const lines: string[] = []
  if (!status.accessibility) {
    lines.push(
      'macOS: grant Accessibility (System Settings › Privacy & Security › Accessibility) ' +
      'so element actions can reach other apps.',
    )
  }
  if (!status.screenRecording) {
    lines.push(
      'macOS: grant Screen Recording (System Settings › Privacy & Security › Screen Recording) ' +
      'to capture windows. Element actions work without it.',
    )
  }
  return lines
}

/**
 * Ask for whatever is missing, at most once at a time.
 *
 * Called when a session first takes the desktop, not at app launch: a person who never uses
 * desktop control should never see a permission dialog for it.
 */
export function requestMacComputerPermissions(log: Log = () => {}): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve()
  if (requestAttempted) return Promise.resolve()
  requestAttempted = true
  if (!requestInFlight) {
    requestInFlight = runRequest(log).finally(() => { requestInFlight = null })
  }
  return requestInFlight
}

async function runRequest(log: Log): Promise<void> {
  const sdk = await permissionSdk()
  if (!sdk) return
  const before = await readMacComputerPermissions()
  if (!before) return
  if (hasMacComputerPermissions(before)) return
  const electron = loadElectron()
  if (!electron?.systemPreferences) {
    // Probes and headless runs have no AppKit host to attribute a prompt to.
    log('computer-use: macOS permissions missing; grant them from the app', { ...before })
    return
  }
  const { app, systemPreferences } = electron
  log('computer-use: macOS permissions requested', { ...before })

  if (!before.accessibility) {
    try {
      systemPreferences.isTrustedAccessibilityClient(true)
    } catch (error) {
      log('computer-use: accessibility prompt failed', { error: String(error) })
      return
    }
    const granted = await waitFor(
      () => safe(() => systemPreferences.isTrustedAccessibilityClient(false)),
      ACCESSIBILITY_WAIT_MS,
      app,
    )
    log('computer-use: accessibility prompt closed', { granted })
    if (!granted) return
    await delay(BETWEEN_PROMPTS_MS, app)
  }

  const current = await readMacComputerPermissions()
  if (current && !current.screenRecording) {
    try {
      // Only the SDK knows how to raise the Screen Recording prompt for this host identity.
      sdk.requestMacOsPermissions()
    } catch (error) {
      log('computer-use: screen recording prompt failed', { error: String(error) })
    }
  }
  log('computer-use: macOS permission result', { ...(await readMacComputerPermissions()) })
}

/** The bundled main process is CJS, so `require('electron')` is the reliable loader here. */
function loadElectron(): any | null {
  try {
    const req = typeof require === 'function' ? require : null
    return req ? req('electron') : null
  } catch {
    return null
  }
}

function safe<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

/** Poll a boolean that has no callback, stopping at the deadline or when the app quits. */
function waitFor(
  read: () => boolean | null,
  timeoutMs: number,
  app: { once?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void } | undefined,
): Promise<boolean> {
  if (read() === true) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearInterval(poll)
      clearTimeout(deadline)
      app?.removeListener?.('before-quit', onQuit)
      resolve(value)
    }
    const onQuit = () => finish(false)
    const poll = setInterval(() => {
      if (read() === true) finish(true)
    }, 500)
    const deadline = setTimeout(() => finish(false), timeoutMs)
    poll.unref?.()
    deadline.unref?.()
    app?.once?.('before-quit', onQuit)
  })
}

function delay(ms: number, app: { once?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void } | undefined): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      app?.removeListener?.('before-quit', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    app?.once?.('before-quit', finish)
  })
}
