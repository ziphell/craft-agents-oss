/**
 * The persisted "replay prototype edits automatically" preference (plan §21.4).
 *
 * It lives in `~/.craft-agent/preferences.json` rather than in the renderer's own
 * storage, like every other setting in this app: it is a choice the user made
 * about the app, and it should survive a cleared web storage and travel with the
 * config directory the rest of their settings live in.
 *
 * Read and written as part of the whole preferences document — the API takes and
 * returns the file's JSON — so a save re-reads first and merges. Writing only our
 * key would drop everything else in there.
 *
 * Absence means **on**: the behaviour is the fix for "I saved the patch and
 * nothing happened", so the default is what the feature is for. Only an explicit
 * `false` turns it off.
 */

import type { UserPreferences } from '@craft-agent/shared/config'

/** The field name, so the read and the write cannot drift apart. */
const KEY = 'prototypeAutoReplay' as const

function parsePreferences(json: string): UserPreferences {
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null ? (parsed as UserPreferences) : {}
  } catch {
    // An unreadable document is treated as "nothing set", the same way the main
    // process reads it (`loadPreferences` returns `{}` on a bad file).
    return {}
  }
}

/** The stored value, or null when the user has never touched the switch. */
export async function loadPrototypeAutoReplayPreference(): Promise<boolean | null> {
  try {
    const { content } = await window.electronAPI.readPreferences()
    const stored = parsePreferences(content)[KEY]
    return typeof stored === 'boolean' ? stored : null
  } catch (err) {
    console.error('[prototypeAutoReplay] Failed to read the preference:', err)
    return null
  }
}

/** Persist the switch, keeping every other preference in the file intact. */
export async function savePrototypeAutoReplayPreference(enabled: boolean): Promise<void> {
  try {
    const { content } = await window.electronAPI.readPreferences()
    const prefs = parsePreferences(content)
    await window.electronAPI.writePreferences(JSON.stringify({ ...prefs, [KEY]: enabled }, null, 2))
  } catch (err) {
    // A preference that cannot be remembered still applies to this session.
    console.error('[prototypeAutoReplay] Failed to write the preference:', err)
  }
}
