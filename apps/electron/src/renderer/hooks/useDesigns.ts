/**
 * useDesigns
 *
 * Loads workspace-scoped designs into `designsAtom` and keeps them in sync via the
 * `designs:changed` broadcast (pushed whenever any design.json changes — create,
 * update, delete, content save, or a refresh-script run completing).
 *
 * Unlike `useProjects`, the atom is the ONLY state: consumers read
 * `designsAtom` (or this hook's passthrough) and there is no duplicate local
 * list to drift.
 */

import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { designsAtom } from '@/atoms/designs'
import type { LoadedDesign } from '@craft-agent/shared/designs/types'

export interface UseDesignsResult {
  designs: LoadedDesign[]
  refresh: () => Promise<void>
}

export function useDesigns(activeWorkspaceId: string | null | undefined): UseDesignsResult {
  const designs = useAtomValue(designsAtom)
  const setDesigns = useSetAtom(designsAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setDesigns([])
      return
    }
    try {
      const result = await window.electronAPI.getDesigns(activeWorkspaceId)
      setDesigns(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('[useDesigns] Failed to load designs:', err)
      setDesigns([])
    }
  }, [activeWorkspaceId, setDesigns])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onDesignsChanged((wsId, list) => {
      // Watcher-driven pushes carry the CONFIG workspace id, but the WebUI
      // identifies its workspace by slug — those pushes still target this
      // client (routing is handshake-based), so on an id-form mismatch we
      // re-read instead of dropping (mirrors useAutomations' refetch shape).
      if (wsId === activeWorkspaceId) {
        setDesigns(Array.isArray(list) ? list : [])
      } else {
        void refresh()
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setDesigns, refresh])

  return { designs, refresh }
}
