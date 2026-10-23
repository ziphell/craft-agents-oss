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
 * Browser windows belong to the workspace's own server now, so a remote window reads its hub's
 * windows directly. The scope is still needed for one case: a browser this machine hosts **for**
 * a hub through the device capability is filed under `hub:<connectionId>:<workspaceId>`, and a
 * tab strip must not confuse it with a local workspace of the same id.
 */
export const windowServerScopeAtom = atom<string | null>(null)
