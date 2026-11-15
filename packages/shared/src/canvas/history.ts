/**
 * Undo belongs to a canvas, not to a window.
 *
 * Two people edit one document: a person dragging nodes, and an agent applying a batch it
 * described. If each kept its own stack, Ctrl+Z would step over the other's work — or, worse,
 * replay a change against a document that no longer matches. So there is **one stack per canvas**,
 * every entry says who made it, and a batch means one step for both.
 *
 * The stack lives as long as the canvas is open (see `store.ts`): a closed canvas has no history,
 * and reopening one starts clean. That is a deliberate cost — history that survives restarts has
 * to be reconciled with what other editors wrote in the meantime — and it is why this file is
 * only the stack, with no persistence of its own.
 *
 * Entries hold whole documents rather than inverse operations. A canvas is small (hundreds of
 * nodes, kilobytes of JSON), and a snapshot cannot be *wrong*, where an inverse can: any future
 * operation that cannot express its own undo would quietly corrupt the stack.
 */

import type { CanvasDoc } from './document.ts'

export type CanvasEditOrigin = 'user' | 'agent'

export interface CanvasHistoryEntry {
  id: string
  origin: CanvasEditOrigin
  /** What the person would call this step ("对齐", "字幕位移", an agent's sentence). */
  label: string
  at: number
  before: CanvasDoc
  after: CanvasDoc
}

export interface CanvasHistoryState {
  canUndo: boolean
  canRedo: boolean
  undoLabel?: string
  redoLabel?: string
  /** Entries still applied, newest last — for a history panel or an agent asking what happened. */
  depth: number
}

export interface CanvasHistorySummaryEntry {
  id: string
  origin: CanvasEditOrigin
  label: string
  at: number
  undone: boolean
}

const DEFAULT_LIMIT = 80

export class CanvasHistory {
  private readonly limit: number
  private entries: CanvasHistoryEntry[] = []
  /** Number of entries currently applied; entries at or past this index are redoable. */
  private cursor = 0

  constructor(limit: number = DEFAULT_LIMIT) {
    this.limit = Math.max(1, limit)
  }

  /**
   * Record an applied batch.
   *
   * The `before` document is what the caller read before applying, `after` is what landed. A new
   * edit after an undo drops the redo tail — the usual rule, and the honest one: those steps can
   * no longer be reached from the document that now exists.
   */
  record(entry: Omit<CanvasHistoryEntry, 'id' | 'at'>): CanvasHistoryEntry {
    const recorded: CanvasHistoryEntry = {
      ...entry,
      id: `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
    }
    this.entries = this.entries.slice(0, this.cursor)
    this.entries.push(recorded)
    if (this.entries.length > this.limit) this.entries = this.entries.slice(this.entries.length - this.limit)
    this.cursor = this.entries.length
    return recorded
  }

  /** The document to restore, or null when there is nothing left to undo. */
  undo(): CanvasDoc | null {
    if (this.cursor === 0) return null
    this.cursor -= 1
    return this.entries[this.cursor]!.before
  }

  redo(): CanvasDoc | null {
    if (this.cursor >= this.entries.length) return null
    const entry = this.entries[this.cursor]!
    this.cursor += 1
    return entry.after
  }

  state(): CanvasHistoryState {
    const undoable = this.cursor > 0 ? this.entries[this.cursor - 1]! : null
    const redoable = this.cursor < this.entries.length ? this.entries[this.cursor]! : null
    return {
      canUndo: Boolean(undoable),
      canRedo: Boolean(redoable),
      ...(undoable ? { undoLabel: undoable.label } : {}),
      ...(redoable ? { redoLabel: redoable.label } : {}),
      depth: this.cursor,
    }
  }

  summary(): CanvasHistorySummaryEntry[] {
    return this.entries.map((entry, index) => ({
      id: entry.id,
      origin: entry.origin,
      label: entry.label,
      at: entry.at,
      undone: index >= this.cursor,
    }))
  }
}
