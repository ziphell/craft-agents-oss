/**
 * Import a video the user recorded elsewhere, as research evidence.
 *
 * A recording made with a phone, Loom or QuickTime is the same kind of evidence as
 * a live capture — what differs is where its timeline came from. So the import
 * produces the *same artifact*: numbered frames plus an index under
 * `research/frames/`, which is what makes a finding able to cite them identically
 * (plan §20.5).
 *
 * Three decisions live here rather than in the caller:
 *
 * - **the video is copied in first** (`research/videos/`), because a capture whose
 *   source has been cleaned up cannot be re-sampled, and re-sampling is most of
 *   what having a source is for;
 * - **the recording arrives as a path**, not as a picker: the only caller is the
 *   agent's command (`sample-video <path>`), so nobody here asks the
 *   user for anything (plan §20.5);
 * - **an imported frame carries its offset**, not just a wall-clock timestamp —
 *   "0:12" is the coordinate a reader of a recording can use.
 *
 * @see docs/prototype-workbench-plan.md §20.5
 */

import { join } from 'node:path'
import {
  copyPrototypeVideo,
  frameFileName,
  sessionDirName,
  writeFrameCapture,
  type PrototypeFrame,
  type PrototypeFrameCapture,
} from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export interface PrototypeVideoImportOptions {
  /** The recording to sample. */
  path: string
  /** `timeline` samples on an interval; `changes` keeps only what moved. */
  mode?: 'timeline' | 'changes'
  /** Sampling interval, ms. */
  everyMs?: number
  /** Ceiling on frames. */
  maxFrames?: number
}

export interface PrototypeVideoImportResult {
  /** Directory name under `research/frames/`. */
  session: string
  /** The copy inside the prototype, relative to its directory. */
  video: string
  frames: number
  files: string[]
  truncated: boolean
  durationMs: number
  /** The frames themselves, in order, with the file each was written to (the reply's copy). */
  images: Array<{ path: string; bytes: Uint8Array }>
}

const DEFAULT_EVERY_MS = 2_000
const DEFAULT_MAX_FRAMES = 40

/**
 * Sample a recording into the prototype's frames.
 *
 * A recording that cannot be read throws (naming the codec when that is the
 * reason) — there is no "the user changed their mind" answer left to return.
 */
export async function importPrototypeVideo(
  bpm: IBrowserPaneManager,
  workspaceRootPath: string,
  slug: string,
  options: PrototypeVideoImportOptions,
): Promise<PrototypeVideoImportResult> {
  const source = options.path

  const mode = options.mode ?? 'timeline'
  const everyMs = Math.max(100, options.everyMs ?? DEFAULT_EVERY_MS)
  const maxFrames = Math.max(1, Math.min(400, options.maxFrames ?? DEFAULT_MAX_FRAMES))

  const extracted = await bpm.extractVideoFrames(source, { mode, everyMs, maxFrames })

  // Copied after decoding succeeded: a recording Chromium cannot read should not
  // leave a copy behind that nothing will ever sample.
  const copied = copyPrototypeVideo(workspaceRootPath, slug, source)

  const startedAt = new Date().toISOString()
  const frames: PrototypeFrame[] = extracted.frames.map((frame, index) => ({
    index: index + 1,
    // Wall clock is when the frame was sampled; `offsetMs` is what it shows — the
    // two are different facts and only the second is about the recording.
    at: new Date(Date.parse(startedAt) + frame.offsetMs).toISOString(),
    url: source,
    page: null,
    reason: 'imported',
    offsetMs: frame.offsetMs,
  }))

  const capture: PrototypeFrameCapture = {
    startedAt,
    endedAt: new Date().toISOString(),
    intervalMs: everyMs,
    threshold: 0,
    viewport: extracted.viewport,
    truncated: extracted.truncated,
    frames,
    source: { video: copied.file, mode },
  }

  // Named after the recording, because "which one is this" is the first question
  // anyone asks of an imported capture.
  const label = (copied.file.split('/').pop() ?? 'video').replace(/\.[^.]+$/, '')
  const session = `import-${label}-${sessionDirName(startedAt)}`

  const written = writeFrameCapture(
    workspaceRootPath,
    slug,
    capture,
    extracted.frames.map((frame) => frame.bytes),
    { session },
  )

  return {
    session,
    video: copied.file,
    frames: frames.length,
    files: written.files,
    truncated: extracted.truncated,
    durationMs: extracted.durationMs,
    images: frames.map((frame, position) => ({
      path: join(written.dir, frameFileName(frame.index)),
      bytes: extracted.frames[position]!.bytes,
    })),
  }
}
