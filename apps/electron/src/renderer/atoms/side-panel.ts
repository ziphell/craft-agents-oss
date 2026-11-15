/**
 * What a project has open on its side panel — and which tab is in front.
 *
 * A tab is **a path**. Not a kind, not an id: a project's canvas is `canvas.json` and a file is a
 * file, so "what is open" is one list of paths and the renderer decides per path what to draw
 * (`classifyFile` for files, the name for a canvas). Storing a kind would be a second place to
 * keep in sync with the first. The one exception is the project tab
 * (`PROJECT_DETAIL_PATH`): it is not a file, but it is always first — the panel's floor — and the
 * body draws the project's detail page for it.
 *
 * **View state, not project state** — the same rule as the panel's open/closed flag
 * (`canvas-layout.ts`): the project folder is a deliverable a person hands over, and "I had a
 * scratch note open" is not part of it. Keyed by project id, so a conversation opened later finds
 * the bench as it was left.
 *
 * Opening is the person's own act today. When an agent can ask for a tab to come forward, it calls
 * `openSidePanelTab` with the same shape — the rule about *who* may ask belongs there, not here.
 */

import { useCallback } from 'react'
import { getDefaultStore, useAtom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { atom } from 'jotai'

export interface SidePanelState {
  /** Absolute paths, in tab order. */
  paths: string[]
  /** The path in front — the project tab when no file is. */
  active: string | null
}

/**
 * The panel's first tab: the project itself. It is a path so the strip stays one list, but nothing
 * on disk answers to it — the body draws the project's detail page instead of a file.
 */
export const PROJECT_DETAIL_PATH = '__project_detail__'

/**
 * The asset library's own tab.
 *
 * The library is the project's media, and the board is one of its views — not a document of its
 * own (`assets/.index.json` holds the layout). So it is a tab without a path on disk, like the
 * project tab: the body draws `AssetLibrary`, and the grid/board switch lives inside it.
 */
export const PROJECT_ASSETS_PATH = '__project_assets__'

/**
 * The suffix cuts used before `.reel`.
 *
 * A tab saved under it is a leftover of that format, not a document this panel edits: it would no
 * longer match the cut editor and would fall through to the JSON viewer, showing a timeline as
 * text. View state is ours to discard — the file on disk stays where it is.
 */
const LEGACY_EDIT_SUFFIX = '.edit.json'

export const sidePanelMapAtom = atomWithStorage<Record<string, SidePanelState>>('craft-side-panel', {}, undefined, {
  // Read the stored tabs on the first render. Without this the atom starts empty on load and the
  // tabs you had are silently replaced by the next update.
  getOnInit: true,
})

export function normalizeSidePanelState(state: SidePanelState | undefined): SidePanelState {
  const stored = Array.isArray(state?.paths)
    ? state.paths.filter(
        // `PROJECT_DETAIL_PATH` is added back below; a stored `.../assets` tab addressed the folder
        // as if it were a file (the library now has its own tab, `PROJECT_ASSETS_PATH`); and a
        // legacy cut tab would show as JSON.
        (path) =>
          path !== PROJECT_DETAIL_PATH &&
          !path.replace(/\\/g, '/').endsWith('/assets') &&
          !path.toLowerCase().endsWith(LEGACY_EDIT_SUFFIX),
      )
    : []
  // The project is the panel's floor, not a tab somebody opens: it is always first, and it is what
  // is in front when nothing else is.
  const paths = [PROJECT_DETAIL_PATH, ...stored]
  if (stored.length === 0) return { paths, active: PROJECT_DETAIL_PATH }
  const active = state?.active && paths.includes(state.active) ? state.active : stored[stored.length - 1]!
  return { paths, active }
}

export function useSidePanel(projectId: string | null | undefined) {
  const [map, setMap] = useAtom(sidePanelMapAtom)
  const state = normalizeSidePanelState(projectId ? map[projectId] : undefined)

  const update = useCallback(
    (mutate: (current: SidePanelState) => SidePanelState) => {
      if (!projectId) return
      setMap((previous) => ({ ...previous, [projectId]: normalizeSidePanelState(mutate(normalizeSidePanelState(previous[projectId]))) }))
    },
    [projectId, setMap],
  )

  /** Open a path in a new tab (or bring the existing tab forward — one tab per path). */
  const open = useCallback(
    (path: string) => {
      update((current) => ({
        paths: current.paths.includes(path) ? current.paths : [...current.paths, path],
        active: path,
      }))
    },
    [update],
  )

  const close = useCallback(
    (path: string) => {
      // The project tab is the panel's floor: it has no close button, and a request to close it is
      // not a request to empty the panel.
      if (path === PROJECT_DETAIL_PATH) return
      update((current) => {
        const index = current.paths.indexOf(path)
        if (index === -1) return current
        const remaining = current.paths.filter(
          (candidate) => candidate !== path && candidate !== PROJECT_DETAIL_PATH,
        )
        const paths = [PROJECT_DETAIL_PATH, ...remaining]
        if (current.active !== path) return { paths, active: current.active }
        // Closing the front tab brings the one to its right forward (or its left, at the end); the
        // project tab is what is left when there are no files.
        const next = remaining[Math.min(Math.max(index - 1, 0), remaining.length - 1)] ?? PROJECT_DETAIL_PATH
        return { paths, active: next }
      })
    },
    [update],
  )

  const setActive = useCallback(
    (path: string) => {
      update((current) => ({ paths: current.paths, active: path }))
    },
    [update],
  )

  return { state, open, close, setActive }
}

/** Open a tab from outside React (a menu, a later agent request). */
export function openSidePanelTab(projectId: string, path: string): void {
  const store = getDefaultStore()
  const previous = store.get(sidePanelMapAtom)
  const current = normalizeSidePanelState(previous[projectId])
  store.set(sidePanelMapAtom, {
    ...previous,
    [projectId]: {
      paths: current.paths.includes(path) ? current.paths : [...current.paths, path],
      active: path,
    },
  })
}

/**
 * Whether the panel is covering the conversation (focus mode) — per project, like the tabs.
 *
 * Not persisted on purpose: a window that opens in focus mode because it was left that way
 * yesterday is a surprise, and the conversation is what a fresh window is for.
 */
export const sidePanelFocusAtom = atom<Record<string, boolean>>({})

export function useSidePanelFocus(projectId: string | null | undefined) {
  const [map, setMap] = useAtom(sidePanelFocusAtom)
  const focused = Boolean(projectId && map[projectId])
  const toggle = useCallback(() => {
    if (!projectId) return
    setMap((previous) => ({ ...previous, [projectId]: !previous[projectId] }))
  }, [projectId, setMap])
  return { focused, toggle }
}
