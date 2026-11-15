/**
 * Uploading a local file so a provider can refer to it by id.
 *
 * Some providers will not take bytes inline — a long video, a large reference, or a body limit —
 * and instead ask for a file that was uploaded first. The wire is the same everywhere: a multipart
 * POST with a `purpose` and the file, answering with an id. What differs is the path and what the
 * id is called in a generation request (`mm_file://…` for MiniMax), which the channel supplies.
 */

import { MediaFailure } from '../types.ts'

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
}

/** The type of a reference, by the name the caller gave it. */
export function mimeOfFile(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'
}

export interface FileUploadRequest {
  baseUrl: string
  apiKey: string
  /** Appended to the base, e.g. `/v1/files/upload`. */
  path?: string
  purpose: string
  bytes: Uint8Array
  mimeType: string
  filename: string
  auth?: { header: string; prefix?: string }
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface FileUploadResult {
  fileId: string
  byteLength?: number
}

function authHeaders(request: FileUploadRequest): Record<string, string> {
  const header = request.auth?.header ?? 'Authorization'
  const prefix = request.auth?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '')
  return { [header]: prefix + request.apiKey }
}

async function describeFailure(response: Response): Promise<string> {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const error = parsed.error as Record<string, unknown> | string | undefined
      if (typeof error === 'string') detail = error
      else if (error && typeof error.message === 'string') detail = error.message
      else if (typeof parsed.message === 'string') detail = parsed.message
      else if (typeof parsed.base_resp === 'object' && parsed.base_resp) {
        const message = (parsed.base_resp as Record<string, unknown>).status_msg
        if (typeof message === 'string') detail = message
      } else detail = text
    } catch {
      detail = text
    }
  } catch {
    // No readable body: the status is the only fact.
  }
  const trimmed = detail.trim().slice(0, 300)
  const head =
    response.status === 401 || response.status === 403
      ? '密钥被拒绝'
      : response.status === 429
        ? '被限流了，稍后再试'
        : response.status === 404
          ? '这个地址没有上传端点'
          : `上传失败（HTTP ${response.status}）`
  return trimmed ? `${head}：${trimmed}` : head
}

export async function uploadFileOverApi(request: FileUploadRequest): Promise<FileUploadResult> {
  const fetchImpl = request.fetch ?? fetch
  const base = request.baseUrl.replace(/\/+$/, '')
  const path = request.path || '/v1/files/upload'
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
  const timeoutMs = request.timeoutMs ?? 5 * 60 * 1000

  const form = new FormData()
  form.append('purpose', request.purpose)
  form.append(
    'file',
    new Blob([new Uint8Array(request.bytes)], {
      type: request.mimeType || mimeOfFile(request.filename),
    }),
    request.filename,
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: authHeaders(request),
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      throw new MediaFailure(
        'upload',
        controller.signal.aborted
          ? `上传失败：${Math.round(timeoutMs / 1000)} 秒内没有完成（${url}）`
          : `上传失败：连不上 ${url}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }

    if (!response.ok) throw new MediaFailure('upload', await describeFailure(response))

    const payload = (await response.json().catch(() => null)) as
      | {
          file?: { file_id?: string; bytes?: number }
          base_resp?: { status_code?: number; status_msg?: string }
        }
      | null
    if (
      payload?.base_resp &&
      typeof payload.base_resp.status_code === 'number' &&
      payload.base_resp.status_code !== 0
    ) {
      throw new MediaFailure(
        'upload',
        `上传失败：${payload.base_resp.status_msg ?? `状态码 ${payload.base_resp.status_code}`}`,
      )
    }
    const fileId = payload?.file?.file_id
    if (typeof fileId !== 'string' || !fileId) {
      throw new MediaFailure('upload', '上传失败：接口返回里没有 file_id')
    }
    return {
      fileId,
      ...(typeof payload?.file?.bytes === 'number' ? { byteLength: payload.file.bytes } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}
