/**
 * Media generation over an API that answers with a **task id** and gives the result later.
 *
 * Half the providers people use answer synchronously (`data[0].b64_json`); the other half — metaso's
 * MiniMax endpoint among them — answer `{ task_id }` and expect you to ask again. Both are the same
 * call from a card's point of view, so both are handled here, and *where* to ask is configuration
 * rather than code: a channel says its submit path, its poll path, and where the answer sits in the
 * JSON.
 *
 * The submit and the poll are **two calls, not a loop**. `generateOverTaskApi` is the loop, kept for
 * callers that can afford to wait; a caller that has to survive a restart uses the two halves
 * separately and stores the task id in between (`media/task-runner.ts`).
 *
 * Two rules this file obeys because they were paid for by somebody:
 *
 * 1. **A submission is never repeated.** Once a task id exists, that id is the truth; a lost
 *    response means "unknown", and asking again about the same id costs nothing.
 * 2. **A result url is fetched immediately.** Providers hand out links that expire, and a link that
 *    expired is a picture nobody has.
 */

import { MediaFailure } from '../types.ts'
import { isSoundKind, type MediaKind } from '../channels.ts'

export type { MediaKind }

/** How to talk to one channel's task API. Every field has a default that fits OpenAI-style relays. */
export interface ApiTaskShape {
  kind: MediaKind
  /** Appended to the channel's base URL for the submit call. */
  submitPath: string
  /** Appended for the poll call; `{taskId}` is substituted. */
  pollPath: string
  /** Appended to cancel a task; absent when the provider offers no cancellation. */
  cancelPath?: string
  /** Field in the submit response that carries the task id (`task_id` by default). */
  taskIdPath?: string
  /** Dotted path to the status inside the poll response. */
  statusPath?: string
  /** Status values that mean done / failed. Compared case-insensitively. */
  doneStatuses?: string[]
  failedStatuses?: string[]
  /** Which header carries the key; Bearer by default, `x-goog-api-key` for Gemini. */
  auth?: { header: string; prefix?: string }
  /** Everything else the submit needs. DashScope queues a job only when it is told to. */
  submitHeaders?: Record<string, string>
  /** Dotted path to the media url (or an array of them) inside the poll response. */
  resultPath?: string
  /** How often to ask. */
  pollMs?: number
  /** Give up after this long — a stuck queue is not an answer. */
  timeoutMs?: number
}

/** Where the task lives: URLs, credentials, and the wire shape. No body — that is the submission. */
export interface ApiTaskEndpoint extends ApiTaskShape {
  baseUrl: string
  apiKey: string
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface ApiTaskRequest extends ApiTaskEndpoint {
  /** Body sent to the submit endpoint, already in the provider's own shape. */
  body: Record<string, unknown>
  /** Called as soon as a task id exists, so a caller can record it before waiting. */
  onTaskId?: (taskId: string) => void
}

export interface ApiTaskResult {
  bytes: Uint8Array
  mimeType: string
  filename: string
  taskId?: string
  via: 'task-url' | 'task-b64'
}

/** What one poll learned. `running` means "ask again"; nothing here sleeps on its own. */
export type ApiTaskPoll =
  | { state: 'running'; retryAfterMs?: number }
  | { state: 'done'; result: ApiTaskResult }
  | { state: 'failed'; message: string }

/**
 * What one submit learned.
 *
 * `refused` and `unknown` are deliberately different: a refusal is an answer (nothing was queued,
 * so nothing was billed), while an unknown is a lost answer — the job may well be running, and
 * submitting again would pay for it twice.
 */
export type ApiTaskSubmit =
  | { state: 'task'; taskId: string }
  | { state: 'done'; result: ApiTaskResult }
  | { state: 'refused'; message: string }
  | { state: 'unknown'; message: string }

/**
 * A provider's refusal, in one sentence a person can act on.
 *
 * The status alone is not a cause: 401 means the key, 402 means the account, 429 means wait, and
 * 400 could be anything from a prompt filter to a size nobody supports. Every vendor wraps its
 * message somewhere slightly different, so all three shapes are read before giving up.
 */
function describeApiFailure(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error as Record<string, unknown> | string | undefined
    if (typeof error === 'string') detail = error
    else if (error && typeof error.message === 'string') detail = error.message
    else if (typeof parsed.message === 'string') detail = parsed.message
    else if (typeof parsed.detail === 'string') detail = parsed.detail
  } catch {
    detail = body.trim().slice(0, 200)
  }
  const head =
    status === 401 || status === 403
      ? '密钥被拒绝'
      : status === 402
        ? '账户余额或额度不足'
        : status === 429
          ? '被限流了，稍后再试'
          : status === 404
            ? '这个地址没有生成端点'
            : status >= 500
              ? '供应商服务出错'
              : `请求被拒绝（HTTP ${status}）`
  return detail ? `${head}：${detail}` : head
}

const DEFAULT_DONE = ['succeeded', 'success', 'completed', 'done', 'finished']
const DEFAULT_FAILED = ['failed', 'error', 'cancelled', 'canceled']

export function readPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)]
    if (typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, source)
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaFailure('generate', '已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new MediaFailure('generate', '已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mpeg')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('flac')) return 'flac'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('jpeg')) return 'jpg'
  return 'png'
}

function authHeadersOf(endpoint: ApiTaskEndpoint): Record<string, string> {
  const header = endpoint.auth?.header ?? 'Authorization'
  const prefix = endpoint.auth?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '')
  return { [header]: prefix + endpoint.apiKey }
}

/**
 * Submit once.
 *
 * Two possible answers, and they are not interchangeable: a task id to watch, or the bytes a relay
 * chose to return immediately. Everything about "what happens next" follows from which came back.
 */
export async function submitApiTask(request: ApiTaskRequest): Promise<ApiTaskSubmit> {
  const fetchImpl = request.fetch ?? fetch
  const base = request.baseUrl.replace(/\/+$/, '')

  const submit = await (async () => {
    try {
      return await fetchImpl(`${base}${request.submitPath}`, {
        method: 'POST',
        headers: {
          ...authHeadersOf(request),
          'Content-Type': 'application/json',
          ...(request.submitHeaders ?? {}),
        },
        body: JSON.stringify(request.body),
        signal: request.signal,
      })
    } catch (error) {
      // The request may have reached the provider before the connection broke. Saying so is the
      // whole point of this branch: the caller must not resubmit on a guess.
      return {
        state: 'unknown' as const,
        message: `提交结果未知（${error instanceof Error ? error.message : String(error)}）：任务可能已经建好了，先确认再重试`,
      }
    }
  })()
  if ('state' in submit) return submit

  if (!submit.ok) {
    const body = await submit.text().catch(() => '')
    return { state: 'refused', message: describeApiFailure(submit.status, body) }
  }

  const submitted = (await submit.json().catch(() => null)) as Record<string, unknown> | null
  const taskIdRaw = readPath(submitted, request.taskIdPath ?? 'task_id')
  const taskId = typeof taskIdRaw === 'string' ? taskIdRaw : undefined
  if (!taskId) {
    // Some relays answer synchronously even from the submit call — take that path when it is there.
    const url = readPath(submitted, request.resultPath ?? 'data.0.url')
    if (typeof url === 'string' && url) {
      return { state: 'done', result: { ...(await download(fetchImpl, url, request.signal)), via: 'task-url' } }
    }
    return { state: 'refused', message: '提交后既没有 task_id，也没有媒体地址' }
  }

  request.onTaskId?.(taskId)
  return { state: 'task', taskId }
}

/**
 * Ask once.
 *
 * A task the provider says failed is over and says why; a task still working says "again later".
 * A transport error or a 500 is **not** an answer — it throws, so the caller keeps the task alive
 * and asks again rather than telling the person their video failed.
 */
export async function pollApiTask(endpoint: ApiTaskEndpoint, taskId: string): Promise<ApiTaskPoll> {
  const fetchImpl = endpoint.fetch ?? fetch
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  const pollUrl = `${base}${endpoint.pollPath.replace('{taskId}', encodeURIComponent(taskId))}`
  const done = (endpoint.doneStatuses ?? DEFAULT_DONE).map((value) => value.toLowerCase())
  const failed = (endpoint.failedStatuses ?? DEFAULT_FAILED).map((value) => value.toLowerCase())

  let response: Response
  try {
    response = await fetchImpl(pollUrl, { headers: authHeadersOf(endpoint), signal: endpoint.signal })
  } catch (error) {
    if (endpoint.signal?.aborted) throw new MediaFailure('generate', '已取消')
    throw new MediaFailure('generate', `查询任务时连不上（${error instanceof Error ? error.message : String(error)}）`)
  }

  // Being told to wait is not a failure: a queue that is busy, or a result the provider is still
  // delivering, means ask again later — with the provider's own delay when it says one.
  if (response.status === 429 || response.status === 503) {
    const seconds = Number(response.headers.get('retry-after'))
    return { state: 'running', retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined }
  }
  if (!response.ok) throw new MediaFailure('generate', `查询任务 HTTP ${response.status}`)

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const statusRaw = readPath(payload, endpoint.statusPath ?? 'task.status')
  const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : ''

  if (failed.includes(status)) {
    const reason = readPath(payload, 'task.message') ?? readPath(payload, 'message') ?? ''
    return { state: 'failed', message: String(reason || 'provider reported failure') }
  }

  if (done.includes(status)) {
    const result = readPath(payload, endpoint.resultPath ?? 'task.content.url')
    const url = typeof result === 'string' ? result : Array.isArray(result) ? String(result[0] ?? '') : ''
    if (!url) return { state: 'failed', message: '生成完成但没有返回媒体地址' }
    return {
      state: 'done',
      result: {
        ...(await download(fetchImpl, url, endpoint.signal, endpoint.kind)),
        taskId,
        via: 'task-url',
      },
    }
  }

  return { state: 'running' }
}

/**
 * Ask the provider to stop a task.
 *
 * A refusal is not a failure of this function: it means the job is still running, and the caller
 * decides what to do about it (keep watching, or stop watching and let it land). Providers without
 * a cancel endpoint answer `cancelled: false` without a round trip.
 */
export async function cancelApiTask(
  endpoint: ApiTaskEndpoint,
  taskId: string,
): Promise<{ cancelled: boolean; message?: string }> {
  if (!endpoint.cancelPath) {
    return { cancelled: false, message: '这个渠道没有取消端点' }
  }
  const fetchImpl = endpoint.fetch ?? fetch
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  const url = `${base}${endpoint.cancelPath.replace('{taskId}', encodeURIComponent(taskId))}`
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: authHeadersOf(endpoint),
      signal: endpoint.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { cancelled: false, message: describeApiFailure(response.status, body) }
    }
    return { cancelled: true }
  } catch (error) {
    return { cancelled: false, message: `取消请求没送到（${error instanceof Error ? error.message : String(error)}）` }
  }
}

/**
 * Submit, then ask until the answer is final. The loop, for a caller that can afford to wait.
 *
 * `onTaskId` fires the moment the id exists, so a caller that wants to persist it can — and a
 * restart in the middle of this call loses only the waiting, not the paid-for task.
 */
export async function generateOverTaskApi(request: ApiTaskRequest): Promise<ApiTaskResult> {
  const pollMs = request.pollMs ?? 5000
  const timeoutMs = request.timeoutMs ?? 10 * 60 * 1000
  const deadline = Date.now() + timeoutMs

  const submitted = await submitApiTask(request)
  if (submitted.state === 'done') return submitted.result
  if (submitted.state !== 'task') throw new MediaFailure('generate', submitted.message)
  const taskId = submitted.taskId

  while (Date.now() < deadline) {
    await sleep(pollMs, request.signal)
    const poll = await pollApiTask(request, taskId)
    if (poll.state === 'failed') throw new MediaFailure('generate', poll.message)
    if (poll.state === 'done') return poll.result
  }

  throw new MediaFailure(
    'generate',
    `${Math.round(timeoutMs / 60000)} 分钟没有结果（任务 ${taskId} 可能还在跑，重新查询它而不是重新提交）`,
  )
}

async function download(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
  kind: MediaKind = 'image',
): Promise<Omit<ApiTaskResult, 'via'>> {
  const response = await fetchImpl(url, { signal }).catch((error: unknown) => {
    throw new MediaFailure('download', `下载失败：${error instanceof Error ? error.message : String(error)}`)
  })
  if (!response.ok) throw new MediaFailure('download', `下载失败：HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const mimeType =
    response.headers.get('content-type')?.split(';')[0]?.trim() ||
    (isSoundKind(kind) ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'image/png')
  return {
    bytes,
    mimeType,
    filename: `media-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
  }
}
