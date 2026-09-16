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
 * - **the file chooser is the browser pane's**, because a renderer never sees a
 *   path and the panel should not learn one;
 * - **an imported frame carries its offset**, not just a wall-clock timestamp —
 *   "0:12" is the coordinate a reader of a recording can use.
 *
 * @see docs/prototype-workbench-plan.md §20.5
 */

import {
  copyPrototypeVideo,
  sessionDirName,
  writeFrameCapture,
  type PrototypeFrame,
  type PrototypeFrameCapture,
} from '@craft-agent/shared/prototypes'
import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export interface PrototypeVideoImportOptions {
  /** The recording. Omitted by the panel, which asks the user instead. */
  path?: string
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
}

const DEFAULT_EVERY_MS = 2_000
const DEFAULT_MAX_FRAMES = 40

/**
 * Sample a recording into the prototype's frames.
 *
 * Returns null when no recording was chosen — the panel's button and the agent's
 * command both need "the user changed their mind" to be an ordinary answer rather
 * than an error.
 */
export async function importPrototypeVideo(
  bpm: IBrowserPaneManager,
  workspaceRootPath: string,
  slug: string,
  options: PrototypeVideoImportOptions = {},
): Promise<PrototypeVideoImportResult | null> {
  const source = options.path ?? (await bpm.pickVideoFile())
  if (!source) return null

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
  }
}
