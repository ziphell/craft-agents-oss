/**
 * One door for "draw this picture".
 *
 * The caller says which channel and which model; this decides whether that means an HTTP request or
 * a local graph. Everything above it — the canvas node, the agent's tool — only ever sees a channel,
 * a prompt, and the bytes that came back.
 *
 * The async half is split so it can outlive a call: `prepareTaskSubmission` builds the wire request
 * and `generateOverTaskApi`'s two halves (submit, poll) can be driven by a runner that persists the
 * task between them. `generateMedia` is the convenience path for callers that can just wait.
 */

import { MediaFailure } from './types.ts'
import { bytesOfDataUrl } from './inputs.ts'
import { validateMediaRequest } from './validate.ts'
import { generateImageOverApi } from './providers/api-image.ts'
import { synthesizeSpeechOverApi, speechBodyFor } from './providers/api-speech.ts'
import { generateOverTaskApi, type ApiTaskEndpoint } from './providers/api-task.ts'
import {
  channelForKind,
  isSoundKind,
  mediaChannelKey,
  mediaChannelModel,
  type MediaChannel,
  type MediaKind,
} from './channels.ts'
import { paramsForModel, paramSpecsOf, wireParams, withParamDefaults } from './params.ts'
import { findMediaProtocol } from './protocols.ts'
import {
  modelMode,
  paramsForMode,
  videoEditProblem,
  withoutFixedDuration,
  type MediaMode,
} from './modes.ts'

export interface MediaGenerateRequest {
  channel: MediaChannel
  prompt: string
  /** Card-level override; the channel's default fills in otherwise. */
  model?: string
  size?: string
  images?: string[]
  /** Video/audio references as data URLs or public URLs. Only the `content` shape carries them. */
  videos?: string[]
  audios?: string[]
  /** The picture the clip starts on, and the one it must end on. A role, not a numbered reference. */
  firstFrame?: string
  lastFrame?: string
  /** Card-level parameters that win over the channel's defaults (duration, resolution, ratio, size). */
  params?: Record<string, string | number>
  /** What this run makes. Defaults to what the channel makes. */
  kind?: MediaKind
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export interface MediaGenerateResult {
  bytes: Uint8Array
  mimeType: string
  filename: string
  providerTaskId?: string
  /** Which protocol did the work — worth saying out loud in a log. */
  via: string
}

/** The model and the key a channel needs, or a sentence naming the one that is missing. */
export function credentialsFor(
  channel: MediaChannel,
  requestedModel?: string,
): { model: string; apiKey: string } {
  const model = mediaChannelModel(channel, requestedModel)
  if (!model) {
    throw new MediaFailure('generate', `渠道「${channel.name}」没有可用模型：在设置 › 媒体生成里选一个。`, {
      code: 'missing_model',
      field: 'model',
    })
  }
  const apiKey = mediaChannelKey(channel)
  if (!apiKey) {
    throw new MediaFailure('generate', `渠道「${channel.name}」没有密钥：在设置 › 媒体生成里填一次。`, {
      code: 'missing_credentials',
      field: 'apiKey',
    })
  }
  return { model, apiKey }
}

/** What a task submission is: where to send it, and the body in the provider's own shape. */
export interface MediaTaskSubmission {
  endpoint: ApiTaskEndpoint
  body: Record<string, unknown>
}

/**
 * The channel as the one capability this call is about.
 *
 * An account may offer several kinds; everything below reads a channel as if it made exactly one.
 * When the requested kind is absent, the channel is returned unchanged and the caller's own checks
 * refuse the run with a message that names the channel.
 */
function capabilityOf(channel: MediaChannel, kind?: MediaKind): MediaChannel {
  return (kind ? channelForKind(channel, kind) : null) ?? channel
}

/**
 * The channel as the one model's wire sees it.
 *
 * Bailian's image capability holds Qwen-Image (one request) and Wan t2i (a queued task): same
 * account, same kind, two wires. Everything that is not wire — models, params, mode — is inherited.
 *
 * Exported because "is this a task?" must be answered against the model, not the capability: a
 * caller that asks the capability would hand Wan to the synchronous path and wait for it.
 */
export function mediaChannelForModel(channel: MediaChannel, model: string): MediaChannel {
  // A named protocol is the normal case; an explicit wire is the hand-edited exception and wins.
  const protocolId = channel.modelProtocols?.[model]
  const named = protocolId ? findMediaProtocol(protocolId)?.wire : undefined
  const explicit = channel.modelWires?.[model]
  const wire = named || explicit ? { ...named, ...explicit } : undefined
  return wire ? { ...channel, ...wire } : channel
}

/**
 * Where a task lives for this channel: URLs, credentials, wire shape. No body — a poll needs
 * exactly this much, and a task that is already submitted only ever polls.
 */
export function taskEndpointFor(
  channel: MediaChannel,
  request: { model?: string; timeoutMs?: number; kind?: MediaKind },
): ApiTaskEndpoint {
  const declared = capabilityOf(channel, request.kind)
  const { model, apiKey } = credentialsFor(declared, request.model)
  // The model decides whether this is a task at all: Wan queues one where Qwen-Image answers now.
  const capability = mediaChannelForModel(declared, model)
  if (!capability.pollPath) {
    throw new MediaFailure('generate', `渠道「${capability.name}」不是异步渠道：它没有 pollPath。`, {
      code: 'unsupported',
      field: 'pollPath',
    })
  }
  const kind: MediaKind = capability.kind ?? request.kind ?? 'image'
  return {
    kind,
    baseUrl: capability.baseUrl,
    apiKey,
    submitPath: (capability.submitPath ?? '/images/generations').replace('{model}', encodeURIComponent(model)),
    pollPath: capability.pollPath,
    cancelPath: capability.cancelPath,
    auth: capability.auth,
    submitHeaders: capability.submitHeaders,
    taskIdPath: capability.taskIdPath,
    statusPath: capability.statusPath,
    resultPath: capability.resultPath,
    pollMs: capability.pollMs,
    timeoutMs: request.timeoutMs,
  }
}

/**
 * Refuse inputs a model cannot take, before a request is sent.
 *
 * A video-edit model is handed the clip it edits: one video, nothing beside it. The output's length
 * is that clip's length, which is why the duration never reaches the wire.
 */
function ensureModeInputs(
  channel: MediaChannel,
  mode: MediaMode,
  request: Omit<MediaGenerateRequest, 'channel'>,
): void {
  if (mode !== 'video-edit') return
  const problem = videoEditProblem({
    videos: request.videos?.length ?? 0,
    images: request.images?.length ?? 0,
    audios: request.audios?.length ?? 0,
    frames: (request.firstFrame ? 1 : 0) + (request.lastFrame ? 1 : 0),
  })
  if (problem === 'needs-one-video') {
    throw new MediaFailure(
      'generate',
      `渠道「${channel.name}」的视频编辑模型需要且只需要一个视频输入。`,
      { code: 'invalid_request', field: 'inputs' },
    )
  }
  if (problem === 'video-only') {
    throw new MediaFailure(
      'generate',
      `渠道「${channel.name}」的视频编辑模型只接收一个视频，不能再带图片、音频或首尾帧。`,
      { code: 'invalid_request', field: 'inputs' },
    )
  }
}

/** The body in the provider's own shape. Built from the request every time, never stored. */
function taskBodyFor(
  raw: MediaChannel,
  request: Omit<MediaGenerateRequest, 'channel'>,
): Record<string, unknown> {
  const declared = capabilityOf(raw, request.kind)
  const { model } = credentialsFor(declared, request.model)
  const channel = mediaChannelForModel(declared, model)
  const kind = channel.kind ?? request.kind ?? 'image'
  const mode = modelMode(channel, model)
  ensureModeInputs(channel, mode, request)
  // The same defaults the panel shows, in the same order the direct path uses. A task is often
  // submitted from a stored request rather than from a form, and it must still carry the ratio or
  // resolution the model declares — otherwise the panel and the agent ask for different pictures.
  const specs = paramsForMode(paramsForModel(paramSpecsOf(channel), model), mode)
  const chosen = withoutFixedDuration(
    {
      ...withParamDefaults(specs, {}),
      ...(channel.params ?? {}),
      ...(request.params ?? {}),
    },
    mode,
  )
  // Above the wire the card speaks ratio + quality; a pixel-only model gets its own `size` string.
  const wire = wireParams(chosen, specs)
  // Speech and music both answer with a sound file, so an account that names no wire speaks the
  // simplest speech shape. A composing channel should declare `audio-generation` explicitly.
  const shape =
    channel.bodyShape ??
    (isSoundKind(kind) ? 'openai-speech' : kind === 'video' ? 'content' : 'prompt')
  if (
    (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame) &&
    shape !== 'content'
  ) {
    throw new MediaFailure(
      'generate',
      `渠道「${channel.name}」只接收图片参考：去掉视频/音频参考或首尾帧，或换一个用 content 协议的渠道。`,
      { code: 'unsupported', field: 'inputs' },
    )
  }
  if (shape === 'dashscope-image') {
    // The asynchronous Wan t2i door: the same nested shape as video, one image per task.
    return {
      model,
      input: {
        prompt: request.prompt,
        ...(request.images?.[0] ? { ref_img: request.images[0] } : {}),
      },
      parameters: {
        ...wire,
        n: 1,
        ...(request.size ? { size: request.size } : {}),
      },
    }
  }
  if (shape === 'dashscope-video') {
    // DashScope nests the brief under `input` and every knob under `parameters`. The same shape
    // carries wan3.0's resolution/ratio and wan2.6's size, so whichever the model declares travels.
    const { duration, ...rest } = wire
    return {
      model,
      input: {
        prompt: request.prompt,
        ...(request.firstFrame ? { img_url: request.firstFrame } : {}),
      },
      parameters: {
        ...rest,
        ...(request.size ? { size: request.size } : {}),
        ...(duration !== undefined ? { duration: Number(duration) } : {}),
      },
    }
  }
  if (
    shape === 'openai-speech' ||
    shape === 'dashscope-tts' ||
    shape === 'volcengine-audio' ||
    shape === 'minimax-tts' ||
    shape === 'minimax-music' ||
    shape === 'dashscope-music' ||
    shape === 'audio-generation'
  ) {
    return speechBodyFor({
      baseUrl: channel.baseUrl,
      apiKey: '',
      model,
      text: request.prompt,
      bodyShape: shape,
      params: wire,
    })
  }
  return shape === 'content'
    ? {
        // Parameters first: what this door is *for* — the model, the prompt, the references — is
        // written after them, so a field named `content` or `model` cannot replace the brief.
        ...wire,
        model,
        content: [
          { type: 'text', text: request.prompt },
          // Frames are roles: the provider knows where they go, so they are not part of the
          // numbered reference arrays.
          ...(request.firstFrame
            ? [{ role: 'first_frame', type: 'image_url', image_url: { url: request.firstFrame } }]
            : []),
          ...(request.lastFrame
            ? [{ role: 'last_frame', type: 'image_url', image_url: { url: request.lastFrame } }]
            : []),
          // A node is both input and output: what is already here can be what the next run is
          // built on, so the references travel with the request. Order inside each kind is the
          // order the card showed; the prompt's `{{ref N}}` was rewritten to these labels.
          ...(request.images ?? []).map((url) => ({
            role: 'reference_image',
            type: 'image_url',
            image_url: { url },
          })),
          ...(request.videos ?? []).map((url) => ({
            role: 'reference_video',
            type: 'video_url',
            video_url: { url },
          })),
          ...(request.audios ?? []).map((url) => ({
            role: 'reference_audio',
            type: 'audio_url',
            audio_url: { url },
          })),
        ],
      }
    : shape === 'gemini'
      ? (() => {
          // The same body the synchronous Gemini path builds: `ratio` is the card's word for what
          // Gemini calls `aspectRatio`, `quality` for `imageSize`, and every other parameter
          // belongs in `generationConfig`.
          const { ratio, quality, ...providerParams } = wire
          const aspect = providerParams.aspectRatio ?? ratio
          return {
            contents: [
              {
                role: 'user',
                parts: [
                  { text: request.prompt },
                  // Gemini takes the bytes inline; a data URL is split into MIME + base64, and a
                  // public URL becomes `file_data`. Either way the reference is not dropped.
                  ...(request.images ?? []).map(geminiImagePart),
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
        })()
      : {
          ...wire,
          model,
          prompt: request.prompt,
          n: 1,
          ...(request.size ? { size: request.size } : {}),
          ...(request.images?.length ? { image: request.images.length === 1 ? request.images[0] : request.images } : {}),
        }
}

/** One reference in the parts Gemini expects: inline bytes, or a file reference for a URL. */
function geminiImagePart(reference: string): Record<string, unknown> {
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
 * Build the submission for a channel that answers with a task id.
 *
 * Kept apart from actually submitting so the same inputs can be rebuilt later: a task record stores
 * the prompt, the references and the model — never the body or the key — and a resumed task calls
 * this again to get the identical request.
 */
export function prepareTaskSubmission(
  channel: MediaChannel,
  request: Omit<MediaGenerateRequest, 'channel'>,
): MediaTaskSubmission {
  return {
    endpoint: taskEndpointFor(channel, request),
    body: taskBodyFor(channel, request),
  }
}

/**
 * Bytes of the inline references. A URL has no size we can know without fetching it, so it is
 * skipped rather than guessed — an unknown size must not become a false "too large".
 */
function sizesOf(references?: string[]): number[] | undefined {
  if (!references?.length) return undefined
  const sizes: number[] = []
  for (const reference of references) {
    const inline = bytesOfDataUrl(reference)
    if (inline) sizes.push(inline.bytes.length)
  }
  return sizes.length ? sizes : undefined
}

export async function generateMedia(request: MediaGenerateRequest): Promise<MediaGenerateResult> {
  // The account may offer several capabilities; this run asks for one, and everything below reads
  // the channel as if it made only that one.
  const declared = capabilityOf(request.channel, request.kind)
  // The effective model is settled before the wire is read: one capability may hold models that
  // queue a task and models that answer at once (Bailian's Wan and Qwen-Image).
  const { model, apiKey } = credentialsFor(declared, request.model)
  const channel = mediaChannelForModel(declared, model)

  // What the channel declared it can accept, checked before a provider is called (and paid).
  validateMediaRequest(channel, {
    prompt: request.prompt,
    model: request.model,
    params: request.params,
    counts: {
      image: request.images?.length ?? 0,
      video: request.videos?.length ?? 0,
      audio: request.audios?.length ?? 0,
    },
    firstFrame: Boolean(request.firstFrame),
    lastFrame: Boolean(request.lastFrame),
    sizes: {
      image: sizesOf(request.images),
      video: sizesOf(request.videos),
      audio: sizesOf(request.audios),
    },
  })

  // A synchronous image endpoint has no field for a clip or a recording: refusing here is better
  // than sending a prompt that promises a reference the provider never received.
  if (
    !channel.pollPath &&
    (request.videos?.length || request.audios?.length || request.firstFrame || request.lastFrame)
  ) {
    throw new MediaFailure(
      'generate',
      `渠道「${channel.name}」是同步渠道，只接收图片参考：去掉视频/音频参考或首尾帧，或换一个异步渠道。`,
      { code: 'unsupported', field: 'inputs' },
    )
  }

  // The panel and the agent must send the same thing: the selected model's spec defaults, then the
  // channel's own params, then the caller's choice. Without this, a value the panel showed is
  // omitted on the agent's path and the provider quietly picks something else. The model is the
  // effective one (the caller's, else the channel's default), so a model-scoped param is not sent
  // to a different model just because the agent left the name out.
  const specModel = mediaChannelModel(channel, request.model)
  const mode = modelMode(channel, specModel)
  // A video edit is exactly one video and keeps that video's length, so a duration is refused
  // here rather than sent and ignored — and so is anything else travelling beside the clip.
  ensureModeInputs(channel, mode, request)
  const specs = paramsForMode(paramsForModel(paramSpecsOf(channel), specModel), mode)
  const params = withoutFixedDuration(
    {
      ...withParamDefaults(specs, {}),
      ...(channel.params ?? {}),
      ...(request.params ?? {}),
    },
    mode,
  )

  // A channel that names a poll path answers with a task id and gives the result later — metaso's
  // MiniMax endpoint is one. Everything above this line is the same either way.
  if (channel.pollPath) {
    // The submission builder fills the same defaults again: a task may also be submitted from a
    // stored record, where this function never ran.
    const { endpoint, body } = prepareTaskSubmission(channel, request)
    const result = await generateOverTaskApi({
      ...endpoint,
      body,
      fetch: request.fetch,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    })
    return { ...result, providerTaskId: result.taskId, via: `${channel.protocol}:${result.via}` }
  }

  // The card's word becomes the provider's: ratio + quality become a `size` when the model only
  // accepts pixels, and a declared alias (`quality` → `resolution`) is applied.
  const wire = wireParams(params, specs)

  // Sound answers in one request: speech now, or a music clip if the provider makes it quickly.
  // A provider that needs minutes for a song names a poll path, and the branch above takes it.
  if (isSoundKind(channel.kind)) {
    const result = await synthesizeSpeechOverApi({
      baseUrl: channel.baseUrl,
      apiKey,
      model,
      text: request.prompt,
      submitPath: channel.submitPath,
      bodyShape:
        channel.bodyShape === 'openai-speech' ||
        channel.bodyShape === 'dashscope-tts' ||
        channel.bodyShape === 'volcengine-audio' ||
        channel.bodyShape === 'minimax-tts' ||
        channel.bodyShape === 'minimax-music' ||
        channel.bodyShape === 'dashscope-music' ||
        channel.bodyShape === 'audio-generation' ||
        channel.bodyShape === 'prompt'
          ? channel.bodyShape
          : undefined,
      responseShape: channel.responseShape,
      resultPath: channel.resultPath,
      auth: channel.auth,
      params: wire,
      fetch: request.fetch,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    })
    return { ...result, via: `${channel.protocol}:speech-${result.via}` }
  }

  const result = await generateImageOverApi({
    baseUrl: channel.baseUrl,
    submitPath: channel.submitPath,
    editPath: channel.editPath,
    bodyShape:
      channel.bodyShape === 'minimax-image'
        ? 'minimax-image'
        : channel.bodyShape === 'minimax-h3-image'
          ? 'minimax-h3-image'
          : channel.bodyShape === 'gemini'
            ? 'gemini'
            : 'prompt',
    auth: channel.auth,
    apiKey,
    model,
    prompt: request.prompt,
    size: request.size,
    images: request.images,
    // The channel's own defaults underneath the card's choice, the same order the task path uses:
    // a provider field named here reaches the body instead of being silently dropped.
    params: wire,
    fetch: request.fetch,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  })

  return { ...result, via: `${channel.protocol}:${result.via}` }
}
