/**
 * One frame of a cut, drawn by whoever owns a renderer.
 *
 * A `reel_tool` command runs in the tool layer, which has files but no canvas. The host that does
 * — the desktop app's hidden window, a hub's render host — installs the drawing function here at
 * startup, the same seam `officePageCapture` uses for a document page. A host with no renderer
 * leaves it unset and `snapshot` refuses in words instead of pretending to have looked.
 *
 * The answer is a file. A tool result carries text, and the agent already reads pictures by path,
 * so the frame is written where the caller asked and its path is what comes back.
 */

import type { EditDocument } from './document.ts'

export interface ReelSnapshotInput {
  /** The cut as read from disk: sources are still project-relative. */
  document: EditDocument
  /** Timeline seconds to draw. */
  at: number
  /** Absolute path the JPEG is written to. */
  outPath: string
  /** Cap the longest edge, so a 4K frame does not ride into the conversation at full size. */
  maxEdge?: number
  /** A project-relative source, resolved to the file on disk by the caller that knows the roots. */
  pathOf: (src: string) => string
}

export interface ReelSnapshotResult {
  ok: boolean
  /** Absolute path of the picture, when `ok`. */
  path?: string
  width?: number
  height?: number
  /** Sources that could not be decoded, so the caller knows what the picture is missing. */
  warnings?: string[]
  message?: string
}

export type ReelSnapshot = (input: ReelSnapshotInput) => Promise<ReelSnapshotResult>

let installed: ReelSnapshot | null = null

/** Give the tools a way to draw a frame, or take it away (`null`) on a host that cannot. */
export function setReelSnapshot(snapshot: ReelSnapshot | null): void {
  installed = snapshot
}

/** The renderer in force, or null when this host has none. */
export function reelSnapshot(): ReelSnapshot | null {
  return installed
}
