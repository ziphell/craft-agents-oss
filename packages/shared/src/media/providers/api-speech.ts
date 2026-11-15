/**
 * Audio generation over an HTTP API — speech and music.
 *
 * Two answer shapes cover the providers people actually use:
 *
 * - **the body is the file** (OpenAI's `/audio/speech`): write what came back;
 * - **the body is a payload** with a URL or base64 inside it (DashScope's Qwen-TTS and the Model
 *   Studio audio-generation service): read the path the channel names, then download while the URL
 *   is still alive.
 *
 * Making the request is smaller than the image path because the input is text: there is no size, no
 * reference picture and no `n`. What varies is where the text sits in the body, which is why the
 * channel names a `bodyShape` instead of this file knowing one vendor.
 */

import { MediaFailure } from '../types.ts'
import { readPath } from './api-task.ts'

export type AudioBodyShape =
  | 'openai-speech'
  | 'dashscope-tts'
  | 'volcengine-audio'
  | 'minimax-tts'
  | 'minimax-music'
  | 'dashscope-music'
  | 'audio-generation'
  | 'prompt'

export interface SpeechSynthesisRequest {
  baseUrl: string
  apiKey: string
  model: string
  /** The words to speak, or the description of the music to make. */
  text: string
  submitPath?: string
  bodyShape?: AudioBodyShape
  responseShape?: 'json' | 'binary'
  /** Where the audio URL or base64 sits in a JSON answer. Defaults to `output.audio.url`. */
  resultPath?: string
  auth?: { header: string; prefix?: string }
  /** Voice, format, speed, sample rate… provider fields, passed through by the shape. */
  params?: Record<string, string | number>
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SpeechSynthesisResult {
  bytes: Uint8Array
  mimeType: string
  filename: string
  /** The provider's own duration, when it says one. */
  durationSeconds?: number
  via: 'binary' | 'url' | 'b64'
}

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
}

export function audioMimeFor(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return AUDIO_MIME_BY_EXTENSION[extension] ?? 'audio/mpeg'
}

/**
 * Name the file for what it is.
 *
 * Providers answer with whatever format they chose, and a WAV named `.mp3` is a file a player will
 * refuse: the caller may ask for a container, but the bytes are the authority.
 */
export function fileNameForMime(path: string, mimeType: string): string {
  const mime = mimeType.toLowerCase().split(';')[0]!.trim()
  const extension = mime.includes('mpeg') || mime.includes('mp3')
    ? 'mp3'
    : mime.includes('wav')
      ? 'wav'
      : mime.includes('ogg') || mime.includes('opus')
        ? 'ogg'
        : mime.includes('flac')
          ? 'flac'
          : mime.includes('mp4')
            ? 'm4a'
            : mime.includes('aac')
              ? 'aac'
              : mime.includes('webm')
                ? 'webm'
                : null
  if (!extension) return path
  const current = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (current === extension) return path
  return `${path.replace(/\.[^./\\]+$/, '')}.${extension}`
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('flac')) return 'flac'
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('aac')) return 'aac'
  if (mimeType.includes('webm')) return 'webm'
  return 'mp3'
}

/** The first bytes of a file know what it is, which matters when a provider sends no header. */
function sniffAudio(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg' // ID3
  if (bytes[0] === 0xff && (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2)) return 'audio/mpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x41) return 'audio/wav' // RIFF…WAVE
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg'
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 'audio/flac'
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'audio/mp4'
  return null
}

function authHeaders(request: SpeechSynthesisRequest): Record<string, string> {
  const header = request.auth?.header ?? 'Authorization'
  const prefix = request.auth?.prefix ?? (header.toLowerCase() === 'authorization' ? 'Bearer ' : '')
  return { [header]: prefix + request.apiKey }
}

/**
 * The body, in the shape the channel named.
 *
 * `voice` and `format` are pulled out of `params` because they have a different name in every
 * vendor's protocol; everything else is passed through untouched, which is how a new field reaches
 * a provider without a code change.
 */
export function speechBodyFor(request: SpeechSynthesisRequest): Record<string, unknown> {
  const params = { ...(request.params ?? {}) }
  const shape = request.bodyShape ?? 'openai-speech'
  if (shape === 'openai-speech') {
    const { voice, format, ...rest } = params
    return {
      ...rest,
      model: request.model,
      input: request.text,
      voice: voice ?? 'alloy',
      response_format: format ?? 'mp3',
    }
  }
  if (shape === 'dashscope-tts') {
    const { voice, format, language, ...rest } = params
    // The words go in last: a parameter named `text` must not replace the brief.
    return {
      model: request.model,
      input: {
        ...rest,
        text: request.text,
        ...(voice ? { voice } : {}),
        ...(language ? { language_type: language } : {}),
        ...(format ? { format } : {}),
      },
    }
  }
  if (shape === 'audio-generation') {
    return {
      model: request.model,
      // `text_prompt` is the brief; parameters fill in around it.
      input: { ...params, text_prompt: request.text },
    }
  }
  if (shape === 'volcengine-audio') {
    const { speaker, voice, speed, format, sample_rate, speech_rate, loudness_rate, pitch_rate, ...rest } =
      params
    // The card says `voice`; this API calls the same thing `speaker`.
    const named = speaker ?? voice
    // The card says `speed` as a multiplier; this API calls it `speech_rate`, -50..100.
    const rate =
      speech_rate ??
      (typeof speed === 'number' ? Math.max(-50, Math.min(100, Math.round((speed - 1) * 100))) : undefined)
    return {
      model: request.model,
      text_prompt: request.text,
      // A named voice is a reference, not a field: the audio-generation API treats a built-in
      // speaker and a recorded sample as the same kind of thing.
      ...(named ? { references: [{ speaker: named }] } : {}),
      audio_config: {
        ...(format ? { format } : {}),
        ...(sample_rate ? { sample_rate } : {}),
        ...(rate !== undefined ? { speech_rate: rate } : {}),
        ...(loudness_rate !== undefined ? { loudness_rate } : {}),
        ...(pitch_rate !== undefined ? { pitch_rate } : {}),
        ...rest,
      },
    }
  }
  if (shape === 'dashscope-music') {
    const { lyrics, gender, is_instrumental, format, ...rest } = params
    const instrumental = String(is_instrumental) === 'true'
    return {
      ...rest,
      model: request.model,
      input: {
        prompt: request.text,
        ...(lyrics !== undefined ? { lyrics: String(lyrics) } : {}),
        ...(gender !== undefined ? { gender: String(gender) } : {}),
        ...(instrumental ? { is_instrumental: true } : {}),
        ...(format !== undefined ? { format: String(format) } : {}),
      },
    }
  }
  if (shape === 'minimax-music') {
    const { format, sample_rate, bitrate, lyrics, ...rest } = params
    // The lyrics arrive through the card's dedicated port; the card's text is the style brief.
    const words = typeof lyrics === 'string' ? lyrics.trim() : ''
    if (!words) {
      throw new MediaFailure('generate', 'MiniMax 音乐生成需要歌词（10-600 字，可带 [verse]/[chorus]）。', {
        code: 'invalid_request',
        field: 'lyrics',
      })
    }
    return {
      ...rest,
      model: request.model,
      prompt: request.text,
      lyrics: words,
      stream: false,
      // A URL is one download instead of a megabyte of hex.
      output_format: 'url',
      audio_setting: {
        ...(format ? { format } : {}),
        ...(sample_rate !== undefined ? { sample_rate } : {}),
        ...(bitrate !== undefined ? { bitrate } : {}),
      },
    }
  }
  if (shape === 'minimax-tts') {
    const { voice, format, speed, vol, pitch, emotion, sample_rate, bitrate, channel, ...rest } =
      params
    return {
      ...rest,
      model: request.model,
      text: request.text,
      stream: false,
      // Ask for a link rather than hex: the bytes are the same, but a URL is one download instead
      // of a megabyte of text. The decoder still accepts hex if a provider insists.
      output_format: 'url',
      voice_setting: {
        voice_id: voice ?? 'male-qn-qingse',
        ...(speed !== undefined ? { speed } : {}),
        ...(vol !== undefined ? { vol } : {}),
        ...(pitch !== undefined ? { pitch } : {}),
        ...(emotion ? { emotion } : {}),
      },
      audio_setting: {
        ...(format ? { format } : {}),
        ...(sample_rate !== undefined ? { sample_rate } : {}),
        ...(bitrate !== undefined ? { bitrate } : {}),
        ...(channel !== undefined ? { channel } : {}),
      },
    }
  }
  const { format, ...rest } = params
  // `prompt` is the brief for a music/misc endpoint; parameters fill in around it.
  return { ...rest, model: request.model, prompt: request.text, ...(format ? { format } : {}) }
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
      else if (typeof parsed.detail === 'string') detail = parsed.detail
      else detail = text
    } catch {
      detail = text
    }
  } catch {
    // No body readable: the status is the only fact.
  }
  const trimmed = detail.trim().slice(0, 300)
  const head =
    response.status === 401 || response.status === 403
      ? '密钥被拒绝'
      : response.status === 402
        ? '账户余额或额度不足'
        : response.status === 429
          ? '被限流了，稍后再试'
          : response.status === 404
            ? '这个地址没有音频端点'
            : `请求被拒绝（HTTP ${response.status}）`
  return trimmed ? `${head}：${trimmed}` : head
}

export async function synthesizeSpeechOverApi(
  request: SpeechSynthesisRequest,
): Promise<SpeechSynthesisResult> {
  const fetchImpl = request.fetch ?? fetch
  const base = request.baseUrl.replace(/\/+$/, '')
  const path = request.submitPath || '/audio/speech'
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`
  const timeoutMs = request.timeoutMs ?? 5 * 60 * 1000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = request.signal ?? controller.signal

  try {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...authHeaders(request), 'Content-Type': 'application/json' },
        body: JSON.stringify(speechBodyFor(request)),
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

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (
      request.responseShape === 'binary' ||
      contentType.startsWith('audio/') ||
      contentType === 'application/octet-stream'
    ) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length === 0) throw new MediaFailure('generate', '生成失败：接口返回了空音频')
      const mimeType = contentType.startsWith('audio/') ? contentType : (sniffAudio(bytes) ?? 'audio/mpeg')
      return {
        bytes,
        mimeType,
        filename: `audio-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
        via: 'binary',
      }
    }

    const payload = await response.json().catch(() => null)
    // MiniMax answers 200 with its own status envelope; a refused run is not "no audio".
    const providerCode = readPath(payload, 'base_resp.status_code')
    const providerMessage = readPath(payload, 'base_resp.status_msg')
    if (typeof providerCode === 'number' && providerCode !== 0) {
      throw new MediaFailure(
        'generate',
        `生成失败：${typeof providerMessage === 'string' && providerMessage ? providerMessage : `状态码 ${providerCode}`}`,
      )
    }
    const pathOfUrl = request.resultPath ?? 'output.audio.url'
    const audioUrl =
      (typeof readPath(payload, pathOfUrl) === 'string' ? (readPath(payload, pathOfUrl) as string) : '') ||
      (typeof readPath(payload, 'data.0.url') === 'string' ? (readPath(payload, 'data.0.url') as string) : '')
    const b64 =
      (typeof readPath(payload, 'output.audio.data') === 'string'
        ? (readPath(payload, 'output.audio.data') as string)
        : '') ||
      (typeof readPath(payload, 'data.0.b64_json') === 'string'
        ? (readPath(payload, 'data.0.b64_json') as string)
        : '') ||
      // Volcengine's audio-generation API returns the bytes as a top-level `audio`.
      (typeof readPath(payload, 'audio') === 'string' ? (readPath(payload, 'audio') as string) : '')
    const duration =
      readPath(payload, 'output.audio.duration') ??
      readPath(payload, 'duration') ??
      readPath(payload, 'original_duration')
    let durationSeconds = typeof duration === 'number' ? duration : undefined
    if (durationSeconds === undefined) {
      // MiniMax reports milliseconds under `extra_info.audio_length`.
      const durationMs = readPath(payload, 'extra_info.audio_length')
      if (typeof durationMs === 'number') durationSeconds = durationMs / 1000
    }

    if (b64) {
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'))
      const mimeType = sniffAudio(bytes) ?? 'audio/mpeg'
      return {
        bytes,
        mimeType,
        filename: `audio-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        via: 'b64',
      }
    }

    if (audioUrl) {
      // Some providers ignore `output_format` and answer hex anyway; hex is a file, not a link.
      if (!audioUrl.includes('://') && /^[0-9a-f]+$/i.test(audioUrl) && audioUrl.length > 128) {
        const bytes = Uint8Array.from(Buffer.from(audioUrl, 'hex'))
        const mimeType = sniffAudio(bytes) ?? 'audio/mpeg'
        return {
          bytes,
          mimeType,
          filename: `audio-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          via: 'b64',
        }
      }
      let download: Response
      try {
        download = await fetchImpl(audioUrl, { signal })
      } catch (error) {
        throw new MediaFailure(
          'download',
          `下载失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!download.ok) throw new MediaFailure('download', `下载失败：HTTP ${download.status}`)
      const bytes = new Uint8Array(await download.arrayBuffer())
      const mimeType =
        download.headers.get('content-type')?.split(';')[0]?.trim() ||
        sniffAudio(bytes) ||
        'audio/mpeg'
      return {
        bytes,
        mimeType,
        filename: `audio-${Date.now().toString(36)}.${extensionFor(mimeType)}`,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        via: 'url',
      }
    }

    throw new MediaFailure('generate', `生成失败：接口返回里没有音频（${pathOfUrl} 为空）`)
  } finally {
    clearTimeout(timer)
  }
}
