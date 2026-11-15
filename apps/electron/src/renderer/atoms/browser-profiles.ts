/**
 * Browser profiles — the named Chromium sessions a browser window can be signed into.
 *
 * One list, loaded once per renderer and refreshed after a change, so the composer's picker and the
 * settings page cannot disagree about what exists.
 */

import { atom } from 'jotai'
// Subpath, not the config barrel: the barrel reaches server-only modules (the Claude SDK among
// them) and this file is part of the renderer bundle.
import { DEFAULT_BROWSER_PROFILE_ID, type BrowserProfile } from '@config/browser-profiles'

export { DEFAULT_BROWSER_PROFILE_ID }

/** Every profile this app has — the built-in `default` always first. */
export const browserProfilesAtom = atom<BrowserProfile[]>([])

/** Re-read the registry from the app's config. */
export const refreshBrowserProfilesAtom = atom(null, async (_get, set) => {
  const profiles = await window.electronAPI.browserProfiles.list()
  set(browserProfilesAtom, profiles)
})

/**
 * The profile the composer just picked, before the host's resolution agrees.
 *
 * A switch is persisted (and the session event round-trips) before `browserProfiles.resolve`
 * reports the new profile, so the top bar used to lag one beat behind the composer. The picker
 * writes the effective id here on the click; the top bar reads it ahead of its own resolution and
 * drops the entry once that resolution reports the same profile.
 */
export const optimisticSessionProfileAtom = atom<Record<string, { profileId: string; at: number }>>({})
