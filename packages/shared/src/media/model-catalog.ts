/**
 * What a model can do, keyed by a canonical id rather than by a vendor's spelling.
 *
 * A vendor may expose the same model as `MiniMax-H3`, `minimax-h3`, or
 * `bytedance/seedance-2.5/image-to-video` with a date suffix. The catalogue holds one entry per
 * model; `recognizeModelId` finds it without ever rewriting the id the provider must receive.
 *
 * Deliberately small: only models craft actually ships presets for. Capability fields (resolution,
 * duration, reference limits) arrive in a later step; this file exists so they have somewhere to
 * live that is not the settings JSON.
 */

import type { MediaInputKind, MediaKind } from './channels.ts'

export interface MediaReferenceCapability {
  maxCount?: number
  /** Per-file ceiling, in megabytes. */
  maxSizeMb?: number
}

/**
 * What a model allows beyond the choices its channel already lists.
 *
 * Deliberately small: resolution/ratio/duration come from the channel's `paramSpecs`; this holds
 * the rules a parameter list cannot express — prompt ceiling, reference counts, frame roles and
 * whether reference mode exists at all. Absent means "no declared limit", not "not allowed".
 */
export interface MediaModelCapabilities {
  maxPromptCharacters?: number
  /** Total references beside the prompt and frames. */
  maxReferences?: number
  references?: Partial<Record<MediaInputKind, MediaReferenceCapability>>
  frameRoles?: Array<'first_frame' | 'last_frame'>
  supportsLastFrameOnly?: boolean
  allowsReferenceMode?: boolean
  /**
   * What this model wants as input. Absent means "not declared": an image-generation model needs
   * nothing but text, while a speech model may accept a voice sample. Advisory for now — the
   * refusal rules above are what the validator runs.
   */
  inputs?: MediaInputKind[]
}

/**
 * How to call a model, in the words the tool speaks.
 *
 * A vendor's own field names are the thing an agent cannot guess, and prose in a prompt is not
 * lookupable. This is the same knowledge in one place: the parameter names craft accepts, the
 * values that are model-specific, and one sentence on the shape of the call.
 */
export interface MediaModelGuide {
  /** Parameter names this model reads, in the order a person sets them (`voice`, `format`…). */
  params?: string[]
  /** Voices only this model knows, when the channel's list is not the whole story. */
  voices?: string[]
  /** Containers only this model writes. */
  formats?: string[]
  /** One sentence: how this model wants to be called. */
  usage?: string
}

export interface MediaModelCatalogEntry {
  /** Canonical id. Stable across vendor spellings; never sent to a provider. */
  id: string
  kind: MediaKind
  /** Other names this model ships under, including the vendor's own id. */
  aliases?: string[]
  /** Refusal rules applied before submission. Omitted fields are simply not checked. */
  capabilities?: MediaModelCapabilities
  /** How to call it: unified parameter names, model-specific values, one sentence of usage. */
  guide?: MediaModelGuide
}

export const MEDIA_MODEL_CATALOG: readonly MediaModelCatalogEntry[] = [
  // MiniMax
  {
    id: 'minimax-h3',
    kind: 'video',
    aliases: ['MiniMax-H3'],
    capabilities: {
      frameRoles: ['first_frame', 'last_frame'],
      allowsReferenceMode: true,
      maxReferences: 12,
      references: {
        image: { maxCount: 9 },
        video: { maxCount: 3 },
        audio: { maxCount: 3 },
      },
    },
    guide: {
      params: ['ratio', 'quality', 'duration'],
      usage:
        'ratio 选画幅，quality 选 768P/2K（接口字段是 resolution），duration 是秒数；首尾帧用 first-frame/last-frame，其余素材走参考。',
    },
  },
  { id: 'minimax-h3-max', kind: 'video', aliases: ['MiniMax-H3-Max'] },
  { id: 'minimax-h3-highspeed', kind: 'video', aliases: ['MiniMax-H3-Highspeed'] },
  { id: 'minimax-h3-lite', kind: 'video', aliases: ['MiniMax-H3-Lite'] },
  { id: 'image-01', kind: 'image', aliases: ['image-01'] },
  { id: 'image-01-live', kind: 'image', aliases: ['image-01-live'] },
  {
    id: 'minimax-h3-image',
    kind: 'image',
    aliases: ['MiniMax-H3-Image'],
    capabilities: {
      maxPromptCharacters: 32000,
      maxReferences: 16,
      references: { image: { maxCount: 16 } },
      inputs: ['image'],
    },
    guide: {
      params: ['ratio', 'quality', 'format', 'compression'],
      formats: ['jpeg', 'png', 'webp'],
      usage:
        'ratio 选画幅，quality 选 1K/2K/4K（默认 2K，接口字段是 area）；带参考图时自动走图像编辑，最多 16 张，提示词用「图1」「图2」指代（不是 --first-frame）。',
    },
  },
  {
    id: 'minimax-h3-image-highspeed',
    kind: 'image',
    aliases: ['MiniMax-H3-Image-Highspeed'],
    capabilities: {
      maxPromptCharacters: 32000,
      maxReferences: 16,
      references: { image: { maxCount: 16 } },
      inputs: ['image'],
    },
    guide: {
      params: ['ratio', 'quality', 'format', 'compression'],
      formats: ['jpeg', 'png', 'webp'],
      usage:
        'H3-Image 的极速版，参数与标准版相同；ratio 选画幅，quality 选 1K/2K/4K（默认 2K，接口字段是 area）。',
    },
  },
  {
    id: 'speech-2.8-hd',
    kind: 'tts',
    aliases: ['speech-2.8-hd'],
    guide: {
      params: ['voice', 'speed', 'volume', 'format'],
      usage:
        '系统音色写在 voice；正文是纯文本（可带 (laughs) 等语气词和 <#x#> 停顿，不解析 SSML）；音色克隆改用参考音频，两者不要同时给。',
    },
  },
  {
    id: 'speech-2.8-turbo',
    kind: 'tts',
    aliases: ['speech-2.8-turbo'],
    guide: {
      params: ['voice', 'speed', 'volume', 'format'],
      usage:
        '系统音色写在 voice；正文是纯文本（可带 (laughs) 等语气词和 <#x#> 停顿，不解析 SSML）；音色克隆改用参考音频，两者不要同时给。',
    },
  },
  {
    id: 'speech-2.6-hd',
    kind: 'tts',
    aliases: ['speech-2.6-hd'],
    guide: {
      params: ['voice', 'speed', 'volume', 'format'],
      usage: '系统音色写在 voice；正文是纯文本（不解析 SSML）；音色克隆改用参考音频，两者不要同时给。',
    },
  },
  {
    id: 'speech-2.6-turbo',
    kind: 'tts',
    aliases: ['speech-2.6-turbo'],
    guide: {
      params: ['voice', 'speed', 'volume', 'format'],
      usage: '系统音色写在 voice；正文是纯文本（不解析 SSML）；音色克隆改用参考音频，两者不要同时给。',
    },
  },
  {
    id: 'speech-02-hd',
    kind: 'tts',
    aliases: ['speech-02-hd'],
    guide: {
      params: ['voice', 'speed', 'volume', 'format'],
      usage: '系统音色写在 voice；正文是纯文本（不解析 SSML）；音色克隆改用参考音频，两者不要同时给。',
    },
  },
  {
    id: 'speech-02-turbo',
    kind: 'tts',
    aliases: ['speech-02-turbo'],
    guide: {
      params: ['voice', 'speed', 'volume', 'format'],
      usage: '系统音色写在 voice；正文是纯文本（不解析 SSML）；音色克隆改用参考音频，两者不要同时给。',
    },
  },

  // Volcengine / ByteDance
  { id: 'seedream-5.0', kind: 'image', aliases: ['doubao-seedream-5-0'] },
  { id: 'seedream-5.0-lite', kind: 'image', aliases: ['doubao-seedream-5-0-lite'] },
  {
    id: 'seedance-2.5',
    kind: 'video',
    aliases: ['doubao-seedance-2-5'],
    guide: {
      params: ['ratio', 'quality'],
      usage: 'ratio 选画幅，quality 选 480P/720P/1080P（接口字段是 resolution）。',
    },
  },
  { id: 'seedance-2.0', kind: 'video', aliases: ['doubao-seedance-2-0'] },
  {
    id: 'fun-music-v1',
    kind: 'music',
    aliases: ['fun-music-v1', 'fun-music-preview'],
    guide: {
      params: ['lyrics', 'gender', 'is_instrumental', 'format'],
      usage:
        'prompt 或 lyrics 至少给一个（只支持中英文）；两者都是纯文本，不解析 SSML；gender 选 female/male；is_instrumental=true 生成纯音乐。',
    },
  },
  {
    id: 'music-1.5',
    kind: 'music',
    aliases: ['music-1.5'],
    capabilities: { maxPromptCharacters: 300 },
    guide: {
      params: ['lyrics', 'format', 'sample_rate', 'bitrate'],
      usage:
        'prompt 写风格与情绪（10-300 字）；lyrics 是纯文本歌词（10-600 字），换行分行，可用 [Verse]/[Chorus] 等结构标签分段，不支持 SSML；单次最长 90 秒。',
    },
  },
  {
    id: 'seed-audio-1.0',
    kind: 'tts',
    aliases: ['seed-audio-1-0'],
    capabilities: {
      maxPromptCharacters: 3000,
      allowsReferenceMode: true,
      references: { audio: { maxCount: 3, maxSizeMb: 10 }, image: { maxCount: 1 } },
    },
    guide: {
      params: ['voice', 'format', 'speed', 'pitch_rate', 'loudness_rate'],
      usage:
        'voice 是豆包音色 ID（也可用参考音频代替）；text_prompt 是自然语言描述，纯文本、不解析 SSML；speed 是 0.5-2 的倍速，会换算成 speech_rate；输出不超过 120 秒。',
    },
  },

  // OpenAI
  {
    id: 'gpt-image-1',
    kind: 'image',
    aliases: ['gpt-image-1'],
    guide: {
      params: ['ratio'],
      usage: 'ratio 选画幅；这个模型每个画幅只有一档尺寸，像素由渠道换算，不要传 size。',
    },
  },
  {
    id: 'gpt-4o-mini-tts',
    kind: 'tts',
    aliases: ['gpt-4o-mini-tts'],
    guide: { params: ['voice', 'format', 'speed'], usage: '正文是纯文本，不解析 SSML；音色从 voice 里选；语速用 speed（0.25 到 4）。' },
  },
  {
    id: 'tts-1',
    kind: 'tts',
    aliases: ['tts-1'],
    guide: { params: ['voice', 'format', 'speed'], usage: '正文是纯文本，不解析 SSML；音色从 voice 里选；语速用 speed（0.25 到 4）。' },
  },
  {
    id: 'tts-1-hd',
    kind: 'tts',
    aliases: ['tts-1-hd'],
    guide: { params: ['voice', 'format', 'speed'], usage: '正文是纯文本，不解析 SSML；音色从 voice 里选；语速用 speed（0.25 到 4）。' },
  },

  // xAI
  { id: 'grok-2-image', kind: 'image', aliases: ['grok-2-image'] },
  { id: 'grok-imagine-image', kind: 'image', aliases: ['grok-imagine-image'] },

  // Alibaba
  {
    id: 'qwen3-tts-flash',
    kind: 'tts',
    aliases: ['qwen3-tts-flash'],
    guide: { params: ['voice'], usage: '正文是纯文本，不解析 SSML；音色只能从 voice 里选，不写就用 Cherry。' },
  },
  {
    id: 'qwen-image-3.0-pro',
    kind: 'image',
    aliases: ['qwen-image-3.0-pro'],
    guide: {
      params: ['ratio'],
      usage: 'ratio 选画幅（1:1 / 16:9 / 9:16）；尺寸固定 1K，像素由渠道换算，不要传 size。',
    },
  },
  { id: 'qwen-image-3.0', kind: 'image', aliases: ['qwen-image-3.0'] },
  { id: 'qwen-image-2.1-pro', kind: 'image', aliases: ['qwen-image-2.1-pro'] },
  { id: 'qwen-image-2.1-turbo', kind: 'image', aliases: ['qwen-image-2.1-turbo'] },
  { id: 'wan-2.5-t2i', kind: 'image', aliases: ['wan2.5-t2i-preview'] },
  { id: 'wan-2.2-t2i-flash', kind: 'image', aliases: ['wan2.2-t2i-flash'] },
  { id: 'wan-2.2-t2i-plus', kind: 'image', aliases: ['wan2.2-t2i-plus'] },
  { id: 'wanx-2.1-t2i-turbo', kind: 'image', aliases: ['wanx2.1-t2i-turbo'] },
  { id: 'wanx-2.1-t2i-plus', kind: 'image', aliases: ['wanx2.1-t2i-plus'] },
  {
    id: 'wan-3.0-video',
    kind: 'video',
    aliases: ['wan3.0-video'],
    guide: {
      params: ['ratio', 'quality', 'duration'],
      usage: 'ratio 选画幅，quality 选 480P/720P/1080P（接口字段是 resolution），duration 是秒数。',
    },
  },
  {
    id: 'wan-2.6-t2v',
    kind: 'video',
    aliases: ['wan2.6-t2v'],
    guide: {
      params: ['ratio', 'duration'],
      usage: 'ratio 选画幅（16:9 / 9:16 / 1:1）；只有 720P，像素由渠道换算，不要传 size。',
    },
  },
  { id: 'wan-2.5-t2v', kind: 'video', aliases: ['wan2.5-t2v-preview'] },
  { id: 'wan-2.2-t2v', kind: 'video', aliases: ['wan2.2-t2v-plus'] },

  // Others
  { id: 'sora-2', kind: 'video', aliases: ['sora-2'] },
  {
    id: 'gemini-3-pro-image',
    kind: 'image',
    aliases: ['gemini-3-pro-image'],
    guide: {
      params: ['ratio', 'quality'],
      usage: 'ratio 选画幅，quality 选 1K/2K/4K；两者分别写进 imageConfig 的 aspectRatio 和 imageSize。',
    },
  },
]

const BY_ID = new Map(MEDIA_MODEL_CATALOG.map((entry) => [entry.id, entry]))

/** The normalisation used only for matching: case, dots and underscores are not model identity. */
const normalizeName = (id: string): string => id.trim().toLowerCase().replace(/[._]/g, '-')

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const BY_NAME = new Map<string, string>()
const MATCHERS: Array<{ id: string; length: number; pattern: RegExp }> = []
for (const entry of MEDIA_MODEL_CATALOG) {
  const names = new Set([entry.id, ...(entry.aliases ?? [])].map(normalizeName))
  for (const name of names) {
    BY_NAME.set(name, entry.id)
    MATCHERS.push({
      id: entry.id,
      length: name.length,
      // A relay may prefix or suffix an id (`bytedance/…/image-to-video`, `…-260128`). The boundary
      // keeps `tts-1` from matching inside `tts-1-hd`.
      pattern: new RegExp(
        `(^|[^a-z0-9])${escapeRegExp(name)}` +
          `(?:-(?:[0-9]{6}|[0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2}))?(?=$|[/@:])`,
      ),
    })
  }
}
// Longest name first, so a model is never recognised as a shorter one it contains.
MATCHERS.sort((left, right) => right.length - left.length)

export function mediaModelCatalogEntry(id: string | null | undefined): MediaModelCatalogEntry | null {
  return id ? (BY_ID.get(id) ?? null) : null
}

/**
 * The catalogue id a vendor's model id names, or `null` when it is not one we know.
 *
 * Exact ids win over aliases. Nothing here rewrites the request: a relay that invents `my-video-v9`
 * still receives `my-video-v9`; it simply has no catalogue capabilities.
 */
export function recognizeModelId(modelId: string | null | undefined): string | null {
  const raw = modelId?.trim()
  if (!raw) return null
  const normalized = normalizeName(raw)
  const exact = BY_NAME.get(normalized)
  if (exact) return exact
  for (const matcher of MATCHERS) {
    if (matcher.pattern.test(normalized)) return matcher.id
  }
  return null
}

/**
 * The catalogue id for one channel's model: what the channel declared, else recognition.
 *
 * The declaration is authoritative because a vendor may map two of its ids onto one catalogue
 * model; recognition is the fallback that makes relay ids useful without a per-id table.
 */
export function catalogIdOf(
  channel: { modelCatalogId?: Record<string, string> },
  model: string | null | undefined,
): string | null {
  if (!model) return null
  return channel.modelCatalogId?.[model] ?? recognizeModelId(model)
}

/** What a settings page or a model picker needs to know about one model on a channel. */
export interface MediaModelInfo {
  /** The vendor's id — the one sent to the provider. */
  id: string
  /** The canonical catalogue id, when the model is known. */
  catalogId: string | null
  capabilities?: MediaModelCapabilities
  /** How to call it, when the catalogue has anything to say beyond the parameters. */
  guide?: MediaModelGuide
}

/** The models of one capability, each with its catalogue id, declared rules and usage. */
export function modelInfoOf(
  channel: { modelCatalogId?: Record<string, string> },
  models: readonly string[] | undefined,
): MediaModelInfo[] {
  return (models ?? []).map((id) => {
    const catalogId = catalogIdOf(channel, id)
    const entry = mediaModelCatalogEntry(catalogId)
    const info: MediaModelInfo = { id, catalogId }
    if (entry?.capabilities) info.capabilities = entry.capabilities
    if (entry?.guide) info.guide = entry.guide
    return info
  })
}
