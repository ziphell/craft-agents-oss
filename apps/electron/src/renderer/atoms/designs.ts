/**
 * Jotai atoms for workspace Designs (agent-authored mini dashboards).
 *
 * `designsAtom` is the single source of truth for the loaded design list —
 * `useDesigns` writes it and every consumer (sidebar count, grid, detail view)
 * reads it. There is deliberately no local-state mirror.
 *
 * `designsProjectFilterAtom` follows the Kanban board's filter semantics
 * (empty = all), with one addition: the `PAGES_UNASSIGNED_PROJECT` sentinel
 * selects designs that have no project. It survives board remounts within a
 * session but is cleared on workspace switch (DesignsHome owns the pruning).
 */

import { atom } from 'jotai'
import type { LoadedDesign } from '@craft-agent/shared/designs/types'

export const designsAtom = atom<LoadedDesign[]>([])

/** Sentinel id representing "designs without a project" in the project filter. */
export const PAGES_UNASSIGNED_PROJECT = '__unassigned__'

/** Selected project ids to filter the designs grid by. Empty array = all designs. */
export const designsProjectFilterAtom = atom<string[]>([])
