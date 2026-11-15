/**
 * Exports, as jobs that outlive the tool call that asked for them.
 *
 * An encode takes minutes; a tool result takes one turn. So the map below is the truth: `start`
 * answers with a job while the render runs on its own promise, `status` reads the map, and a
 * settled job stays quotable for an hour so "did it land?" has an answer after the fact.
 *
 * The file is the artifact, not the map: a restart loses the row, and the person still has the
 * `.mp4`. Nothing here retries — a failed encode is a failed encode, and the cut is untouched.
 */

import { existsSync, unlinkSync } from 'node:fs'
import type {
  ReelExportHost,
  ReelExportJob,
  ReelExportJobInput,
} from '@craft-agent/shared/reel/export-host'
import { exportCutToFile } from './edit-export'

const jobs = new Map<string, ReelExportJob>()
/** The abort handle of a running job; absent once it settled. */
const controllers = new Map<string, AbortController>()
let sequence = 0

/** Long enough to answer after the fact, short enough not to grow forever. */
const KEEP_FINISHED_MS = 60 * 60 * 1000

function prune(now: number): void {
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.completedAt && now - job.completedAt > KEEP_FINISHED_MS) {
      jobs.delete(id)
    }
  }
}

export const reelExportJobs: ReelExportHost = {
  start(input: ReelExportJobInput): ReelExportJob {
    const now = Date.now()
    sequence += 1
    const job: ReelExportJob = {
      id: `export-${now.toString(36)}-${sequence.toString(36)}`,
      sessionId: input.sessionId,
      name: input.name,
      outPath: input.outPath,
      container: input.container,
      audioOnly: input.audioOnly === true,
      status: 'running',
      startedAt: now,
    }
    jobs.set(job.id, job)
    prune(now)
    const controller = new AbortController()
    controllers.set(job.id, controller)

    // The render outlives this call on purpose: no await, and a rejection is a job status rather
    // than an unhandled promise.
    void (async () => {
      try {
        const result = await exportCutToFile({
          document: input.document,
          outPath: input.outPath,
          container: input.container,
          ...(input.audioOnly ? { audioOnly: true } : {}),
          pathOf: input.pathOf,
          signal: controller.signal,
          // The encoder's own number, kept on the job so `--status` can answer "how much longer?".
          onProgress: (ratio: number) => {
            job.progress = Math.max(0, Math.min(1, ratio))
          },
        })
        const cancelled = result.cancelled === true || controller.signal.aborted
        job.status = cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed'
        if (result.ok) job.duration = result.duration
        else if (!cancelled) job.message = result.message
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'
        if (job.status === 'failed') {
          job.message = error instanceof Error ? error.message : String(error)
        }
      } finally {
        controllers.delete(job.id)
        job.completedAt = Date.now()
        // A cancelled render leaves whatever the muxer had written; it is not a film, so remove it
        // rather than leave a file that looks deliverable.
        if (job.status === 'cancelled') {
          try {
            if (existsSync(job.outPath)) unlinkSync(job.outPath)
          } catch {
            /* the file may be held by a dying encoder; the job already says cancelled */
          }
        }
        // A wake-up that fails must not fail the file: the render is already on disk.
        try {
          input.onFinished?.({ ...job })
        } catch {
          /* the session may be gone; the file is not */
        }
      }
    })()

    return { ...job }
  },

  status(id: string): ReelExportJob | null {
    const job = jobs.get(id.trim())
    return job ? { ...job } : null
  },

  list(sessionId: string): ReelExportJob[] {
    return [...jobs.values()]
      .filter((job) => job.sessionId === sessionId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((job) => ({ ...job }))
  },

  cancel(id: string): boolean {
    const job = jobs.get(id.trim())
    if (!job || job.status !== 'running') return false
    const controller = controllers.get(id.trim())
    if (!controller) return false
    controller.abort()
    return true
  },
}
