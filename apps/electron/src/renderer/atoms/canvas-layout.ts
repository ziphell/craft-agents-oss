/**
 * How a project shows its work beside its conversations.
 *
 * The layout is a **panel**, not a set of modes: the conversation is always there, and the panel is
 * either open beside it or closed. There is no "panel only" state — reading a conversation and
 * looking at the project's assets are things a person does together, and a full-screen view of the
 * library costs the conversation it was opened from.
 *
 * **This is view state, not project state.** The key is the project — so a conversation opened
 * later in the same project starts the way the last one looked — but the value lives in this
 * machine's UI storage, not in `projects/<slug>/config.json`. The project folder is a deliverable
 * a person hands to someone else; "is my panel open" is not part of what they hand over.
 */

import { useCallback } from 'react'
import { getDefaultStore, useAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** Open or closed. A stored `canvas` from the old three-way cycle reads as `split`. */
export type CanvasLayoutMode = 'chat' | 'split'

export const DEFAULT_CANVAS_LAYOUT: CanvasLayoutMode = 'chat'

export const canvasLayoutMapAtom = atomWithStorage<Record<string, unknown>>(
  'craft-canvas-layout',
  {},
)

export function useCanvasLayout(projectId: string | null | undefined) {
  const [layouts, setLayouts] = useAtom(canvasLayoutMapAtom)

  const stored = projectId ? layouts[projectId] : undefined
  // A project that was left in the old `canvas` mode opens the panel instead of losing it silently.
  const mode: CanvasLayoutMode = stored === 'split' || stored === 'canvas' ? 'split' : DEFAULT_CANVAS_LAYOUT

  const setMode = useCallback(
    (next: CanvasLayoutMode) => {
      if (!projectId) return
      setLayouts((previous) => ({ ...previous, [projectId]: next }))
    },
    [projectId, setLayouts],
  )

  return [mode, setMode] as const
}

/** One click: closed → open, open → closed. */
export function nextCanvasLayout(mode: CanvasLayoutMode): CanvasLayoutMode {
  return mode === 'split' ? 'chat' : 'split'
}

/**
 * Set a project's layout from outside React — the new-canvas flow creates a project and wants its
 * first conversation to open split, before any component for that project exists.
 */
export function setCanvasLayoutMode(projectId: string, mode: CanvasLayoutMode): void {
  if (!projectId) return
  const store = getDefaultStore()
  store.set(canvasLayoutMapAtom, { ...store.get(canvasLayoutMapAtom), [projectId]: mode })
}
