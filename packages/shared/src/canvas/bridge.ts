/**
 * The door from the agent's side to the editor showing a canvas.
 *
 * A canvas is owned by the panel showing it, for the same reason a document is owned by its editor:
 * the change has to land **inside that panel**, as one step of the history the person is looking at,
 * or it is a file that changed underneath them. This module is the one place that asks.
 *
 * It holds an installed function rather than reaching for the RPC server itself, because the two
 * callers live in different halves of the process: the tool runs in the session-tool layer, the
 * forwarder lives in `server-core` where `invokeClient` and `documentShownBy` are. The desktop (and
 * the headless server) installs it at startup, the same way the app installs its page-capture hooks.
 *
 * `null` is a real answer and the important one: **nobody is showing this canvas**, so there is no
 * history to join. The caller must say that out loud (write the file, and tell the agent the change
 * is outside anyone's undo) instead of pretending an editor took it.
 */

import type { CanvasDoc, CanvasOp } from './document.ts'

export interface CanvasApplyToEditorRequest {
  path: string
  ops: CanvasOp[]
  label: string
  origin: 'agent' | 'user'
  /** The revision the caller read; the panel refuses if it is showing something else. */
  expectedRevision?: number
}

export interface CanvasApplyToEditorReply {
  ok: boolean
  revision?: number
  ids?: string[]
  /** Why it was refused, in the panel's own words (a stale document, not this canvas, …). */
  message?: string
}

export interface CanvasEditorBridge {
  /** Ask the panel showing `path` to apply a batch. `null` when nothing is showing it. */
  apply(request: CanvasApplyToEditorRequest): Promise<CanvasApplyToEditorReply | null>
  /** Step the panel's own history. `null` when nothing is showing the canvas. */
  history(path: string, action: 'undo' | 'redo'): Promise<CanvasApplyToEditorReply | null>
  /** The document as the panel holds it — newer than the file while its save is in flight. */
  snapshot(path: string): Promise<CanvasDoc | null>
}

let installed: CanvasEditorBridge | null = null

export function setCanvasEditorBridge(bridge: CanvasEditorBridge | null): void {
  installed = bridge
}

/** The bridge for this process, or null where no editor can be reached (a CLI, a test). */
export function canvasEditorBridge(): CanvasEditorBridge | null {
  return installed
}

/**
 * What travels to a panel, and what comes back.
 *
 * One envelope for both directions so the preload has one capability rather than four: a `snapshot`
 * asks for the document the panel holds, an `apply` asks it to change it. The reply carries whichever
 * of the two the request implied.
 */
export type CanvasEditorRequest =
  | ({ kind: 'apply' } & CanvasApplyToEditorRequest)
  | { kind: 'snapshot'; path: string }
  | { kind: 'undo'; path: string }
  | { kind: 'redo'; path: string }

export interface CanvasEditorReply {
  ok: boolean
  revision?: number
  ids?: string[]
  doc?: CanvasDoc
  message?: string
}
