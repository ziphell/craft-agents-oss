/**
 * The workspace's works, as last read.
 *
 * One atom: the snapshot the RPC returned. There is no local mirror and no derived state to keep
 * in step — the library is a *view* of two things the app does not own (transcripts and files), so
 * the only state it has is "what we last saw".
 */

import { atom } from 'jotai'
import type { CreationsSnapshot } from '@craft-agent/shared/creations/types'

export const creationsAtom = atom<CreationsSnapshot | null>(null)

/**
 * The project filter, in the same vocabulary as the board: **project ids**, empty meaning
 * "every project", and a sentinel for the works that belong to none.
 *
 * State rather than local `useState` because the library is left and re-entered constantly —
 * opening a work, jumping to the turn that made it — and a filter that resets on every return is
 * a filter nobody uses. It survives those remounts; a workspace switch clears it (`CreationsHome`
 * owns the pruning).
 */
export const CREATIONS_UNASSIGNED_PROJECT = '__unassigned__'

export const creationsProjectFilterAtom = atom<string[]>([])
