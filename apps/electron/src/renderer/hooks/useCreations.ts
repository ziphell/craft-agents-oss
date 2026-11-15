/**
 * Load the library for one workspace, and keep it current.
 *
 * Two mechanisms, both cheap, because the answer is derived rather than stored:
 *
 * - **a push** — the host watches the workspace's session logs and broadcasts the fresh list when
 *   one grows. That is the moment a work appears (a turn wrote a file), so the grid updates while
 *   the person is watching the conversation that made it.
 * - **a poll** — every 20 s, only while the document is visible. The push covers the agent's own
 *   writes; nothing covers a *document* being changed by another program, and re-asking is a warm
 *   scan (a handful of `stat` calls, not a re-read of the transcripts).
 *
 * Both land in the same atom, so there is one list and no merge logic. What there *is* — see
 * `mergeSnapshot` — is identity preservation: an answer that changed one work must not hand the
 * grid a hundred new objects, because React would then re-render a hundred cards to show the same
 * hundred pictures. A push arrives every second or two while a turn runs, so that difference is
 * the difference between a still page and a page that keeps rebuilding itself.
 *
 * **A background refresh is silent.** `loading` is what the button's spinner reads, and the poll is
 * every 20 s: a spinner that turns on its own says "something is happening" when nothing is. It is
 * raised for the first load and for the button only.
 */

import { useCallback, useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { creationsAtom } from '@/atoms/creations'
import { mergeSnapshot } from '@craft-agent/shared/creations/merge'
import type { CreationsQuery, CreationsSnapshot } from '@craft-agent/shared/creations/types'

/** How often a visible library re-asks. Warm scans are `stat`-shaped, so this is cheap. */
const POLL_INTERVAL_MS = 20_000

export interface UseCreationsResult {
  snapshot: CreationsSnapshot | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * The one place the snapshot's shape is trusted.
 *
 * Renderer and main are built separately (vite for this side, esbuild for that one), so during a
 * change to the index there is a window where the host answers in the older shape. `projectSlugs`
 * is filled here rather than with `?? []` in every reader: a stale host then shows every work as
 * "in no project", which is wrong but honest, instead of throwing on the first filter that indexes
 * it.
 */
function normalizeSnapshot(snapshot: CreationsSnapshot | null | undefined): CreationsSnapshot | null {
  if (!snapshot) return null
  return {
    ...snapshot,
    creations: snapshot.creations.map((creation) => ({
      ...creation,
      projectSlugs: creation.projectSlugs ?? [],
    })),
  }
}

/**
 * What a refresh cost, in a dev build only.
 *
 * The number worth watching is `changed`: how many cards a fresh answer makes render. It must be 0
 * on a poll that found nothing and one or two while a turn writes a file — a grid-sized number
 * means the identity preservation stopped working, which is invisible in the UI (the page looks
 * right, it only works too hard).
 *
 * `spinner` marks the two that a person asked for (opening the library, pressing refresh); those
 * are written to the main log too, because "opening this felt slow" is a question about exactly one
 * of them and the answer is not visible from the screen.
 */
function reportRefresh(
  previous: CreationsSnapshot | null,
  next: CreationsSnapshot | null,
  ms: number,
  spinner: boolean,
): void {
  if (!next) return
  const before = new Map((previous?.creations ?? []).map((creation) => [creation.id, creation]))
  const changed = next.creations.filter((creation) => before.get(creation.id) !== creation).length
  const line = `[creations] refresh ${ms.toFixed(0)} ms · ${next.creations.length} works · ${changed} changed`
  if (import.meta.env.DEV) console.debug(line)
  if (spinner) void window.electronAPI.debugLog(line)
}

export function useCreations(activeWorkspaceId: string | null | undefined): UseCreationsResult {
  const [snapshot, setSnapshot] = useAtom(creationsAtom)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Ask the host, and merge the answer into what is on screen.
   *
   * `showSpinner` is the whole difference between "the person asked" and "we asked on a timer":
   * the same call, one flag, and only the first one is worth a spinner.
   */
  const load = useCallback(
    async (showSpinner: boolean) => {
      if (!activeWorkspaceId) {
        setSnapshot(null)
        return
      }
      if (showSpinner) setLoading(true)
      const startedAt = performance.now()
      try {
        // The default list is "things that are still there", which is what a library of works means.
        const query: CreationsQuery = {}
        const result = await window.electronAPI.getCreations(activeWorkspaceId, query)
        const next = normalizeSnapshot(result)
        setSnapshot((previous) => {
          const merged = next ? mergeSnapshot(previous, next) : null
          reportRefresh(previous, merged, performance.now() - startedAt, showSpinner)
          return merged
        })
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setSnapshot(null)
      } finally {
        if (showSpinner) setLoading(false)
      }
    },
    [activeWorkspaceId, setSnapshot],
  )

  const refresh = useCallback(() => load(true), [load])

  useEffect(() => {
    void load(true)
  }, [load])

  // The host's own signal: a transcript grew, so re-read rather than wait for the poll.
  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onCreationsChanged((workspaceId, next) => {
      // Pushes carry the workspace id the host knows; a WebUI may identify it by slug. Either way
      // this client is the one being addressed, so a mismatch means "ask again", not "drop it".
      const normalized = normalizeSnapshot(next)
      if (workspaceId === activeWorkspaceId && normalized) {
        setSnapshot((previous) => mergeSnapshot(previous, normalized))
      } else {
        void load(false)
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setSnapshot, load])

  // A document edited by another program produces no transcript line; only asking again sees it.
  useEffect(() => {
    if (!activeWorkspaceId) return
    const tick = () => {
      if (document.visibilityState === 'visible') void load(false)
    }
    const timer = window.setInterval(tick, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [activeWorkspaceId, load])

  return { snapshot, loading, error, refresh }
}
