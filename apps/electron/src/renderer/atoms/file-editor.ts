/**
 * "Open this file in its editor" — asked by anything, answered once, by the app shell.
 *
 * The canvas needs it and cannot do it alone: a node's body **is a file**, and the editor for a file
 * is the app's own (markdown, HTML, drawio, office) — not something a 300px card should reimplement.
 * The app shell already knows how to route a path to the right overlay (`useLinkInterceptor`'s
 * `handleOpenFile`); this is the one atom that lets a panel ask for it.
 *
 * `at` is a timestamp rather than a path identity: opening the same file twice in a row is a real
 * thing (the person clicked, nothing seemed to happen), and a request that equals the previous one
 * must still be a new request.
 */

import { atom } from 'jotai'

export interface FileEditorRequest {
  /** Absolute path — the shell routes it by extension, exactly as a link in chat would be. */
  path: string
  /** Why it was opened, for the overlay's own wording. */
  origin?: 'canvas'
  /** Monotonic, so the same path requested twice is two requests. */
  at: number
}

export const fileEditorRequestAtom = atom<FileEditorRequest | null>(null)

export const requestFileEditorAtom = atom(null, (_get, set, request: Omit<FileEditorRequest, 'at'>) => {
  set(fileEditorRequestAtom, { ...request, at: Date.now() })
})
