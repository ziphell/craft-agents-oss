/**
 * Jotai atom for workspace Artifacts.
 *
 * `artifactsAtom` is the single source of truth for the loaded artifact list —
 * `useArtifacts` writes it and every consumer (sidebar count, list panel, detail
 * header) reads it. There is deliberately no local-state mirror.
 */

import { atom } from 'jotai'
import type { ArtifactEntry } from '@craft-agent/shared/artifacts'

export const artifactsAtom = atom<ArtifactEntry[]>([])
