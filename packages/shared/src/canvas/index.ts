/**
 * Canvases: a project's boards, as files both a person and an agent edit.
 *
 * See `document.ts` for the document and its operations, `history.ts` for the per-canvas undo
 * stack, `files.ts` for where a canvas lives on disk, and `store.ts` for the one place a write
 * lands (revisions, history, open state).
 */

export * from './document.ts'
export * from './title.ts'
export * from './history.ts'
export * from './bridge.ts'
export * from './files.ts'
export * from './store.ts'
