/**
 * Ask the app shell to show or hide the sidebar and navigator (its Ctrl+. layout).
 *
 * Focus mode lives in `AppShell`'s own state because it is chrome, not document: a panel that
 * wants the window to itself cannot reach it. This is the request — a value plus a timestamp, so
 * asking for the same state twice is two requests (the person may have toggled it back by hand
 * between them) and the shell applies it in an effect.
 */

import { atom } from 'jotai'

export interface ChromeFocusRequest {
  hidden: boolean
  at: number
}

export const chromeFocusRequestAtom = atom<ChromeFocusRequest | null>(null)
