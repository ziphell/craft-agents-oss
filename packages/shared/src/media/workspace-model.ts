/**
 * One question, answered by the workspace's own AI connection.
 *
 * Media generation does not own a chat model. Reading a picture back into words, or turning a
 * brief into text, is the same job the agent's `call_llm` does — so it asks the connection the
 * person already configured, with the model roles that connection already declares:
 * `visionModel` for pictures, `fastModel` for cheap text, `defaultModel` otherwise.
 *
 * Two wire shapes are covered, because those are the two the app's connections use: OpenAI-style
 * `chat/completions` and Anthropic's `messages`. Which one is a property of the connection.
 */

import { getCredentialManager } from '../credentials/index.ts'
import { loadStoredConfig } from '../config/index.ts'
import { getOmniModel, canServeOmni, resolveImageModel, type LlmConnection } from '../config/llm-connections.ts'
import { asrConfigProblem, readAsrConfig } from './asr.ts'

export interface WorkspaceModelAnswer {
  ok: boolean
  text?: string
  /** Which model answered — worth saying, because it may not be the one they thought. */
  model?: string
  connection?: string
  message?: string
}

export interface ConnectionShape {
  slug: string
  name?: string
  baseUrl?: string
  providerType?: string
  defaultModel?: string
  fastModel?: string
  visionModel?: string
  /** The model that listens (audio) and reads short video for `call_llm`. */
  omniModel?: string
  piAuthProvider?: string
  models?: Array<{ id: string; supportsImages?: boolean }>
  customEndpoint?: { api?: string }
  authType?: string
}

/** The connection to ask: a named one, the first that can see images, then the default. */
export function pickVisionConnection(connections: ConnectionShape[], preferred?: string): ConnectionShape | null {
  if (preferred) {
    const named = connections.find((connection) => connection.slug === preferred)
    if (named) return named
  }
  // The vision chain only: the omni role means "reads sound and video", and a person who wants an
  // omni model to read pictures names it as `visionModel`.
  const seesImages = (connection: ConnectionShape) =>
    Boolean(connection.visionModel?.trim()) ||
    (connection.models ?? []).some((model) => model.supportsImages)
  return connections.find(seesImages) ?? connections[0] ?? null
}

/** The default connection for text-only calls — any configured connection will do. */
export function pickDefaultConnection(connections: ConnectionShape[], preferred?: string): ConnectionShape | null {
  if (preferred) {
    const named = connections.find((connection) => connection.slug === preferred)
    if (named) return named
  }
  return connections[0] ?? null
}

/**
 * The connection that can listen: one with a usable `omniModel`.
 *
 * "Usable" is the shared rule (`getOmniModel`): a pick on a connection whose wire cannot carry
 * audio is no pick, so two connections with the first misconfigured still finds the second.
 * No capability guess beyond that: sending a recording to a model that cannot hear it spends money
 * to learn nothing. No pick means a sentence asking for one, not a fallback to the text model.
 */
export function pickOmniConnection(connections: ConnectionShape[], preferred?: string): ConnectionShape | null {
  if (preferred) {
    const named = connections.find((connection) => connection.slug === preferred)
    if (named) return named
  }
  return connections.find((connection) => getOmniModel(connection)) ?? null
}

/** A stored connection, as the capability helpers see it. */
const asConnection = (connection: ConnectionShape): LlmConnection => connection as unknown as LlmConnection

/**
 * The model a connection uses for this kind of question.
 *
 * Pictures go through the same capability chain `call_llm` uses, so a main/default model that can
 * see is used with no extra configuration; text falls back the old way.
 */
function modelOf(connection: ConnectionShape, hasImage: boolean): string {
  if (hasImage) return resolveImageModel(asConnection(connection)) ?? ''
  const preferred = connection.fastModel
  return preferred?.trim() || connection.defaultModel?.trim() || connection.models?.[0]?.id || ''
}

function baseOf(connection: ConnectionShape): string {
  const base = (connection.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) return ''
  // Connection base URLs are stored without `/v1` in some setups and with it in others.
  return /\/v\d+$/.test(base) ? base : `${base}/v1`
}

function wireShape(connection: ConnectionShape): 'anthropic' | 'openai' {
  // One rule for both questions: only an OpenAI-compatible wire can carry media in the body.
  return canServeOmni(connection) ? 'openai' : 'anthropic'
}

export async function askWorkspaceModel(request: {
  /** Pictures, in order — data URLs or public URLs. All of them are sent. */
  images?: string[]
  /** What to answer; required — there is no built-in prompt. */
  instruction: string
  /** Prefer a particular connection (a workspace may have several). */
  connectionSlug?: string
  /** An explicit model, when the caller knows which reader it wants. */
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxTokens?: number
  /** System prompt for text-only calls. */
  systemPrompt?: string
}): Promise<WorkspaceModelAnswer> {
  const imageUrls = [...(request.images ?? [])]
  const hasImage = imageUrls.length > 0
  const stored = loadStoredConfig()
  const connections = (stored?.llmConnections ?? []) as ConnectionShape[]
  const connection = hasImage
    ? pickVisionConnection(connections, request.connectionSlug)
    : pickDefaultConnection(connections, request.connectionSlug)
  if (!connection) {
    return {
      ok: false,
      message: hasImage
        ? '这个工作区还没有配置大模型（设置 → 模型），没法反推提示词。'
        : '这个工作区还没有配置大模型（设置 → 模型），没法生成文本。',
    }
  }
  const model = request.model?.trim() || modelOf(connection, hasImage)
  if (!model) return { ok: false, message: `连接「${connection.name ?? connection.slug}」没有模型。` }

  const apiKey = await getCredentialManager().getLlmApiKey(connection.slug)
  if (!apiKey) {
    return {
      ok: false,
      message: `连接「${connection.name ?? connection.slug}」没有密钥：在设置里补上，然后重试。`,
    }
  }

  const base = baseOf(connection)
  if (!base) {
    return { ok: false, message: `连接「${connection.name ?? connection.slug}」没有地址。` }
  }

  const fetchImpl = request.fetchImpl ?? fetch
  const timeoutMs = request.timeoutMs ?? 90_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const instruction = request.instruction.trim()
  if (!instruction) return { ok: false, message: '需要一句 prompt：想让它回答什么？' }
  const shape = wireShape(connection)
  const maxTokens = request.maxTokens ?? (hasImage ? 1024 : 2048)

  try {
    // Build the messages payload — vision content array for images, plain text otherwise. The
    // instruction is the caller's and is always present: there is no built-in describe prompt.
    let messages: Array<{ role: 'system' | 'user'; content: unknown }>
    if (hasImage) {
      messages = [
        {
          role: 'user',
          content: [
            { type: 'text' as const, text: instruction },
            ...imageUrls.map((url) =>
              shape === 'anthropic'
                ? {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: url.slice(5).split(';')[0] || 'image/png',
                      data: url.split(',')[1] ?? '',
                    },
                  }
                : { type: 'image_url' as const, image_url: { url } },
            ),
          ],
        },
      ]
    } else {
      messages = []
      if (request.systemPrompt?.trim()) messages.push({ role: 'system', content: request.systemPrompt.trim() })
      messages.push({ role: 'user', content: instruction })
    }

    const response =
      shape === 'anthropic'
        ? await fetchImpl(`${base}/messages`, {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              messages,
            }),
            signal: controller.signal,
          })
        : await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              max_tokens: maxTokens,
            }),
            signal: controller.signal,
          })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        message:
          response.status === 401 || response.status === 403
            ? `模型「${model}」的密钥被拒绝`
            : `模型「${model}」返回 HTTP ${response.status} ${body.slice(0, 160)}`,
        model,
        connection: connection.slug,
      }
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    const text =
      shape === 'anthropic'
        ? ((payload?.content as Array<{ type?: string; text?: string }> | undefined) ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('')
        : (() => {
            const choices = (payload?.choices as Array<{ message?: { content?: unknown } }> | undefined) ?? []
            const content = choices[0]?.message?.content
            if (typeof content === 'string') return content
            if (Array.isArray(content)) {
              return content
                .map((part) =>
                  part && typeof part === 'object' && 'text' in part
                    ? String((part as { text?: unknown }).text ?? '')
                    : '',
                )
                .join('')
            }
            return ''
          })()

    const cleaned = text.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()
    if (!cleaned) return { ok: false, message: `模型「${model}」没有给出内容`, model }
    return { ok: true, text: cleaned, model, connection: connection.slug }
  } catch (error) {
    return {
      ok: false,
      message:
        controller.signal.aborted
          ? `模型「${model}」在 ${Math.round(timeoutMs / 1000)} 秒内没有回答`
          : `连不上模型「${model}」：${error instanceof Error ? error.message : String(error)}`,
      model,
      connection: connection.slug,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** What the person's settings can currently do for `understand`. */
export interface UnderstandCapabilities {
  /** A model that listens (and may take short video). */
  omni: boolean
  /** A model that reads pictures, for the frames/transcript routes. */
  vision: boolean
  /** Speech-to-text is configured (local model installed, or a cloud provider chosen). */
  asr: boolean
}

/** The capability decision, once the connections and the recognition setting are known. */
export function evaluateUnderstandCapabilities(
  connections: ConnectionShape[],
  asr: boolean,
): UnderstandCapabilities {
  const omni = pickOmniConnection(connections) !== null

  // The same chain the picture calls use: explicit vision model, then the small model, then the
  // main/default model. A main model that can see counts with no separate vision role.
  const visionConnection = pickVisionConnection(connections) ?? connections[0] ?? null
  const vision = Boolean(visionConnection && resolveImageModel(asConnection(visionConnection)))
  return { omni, vision, asr }
}

/** Read once per `understand`, so a strategy is chosen from what is actually configured. */
export function understandCapabilities(): UnderstandCapabilities {
  const stored = loadStoredConfig()
  const connections = (stored?.llmConnections ?? []) as ConnectionShape[]

  let asr = false
  try {
    asr = asrConfigProblem(readAsrConfig().config) === undefined
  } catch {
    asr = false
  }
  return evaluateUnderstandCapabilities(connections, asr)
}

/** A resolved endpoint, for callers that already found the connection (a host, or a test). */
export interface OmniEndpoint {
  /** Full chat-completions URL or a base that ends before `/chat/completions`. */
  baseUrl: string
  apiKey: string
  model: string
}

export interface OmniModelRequest {
  /** What to answer about the recording. */
  instruction: string
  /** Frames, in time order, as data URLs or public URLs. */
  images?: string[]
  /** The recording's sound, compressed. */
  audio?: { data: Uint8Array; format: 'mp3' | 'wav' | 'm4a' | 'aac' }
  /** A short clip sent as-is, so the model hears and sees it in sync. */
  video?: { data: Uint8Array; format: string }
  /** Explicit model id; otherwise the connection's `omniModel`. */
  model?: string
  connectionSlug?: string
  /** Already resolved — skips config and the credential store. */
  endpoint?: OmniEndpoint
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxTokens?: number
}

export interface OmniModelAnswer {
  ok: boolean
  text?: string
  model?: string
  connection?: string
  message?: string
}

const AUDIO_MIME: Record<NonNullable<OmniModelRequest['audio']>['format'], string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
}

/**
 * How much media one omni request may carry.
 *
 * These are our own ceilings, and the strictest provider sets them: Qwen-Omni (DashScope)
 * rejects a base64 media string at 10 MB, while Ark's base64 route allows 50 MB of video with a
 * 64 MB request body and 25 MB of audio. One budget for every omni connection therefore has to
 * fit the strictest one. Base64 grows a file by 4/3, so 7.5 MB of file is a 10 MB string.
 *
 * The point is to fail before a large upload, not to describe any single provider.
 */
export const OMNI_MAX_MEDIA_BASE64_BYTES = 10 * 1024 * 1024
export const OMNI_MAX_VIDEO_BYTES = (OMNI_MAX_MEDIA_BASE64_BYTES * 3) / 4
export const OMNI_MAX_AUDIO_BYTES = OMNI_MAX_VIDEO_BYTES
/** Ark's request-body ceiling; the per-media limits above bind first on every other provider. */
export const OMNI_MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * One media file per request. Our rule, not a provider one: a video already carries its own
 * soundtrack, and capping at one media keeps the request valid on every omni provider we target.
 */
export const OMNI_SINGLE_MEDIA_MESSAGE =
  '一次只能带一个媒体文件：视频已经带音轨，去掉单独的音频引用。'

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Bytes a file occupies once base64-encoded into the JSON body. */
function base64Bytes(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Whether this request cannot be sent as described, and the sentence to say instead.
 *
 * Two kinds of rule, both checked before any config, credential or network work:
 * - shape: one media file per request — our own rule (a video already carries its soundtrack),
 *   which also keeps the request valid on every omni provider we target;
 * - size: the strictest provider's base64 limits (see the ceilings above). A request that would be
 *   rejected, or cost a long upload, should never reach the provider.
 */
export function omniPayloadProblem(payload: {
  videoBytes?: number
  audioBytes?: number
  /** Length of the image data URLs / public URLs, in characters. */
  imageChars?: number
  /** Longest single image, in characters — providers cap each base64 string, not only the total. */
  largestImageChars?: number
  /** Length of the instruction, in characters. */
  instructionChars?: number
}): string | undefined {
  if (payload.videoBytes && payload.audioBytes) return OMNI_SINGLE_MEDIA_MESSAGE
  if (payload.videoBytes && payload.videoBytes > OMNI_MAX_VIDEO_BYTES) {
    return (
      `视频 ${megabytes(payload.videoBytes)}，超过单次请求的 ${megabytes(OMNI_MAX_VIDEO_BYTES)} 上限：` +
      '剪短后再试，或用 `recording_tool understand` 抽帧理解。'
    )
  }
  if (payload.audioBytes && payload.audioBytes > OMNI_MAX_AUDIO_BYTES) {
    return (
      `音频 ${megabytes(payload.audioBytes)}，超过单次请求的 ${megabytes(OMNI_MAX_AUDIO_BYTES)}：` +
      '压成 MP3 或剪短后再试。'
    )
  }
  if (payload.largestImageChars && payload.largestImageChars > OMNI_MAX_MEDIA_BASE64_BYTES) {
    return (
      `单张图片的编码后大小约 ${megabytes(payload.largestImageChars)}，` +
      `超过单次请求的 ${megabytes(OMNI_MAX_MEDIA_BASE64_BYTES)}：换一张更小的图片。`
    )
  }
  const body =
    base64Bytes(payload.videoBytes ?? 0) +
    base64Bytes(payload.audioBytes ?? 0) +
    (payload.imageChars ?? 0) +
    (payload.instructionChars ?? 0)
  if (body > OMNI_MAX_BODY_BYTES) {
    return (
      `这次请求的媒体合计约 ${megabytes(body)}，超过单次请求的 ${megabytes(OMNI_MAX_BODY_BYTES)} 上限：` +
      '去掉一些引用，或把视频剪短。'
    )
  }
  return undefined
}

function chatText(payload: Record<string, unknown> | null): string {
  const choices = (payload?.choices as Array<{ message?: { content?: unknown } }> | undefined) ?? []
  const content = choices[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : '',
      )
      .join('')
  }
  return ''
}

/**
 * Ask the omni model about a recording — one chat completion, audio and frames in the content.
 *
 * The shape is the OpenAI one DashScope's compatible mode speaks: `input_audio` for the recording,
 * `image_url` for frames, and a text instruction. It is deliberately not the agent backend: Claude
 * Code and the pi adapters do not carry audio, so a listening question has its own wire.
 */
export async function askOmniModel(request: OmniModelRequest): Promise<OmniModelAnswer> {
  const imageChars = (request.images ?? []).map((url) => url.length)
  const problem = omniPayloadProblem({
    videoBytes: request.video?.data.byteLength,
    audioBytes: request.audio?.data.byteLength,
    imageChars: imageChars.reduce((sum, chars) => sum + chars, 0),
    largestImageChars: imageChars.length ? Math.max(...imageChars) : undefined,
    instructionChars: request.instruction.length,
  })
  if (problem) return { ok: false, message: problem }

  let endpoint = request.endpoint
  let connectionSlug: string | undefined

  if (!endpoint) {
    const stored = loadStoredConfig()
    const connections = (stored?.llmConnections ?? []) as ConnectionShape[]
    const connection = pickOmniConnection(connections, request.connectionSlug)
    if (!connection) {
      return {
        ok: false,
        message:
          '这个工作区还没有配置能理解音频/视频的模型：在 设置 → 模型 → 连接 → Omni model 里选一个（例如 Qwen-Omni），再试。',
      }
    }
    connectionSlug = connection.slug
    if (!canServeOmni(connection)) {
      return {
        ok: false,
        connection: connection.slug,
        message: `连接「${connection.name ?? connection.slug}」是 Anthropic 协议，不支持音频输入：换一个 OpenAI 兼容连接。`,
      }
    }
    const model = request.model?.trim() || getOmniModel(connection) || ''
    if (!model) {
      return {
        ok: false,
        connection: connection.slug,
        message: `连接「${connection.name ?? connection.slug}」没有配置 Omni model：在设置里选一个，或用一个显式的模型名。`,
      }
    }
    const apiKey = await getCredentialManager().getLlmApiKey(connection.slug)
    if (!apiKey) {
      return {
        ok: false,
        connection: connection.slug,
        message: `连接「${connection.name ?? connection.slug}」没有密钥：在设置里补上，然后重试。`,
      }
    }
    const base = baseOf(connection)
    if (!base) {
      return {
        ok: false,
        connection: connection.slug,
        message: `连接「${connection.name ?? connection.slug}」没有地址。`,
      }
    }
    endpoint = { baseUrl: `${base}/chat/completions`, apiKey, model }
  }

  const url = /\/chat\/completions$/.test(endpoint.baseUrl)
    ? endpoint.baseUrl
    : `${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const content: unknown[] = [{ type: 'text', text: request.instruction }]
  for (const image of request.images ?? []) {
    content.push({ type: 'image_url', image_url: { url: image } })
  }
  if (request.audio) {
    const data = Buffer.from(request.audio.data).toString('base64')
    content.push({
      type: 'input_audio',
      input_audio: {
        data: `data:${AUDIO_MIME[request.audio.format]};base64,${data}`,
        format: request.audio.format,
      },
    })
  }
  if (request.video) {
    const data = Buffer.from(request.video.data).toString('base64')
    content.push({ type: 'video_url', video_url: { url: `data:video/${request.video.format};base64,${data}` } })
  }

  const fetchImpl = request.fetchImpl ?? fetch
  const timeoutMs = request.timeoutMs ?? 5 * 60 * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content }],
        max_tokens: request.maxTokens ?? 2048,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        model: endpoint.model,
        ...(connectionSlug ? { connection: connectionSlug } : {}),
        message:
          response.status === 401 || response.status === 403
            ? `模型「${endpoint.model}」的密钥被拒绝`
            : `模型「${endpoint.model}」返回 HTTP ${response.status} ${body.slice(0, 200)}`,
      }
    }

    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
    const text = chatText(payload).trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()
    if (!text) {
      return {
        ok: false,
        model: endpoint.model,
        ...(connectionSlug ? { connection: connectionSlug } : {}),
        message: `模型「${endpoint.model}」没有给出内容`,
      }
    }
    return {
      ok: true,
      text,
      model: endpoint.model,
      ...(connectionSlug ? { connection: connectionSlug } : {}),
    }
  } catch (error) {
    return {
      ok: false,
      model: endpoint.model,
      ...(connectionSlug ? { connection: connectionSlug } : {}),
      message: controller.signal.aborted
        ? `模型「${endpoint.model}」在 ${Math.round(timeoutMs / 1000)} 秒内没有回答`
        : `连不上模型「${endpoint.model}」：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
