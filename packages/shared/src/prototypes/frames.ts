/**
 * Frame capture — the pictures a finding argues from.
 *
 * A recording is not kept as a video. What consumes these is a model, and a model
 * given a video has to decode it and pick frames itself; the frames that matter
 * are the ones where the screen *changed*, and we are the only party that knows
 * when that happened (plan §20.3). So a capture writes a numbered JPEG per change
 * and an index next to them.
 *
 * Two properties make the result usable rather than merely stored:
 *
 * - **every frame carries where it was taken** — the address, the page of the
 *   prototype it belonged to, and the time. A wall of images with no coordinates
 *   is a wall of images: nothing in it can be cited.
 * - **frames live under `research/`**, so the same rule as a finding applies —
 *   they are how the author got to the requirements, they ship with nothing, and
 *   being binary costs nothing (the packaging rule only ever had to deal with
 *   `assets/`, see `export.ts`).
 *
 * The sampler lives in the browser pane (it is the only place that can see the
 * screen); this module is the paper trail it hands back — the index, the human
 * readable companion, and the directory both go in.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getPrototypeResearchPath } from './storage.ts'

/** Directory under `research/` that holds one capture session each. */
export const PROTOTYPE_FRAMES_DIRNAME = 'frames'

/** Absolute path to the directory a prototype's captures live in. */
export function getPrototypeFramesPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeResearchPath(workspaceRootPath, slug), PROTOTYPE_FRAMES_DIRNAME)
}

/** Why a frame is in the capture. */
export type PrototypeFrameReason =
  /** The first frame, before anything happened. */
  | 'start'
  /** The screen changed on its own — a stream redrawing, an animation, a poll. */
  | 'changed'
  /** An action was taken. Kept whatever the screen did, because the cause matters. */
  | 'action'
  /** A moment after an action, to catch what it produced. */
  | 'result'
  /**
   * Sampled from a video someone else recorded (plan §20.5).
   *
   * A different kind of frame from the four above, and worth saying so: those
   * were taken because something happened *now*, this one because a moment in a
   * recording was worth keeping. Which is why it carries an `offsetMs`.
   */
  | 'imported'

/** One frame: an image file plus the coordinates that make it citable. */
export interface PrototypeFrame {
  /** 1-based, in capture order. */
  index: number
  /** ISO timestamp of the capture. */
  at: string
  /** The address the window was showing. */
  url: string
  /**
   * The page of the prototype the address names, or null when it names none —
   * the window may have been taken somewhere else mid-capture.
   */
  page: string | null
  /**
   * Why the frame is here.
   *
   * A screen changes for two different reasons, and a capture that could not tell
   * them apart would be much less useful: a page that streams (a chat answering,
   * a list loading) changes with nobody touching it, while a click changes because
   * of what was clicked. Only the second can be explained, so only the second is.
   */
  reason: PrototypeFrameReason
  /** What was done, when the frame was caused by an action — e.g. `click [data-add]`. */
  action?: string
  /**
   * Where in the source video this frame is, for an `imported` frame.
   *
   * The wall-clock timestamp of an imported frame says when it was *sampled*, not
   * what it shows — this is the coordinate a reader can actually use ("at 0:12 the
   * total moves"). Absent on frames captured live, where `at` is the coordinate.
   */
  offsetMs?: number
}

/**
 * What one capture session produced.
 *
 * The images are files (`frame-0001.jpg`); this is the index beside them, written
 * to `frames.json` so a reader can say "frame 12 is the one where the total
 * moved" without guessing.
 */
export interface PrototypeFrameCapture {
  /** ISO timestamps bracketing the session. */
  startedAt: string
  endedAt: string
  /** How often the screen was compared. */
  intervalMs: number
  /**
   * How much of the sampled screen had to differ before a frame was kept, as a
   * ratio (0.005 = 0.5%). Recorded because it is what "a frame" means here — two
   * captures with different thresholds are not comparable.
   */
  threshold: number
  /**
   * Size of the captured image in **device pixels**, from the first frame.
   *
   * Not CSS pixels: `capturePage` returns what the compositor had, and dividing
   * by a device pixel ratio here would be a guess about a display. Recorded so a
   * reader knows whether they are looking at a phone-sized or a desktop-sized
   * screen.
   */
  viewport: { width: number; height: number } | null
  /**
   * True when the session hit its frame ceiling: what is here is a sample of the
   * session, not all of it. Reported rather than silently dropping the difference.
   */
  truncated: boolean
  frames: PrototypeFrame[]
  /**
   * Set when the frames were sampled from a video rather than captured live.
   *
   * Recorded so the record says where its pictures came from: frames sampled out
   * of a recording are evidence of a recording, and a reader who cannot tell the
   * two apart will read a re-enactment as an observation.
   */
  source?: {
    /** Path relative to the prototype directory, e.g. `videos/demo.mp4`. */
    video: string
    /** How it was sampled: on a timeline, or on change. */
    mode: 'timeline' | 'changes'
  }
}

export interface WrittenFrameCapture {
  /** Absolute path to the session directory. */
  dir: string
  /** File names written inside it, in order. */
  files: string[]
}

/** Directory under `research/` where imported videos are kept. */
export const PROTOTYPE_VIDEOS_DIRNAME = 'videos'

/** Absolute path to a prototype's imported videos. */
export function getPrototypeVideosPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeResearchPath(workspaceRootPath, slug), PROTOTYPE_VIDEOS_DIRNAME)
}

/**
 * Copy a video into the prototype, so the frames can be re-sampled later.
 *
 * Copied rather than referenced, because a path the author typed points at a file
 * nothing here owns: the recording gets moved, the temp file is cleaned up, and a
 * capture whose source is gone cannot be re-read — which is most of what having a
 * source is for. A name already taken gets a suffix rather than being overwritten:
 * two recordings of the same demo are two captures, not one.
 *
 * Returns the path relative to the prototype directory (what `frames.json` holds)
 * and the absolute path (what the decoder needs).
 */
export function copyPrototypeVideo(
  workspaceRootPath: string,
  slug: string,
  sourcePath: string,
): { file: string; absolutePath: string } {
  const dir = getPrototypeVideosPath(workspaceRootPath, slug)
  mkdirSync(dir, { recursive: true })

  const name = sourcePath.split(/[/\\]/).pop() ?? 'video'
  const stem = name.replace(/\.[^.]+$/, '')
  const extension = name.slice(stem.length)
  let candidate = name
  for (let suffix = 2; existsSync(join(dir, candidate)); suffix += 1) {
    candidate = `${stem}-${suffix}${extension}`
  }

  copyFileSync(sourcePath, join(dir, candidate))
  return { file: `${PROTOTYPE_VIDEOS_DIRNAME}/${candidate}`, absolutePath: join(dir, candidate) }
}

/**
 * One capture session, as it is on disk.
 *
 * A session of one per capture, named from the start time — or, for a video, from
 * the video's name, because "which recording was this sampled from" is the first
 * question a person asks of an imported capture.
 */
export function sessionDirName(startedAt: string): string {
  const packed = startedAt.replace(/[^0-9]/g, '').slice(0, 14)
  return packed.length >= 14 ? `${packed.slice(0, 8)}-${packed.slice(8)}` : packed
}

/** `0:12.4` — a position in a recording, as a person reads it. */
export function formatOffset(offsetMs: number): string {
  const total = Math.max(0, Math.round(offsetMs))
  const minutes = Math.floor(total / 60_000)
  const seconds = (total % 60_000) / 1000
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

/** `frame-0001.jpg` — index first, so a plain `ls` is already in order. */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(4, '0')}.jpg`
}

/**
 * The human-readable companion to `frames.json`.
 *
 * Written because the index is read twice by two readers: the agent cites frames
 * from a finding, and a person opens the directory to see what was captured. The
 * first deserves JSON; the second should not have to read JSON.
 */
export function buildFramesIndexDoc(capture: PrototypeFrameCapture, files: string[]): string {
  const origin = capture.source
    ? capture.source.mode === 'timeline'
      ? `sampled from \`${capture.source.video}\` every ${capture.intervalMs} ms`
      : `sampled from \`${capture.source.video}\`, keeping the moments that moved`
    : `captured by comparing the screen every ${capture.intervalMs} ms ` +
      `and keeping it when more than ${(capture.threshold * 100).toFixed(1)}% of it had changed`

  const lines = [
    `# Frames — ${capture.startedAt}`,
    '',
    `${capture.frames.length} frame${capture.frames.length === 1 ? '' : 's'} ` +
      `(${sessionDirName(capture.startedAt)}), ${origin}.`,
    '',
  ]

  if (capture.viewport) {
    lines.push(`Image size: ${capture.viewport.width}×${capture.viewport.height} device pixels.`, '')
  }
  if (capture.truncated) {
    lines.push(
      `**The session hit its frame limit**, so this is a sample: later changes were not recorded.`,
      '',
    )
  }

  lines.push(
    '',
    'Why a frame is here: `start` is the first one, `action` is what someone did, `result` is a moment after',
    'it, `changed` is a screen that moved on its own (a stream, an animation), and `imported` came out of a',
    'recording — where the number in brackets is the position in that recording.',
    '',
    '| # | File | At | Why | Page | Address |',
    '| --- | --- | --- | --- | --- | --- |',
  )
  capture.frames.forEach((frame, position) => {
    const why = [
      frame.action ? `${frame.reason}: ${frame.action}` : frame.reason,
      frame.offsetMs !== undefined ? `[${formatOffset(frame.offsetMs)}]` : '',
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(
      `| ${frame.index} | \`${files[position] ?? frameFileName(frame.index)}\` | ${frame.at} | ${why} | ${
        frame.page ?? '—'
      } | ${frame.url} |`,
    )
  })

  if (capture.source) {
    lines.push(
      '',
      `Sampled from \`${capture.source.video}\` (${capture.source.mode === 'timeline' ? 'on a timeline' : 'on change'}).`,
    )
  }

  lines.push(
    '',
    `Cite these from a finding's \`evidence:\` line, e.g. \`evidence: ${PROTOTYPE_FRAMES_DIRNAME}/${sessionDirName(
      capture.startedAt,
    )}/${frameFileName(1)}\`.`,
    '',
  )

  return lines.join('\n')
}

/** One capture session, as it is on disk. */
export interface PrototypeFrameCaptureSummary {
  /** Directory name, e.g. `20260915-183012`. */
  session: string
  /** Path relative to the prototype directory. */
  file: string
  startedAt: string
  frames: number
  /** True when the capture hit its ceiling — a sample of the session. */
  truncated: boolean
  /**
   * The video this capture was sampled from, relative to the prototype directory,
   * or null when the frames were captured live.
   */
  video: string | null
}

/**
 * The captures a prototype has, newest first.
 *
 * Read back from disk rather than remembered, for the same reason patches are
 * scanned: the index beside the images *is* the record, so what the panel shows
 * and what a finding can cite cannot drift apart. A session directory without a
 * readable `frames.json` is skipped — it is a half-written capture, not a
 * capture with zero frames.
 */
export function listFrameCaptures(
  workspaceRootPath: string,
  slug: string,
): PrototypeFrameCaptureSummary[] {
  const dir = getPrototypeFramesPath(workspaceRootPath, slug)
  if (!existsSync(dir)) return []

  let sessions: string[]
  try {
    sessions = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }

  const captures: PrototypeFrameCaptureSummary[] = []
  for (const session of sessions) {
    const indexPath = join(dir, session, 'frames.json')
    if (!existsSync(indexPath)) continue

    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as PrototypeFrameCapture
      captures.push({
        session,
        file: `${PROTOTYPE_FRAMES_DIRNAME}/${session}`,
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : session,
        frames: Array.isArray(parsed.frames) ? parsed.frames.length : 0,
        truncated: parsed.truncated === true,
        video: typeof parsed.source?.video === 'string' ? parsed.source.video : null,
      })
    } catch {
      continue
    }
  }

  return captures.sort((a, b) => b.session.localeCompare(a.session))
}

/**
 * Write one capture session.
 *
 * The images arrive as bytes and are written as they are — no re-encoding, no
 * resizing: what the screen looked like is evidence, and evidence that has been
 * through a converter is no longer the thing that was seen.
 *
 * @throws when the frame count and the image count disagree: a frames.json that
 *   points at images which are not there would be worse than a failed write.
 */
export function writeFrameCapture(
  workspaceRootPath: string,
  slug: string,
  capture: PrototypeFrameCapture,
  images: Uint8Array[],
  options: {
    /**
     * Directory name for this session. Defaults to the start time; an imported
     * capture passes something that names the video it came from.
     */
    session?: string
  } = {},
): WrittenFrameCapture {
  if (images.length !== capture.frames.length) {
    throw new Error(
      `Frame capture is inconsistent: ${capture.frames.length} frames but ${images.length} images.`,
    )
  }

  const dir = join(
    getPrototypeFramesPath(workspaceRootPath, slug),
    options.session ?? sessionDirName(capture.startedAt),
  )
  mkdirSync(dir, { recursive: true })

  const files: string[] = []
  capture.frames.forEach((frame, position) => {
    const name = frameFileName(frame.index)
    writeFileSync(join(dir, name), images[position]!)
    files.push(name)
  })

  writeFileSync(join(dir, 'frames.json'), `${JSON.stringify(capture, null, 2)}\n`, 'utf-8')
  writeFileSync(join(dir, 'index.md'), buildFramesIndexDoc(capture, files), 'utf-8')
  files.push('frames.json', 'index.md')

  return { dir, files }
}
