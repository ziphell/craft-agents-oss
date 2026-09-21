/**
 * Jotai atoms for workspace Websites (agent-authored single-file sites).
 *
 * `websitesAtom` is the single source of truth for the loaded website list —
 * `useWebsites` writes it and every consumer (sidebar count, grid, detail view)
 * reads it. There is deliberately no local-state mirror.
 *
 * `websitesProjectFilterAtom` follows the Kanban board's filter semantics
 * (empty = all), with one addition: the `PAGES_UNASSIGNED_PROJECT` sentinel
 * selects websites that have no project. It survives board remounts within a
 * session but is cleared on workspace switch (WebsitesHome owns the pruning).
 */

import { atom } from 'jotai'
import type { LoadedWebsite } from '@craft-agent/shared/websites/types'

export const websitesAtom = atom<LoadedWebsite[]>([])

/** Sentinel id representing "websites without a project" in the project filter. */
export const PAGES_UNASSIGNED_PROJECT = '__unassigned__'

/** Selected project ids to filter the websites grid by. Empty array = all websites. */
export const websitesProjectFilterAtom = atom<string[]>([])
