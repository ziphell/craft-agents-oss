/**
 * usePrototypes
 *
 * Loads workspace-scoped prototype projects and keeps them in sync with the
 * `prototypes:changed` broadcast. Mirrors the lightweight half of `useProjects`,
 * plus the fs watcher lifecycle: the broadcast only carries the changed file
 * name, so every event triggers a full re-read of the status report.
 */

import { useState, useEffect, useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { prototypesAtom } from '@/atoms/prototypes'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

export interface UsePrototypesResult {
  prototypes: PrototypeStatus[]
  refresh: () => Promise<void>
}

export function usePrototypes(activeWorkspaceId: string | null | undefined): UsePrototypesResult {
  const [prototypes, setPrototypes] = useState<PrototypeStatus[]>([])
  const setPrototypesAtom = useSetAtom(prototypesAtom)

  const refresh = useCallback(async () => {
    if (!activeWorkspaceId) {
      setPrototypes([])
      setPrototypesAtom([])
      return
    }
    try {
      const result = await window.electronAPI.listPrototypes(activeWorkspaceId)
      const list = Array.isArray(result) ? (result as PrototypeStatus[]) : []
      setPrototypes(list)
      setPrototypesAtom(list)
    } catch (err) {
      console.error('[usePrototypes] Failed to load prototypes:', err)
      setPrototypes([])
      setPrototypesAtom([])
    }
  }, [activeWorkspaceId, setPrototypesAtom])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Watch the workspace prototypes folder while this hook is mounted. The
  // watcher is per-client, so exactly one component may own it — this hook.
  useEffect(() => {
    if (!activeWorkspaceId) return
    let cancelled = false

    window.electronAPI.watchPrototypes().catch((err: unknown) => {
      console.error('[usePrototypes] Failed to start prototypes watcher:', err)
    })

    const off = window.electronAPI.onPrototypesChanged((wsId: string) => {
      if (cancelled || wsId !== activeWorkspaceId) return
      refresh()
    })

    return () => {
      cancelled = true
      if (typeof off === 'function') off()
      window.electronAPI.unwatchPrototypes().catch((err: unknown) => {
        console.error('[usePrototypes] Failed to stop prototypes watcher:', err)
      })
    }
  }, [activeWorkspaceId, refresh])

  return { prototypes, refresh }
}
