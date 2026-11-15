/**
 * Image generation over an HTTP API.
 *
 * The shape most providers actually implement is `POST {baseUrl}/images/generations` with a bearer
 * key, and an answer that carries either base64 or a URL that expires. That is the protocol this
 * file speaks — a relay, a vendor's own gateway and a self-hosted shim all look the same here.
 *
 * It is deliberately **not** a workflow graph. A workflow is one machine's private recipe; an API is
 * a contract. A card that wants a picture should be able to say "draw this, with this model" and let
 * whichever provider is configured do the drawing.
 *
 * Failures keep the four layers apart (`MediaFailure`), because they are fixed differently: a bad key
 * is not retried, a 429 is, and a download that times out is neither.
 */

import { MediaFailure } from '../types.ts'

export interface ApiImageRequest {
  /** e.g. `https://api.example.com/v1` — the base every provider documents. */
  baseUrl: string
  /** Appended to the base; omitted means the OpenAI `/images/generations`. */
  submitPath?: string
  /** The same capability when references are attached (MiniMax H3 image editing). */
  editPath?: string
  /** How the request body is shaped. Defaults to the OpenAI image shape. */
  bodyShape?: 'prompt' | 'minimax-image' | 'minimax-h3-image' | 'gemini'
  auth?: { header: string; prefix?: string }
  apiKey: string
  model: string
  prompt: string
  /** `1024x1024`. Providers ignore what they do not support rather than fail loudly. */
  size?: string
  /** Reference images, already as data URLs or public URLs. */
  images?: string[]
  /** Provider fields beyond the common four (ratio, duration…). They never displace the prompt. */
  params?: Record<string, string | number>
  /** Injected so a test can drive this without a network. */
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export interface ApiImageResult {
  bytes: Uint8Array
  mimeType: string
  filename: string
  /** The provider's own id for the run, when it gives one. */
  providerTaskId?: string
  /** Where the bytes came from, for the log: `b64_json` or a temporary URL. */
  via: 'b64_json' | 'url'
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('jpeg')) return 'jpg'
  return 'png'
}

/** `/v1` or `/v1/` both mean the same thing; `/v1/images/generations` is what we append. */
function endpointOf(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/images\/generations$/.test(trimmed)) return trimmed
  return `${trimmed}/images/generations`
}

/** One reference in the parts Gemini expects: inline bytes, or a file reference for a URL. */
function geminiPart(reference: string): Record<string, unknown> {
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(reference)
  if (dataUrl) {
    return { inline_data: { mime_type: dataUrl[1], data: dataUrl[2] } }
  }
  const extension = reference.split('?')[0]!.split('.').pop()?.toLowerCase() ?? ''
  const mimeType =
    extension === 'png'
      ? 'image/png'
      : extension === 'webp'
        ? 'image/webp'
        : extension === 'gif'
          ? 'image/gif'
          : 'image/jpeg'
  return { file_data: { mime_type: mimeType, file_uri: reference } }
}

/**
 * Read a provider's error body into one sentence.
 *
 * The vendors all wrap their message somewhere else (`error.message`, `message`, `detail`), and a
 * status code alone is not a cause: `400` can be a prompt filter, a size nobody supports, or a
 * missing parameter — and those are fixed differently.
 */
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
      else if (typeof parsed.detail === 'string') detail = parsed.detail
      else detail = text
    } catch {
      detail = text
    }
  } catch {
    // A body we cannot read leaves the status as the only fact.
  }
  const trimmed = detail.trim().slice(0, 300)
  const head =
    response.status === 401 || response.status === 403
      ? 'The key was refused'
      : response.status === 429
        ? 'Rate limited'
        : response.status === 404
          ? 'No such endpoint'
          : `HTTP ${response.status}`
  return trimmed ? `${head}: ${trimmed}` : head
}

export async function generateImageOverApi(request: ApiImageRequest): Promise<ApiImageResult> {
  const fetchImpl = request.fetch ?? fetch
  const base = request.baseUrl.replace(/\/+$/, '')
  // H3 answers text-to-image and image editing at different paths; every other shape has one.
  const usesEdits =
    request.bodyShape === 'minimax-h3-image' && (request.images?.length ?? 0) > 0
  const path = usesEdits ? (request.editPath ?? request.submitPath) : request.submitPath
  const url = (
    path
      ? `${base}${path.startsWith('/') ? path : `/${path}`}`
      : endpointOf(request.baseUrl)
  ).replace('{model}', encodeURIComponent(request.model))
  // H3 may spend up to ten minutes on a 4K image; the provider's own ceiling is 600 seconds.
  const timeoutMs =
    request.timeoutMs ?? (request.bodyShape === 'minimax-h3-image' ? 10 * 60 * 1000 : 5 * 60 * 1000)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = request.signal ?? controller.signal

  try {
    let body: Record<string, unknown>
    if (request.bodyShape === 'minimax-h3-image') {
      const {
        ratio,
        size: sizeParam,
        format,
        compression,
        area: requestedArea,
        n: requestedN,
        ...providerParams
      } = request.params ?? {}
      if (requestedN !== undefined && Number(requestedN) !== 1) {
        throw new MediaFailure(
          'generate',
          '生成失败：MiniMax H3 每次调用写一个文件；不要用 --param n 指定多张。',
        )
      }
      const references = request.images ?? []
      if (references.length > 16) {
        throw new MediaFailure('generate', '生成失败：MiniMax H3 最多接收 16 张参考图。')
      }
      const explicitSize =
        request.size?.trim() || (typeof sizeParam === 'string' ? sizeParam.trim() : '')
      const fixedSize = explicitSize.length > 0 && explicitSize !== 'auto'
      if (fixedSize) {
        if (!/^\d+x\d+$/i.test(explicitSize)) {
          throw new MediaFailure(
            'generate',
            `生成失败：MiniMax H3 的 size 应为宽x高，如 2720x1536；"${explicitSize}" 不是。`,
          )
        }
      }
      const quality = compression !== undefined ? Number(compression) : undefined
      if (quality !== undefined && (!Number.isFinite(quality) || quality < 0 || quality > 100)) {
        throw new MediaFailure('generate', '生成失败：MiniMax H3 的压缩质量应在 0–100 之间。')
      }
      body = {
        ...providerParams,
        model: request.model,
        prompt: request.prompt,
        n: 1,
        // Bytes, not a link: a 24-hour URL is a picture that can be lost.
        response_format: 'b64_json',
        ...(fixedSize
          ? { size: explicitSize }
          : {
              size: 'auto',
              ...(ratio !== undefined && String(ratio) !== 'auto'
                ? { aspect_ratio: String(ratio) }
                : {}),
              // The API defaults to 4K; 2K is the same price as 1K on the standard model.
              area: requestedArea !== undefined ? String(requestedArea) : '2K',
            }),
        ...(format !== undefined ? { output_format: String(format) } : {}),
        ...(quality !== undefined ? { output_compression: quality } : {}),
        ...(usesEdits ? { images: references.map((image_url) => ({ image_url })) } : {}),
      }
    } else if (request.bodyShape === 'minimax-image') {
      // `ratio` is the card's word for a shape; MiniMax calls the same decision `aspect_ratio`,
      // and it has no `size` field.
      const { ratio, size: _size, ...providerParams } = request.params ?? {}
      const references = request.images ?? []
      if (references.length > 1) {
        throw new MediaFailure(
          'generate',
          '生成失败：MiniMax 图像只支持 1 张参考图（人物主体参考），请去掉多余的参考。',
        )
      }
      body = {
        ...providerParams,
        model: request.model,
        prompt: request.prompt,
        n: 1,
        response_format: 'url',
        ...(ratio ? { aspect_ratio: ratio } : {}),
        // `image_file` takes a data URL or a public URL directly — local bytes do not need a host.
        ...(references[0]
          ? { subject_reference: [{ type: 'character', image_file: references[0] }] }
          : {}),
      }
    } else if (request.bodyShape === 'gemini') {
      // `ratio` and `quality` are the card's words: Gemini calls them `aspectRatio` and `imageSize`,
      // both inside `imageConfig`. Everything else belongs beside it in `generationConfig`.
      const { ratio, quality, ...providerParams } = request.params ?? {}
      const aspect = providerParams.aspectRatio ?? ratio
      body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: request.prompt },
              ...(request.images ?? []).map(geminiPart),
            ],
          },
        ],
        generationConfig: {
          ...(aspect || quality
            ? {
                imageConfig: {
                  ...(aspect ? { aspectRatio: aspect } : {}),
                  ...(quality ? { imageSize: String(quality) } : {}),
                },
              }
            : {}),
          ...providerParams,
        },
      }
    } else {
      body = {
        // The provider's own fields first: what this door is *for* — the model, the prompt, one
        // result — is written after them, so a parameter can never quietly replace the brief.
        ...(request.params ?? {}),
        model: request.model,
        prompt: request.prompt,
        n: 1,
        // Ask for bytes rather than a link: a link that expires is a picture you lose.
        response_format: 'b64_json',
        ...(request.size ? { size: request.size } : {}),
        ...(request.images?.length
          ? {
              // The OpenAI shape for an image edit/reference; providers that ignore it still
              // accept the field, and providers that need a different field are a different
              // protocol, not a flag.
              image: request.images.length === 1 ? request.images[0] : request.images,
            }
          : {}),
      }
    }

    let response: Response
    const authHeader = request.auth?.header ?? 'Authorization'
    const authPrefix =
      request.auth?.prefix ?? (authHeader.toLowerCase() === 'authorization' ? 'Bearer ' : '')
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [authHeader]: authPrefix + request.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw new MediaFailure(
        'generate',
        controller.signal.aborted
          ? `生成失败：${Math.round(timeoutMs / 1000)} 秒内没有结果（${url}）`
          : `生成失败：连不上 ${url}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }

    if (!response.ok) throw new MediaFailure('generate', await describeFailure(response))

    const payload = (await response.json().catch(() => null)) as
      | {
          id?: string
          data?:
            | Array<{
                b64_json?: string
                url?: string
                revised_prompt?: string
                error?: { code?: string; message?: string }
              }>
            | { image_urls?: string[]; image_base64?: string[] }
          images?: Array<{ b64_json?: string; url?: string }>
          /** Gemini answers with candidates, not `data`. */
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: { data?: string; mimeType?: string }
                inline_data?: { data?: string; mime_type?: string }
              }>
            }
          }>
          /** MiniMax reports its own outcome inside a 200. */
          base_resp?: { status_code?: number; status_msg?: string }
        }
      | null
    if (
      payload?.base_resp &&
      typeof payload.base_resp.status_code === 'number' &&
      payload.base_resp.status_code !== 0
    ) {
      throw new MediaFailure(
        'generate',
        `生成失败：${payload.base_resp.status_msg ?? `状态码 ${payload.base_resp.status_code}`}`,
      )
    }

    const data = payload?.data
    const entry = Array.isArray(data) ? data[0] : undefined
    const gallery = data && !Array.isArray(data) ? data : undefined
    const gemini = payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part.inlineData ?? part.inline_data)
      .find((inline) => typeof inline?.data === 'string')
    const b64 = entry?.b64_json ?? gallery?.image_base64?.[0] ?? gemini?.data
    const geminiMime =
      (gemini && 'mimeType' in gemini ? gemini.mimeType : undefined) ??
      (gemini && 'mime_type' in gemini ? gemini.mime_type : undefined)
    const imageUrl = entry?.url ?? gallery?.image_urls?.[0] ?? payload?.images?.[0]?.url
    if (!b64 && !imageUrl) {
      // H3 returns a per-image failure inside a 200; its sentence is the useful one.
      if (entry?.error) {
        throw new MediaFailure(
          'generate',
          `生成失败：${entry.error.message ?? entry.error.code ?? '这一张没有生成'}`,
        )
      }
      throw new MediaFailure('generate', '生成失败：接口返回里没有图片（data 为空）')
    }

    if (b64) {
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
      const mimeType = sniffMime(bytes) ?? geminiMime ?? 'image/png'
      return {
        bytes,
        mimeType,
        filename: `image-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
        providerTaskId: payload?.id,
        via: 'b64_json',
      }
    }

    if (imageUrl) {
      // The picture is behind a link — fetch it now, while it is still there.
      let download: Response
      try {
        download = await fetchImpl(imageUrl, { signal })
      } catch (error) {
        throw new MediaFailure(
          'download',
          `下载失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!download.ok) throw new MediaFailure('download', `下载失败：HTTP ${download.status}`)
      const bytes = new Uint8Array(await download.arrayBuffer())
      const mimeType =
        download.headers.get('content-type')?.split(';')[0] ||
        sniffMime(bytes) ||
        'image/png'
      return {
        bytes,
        mimeType,
        filename: `image-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
        providerTaskId: payload?.id,
        via: 'url',
      }
    }

    throw new MediaFailure('generate', '生成失败：接口返回了图片但既没有 b64_json 也没有 url')
  } finally {
    clearTimeout(timer)
  }
}

/** The first bytes of a file say what it is; a Content-Type header often says `octet-stream`. */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  return null
}
