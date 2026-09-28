/**
 * Jotai atom for workspace Tweaks.
 *
 * `tweaksAtom` is the single source of truth for the loaded tweak list —
 * `useTweaks` writes it and every consumer (sidebar count, rows, detail page)
 * reads it. There is deliberately no local-state mirror.
 */

import { atom } from 'jotai'
import type { TweakSummary } from '@craft-agent/shared/tweaks'

export const tweaksAtom = atom<TweakSummary[]>([])
