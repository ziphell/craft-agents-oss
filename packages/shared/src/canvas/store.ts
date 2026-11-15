/**
 * The file half of a canvas: read it, write it, and refuse a write that lost a race.
 *
 * This is deliberately **not** where an edit is decided. On this app the editor showing a document
 * owns it — the rule drawio and the office editors already follow (`office/open-documents.ts`,
 * `CLIENT_OFFICE_APPLY_EDIT`): an agent's change is delivered **into that editor**, lands as one
 * step of its own history, and the file follows from what the editor saves. Writing a file under an
 * open editor leaves the person's screen stale, and their next save is the one that gets refused.
 *
 * So there are two ways a canvas changes, and this file owns only the second:
 *
 * 1. **Somebody is showing it** — the panel applies the batch to its own document (one undo step,
 *    person or agent alike) and saves through `write`. Nothing here decides what the batch means.
 * 2. **Nobody is showing it** — there is no editor to ask and no history to join, so the caller
 *    applies the batch itself and writes the result (`applyUnattended`). The revision check is what
 *    keeps that from landing on top of a write nobody saw.
 *
 * `revision` is the write precondition in both cases and only moves when a write lands. The
 * viewport (pan/zoom) is written too but never bumps it: scrolling is not an edit, and it must not
 * invalidate an agent's read.
 */

import { existsSync } from 'fs'
import { createCanvasFile, ensureCanvasFile, readCanvasFile, writeCanvasFile, type CanvasFileEntry } from './files.ts'
import {
  applyCanvasOps,
  type CanvasApplyResult,
  type CanvasDoc,
  type CanvasOp,
  type CanvasOpResult,
  type CanvasViewport,
} from './document.ts'

/** A refused write says which precondition failed, not just "conflict". */
export class CanvasWriteConflict extends Error {
  readonly expectedRevision: number
  readonly actualRevision: number
  readonly doc: CanvasDoc

  constructor(expectedRevision: number, doc: CanvasDoc) {
    super(`canvas moved from revision ${expectedRevision} to ${doc.revision}`)
    this.name = 'CanvasWriteConflict'
    this.expectedRevision = expectedRevision
    this.actualRevision = doc.revision
    this.doc = doc
  }
}

export interface CanvasWriteRequest {
  /** The document the panel holds. Its `revision` is the precondition. */
  doc: CanvasDoc
  expectedRevision: number
  /** Node ids the batch touched, so a viewer can re-select them. */
  ids?: string[]
  /** What the person would call this step. */
  label?: string
}

/** Saved, or refused with the document that is actually there — never both, never neither. */
export type CanvasWriteReply =
  | { doc: CanvasDoc; revision: number }
  | { conflict: true; expectedRevision: number; actualRevision: number; doc: CanvasDoc }

export interface CanvasWriteReplyInternal {
  doc: CanvasDoc
  /** What the write touched, when the caller applied a batch; empty for a plain save. */
  ids: string[]
}

/**
 * A change another window should hear about.
 *
 * `revision` is what tells a reader whether it already has this one; `origin` and `label` are what a
 * toast says ("the assistant moved two nodes"). `history` is always the empty state now — history
 * belongs to the panel that owns the document, so a notification cannot describe somebody else's
 * stack.
 */
export interface CanvasChange {
  path: string
  revision: number
  origin: 'user' | 'agent'
  label: string
  ids: string[]
  history: { canUndo: boolean; canRedo: boolean; depth: number }
}

export class CanvasFiles {
  /** The project's one canvas: created or migrated on first use. */
  open(projectDir: string, name = '画布'): { path: string; doc: CanvasDoc } {
    return ensureCanvasFile(projectDir, name)
  }

  read(path: string): CanvasDoc {
    return readCanvasFile(path)
  }

  list(projectDir: string): CanvasFileEntry[] {
    const { path, doc } = ensureCanvasFile(projectDir)
    return [{ slug: 'canvas', path, updatedAt: Date.now(), name: doc.name, revision: doc.revision, nodeCount: doc.nodes.length }]
  }

  peek(projectDir: string, _slug?: string): CanvasDoc {
    return ensureCanvasFile(projectDir).doc
  }

  create(projectDir: string, name: string): { slug: string; path: string; doc: CanvasDoc } {
    return createCanvasFile(projectDir, name)
  }

  /**
   * Save a document the caller already holds — the editor's own write.
   *
   * `doc.revision` is what the caller believes is current; the file's own revision is what it must
   * be. A mismatch means somebody else wrote while this editor was working, and the caller gets the
   * document that is there instead of overwriting it.
   */
  write(path: string, doc: CanvasDoc, ids: string[] = []): CanvasWriteReplyInternal {
    const current = readCanvasFile(path)
    if (current.revision !== doc.revision) throw new CanvasWriteConflict(doc.revision, current)
    const next: CanvasDoc = { ...doc, revision: current.revision + 1 }
    writeCanvasFile(path, next)
    return { doc: next, ids }
  }

  /** Pan/zoom: written, never revisioned, never undoable. */
  writeViewport(path: string, viewport: Partial<CanvasViewport>): CanvasDoc {
    const current = readCanvasFile(path)
    const applied = applyCanvasOps(current, [{ type: 'set_viewport', viewport }])
    const next: CanvasDoc = { ...applied.doc, revision: current.revision }
    writeCanvasFile(path, next)
    return next
  }

  /**
   * Apply a batch with nobody watching: the file is the only document there is.
   *
   * Used by an agent when no editor holds the canvas — there is no history to join, so this is a
   * write, and the answer says so (the tool reports that the change is outside anyone's undo).
   */
  applyUnattended(
    path: string,
    request: { ops: CanvasOp[]; expectedRevision: number },
  ): { doc: CanvasDoc; results: CanvasOpResult[]; ids: string[] } {
    if (!existsSync(path)) throw new Error(`no canvas at ${path}`)
    const current = readCanvasFile(path)
    if (current.revision !== request.expectedRevision) throw new CanvasWriteConflict(request.expectedRevision, current)
    const applied: CanvasApplyResult = applyCanvasOps(current, request.ops)
    if (!request.ops.length) return { doc: current, results: [], ids: [] }
    const next: CanvasDoc = { ...applied.doc, revision: current.revision + 1 }
    writeCanvasFile(path, next)
    const ids = [...new Set(applied.results.flatMap((result) => result.ids))]
    return { doc: next, results: applied.results, ids }
  }
}

/** One instance for the process: the RPC handlers and the agent's tool read the same files. */
export const canvasFiles = new CanvasFiles()
