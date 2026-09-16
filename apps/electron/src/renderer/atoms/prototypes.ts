/**
 * Jotai atom for the active workspace's prototypes (read once on
 * workspace switch, refreshed on the `prototypes:changed` broadcast). Components
 * that need prototypes in isolation from AppShell read this atom.
 */

import { atom } from 'jotai'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'
import { savePrototypeAutoReplayPreference } from '@/lib/prototypeAutoReplayPreference'

export const prototypesAtom = atom<PrototypeStatus[]>([])

/**
 * Whether a change under `prototypes/` is replayed into the windows showing that
 * prototype (plan §21.4).
 *
 * **On by default**, because "I saved the patch and nothing happened" is exactly
 * the failure this exists to remove: an edit is supposed to be visible without
 * anyone clicking apply. **Off is offered** because replaying a *live* page
 * reloads it, which throws away whatever was typed into that page — so the
 * decision belongs to the person who knows what the window is being used for.
 *
 * The value is the user's preference (`preferences.json`, see
 * `lib/prototypeAutoReplayPreference.ts`); this atom is the in-session copy the UI
 * reads. `usePrototypes` loads it once, and a toggle writes it back.
 */
export const prototypeAutoReplayAtom = atom(true)

export const setPrototypeAutoReplayAtom = atom(null, (_get, set, enabled: boolean) => {
  set(prototypeAutoReplayAtom, enabled)
  // Not awaited: the switch applies now, and remembering it is bookkeeping.
  void savePrototypeAutoReplayPreference(enabled)
})
