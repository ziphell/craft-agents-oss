/**
 * The one model download a server is running at a time, per kind.
 *
 * A settings page starts a download and then polls; the job outlives the request that started it,
 * and its last state is kept so a page reopened mid-way reads the truth. The map is keyed by kind
 * so a second kind of model can download beside the first without sharing a job.
 */

import {
  ModelDownloadCancelled,
  downloadModel,
  type DownloadableModel,
  type ModelDownloadStatus,
  type ModelMirror,
} from '@craft-agent/shared/media'

type Kind = DownloadableModel['kind']

interface Job {
  status: ModelDownloadStatus
  controller: AbortController | null
}

const jobs = new Map<Kind, Job>()

export const idleDownloadStatus = (): ModelDownloadStatus => ({
  phase: 'idle',
  receivedBytes: 0,
  totalBytes: 0,
  percent: 0,
})

/**
 * Start fetching, or hand back the run already in progress.
 *
 * A second click while 197 MB is arriving returns the same job rather than opening a second
 * connection to the same files.
 */
export function startModelDownload(options: {
  model: DownloadableModel
  root: string
  mirror?: ModelMirror
  /** Called once the run stops for any reason, so a caller can rebuild what the new files enable. */
  onSettled?: () => void
}): ModelDownloadStatus {
  const { model, root } = options
  const existing = jobs.get(model.kind)
  if (
    existing &&
    (existing.status.phase === 'downloading' || existing.status.phase === 'verifying')
  ) {
    return existing.status
  }

  const controller = new AbortController()
  const status: ModelDownloadStatus = {
    phase: 'downloading',
    modelId: model.id,
    receivedBytes: 0,
    totalBytes: model.bytes,
    percent: 0,
  }
  jobs.set(model.kind, { status, controller })

  void downloadModel({
    model,
    root,
    ...(options.mirror ? { mirror: options.mirror } : {}),
    signal: controller.signal,
    onPhase: (phase, file) => {
      status.phase = phase
      status.file = file
    },
    onProgress: (progress) => {
      status.file = progress.file
      status.fileIndex = progress.fileIndex
      status.fileCount = progress.fileCount
      status.receivedBytes = progress.receivedBytes
      status.totalBytes = progress.totalBytes
      status.percent = progress.percent
    },
  })
    .then((result) => {
      Object.assign(status, {
        phase: 'done' as const,
        percent: 100,
        receivedBytes: model.bytes,
        dir: result.dir,
      })
    })
    .catch((error: unknown) => {
      if (error instanceof ModelDownloadCancelled || controller.signal.aborted) {
        status.phase = 'cancelled'
        return
      }
      Object.assign(status, {
        phase: 'failed' as const,
        message: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      const job = jobs.get(model.kind)
      if (job?.controller === controller) job.controller = null
      try {
        options.onSettled?.()
      } catch {
        // A listener failing is not the download's failure.
      }
    })

  return status
}

export function modelDownloadStatus(kind: Kind): ModelDownloadStatus {
  return jobs.get(kind)?.status ?? idleDownloadStatus()
}

export function cancelModelDownload(kind: Kind): ModelDownloadStatus {
  const job = jobs.get(kind)
  if (job?.controller) {
    job.status.phase = 'cancelled'
    job.controller.abort()
  }
  return job?.status ?? idleDownloadStatus()
}
