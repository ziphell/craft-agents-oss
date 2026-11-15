/**
 * useTweaks
 *
 * Loads workspace-scoped tweaks into `tweaksAtom` and keeps them in sync via the
 * `tweaks:changed` broadcast. The config watcher is its one sender: every mutation pokes it —
 * the switch, a delete, an agent's write — and an edit made outside the app it sees for
 * itself.
 *
 * Like the other atoms, the atom is the ONLY state: consumers read `tweaksAtom` and there
 * is no duplicate local list to drift.
 */

import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { tweaksAtom } from '@/atoms/tweaks'
import type { TweakSummary } from '@craft-agent/shared/tweaks'

export interface UseTweaksResult {
  tweaks: TweakSummary[]
  refresh: () => Promise<void>
}

export function useTweaks(activeWorkspaceId: string | null | undefined): UseTweaksResult {
  const tweaks = useAtomValue(tweaksAtom)
  const setTweaks = useSetAtom(tweaksAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setTweaks([])
      return
    }
    try {
      const result = await window.electronAPI.getTweaks(activeWorkspaceId)
      setTweaks(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('[useTweaks] Failed to load tweaks:', err)
      setTweaks([])
    }
  }, [activeWorkspaceId, setTweaks])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onTweaksChanged((wsId, list) => {
      // Watcher-driven pushes carry the CONFIG workspace id, but the WebUI
      // identifies its workspace by slug — those pushes still target this
      // client (routing is handshake-based), so on an id-form mismatch we
      // re-read instead of dropping.
      if (wsId === activeWorkspaceId) {
        setTweaks(Array.isArray(list) ? list : [])
      } else {
        void refresh()
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setTweaks, refresh])

  return { tweaks, refresh }
}
