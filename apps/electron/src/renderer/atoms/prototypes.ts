/**
 * Jotai atom for the active workspace's prototypes (read once on
 * workspace switch, refreshed on the `prototypes:changed` broadcast). Components
 * that need prototypes in isolation from AppShell read this atom.
 */

import { atom } from 'jotai'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

export const prototypesAtom = atom<PrototypeStatus[]>([])
