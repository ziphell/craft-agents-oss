/**
 * usePrototypes
 *
 * Loads workspace-scoped prototypes and keeps them in sync with the
 * `prototypes:changed` broadcast. Mirrors the lightweight half of `useProjects`,
 * plus the fs watcher lifecycle: the broadcast only carries the changed file
 * name, so every event triggers a full re-read of the status report.
 *
 * The same broadcast drives the **auto-replay** (plan §21.4): when the file that
 * changed is one a page is made of, every window showing that prototype is
 * replayed — reloaded if it is a page of ours, re-applied if it is someone
 * else's. It lives here because this hook is the one owner of the watcher, and it
 * is debounced because saving several files is one intention.
 */

import { useState, useEffect, useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { prototypesAtom } from '@/atoms/prototypes'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

/** One save is one replay: a multi-file save must not reload a window three times. */
const REPLAY_DEBOUNCE_MS = 300

/**
 * Which prototype a changed file belongs to, or null when the change is not one
 * a page is made of.
 *
 * The watcher reports a path relative to `prototypes/`, so the first segment is
 * the slug — and a report with no separator cannot name a prototype, so it
 * replays nothing rather than guessing at "the only one".
 *
 * Only the three things a page is made of count: `patches/` (the changes),
 * `assets/` (what a page loads) and a top-level `.html` (the page itself).
 * `dist/` is a deliverable nobody is looking at, `research/` and `anchors/` are
 * evidence, and reloading a window because someone exported or applied would be
 * a side effect of the wrong action.
 */
export function prototypeSlugForChangedFile(file: string | null): string | null {
  if (!file) return null
  const parts = file.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return null

  const [slug, ...rest] = parts
  if (!slug || slug.startsWith('.')) return null
  if (rest.length === 0) return null

  const second = rest[0] ?? ''
  const isPageDocument = rest.length === 1 && /\.html?$/i.test(second)
  if (second !== 'patches' && second !== 'assets' && !isPageDocument) return null

  return slug
}

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
    let replayTimer: ReturnType<typeof setTimeout> | null = null

    window.electronAPI.watchPrototypes().catch((err: unknown) => {
      console.error('[usePrototypes] Failed to start prototypes watcher:', err)
    })

    const off = window.electronAPI.onPrototypesChanged((wsId: string, file: string | null) => {
      if (cancelled || wsId !== activeWorkspaceId) return
      refresh()

      const slug = prototypeSlugForChangedFile(file)
      if (!slug) return

      if (replayTimer) clearTimeout(replayTimer)
      replayTimer = setTimeout(() => {
        replayTimer = null
        // A replay that fails leaves the window on its previous render, which is
        // the state the user is already looking at — so it is logged rather than
        // interrupting with a toast. The file itself is never lost.
        void window.electronAPI.replayPrototype(wsId, slug).catch((err: unknown) => {
          console.error('[usePrototypes] Auto-replay failed:', err)
        })
      }, REPLAY_DEBOUNCE_MS)
    })

    return () => {
      cancelled = true
      if (replayTimer) clearTimeout(replayTimer)
      if (typeof off === 'function') off()
      window.electronAPI.unwatchPrototypes().catch((err: unknown) => {
        console.error('[usePrototypes] Failed to stop prototypes watcher:', err)
      })
    }
  }, [activeWorkspaceId, refresh])

  return { prototypes, refresh }
}
