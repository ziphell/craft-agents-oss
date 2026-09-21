/**
 * useWebsites
 *
 * Loads workspace-scoped websites into `websitesAtom` and keeps them in sync via the
 * `websites:changed` broadcast (pushed whenever any website.json changes — create,
 * update, delete, content save, or a refresh-script run completing).
 *
 * Unlike `useProjects`, the atom is the ONLY state: consumers read
 * `websitesAtom` (or this hook's passthrough) and there is no duplicate local
 * list to drift.
 */

import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { websitesAtom } from '@/atoms/websites'
import type { LoadedWebsite } from '@craft-agent/shared/websites/types'

export interface UseWebsitesResult {
  websites: LoadedWebsite[]
  refresh: () => Promise<void>
}

export function useWebsites(activeWorkspaceId: string | null | undefined): UseWebsitesResult {
  const websites = useAtomValue(websitesAtom)
  const setWebsites = useSetAtom(websitesAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setWebsites([])
      return
    }
    try {
      const result = await window.electronAPI.getWebsites(activeWorkspaceId)
      setWebsites(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('[useWebsites] Failed to load websites:', err)
      setWebsites([])
    }
  }, [activeWorkspaceId, setWebsites])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onWebsitesChanged((wsId, list) => {
      // Watcher-driven pushes carry the CONFIG workspace id, but the WebUI
      // identifies its workspace by slug — those pushes still target this
      // client (routing is handshake-based), so on an id-form mismatch we
      // re-read instead of dropping (mirrors useAutomations' refetch shape).
      if (wsId === activeWorkspaceId) {
        setWebsites(Array.isArray(list) ? list : [])
      } else {
        void refresh()
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setWebsites, refresh])

  return { websites, refresh }
}
