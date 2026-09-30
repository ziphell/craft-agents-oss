/**
 * useArtifacts
 *
 * Loads workspace-scoped artifacts into `artifactsAtom` and keeps them in sync via the
 * `artifacts:changed` broadcast. The config watcher is its one sender: a `.drawio` written
 * by the agent's tools, or edited by hand, is seen for itself — the library is a view of the
 * disk, so the push carries a fresh scan rather than a delta to apply.
 *
 * Like the other atoms, the atom is the ONLY state: consumers read `artifactsAtom` and there
 * is no duplicate local list to drift.
 */

import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { artifactsAtom } from '@/atoms/artifacts'
import type { ArtifactEntry } from '@craft-agent/shared/artifacts'

export interface UseArtifactsResult {
  artifacts: ArtifactEntry[]
  refresh: () => Promise<void>
}

export function useArtifacts(activeWorkspaceId: string | null | undefined): UseArtifactsResult {
  const artifacts = useAtomValue(artifactsAtom)
  const setArtifacts = useSetAtom(artifactsAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setArtifacts([])
      return
    }
    try {
      const result = await window.electronAPI.getArtifacts(activeWorkspaceId)
      setArtifacts(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('[useArtifacts] Failed to load artifacts:', err)
      setArtifacts([])
    }
  }, [activeWorkspaceId, setArtifacts])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onArtifactsChanged((wsId, list) => {
      // Watcher-driven pushes carry the CONFIG workspace id, but the WebUI identifies its
      // workspace by slug — those pushes still target this client (routing is handshake-based),
      // so on an id-form mismatch we re-read instead of dropping.
      if (wsId === activeWorkspaceId) {
        setArtifacts(Array.isArray(list) ? list : [])
      } else {
        void refresh()
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setArtifacts, refresh])

  return { artifacts, refresh }
}
