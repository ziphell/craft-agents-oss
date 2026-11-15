/**
 * Speech recognition over HTTP — two wires, one answer shape.
 *
 * - **Doubao** takes the recording base64 in the request, one call, no task to poll.
 * - **OpenAI-compatible** servers (CrispASR, vLLM, relays…) take the same bytes as
 *   `multipart/form-data`, and usually need no key when they run on this machine.
 *
 * Both hand the bytes up with the request, so no recording has to be hosted at a public address
 * first and there is no submit/query pair to keep in step.
 */

import { MediaFailure } from '../types.ts'

export interface AsrUtterance {
  startMs: number
  endMs: number
  text: string
}

export interface AsrResult {
  text: string
  utterances: AsrUtterance[]
  /** The recording's length in milliseconds, when the provider measured it. */
  durationMs?: number
  /** Which call chain answered — worth saying out loud in a log. */
  via: string
  /** The provider found no speech; an empty transcript is the honest answer, not a failure. */
  silent: boolean
}

/** A recording handed to the provider that wants the bytes in the request. */
export interface AsrBytesRequest {
  baseUrl: string
  apiKey: string
  bytes: Uint8Array
  /** The vendor's resource id; the provider's default applies when absent. */
  model?: string
  /** Which header carries the key. `X-Api-Key` by default; a wire may say otherwise. */
  auth?: { header: string; prefix?: string }
  /** A language hint (`zh`, `en`, `yue`…); empty lets the provider detect it. */
  language?: string
  submitPath?: string
  timeoutMs?: number
  fetch?: typeof fetch
  signal?: AbortSignal
}

/** A recording handed to a provider that wants it as a multipart file part. */
export interface AsrUploadRequest {
  baseUrl: string
  apiKey: string
  submitPath?: string
  model?: string
  auth?: { header: string; prefix?: string }
  /** A language hint (`zh`, `en`, `yue`…); empty lets the provider detect it. */
  language?: string
  fileName: string
  bytes: Uint8Array
  mimeType: string
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

/** The auth header a wire asked for, with the Bearer prefix a key expects. */
function authOf(request: { apiKey: string; auth?: { header: string; prefix?: string } }): Record<string, string> {
  const header = request.auth?.header ?? 'Authorization'
  const prefix = request.auth?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '')
  return { [header]: `${prefix}${request.apiKey}` }
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const numberAt = (row: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Segments as milliseconds.
 *
 * The OpenAI shape documents start/end without a unit; its `duration` is seconds. A span that fits
 * inside the recording twice over is seconds, anything larger is already milliseconds — that keeps
 * both readings working without a per-server flag.
 */
const spanMs = (start: number, end: number, durationSeconds?: number): [number, number] => {
  const asSeconds = durationSeconds === undefined || end <= durationSeconds * 2
  return asSeconds
    ? [Math.round(start * 1000), Math.round(end * 1000)]
    : [Math.round(start), Math.round(end)]
}

/**
 * One JSON POST, bounded in time.
 *
 * The response is handed back even when it is not 2xx: the real status lives in a header, so only
 * the caller can read a refusal correctly.
 */
async function postJson(request: {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs?: number
  fetch?: typeof fetch
  signal?: AbortSignal
}): Promise<Response> {
  const fetchImpl = request.fetch ?? fetch
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = request.signal ?? controller.signal

  try {
    return await fetchImpl(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...request.headers },
      body: request.body,
      signal,
    })
  } catch (error) {
    throw new MediaFailure(
      'transcribe',
      controller.signal.aborted
        ? `${Math.round(timeoutMs / 1000)} 秒内没有结果。`
        : `连不上识别服务：${error instanceof Error ? error.message : String(error)}`,
      { code: 'network', retryable: true },
    )
  } finally {
    clearTimeout(timer)
  }
}

const DEFAULT_DOUBAO_PATH = '/api/v3/auc/bigmodel/recognize/flash'
const DEFAULT_DOUBAO_MODEL = 'volc.bigasr.auc_turbo'

const STATUS = {
  ok: '20000000',
  silent: '20000003',
} as const

/** A provider status code as a sentence; the layer is `transcribe`, the money is already spent. */
function providerFailure(code: string, message: string | null, requestId: string): MediaFailure {
  const detail =
    message?.trim() ||
    (code.startsWith('550') ? '服务内部错误' : '供应商拒绝了这次识别请求')
  return new MediaFailure('transcribe', `${detail}（${code}，任务 ${requestId}）`, {
    code: 'provider_rejected',
    // A busy service is worth another attempt; a bad upload is not.
    retryable: code.startsWith('550'),
  })
}

/**
 * The language key this API takes, or none.
 *
 * Mainland and Taiwan Chinese are named apart; every other code (`en`, `ja`, `ko`, `yue`…) is sent
 * as it is, and `auto` is the absence of the field rather than a value.
 */
function doubaoLanguage(language: string | undefined): string | undefined {
  const wanted = language?.trim()
  if (!wanted || wanted === 'auto') return undefined
  if (wanted === 'zh' || wanted === 'zh_s') return 'zh-CN'
  if (wanted === 'zh_t') return 'zh-TW'
  return wanted
}

/**
 * Doubao's flash recognition: the recording is base64 in the request, the words come back at once.
 *
 * The interesting fact is in a header (`X-Api-Status-Code`), not the body: a 200 can still mean
 * "nothing was recognised". The model is this API's resource id, and `auc_turbo` is the entitlement
 * that allows the flash endpoint — the standard resource id is refused here.
 */
export async function transcribeDoubaoOverApi(request: AsrBytesRequest): Promise<AsrResult> {
  const baseUrl = request.baseUrl.replace(/\/+$/, '')
  const requestId = crypto.randomUUID()
  const language = doubaoLanguage(request.language)
  const response = await postJson({
    url: `${baseUrl}${request.submitPath ?? DEFAULT_DOUBAO_PATH}`,
    headers: {
      [request.auth?.header ?? 'X-Api-Key']: `${request.auth?.prefix ?? ''}${request.apiKey}`,
      'X-Api-Resource-Id': request.model?.trim() || DEFAULT_DOUBAO_MODEL,
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({
      user: { uid: 'craft-agent' },
      // The container is not named: this endpoint reads it from the bytes.
      audio: { data: base64Of(request.bytes) },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
        ...(language ? { language } : {}),
      },
    }),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.fetch ? { fetch: request.fetch } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  })

  const status = response.headers.get('x-api-status-code')?.trim() ?? ''
  if (status === STATUS.silent) {
    return { text: '', utterances: [], via: 'doubao-asr', silent: true }
  }
  if (status !== STATUS.ok) {
    const message = response.headers.get('x-api-message')?.trim() ?? null
    throw providerFailure(status || String(response.status), message, requestId)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    result?: { text?: unknown; utterances?: unknown }
    audio_info?: { duration?: unknown }
  }
  const utterances: AsrUtterance[] = []
  const rows = Array.isArray(payload.result?.utterances) ? payload.result.utterances : []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const line = textOf(row.text)
    if (!line) continue
    const start = numberAt(row, 'start_time') ?? 0
    utterances.push({ startMs: start, endMs: numberAt(row, 'end_time') ?? start, text: line })
  }
  const text = textOf(payload.result?.text) || utterances.map((line) => line.text).join('')
  return {
    text,
    utterances,
    ...(typeof payload.audio_info?.duration === 'number'
      ? { durationMs: payload.audio_info.duration }
      : {}),
    via: 'doubao-asr',
    silent: text.length === 0,
  }
}

const DEFAULT_OPENAI_PATH = '/v1/audio/transcriptions'
const DEFAULT_OPENAI_MODEL = 'whisper-1'

/**
 * The address to POST to.
 *
 * The wire's path already carries `/v1/audio/transcriptions`, while OpenAI's docs and SDKs describe
 * the base as `https://api.openai.com/v1`. Joining those two literally would ask for `/v1/v1/...`,
 * so a base that already ends in the path's own `/v1` hands that segment over instead of repeating
 * it.
 */
function endpointOf(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return path.startsWith('/v1/') && /\/v1$/.test(base) ? `${base}${path.slice(3)}` : `${base}${path}`
}

/**
 * An OpenAI-compatible transcription server: one multipart request, `verbose_json` for the cues.
 *
 * The key is optional: a server on this machine usually has none, and sending an empty `Bearer `
 * would be a refusal invented here rather than by the server. `model` is sent when the wire names
 * one; CrispASR ignores it, while vLLM-style servers require their own name.
 */
export async function transcribeOpenAiOverApi(request: AsrUploadRequest): Promise<AsrResult> {
  const fetchImpl = request.fetch ?? fetch
  const url = endpointOf(request.baseUrl, request.submitPath ?? DEFAULT_OPENAI_PATH)
  const form = new FormData()
  const model = request.model?.trim() || DEFAULT_OPENAI_MODEL
  form.append('model', model)
  // A fresh copy gives the Blob an ArrayBuffer of its own; the caller's view may be a slice.
  form.append(
    'file',
    new Blob([new Uint8Array(request.bytes)], { type: request.mimeType }),
    request.fileName,
  )
  form.append('response_format', 'verbose_json')
  if (request.language && request.language !== 'auto') form.append('language', request.language)

  const timeoutMs = request.timeoutMs ?? 10 * 60 * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = request.signal ?? controller.signal

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: request.apiKey ? authOf(request) : {},
      body: form,
      signal,
    })
  } catch (error) {
    throw new MediaFailure(
      'transcribe',
      controller.signal.aborted
        ? `${Math.round(timeoutMs / 1000)} 秒内没有结果。`
        : `连不上识别服务：${error instanceof Error ? error.message : String(error)}`,
      { code: 'network', retryable: true },
    )
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    let message = detail.slice(0, 200)
    try {
      const parsed = JSON.parse(detail) as { error?: { message?: unknown } }
      if (typeof parsed.error?.message === 'string') message = parsed.error.message
    } catch {
      // Not every server answers with JSON; the text it did send is still the useful part.
    }
    throw new MediaFailure(
      'transcribe',
      `识别服务拒绝：HTTP ${response.status}${message ? ` — ${message}` : ''}`,
      { code: 'provider_rejected', retryable: response.status >= 500 },
    )
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const durationSeconds = typeof payload.duration === 'number' ? payload.duration : undefined
  const segments = Array.isArray(payload.segments) ? payload.segments : []
  const utterances: AsrUtterance[] = []
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue
    const row = segment as Record<string, unknown>
    const text = textOf(row.text)
    if (!text) continue
    const [startMs, endMs] = spanMs(
      numberAt(row, 'start') ?? 0,
      numberAt(row, 'end') ?? 0,
      durationSeconds,
    )
    utterances.push({ startMs, endMs, text })
  }

  const text = textOf(payload.text) || utterances.map((line) => line.text).join('')
  return {
    text,
    utterances,
    ...(durationSeconds !== undefined ? { durationMs: Math.round(durationSeconds * 1000) } : {}),
    via: 'openai-asr',
    silent: text.length === 0,
  }
}
