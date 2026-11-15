/**
 * A whole cut, rendered by whoever owns an encoder — as a job, not a call.
 *
 * An encode is minutes, not milliseconds, so the tool layer does not wait for it: `start` returns
 * at once with a job, `status` answers what happened, and the host calls `onFinished` when the
 * encode settles. That last callback is how a conversation hears back — the desktop turns it into
 * a hidden system message, so the agent can say the film is ready instead of the person finding a
 * file by accident.
 *
 * The counterpart of `snapshot.ts`: same seam, different answer. A host with no encoder leaves
 * this unset and `export` refuses in words.
 */

import type { EditDocument } from './document.ts'

export type ExportContainer = 'mp4' | 'webm' | 'mp3'

export type ReelExportStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** What one render needs, whoever starts it. */
export interface ReelExportInput {
  document: EditDocument
  /** Absolute path the file is written to. Its directory is created when missing. */
  outPath: string
  container: ExportContainer
  /** Mix the sound and write no picture (`.m4a` in an MP4 container). */
  audioOnly?: boolean
  /** A project-relative source, resolved to the file on disk by the caller that knows the roots. */
  pathOf: (src: string) => string
  /** Aborting stops the encode; a cancelled render is not a failed one. */
  signal?: AbortSignal
  /** 0..1, as the encoder reports it — the answer to "how much longer?". */
  onProgress?: (ratio: number) => void
}

export interface ReelExportResult {
  ok: boolean
  /** Absolute path of the file, when `ok`. */
  path?: string
  /** Seconds of timeline rendered. */
  duration?: number
  /** The caller asked to stop, so `ok` is false by intent rather than by fault. */
  cancelled?: boolean
  message?: string
}

export interface ReelExportJob {
  id: string
  /** The conversation that asked, so `status` can answer for one session only. */
  sessionId: string
  /** The cut's own name, for the message a wake-up writes. */
  name: string
  outPath: string
  container: ExportContainer
  audioOnly: boolean
  status: ReelExportStatus
  startedAt: number
  /** 0..1 while running — the encoder's own number, not an estimate. */
  progress?: number
  completedAt?: number
  /** Seconds of timeline rendered, once `completed`. */
  duration?: number
  /** Why it failed, once `failed`. */
  message?: string
}

export interface ReelExportJobInput extends ReelExportInput {
  sessionId: string
  name: string
  /** Called once the job settles. The host uses it to wake the session. */
  onFinished?: (job: ReelExportJob) => void
}

export interface ReelExportHost {
  /** Start the encode and return at once; nobody waits for the file here. */
  start(input: ReelExportJobInput): ReelExportJob
  status(id: string): ReelExportJob | null
  /** Every job this conversation started, newest first. */
  list(sessionId: string): ReelExportJob[]
  /** Ask a running encode to stop. False when there is nothing to stop. */
  cancel(id: string): boolean
}

let installed: ReelExportHost | null = null

/** Give the tools a way to render a cut, or take it away (`null`) on a host that cannot. */
export function setReelExportHost(host: ReelExportHost | null): void {
  installed = host
}

/** The encoder in force, or null when this host has none. */
export function reelExportHost(): ReelExportHost | null {
  return installed
}
