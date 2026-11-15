/**
 * "Put this file on the board."
 *
 * The asset library and the canvas are two tabs of one panel, so only one of them is on screen —
 * a drag between them is not a gesture a person can make. This atom is the hand-off instead: the
 * library says what should land, the panel brings the board forward, and the board (which owns its
 * own history and saves) performs the insert as one undoable step. The request is consumed once.
 */
import { atom } from 'jotai'

export interface CanvasInsertRequest {
  /** Which project's board this is for; a board only takes requests addressed to itself. */
  projectId: string
  /** Project-relative path (`assets/photo.png`). */
  src: string
  /** Display name, from the library entry. */
  name: string
  type: 'image' | 'video'
}

export const canvasInsertAtom = atom<CanvasInsertRequest | null>(null)
