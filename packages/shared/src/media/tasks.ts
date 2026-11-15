/**
 * A generation that outlives the call that started it.
 *
 * A picture comes back in seconds, but a clip can take minutes — longer than a panel stays open and
 * longer than a process usually lives. So the job is a **file**, written where the artifact will be:
 *
 * ```
 * canvas/assets/clip.mp4.task.json   ← while it runs
 * canvas/assets/clip.mp4             ← when it lands
 * canvas/assets/clip.gen.json        ← what it was made from
 * ```
 *
 * Beside the artifact, not in a queue directory, for the same reason the note is: the folder stays
 * the whole truth, and a project copied somewhere else carries its unfinished work with it.
 *
 * Two facts are deliberately **not** in this file: the API key (a task is a job, not a credential)
 * and the request body (rebuilt from the channel when the task is resumed, so a provider edit is
 * picked up rather than replayed from a stale copy).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFileSync } from '../utils/files.ts'
import type { MediaKind } from './channels.ts'

/** The note's suffix. A task is `<artifact>.task.json`; `readMediaTask` takes the artifact path. */
export const MEDIA_TASK_SUFFIX = '.task.json'

/**
 * `queued` — written, not yet submitted.
 * `running` — the provider has it (or is about to) and we are asking again later.
 * `succeeded` — the artifact is on disk; the task file is gone.
 * `failed` — the provider said no, or it ran out of time. Terminal.
 * `cancelled` — somebody stopped it.
 * `submission_unknown` — the submit reached the provider but its answer did not reach us. Ask the
 *                       provider; never submit again. Resumable, so not terminal.
 */
export type MediaTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'submission_unknown'

export interface MediaTask {
  /** Stable id for events. The file is named after the artifact, not after this. */
  id: string
  /**
   * The request shape this task was written with. Tasks are rebuilt from stored facts on resume, so
   * a shape change needs to know which facts an older file actually holds.
   */
  requestVersion: number
  status: MediaTaskStatus
  /** Absolute path the artifact was asked to be written to — the task file's own address. */
  outPath: string
  /**
   * Where the bytes actually landed, when that differs from `outPath`.
   *
   * A sound answer can come back in a different container than the one named (`mp3` asked for,
   * `wav` returned), and the artifact is renamed to match its bytes. The task stays at the
   * requested path so `task --out` still finds it; this is what it points at.
   */
  finalPath?: string
  channelId: string
  kind: MediaKind
  prompt: string
  /** Absolute paths of the files sent as references. Rebuilt into bytes on every attempt. */
  references: string[]
  /**
   * Absolute paths that belong in the note but are not inputs — a lyrics or context text node.
   * Kept apart from `references` so a task never uploads a `.md` as a media reference.
   */
  provenance?: string[]
  /** Absolute paths of the pictures sent as roles, not as numbered references. */
  firstFrame?: string
  lastFrame?: string
  model?: string
  size?: string
  params?: Record<string, string | number>
  /** The conversation that asked, when one did. A panel generation has none. */
  sessionId?: string
  /** The provider's own id. Its presence is what makes a task resumable — never resubmit past it. */
  providerTaskId?: string
  /**
   * Whether stopping this job is real. Before it is submitted, dropping it costs nothing; after
   * that, only a provider that declared a cancel endpoint can be stopped.
   */
  cancellable?: boolean
  /** How many times the provider has been asked. A fact for the person, not a retry budget. */
  attempts: number
  /**
   * Nobody is watching any more, but the provider still is — a channel with no cancel endpoint
   * cannot be stopped, so the file lands later and unannounced. Kept as a fact so a reader can tell
   * "running for a panel" from "running in the background".
   */
  detached?: boolean
  createdAt: number
  updatedAt: number
  /** Ask again at (or after) this time, epoch ms. */
  nextPollAt?: number
  /** Whether or not the provider ever answers, the task ends here. */
  expiresAt: number
  /** A sentence for a person, when the task is not running. */
  error?: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const TERMINAL: ReadonlySet<MediaTaskStatus> = new Set(['succeeded', 'failed', 'cancelled'])

export function isTerminalStatus(status: MediaTaskStatus): boolean {
  return TERMINAL.has(status)
}

/** Where a running task is kept: beside the file it will become. */
export function taskPathFor(outPath: string): string {
  return `${outPath}${MEDIA_TASK_SUFFIX}`
}

export function readMediaTask(outPath: string): MediaTask | null {
  const path = taskPathFor(outPath)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MediaTask>
    return normalizeTask(parsed) ?? null
  } catch {
    return null
  }
}

/** Write the task back, with `updatedAt` moved to now. Returns what was written. */
export function writeMediaTask(task: MediaTask, now = Date.now()): MediaTask {
  const next: MediaTask = { ...task, updatedAt: now }
  const path = taskPathFor(next.outPath)
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

/** Drop the task file — the artifact is its replacement. */
export function removeMediaTask(outPath: string): void {
  rmSync(taskPathFor(outPath), { force: true })
}

/**
 * Every task under a folder, oldest first.
 *
 * The scan is the index: a project holds its own unfinished work, so "what is still running" is a
 * question about a folder rather than a lookup in a table that can fall behind.
 */
export function listMediaTasks(rootDir: string): MediaTask[] {
  const tasks: MediaTask[] = []

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith(MEDIA_TASK_SUFFIX)) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as Partial<MediaTask>
        const task = normalizeTask(parsed)
        if (task) tasks.push(task)
      } catch {
        // A task file we cannot read says nothing about the job it described.
      }
    }
  }

  walk(rootDir)
  return tasks.sort((a, b) => a.createdAt - b.createdAt)
}

/** What a watcher is told when a task moves. No bytes: the artifact is at `path` on this machine. */
export interface MediaTaskEvent {
  task: MediaTask
  artifact?: { path: string; mimeType: string; byteLength: number }
}

/**
 * The answer to "what happened to the file I was waiting for?".
 *
 * Three states, and the third is why this exists: no task and no artifact means the job was lost
 * (or never started), while no task and an artifact means it landed while nobody was looking. The
 * task file is deleted on success, so the presence of the artifact is the other half of the answer.
 */
export interface MediaTaskLookup {
  task: MediaTask | null
  artifact: boolean
}

/** The current task-file shape. Bumped when a stored fact is renamed or given a new meaning. */
export const MEDIA_TASK_REQUEST_VERSION = 1

/** Legacy statuses, read back as the state they meant before the split. */
const STATUS_ALIASES: Record<string, MediaTaskStatus> = {
  interrupted: 'submission_unknown',
}

const TASK_STATUSES: ReadonlySet<MediaTaskStatus> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'submission_unknown',
])

/** One shape for every read, so a hand-edited or half-written file cannot become a broken task. */
function normalizeTask(parsed: Partial<MediaTask>): MediaTask | null {
  if (typeof parsed.outPath !== 'string' || !parsed.outPath) return null
  if (typeof parsed.channelId !== 'string' || !parsed.channelId) return null
  const rawStatus = typeof parsed.status === 'string' ? parsed.status : ''
  const status = STATUS_ALIASES[rawStatus] ?? (rawStatus as MediaTaskStatus)
  if (!TASK_STATUSES.has(status)) return null
  const createdAt = typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now()
  // Read as a plain string: a file on disk may hold a kind this version no longer names.
  const savedKind = String((parsed as { kind?: unknown }).kind ?? '')
  return {
    id: typeof parsed.id === 'string' && parsed.id ? parsed.id : createdAt.toString(36),
    requestVersion:
      typeof parsed.requestVersion === 'number' ? parsed.requestVersion : MEDIA_TASK_REQUEST_VERSION,
    status,
    outPath: parsed.outPath,
    finalPath: typeof parsed.finalPath === 'string' ? parsed.finalPath : undefined,
    channelId: parsed.channelId,
    // A task saved while speech and music shared `audio` is read as a sound file. `advanceMediaTask`
    // also accepts a speech channel for it, so an old task still lands.
    kind:
      savedKind === 'video'
        ? 'video'
        : savedKind === 'tts'
          ? 'tts'
          : savedKind === 'music' || savedKind === 'audio'
            ? 'music'
            : 'image',
    prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
    references: Array.isArray(parsed.references)
      ? parsed.references.filter((item): item is string => typeof item === 'string')
      : [],
    provenance: Array.isArray(parsed.provenance)
      ? parsed.provenance.filter((item): item is string => typeof item === 'string')
      : undefined,
    firstFrame: typeof parsed.firstFrame === 'string' ? parsed.firstFrame : undefined,
    lastFrame: typeof parsed.lastFrame === 'string' ? parsed.lastFrame : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    size: typeof parsed.size === 'string' ? parsed.size : undefined,
    params: parsed.params && typeof parsed.params === 'object' ? parsed.params : undefined,
    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
    providerTaskId: typeof parsed.providerTaskId === 'string' ? parsed.providerTaskId : undefined,
    // An older file did not record this: not yet submitted means it can still be dropped; once
    // submitted, assume the provider cannot be stopped unless the file said otherwise.
    cancellable:
      typeof parsed.cancellable === 'boolean'
        ? parsed.cancellable
        : status === 'submission_unknown'
          ? false
          : !parsed.providerTaskId,
    attempts: typeof parsed.attempts === 'number' ? parsed.attempts : 0,
    detached: parsed.detached === true ? true : undefined,
    createdAt,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : createdAt,
    nextPollAt: typeof parsed.nextPollAt === 'number' ? parsed.nextPollAt : undefined,
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : createdAt + 30 * 60 * 1000,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
  }
}
