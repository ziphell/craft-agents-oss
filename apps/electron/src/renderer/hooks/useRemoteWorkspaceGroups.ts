/**
 * The other places a window can go, for the workspace dropdown's remote level.
 *
 * This app reaches a server through a window, but the dropdown lists servers that have no window
 * open yet — so the workspaces come from each server's own app-level link, never from this
 * window's transport. The window's own server is left out: in a remote window its workspaces are
 * already the list the remote section sits under.
 *
 * This machine gets one group (`connection: null`) whenever the window is on a hub — including a
 * hub that is this machine itself (LAN address, tunnel). It is the only way back to the local
 * window, so it stays even when its workspaces happen to look like the list above.
 */

import { useCallback, useEffect, useState } from 'react'
import type { RemoteConnection } from '@craft-agent/shared/config/client-config'
import type { WorkspaceInfo } from '../../shared/types'

export interface RemoteWorkspaceGroup {
  /** `null` means this machine. */
  connection: RemoteConnection | null
  workspaces: WorkspaceInfo[]
  /** The server could not be asked (offline, or its link is not up yet). */
  unavailable: boolean
}

export interface RemoteWorkspaceGroups {
  groups: RemoteWorkspaceGroup[]
  loading: boolean
  reload: () => Promise<void>
}

/** Reads the groups when `active` turns true — the dropdown opening is the trigger. */
export function useRemoteWorkspaceGroups(active: boolean): RemoteWorkspaceGroups {
  const [groups, setGroups] = useState<RemoteWorkspaceGroup[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!window.electronAPI?.getClientMode) {
      setGroups([])
      return
    }
    setLoading(true)
    try {
      const mode = await window.electronAPI.getClientMode()
      const connections = mode.connections.filter(
        connection => connection.id !== mode.running?.connectionId,
      )
      // A window on a hub always keeps the way back: this machine, listed like any other server.
      const localGroup: RemoteWorkspaceGroup[] = mode.running
        ? [{
            connection: null,
            workspaces: await window.electronAPI.getLocalWorkspaces().catch(() => [] as WorkspaceInfo[]),
            unavailable: false,
          }]
        : []
      const loaded = await Promise.all(connections.map(async (connection): Promise<RemoteWorkspaceGroup> => {
        try {
          return { connection, workspaces: await window.electronAPI.listRemoteWorkspaces(connection.id), unavailable: false }
        } catch {
          // One unreachable server must not hide the others.
          return { connection, workspaces: [], unavailable: true }
        }
      }))
      setGroups([...localGroup, ...loaded])
    } catch {
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) void reload()
  }, [active, reload])

  return { groups, loading, reload }
}
