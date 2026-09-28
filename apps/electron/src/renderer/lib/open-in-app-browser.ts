/**
 * Which browser: the app's own window, or the system's.
 *
 * One answer for both places the question comes up — a link a person clicks, and the "open in
 * browser" button in the window that draws an HTML file — because it is one question a person
 * asks once ("which browser is mine here?"), and the reason for the default is the same in both
 * cases: the app's browser window is the surface the agent can keep working on afterwards.
 *
 * The answer lives in the user's preferences file (`openInAppBrowser`), and the rule about
 * what its absence means lives here, once — the clicks that need it and the switch that sets
 * it must not each decide it separately.
 *
 * Read at the moment of the click, not cached: a click is not a hot path, and the setting is
 * the person's to change while the app is running.
 */

import type { UserPreferences } from '@craft-agent/shared/config'
import { isBrowserUrl } from '@craft-agent/shared/utils/url-safety'

/** Whether a link goes to the app's own browser window — a browser address, and asked for. */
export async function shouldOpenLinkInAppBrowser(url: string): Promise<boolean> {
  return isBrowserUrl(url) && await appBrowserWanted()
}

/**
 * Whether the HTML a preview window is showing opens in that browser window, from the "open in
 * browser" button in its header, instead of in the person's own browser.
 *
 * The kind is already known by the time this is asked — the caller is the button belonging to a
 * window that only ever draws HTML — so only the setting is left.
 */
export async function shouldOpenFileInAppBrowser(): Promise<boolean> {
  return await appBrowserWanted()
}

/**
 * Whether the app's browser window is where these go here at all: there is one to open (a browser
 * client has none — a tab there would be the person's own browser, which is what the shell route
 * already gives them), and the person wants it (their setting; on unless they turned it off).
 */
async function appBrowserWanted(): Promise<boolean> {
  if (window.electronAPI.getRuntimeEnvironment() !== 'electron') return false
  return await readOpenInAppBrowser()
}

/** True unless the person turned it off — see the reader below for why that is the default. */
export async function readOpenInAppBrowser(): Promise<boolean> {
  try {
    const { content } = await window.electronAPI.readPreferences()
    return readOpenInAppBrowserFrom(content)
  } catch {
    // An unreadable preferences file is not a reason to keep the person from their pages.
    return true
  }
}

/** The same rule, for a preferences file already in hand (the settings page reads one). */
export function readOpenInAppBrowserFrom(content: string): boolean {
  try {
    const prefs = JSON.parse(content) as UserPreferences
    return prefs.openInAppBrowser !== false
  } catch {
    return true
  }
}

/**
 * Write it back, keeping whatever else the file holds: preferences are one file with one
 * writer per field, and nothing here may drop a field it did not come for.
 */
export async function writeOpenInAppBrowser(enabled: boolean): Promise<void> {
  const { content } = await window.electronAPI.readPreferences()

  let prefs: UserPreferences
  try {
    prefs = JSON.parse(content) as UserPreferences
  } catch {
    prefs = {}
  }

  const result = await window.electronAPI.writePreferences(
    JSON.stringify({ ...prefs, openInAppBrowser: enabled, updatedAt: Date.now() }, null, 2),
  )
  if (!result.success) {
    throw new Error(result.error ?? 'Could not write preferences')
  }
}
