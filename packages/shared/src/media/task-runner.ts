/**
 * One step of a generation.
 *
 * Nothing here waits. `advanceMediaTask` submits once or asks once, writes what it learned back to
 * the task file, and returns — so the process that started a three-minute clip is free to do
 * anything else, including exit. Whoever calls it again later (a timer, a restart, a person pressing
 * "continue") picks up exactly where it stopped.
 *
 * The rules that make that safe:
 *
 * - **Never submit twice.** With a `providerTaskId` in hand, the only thing left to do is poll.
 * - **A lost answer is not a failure.** A submit whose response never arrived is `interrupted`, not
 *   `failed` — the provider may well be working, and resubmitting would pay twice.
 * - **A poll that cannot reach the provider is not an answer.** It keeps the task running and asks
 *   again later; only the provider saying "failed" ends it.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  channelForKind,
  isSoundKind,
  mediaChannelKey,
  mediaChannelModel,
  readMediaChannels,
  type MediaChannel,
  type MediaKind,
} from './channels.ts'
import { prepareTaskSubmission, taskEndpointFor } from './generate.ts'
import { dataUrlOfFile, mediaKindOfFile } from './inputs.ts'
import { objectStorageUploader } from './object-storage.ts'
import { validateMediaRequest, type MediaRequestFacts } from './validate.ts'
import { fileNameForMime } from './providers/api-speech.ts'
import { pollApiTask, submitApiTask, cancelApiTask, type ApiTaskResult } from './providers/api-task.ts'
import { mimeOfFile, uploadFileOverApi } from './providers/api-upload.ts'
import { MediaFailure } from './types.ts'
import {
  isTerminalStatus,
  MEDIA_TASK_REQUEST_VERSION,
  removeMediaTask,
  writeMediaTask,
  type MediaTask,
  type MediaTaskStatus,
} from './tasks.ts'
import { findProjectDir, readGenerationRecord, toProjectPath, writeGenerationRecord } from '../provenance/storage.ts'

/** A clip can take a while; past this, the task is over whether or not anybody said so. */
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000

const DEFAULT_POLL_MS = 5000

/**
 * Put one local reference where the provider can reach it, and return the reference to write in
 * the body (`mm_file://…` for MiniMax).
 *
 * Reads the file here: a task stores paths, not bytes, so the upload happens at the first submit
 * and is retried with the task if it fails. An upload is a `upload`-layer failure — the provider
 * never saw a generation request.
 */
async function uploadReference(
  channel: MediaChannel,
  reference: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const upload = channel.upload
  if (!upload) {
    throw new MediaFailure('upload', `渠道「${channel.name}」没有上传端点。`, {
      code: 'upload_failed',
      field: 'upload',
    })
  }
  const apiKey = mediaChannelKey(channel)
  if (!apiKey) {
    throw new MediaFailure('upload', `渠道「${channel.name}」没有密钥，参考文件无法上传。`, {
      code: 'missing_credentials',
      field: 'apiKey',
    })
  }
  const result = await uploadFileOverApi({
    baseUrl: channel.baseUrl,
    apiKey,
    path: upload.path,
    purpose: upload.purpose,
    bytes: new Uint8Array(readFileSync(reference)),
    mimeType: mimeOfFile(reference),
    filename: basename(reference),
    auth: channel.auth,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
  return `${upload.refPrefix}${result.fileId}`
}

/**
 * Put one local reference in the configured bucket and return its public URL.
 *
 * Used when the provider has no upload endpoint of its own and cannot take bytes inline: the task
 * stores paths, so the upload happens at submit time and is retried with the task.
 */
async function hostReference(
  upload: (file: { bytes: Uint8Array; mimeType: string; filename?: string }) => Promise<string>,
  reference: string,
): Promise<string> {
  return upload({
    bytes: new Uint8Array(readFileSync(reference)),
    mimeType: mimeOfFile(reference),
    filename: basename(reference),
  })
}

export interface TaskRunnerOptions {
  /** The channels to trust. Defaults to this machine's `media-channels.json`. */
  channels?: MediaChannel[]
  /** Injected by a test; the desktop leaves it out and the real `fetch` is used. */
  fetch?: typeof fetch
  now?: () => number
}

/**
 * The facts a preflight needs, read from paths while the files still exist.
 *
 * Frames are roles, not numbered references: the same rule the submission uses, so a frame path is
 * never counted twice. Sizes are best-effort — a file that vanished is the upload's problem to
 * report, not a reason to invent a limit failure here.
 */
function factsOfPaths(input: {
  prompt: string
  model?: string
  params?: Record<string, string | number>
  references?: readonly string[]
  firstFrame?: string
  lastFrame?: string
}): MediaRequestFacts {
  const roles = new Set(
    [input.firstFrame, input.lastFrame].filter((path): path is string => Boolean(path)),
  )
  const counts = { image: 0, video: 0, audio: 0 }
  const sizes: Record<'image' | 'video' | 'audio', number[]> = {
    image: [],
    video: [],
    audio: [],
  }
  for (const reference of input.references ?? []) {
    if (roles.has(reference)) continue
    const kind = mediaKindOfFile(reference)
    counts[kind]++
    try {
      sizes[kind].push(statSync(reference).size)
    } catch {
      // The upload will say what is missing; a size we cannot read is not a size over a limit.
    }
  }
  return {
    prompt: input.prompt,
    model: input.model,
    params: input.params,
    counts,
    firstFrame: Boolean(input.firstFrame),
    lastFrame: Boolean(input.lastFrame),
    sizes: {
      image: sizes.image.length ? sizes.image : undefined,
      video: sizes.video.length ? sizes.video : undefined,
      audio: sizes.audio.length ? sizes.audio : undefined,
    },
  }
}

/**
 * The capability a task runs against.
 *
 * A task written before speech and music split says `music` for what may be a speech channel; both
 * produce a sound file, so the speech endpoint is accepted rather than failing a paid-for job.
 */
function taskCapabilityOf(channel: MediaChannel, kind: MediaKind): MediaChannel | null {
  return channelForKind(channel, kind) ?? (kind === 'music' ? channelForKind(channel, 'tts') : null)
}

export interface TaskAdvance {
  /** The task as it now stands — already written back, unless it finished or was terminal. */
  task: MediaTask
  /** Present when this step wrote the artifact. */
  artifact?: { path: string; mimeType: string; byteLength: number }
}

/** A task for a request that has not been sent yet. Written by the caller before the first step. */
export function createMediaTask(input: {
  outPath: string
  channelId: string
  kind: MediaKind
  prompt: string
  references?: string[]
  /** Paths that belong in the note but are not inputs (a text port), kept out of the wire. */
  provenance?: string[]
  firstFrame?: string
  lastFrame?: string
  model?: string
  size?: string
  params?: Record<string, string | number>
  /** The conversation that asked, when one did — carried to the note so the file can be traced. */
  sessionId?: string
  now?: number
  timeoutMs?: number
  /**
   * The capability this task will run against. Supplied by callers that have it, so a request the
   * channel cannot serve is refused before a task file is written.
   */
  channel?: MediaChannel
}): MediaTask {
  const now = input.now ?? Date.now()
  if (input.channel) validateMediaRequest(input.channel, factsOfPaths(input))
  return {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    requestVersion: MEDIA_TASK_REQUEST_VERSION,
    status: 'queued',
    outPath: input.outPath,
    channelId: input.channelId,
    kind: input.kind,
    prompt: input.prompt,
    references: input.references ?? [],
    provenance: input.provenance ?? [],
    firstFrame: input.firstFrame,
    lastFrame: input.lastFrame,
    model: input.model,
    size: input.size,
    params: input.params,
    sessionId: input.sessionId,
    // Nothing has been sent yet, so dropping it is free.
    cancellable: true,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + (input.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS),
  }
}

export async function advanceMediaTask(
  task: MediaTask,
  options: TaskRunnerOptions = {},
): Promise<TaskAdvance> {
  const now = options.now?.() ?? Date.now()
  if (isTerminalStatus(task.status)) return { task }

  // The submit may have reached the provider and only the answer went missing. With no provider id
  // there is nothing to ask, and asking again is how a person pays twice — so this step is a no-op
  // until somebody decides to cancel it.
  if (task.status === 'submission_unknown' && !task.providerTaskId) return { task }

  const settle = (status: MediaTaskStatus, error?: string): TaskAdvance => ({
    task: writeMediaTask(
      {
        ...task,
        status,
        error,
        nextPollAt: undefined,
        // A submit whose answer was lost may be running: there is nothing to stop by id.
        ...(status === 'submission_unknown' ? { cancellable: false } : {}),
      },
      now,
    ),
  })

  if (now >= task.expiresAt) {
    return settle(
      'failed',
      `${Math.round((task.expiresAt - task.createdAt) / 60000)} 分钟没有结果：供应商那边可能还在跑，先确认再决定是否重提。`,
    )
  }

  const channels = options.channels ?? readMediaChannels().channels
  const found = channels.find((candidate) => candidate.id === task.channelId)
  if (!found) {
    return settle('failed', `渠道「${task.channelId}」不在了：恢复这条任务需要它。`)
  }
  // The task names what it makes, so it is resumed against that capability — never a sibling
  // endpoint that happens to share the account.
  const channel = taskCapabilityOf(found, task.kind)
  if (!channel) {
    return settle('failed', `渠道「${found.name}」不再提供 ${task.kind}：换一个渠道或重新开始。`)
  }

  const pollMs = channel.pollMs ?? DEFAULT_POLL_MS

  // Already submitted: the only thing left is to ask. No body, no references — a vanished local
  // file must not kill a job the provider is already working on.
  if (task.providerTaskId) {
    let poll
    try {
      poll = await pollApiTask(
        { ...taskEndpointFor(channel, { model: task.model, kind: task.kind }), fetch: options.fetch },
        task.providerTaskId,
      )
    } catch (error) {
      // Not an answer. Keep the paid-for task and ask again later; the deadline is what ends it.
      return {
        task: writeMediaTask(
          {
            ...task,
            status: 'running',
            attempts: task.attempts + 1,
            nextPollAt: now + pollMs,
            error: messageOf(error),
          },
          now,
        ),
      }
    }

    if (poll.state === 'failed') return settle('failed', poll.message)
    if (poll.state === 'done') return finish(task, poll.result, channel, now)

    return {
      task: writeMediaTask(
        {
          ...task,
          status: 'running',
          attempts: task.attempts + 1,
          nextPollAt: now + (poll.retryAfterMs ?? pollMs),
          error: undefined,
        },
        now,
      ),
    }
  }

  const submission = await (async () => {
    try {
      // Checked again here because a task may be resumed long after it was written: the channel or
      // the catalogue may have learned a rule since, and the files are still on disk to check.
      validateMediaRequest(channel, factsOfPaths(task))
      // References travel as one ordered list; the provider wants them split by kind. The prompt
      // was already rewritten against that same order, so the split must not change it. A file
      // assigned a frame role goes as that role, never also as a numbered reference.
      const roles = new Set([task.firstFrame, task.lastFrame].filter((path): path is string => !!path))
      const groups: Record<'image' | 'video' | 'audio', string[]> = { image: [], video: [], audio: [] }
      for (const reference of task.references) {
        if (!roles.has(reference)) groups[mediaKindOfFile(reference)].push(reference)
      }
      // A channel that names an upload endpoint wants an id, not inline bytes: upload once here,
      // then write the id into the body. Otherwise the configured bucket hosts the file — a
      // provider that only reads `http(s)` has nowhere else to get it. Inline bytes are the last
      // resort, for providers that accept them and for a machine with no bucket.
      const host = channel.upload
        ? null
        : await objectStorageUploader(options.fetch ? { fetch: options.fetch } : {})
      const deliver = (reference: string) =>
        channel.upload
          ? uploadReference(channel, reference, options.fetch)
          : host
            ? hostReference(host, reference)
            : Promise.resolve(dataUrlOfFile(reference))
      const prepare = (paths: string[]) => Promise.all(paths.map(deliver))
      const prepareOne = (path?: string) => (path ? deliver(path) : Promise.resolve(undefined))
      const [images, videos, audios, firstFrame, lastFrame] = await Promise.all([
        prepare(groups.image),
        prepare(groups.video),
        prepare(groups.audio),
        prepareOne(task.firstFrame),
        prepareOne(task.lastFrame),
      ])
      return prepareTaskSubmission(channel, {
        prompt: task.prompt,
        model: task.model,
        size: task.size,
        params: task.params,
        kind: task.kind,
        images,
        videos,
        audios,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
      })
    } catch (error) {
      return messageOf(error)
    }
  })()
  if (typeof submission === 'string') return settle('failed', submission)

  const submitted = await submitApiTask({
    ...submission.endpoint,
    body: submission.body,
    fetch: options.fetch,
  })

  if (submitted.state === 'done') return finish(task, submitted.result, channel, now)
  if (submitted.state === 'refused') return settle('failed', submitted.message)
  if (submitted.state === 'unknown') return settle('submission_unknown', submitted.message)

  return {
    task: writeMediaTask(
      {
        ...task,
        status: 'running',
        providerTaskId: submitted.taskId,
        // The provider has it now; only a declared cancel endpoint can stop it.
        cancellable: Boolean(channel.cancelPath),
        attempts: 0,
        nextPollAt: now + pollMs,
        error: undefined,
      },
      now,
    ),
  }
}

/**
 * Write the artifact where the task said it would go, note what made it, and close the task.
 *
 * The task file is the only fallback when the provenance note cannot be written: deleting it first
 * would leave an artifact with no record of what produced it. So the note is written and read back
 * before the task is removed; a failure keeps the task as a terminal record instead.
 */
function finish(
  task: MediaTask,
  result: ApiTaskResult,
  channel: MediaChannel,
  now: number,
): TaskAdvance {
  // A sound answer names its own container: a music or speech provider may return WAV for an `mp3`
  // request, and the extension has to follow the bytes or every reader sees a mislabelled file.
  const finalPath = isSoundKind(task.kind)
    ? fileNameForMime(task.outPath, result.mimeType)
    : task.outPath
  const renamed = finalPath !== task.outPath

  mkdirSync(dirname(finalPath), { recursive: true })
  writeFileSync(finalPath, result.bytes)
  const note = noteArtifact(task, channel, finalPath, now)
  const artifact = { path: finalPath, mimeType: result.mimeType, byteLength: result.bytes.length }

  if (note === 'failed') {
    return {
      task: writeMediaTask(
        {
          ...task,
          status: 'succeeded',
          ...(renamed ? { finalPath } : {}),
          error: 'generated, but its provenance note could not be written',
          nextPollAt: undefined,
        },
        now,
      ),
      artifact,
    }
  }

  if (renamed) {
    // Keep the task at the requested path: that is the handle `task --out` and the callers know.
    // It is terminal, so the clock ignores it, and `finalPath` says where the bytes really are.
    return {
      task: writeMediaTask(
        { ...task, status: 'succeeded', finalPath, error: undefined, nextPollAt: undefined },
        now,
      ),
      artifact,
    }
  }

  removeMediaTask(task.outPath)
  return {
    task: { ...task, status: 'succeeded', error: undefined, nextPollAt: undefined, updatedAt: now },
    artifact,
  }
}

/**
 * The same note the panel writes, from the same facts.
 *
 * A file outside every project folder gets none — there is nowhere that would read it back, and
 * that is a skip rather than a failure. A written note is read back so a half-written or
 * unparseable file is not mistaken for provenance.
 */
function noteArtifact(
  task: MediaTask,
  channel: MediaChannel,
  artifactPath: string,
  now: number,
): 'written' | 'skipped' | 'failed' {
  try {
    const projectDir = findProjectDir(artifactPath)
    if (!projectDir) return 'skipped'
    writeGenerationRecord(artifactPath, {
      file: toProjectPath(projectDir, artifactPath),
      prompt: task.prompt,
      references: [...task.references, ...(task.provenance ?? [])].map((reference) =>
        toProjectPath(projectDir, reference),
      ),
      ...(task.firstFrame ? { firstFrame: toProjectPath(projectDir, task.firstFrame) } : {}),
      ...(task.lastFrame ? { lastFrame: toProjectPath(projectDir, task.lastFrame) } : {}),
      channel: channel.name,
      model: mediaChannelModel(channel, task.model) || undefined,
      params: task.params,
      session: task.sessionId,
      at: now,
    })
    return readGenerationRecord(artifactPath) ? 'written' : 'failed'
  } catch {
    return 'failed'
  }
}

function messageOf(error: unknown): string {
  if (error instanceof MediaFailure) return error.detail
  return error instanceof Error ? error.message : String(error)
}

export interface TaskCancel {
  task: MediaTask
  /**
   * True when the provider could not be stopped and the task is still running. The artifact will
   * arrive later, unannounced — which is better than throwing away something already paid for.
   */
  detached: boolean
  /** Why the provider would not stop, when it had a cancel endpoint and refused. */
  message?: string
}

/**
 * Stop waiting — and stop the provider only if it can be stopped.
 *
 * Most providers have no cancel endpoint: the queue is the queue. For those the honest outcome is
 * **detached**: the task keeps its place in the folder, the clock keeps asking, and the file lands
 * when it lands. Nothing here ever turns a running, paid-for job into "cancelled" on a guess.
 */
export async function cancelOrDetachMediaTask(
  task: MediaTask,
  options: TaskRunnerOptions = {},
): Promise<TaskCancel> {
  if (isTerminalStatus(task.status)) return { task, detached: false }
  const now = options.now?.() ?? Date.now()

  // Nothing was submitted, so there is nothing to wait for and nothing to pay for. An unknown
  // submit is the exception: the provider may already be working, so it is detached, not erased.
  if (!task.providerTaskId) {
    if (task.status === 'submission_unknown') {
      return {
        task: writeMediaTask({ ...task, status: 'submission_unknown', detached: true }, now),
        detached: true,
        message: '提交结果未知：供应商可能已经在处理，无法确认取消。',
      }
    }
    return {
      task: writeMediaTask(
        { ...task, status: 'cancelled', error: undefined, nextPollAt: undefined },
        now,
      ),
      detached: false,
    }
  }

  const channels = options.channels ?? readMediaChannels().channels
  const found = channels.find((candidate) => candidate.id === task.channelId)
  const channel = found ? taskCapabilityOf(found, task.kind) : null

  let endpoint = null
  try {
    endpoint = channel ? taskEndpointFor(channel, { model: task.model, kind: task.kind }) : null
  } catch {
    endpoint = null
  }

  const answer = endpoint
    ? await cancelApiTask({ ...endpoint, fetch: options.fetch }, task.providerTaskId)
    : { cancelled: false, message: `渠道「${task.channelId}」不在了` }

  if (answer.cancelled) {
    return {
      task: writeMediaTask(
        { ...task, status: 'cancelled', detached: undefined, error: undefined, nextPollAt: undefined },
        now,
      ),
      detached: false,
    }
  }

  return {
    task: writeMediaTask({ ...task, status: 'running', detached: true }, now),
    detached: true,
    ...(answer.message ? { message: answer.message } : {}),
  }
}
