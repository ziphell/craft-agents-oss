/**
 * Browser Pane Atoms
 *
 * Jotai atoms for browser instance state in the renderer.
 * Synced from the main process via BROWSER_PANE_STATE_CHANGED IPC events.
 */

import { atom } from 'jotai'
import { browserWorkspaceKey } from '@craft-agent/shared/config/client-config'
import type { BrowserInstanceInfo } from '../../shared/types'

/** Map of all browser instances by ID */
export const browserInstancesMapAtom = atom<Map<string, BrowserInstanceInfo>>(new Map())

/** Derived: array of all browser instances (for iteration) */
export const browserInstancesAtom = atom<BrowserInstanceInfo[]>(
  (get) => Array.from(get(browserInstancesMapAtom).values())
)

/** Derived: count of active browser instances */
export const browserInstanceCountAtom = atom<number>(
  (get) => get(browserInstancesMapAtom).size
)

/**
 * Filter browser instances to those visible in the given workspace.
 *
 * An instance is visible when its `workspaceId` is null/undefined (truly unbound, visible
 * everywhere) or matches the workspace this window shows. Two spellings are accepted: the raw
 * workspace id — what a server returns now that panes belong to the workspace's own server — and
 * the server-suffixed key (`browserWorkspaceKey`), which is how a pane driven through the device
 * capability on this machine is filed. The suffix only differs from the raw id when this window
 * is remote, so a local window behaves exactly as before.
 *
 * When neither a workspace nor a server is known (nothing resolved yet), returns the unfiltered
 * list — the same safe default as before.
 */
export function filterInstancesForWorkspace(
  all: BrowserInstanceInfo[],
  activeWorkspaceId: string | null,
  serverScope: string | null = null,
): BrowserInstanceInfo[] {
  if (!activeWorkspaceId && !serverScope) return all
  const scoped = browserWorkspaceKey(serverScope, activeWorkspaceId)
  return all.filter((i) =>
    !i.workspaceId || i.workspaceId === activeWorkspaceId || i.workspaceId === scoped)
}

/** Currently active browser instance ID (selected/focused by user interactions) */
export const activeBrowserInstanceIdAtom = atom<string | null>(null)

/** The tab a viewer should show when it opens. */
export interface BrowserViewTarget {
  instanceId: string
  tabId: string
}

/**
 * What the browser viewer should do — open, and which tab.
 *
 * One atom for both viewers (the Electron remote window's panel and the webui's), because the
 * thing that asks for it is neither of them: a link the person clicked, or an HTML preview's
 * "open in browser", was opened on the workspace's server and has to be *shown*. `nonce` makes
 * the same tab requestable twice.
 */
export interface BrowserViewRequest {
  open: boolean
  target: BrowserViewTarget | null
  nonce: number
}

export const browserViewRequestAtom = atom<BrowserViewRequest>({
  open: false,
  target: null,
  nonce: 0,
})

/**
 * Open the viewer, optionally at a tab that was just opened.
 *
 * No target — the top bar's globe — means "the workspace's browser", and the viewer picks the
 * first tab it finds.
 */
export const openBrowserViewAtom = atom(null, (_get, set, target?: BrowserViewTarget) => {
  set(browserViewRequestAtom, (prev) => ({ open: true, target: target ?? null, nonce: prev.nonce + 1 }))
})

export const closeBrowserViewAtom = atom(null, (_get, set) => {
  set(browserViewRequestAtom, (prev) => ({ open: false, target: null, nonce: prev.nonce + 1 }))
})

/** Tombstones for instances removed from renderer state (guards against late out-of-order updates) */
export const removedBrowserInstanceIdsAtom = atom<Set<string>>(new Set<string>())

/** Derived: currently active browser instance info */
export const activeBrowserInstanceAtom = atom<BrowserInstanceInfo | null>((get) => {
  const activeId = get(activeBrowserInstanceIdAtom)
  if (!activeId) return null
  return get(browserInstancesMapAtom).get(activeId) ?? null
})

/** Update a single browser instance (from IPC state change event) */
export const updateBrowserInstanceAtom = atom(
  null,
  (get, set, info: BrowserInstanceInfo) => {
    const removedIds = get(removedBrowserInstanceIdsAtom)
    if (removedIds.has(info.id)) {
      return
    }

    const map = new Map(get(browserInstancesMapAtom))
    map.set(info.id, info)
    set(browserInstancesMapAtom, map)
  }
)

/** Remove a browser instance (when destroyed) */
export const removeBrowserInstanceAtom = atom(
  null,
  (get, set, id: string) => {
    const map = new Map(get(browserInstancesMapAtom))
    map.delete(id)
    set(browserInstancesMapAtom, map)

    const removedIds = new Set(get(removedBrowserInstanceIdsAtom))
    removedIds.add(id)
    set(removedBrowserInstanceIdsAtom, removedIds)
  }
)

/** Set all browser instances at once (from list query) */
export const setBrowserInstancesAtom = atom(
  null,
  (get, set, instances: BrowserInstanceInfo[]) => {
    const map = new Map<string, BrowserInstanceInfo>()
    for (const info of instances) {
      map.set(info.id, info)
    }
    set(browserInstancesMapAtom, map)

    const removedIds = new Set(get(removedBrowserInstanceIdsAtom))
    for (const info of instances) {
      removedIds.delete(info.id)
    }
    set(removedBrowserInstanceIdsAtom, removedIds)
  }
)
