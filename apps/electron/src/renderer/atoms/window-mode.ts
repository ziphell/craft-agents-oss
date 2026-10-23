import { atom } from 'jotai'
import type { RemoteWindowTarget } from '../../shared/types'

/**
 * Whether this window is connected to a hub rather than this machine's own server.
 *
 * Set once by `App` from `getClientMode().running`. It answers "where does this window's work
 * happen?" for UI that must not act on the local filesystem for a remote workspace — revealing a
 * skill in Finder, for instance.
 */
export const windowIsRemoteAtom = atom(false)

/**
 * The hub this window is on, or `null` for a local window.
 *
 * The workspace switcher and the title use it to say *which* server a window belongs to: with
 * several windows on screen, "the workspace" alone does not tell you whether you are looking at
 * this machine or at another one.
 */
export const windowRemoteTargetAtom = atom<RemoteWindowTarget | null>(null)

/**
 * The saved server this window is connected to, or `null` for a local window.
 *
 * Browser windows are filed per workspace, and two servers may both own a workspace with the same
 * id. This is the server half of the key the main process uses (`browserWorkspaceKey`), so a tab
 * strip shows only this window's server's browser windows — never another hub's.
 */
export const windowServerScopeAtom = atom<string | null>(null)
