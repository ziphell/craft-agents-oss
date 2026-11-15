/**
 * Refuse a request the channel has already told us it cannot serve — before it costs money.
 *
 * The rules are data, not branches: resolution/ratio/duration come from the channel's `paramSpecs`,
 * while reference counts, frame roles and prompt ceilings come from the model catalogue. A model
 * with no catalogue entry is not refused; only the checks it declared are run. That is what keeps a
 * relay with an invented model id usable.
 */

import { mediaChannelModel, type MediaChannel } from './channels.ts'
import { catalogIdOf, mediaModelCatalogEntry, type MediaModelCapabilities } from './model-catalog.ts'
import { videoEditProblem, videoModeOf, type VideoMode } from './modes.ts'
import { paramSpecsOf, paramsForModel } from './params.ts'
import { MediaFailure } from './types.ts'

export interface MediaReferenceCounts {
  image?: number
  video?: number
  audio?: number
}

/** Bytes per kind, when the caller knows them (inline bytes or a local file). */
export interface MediaReferenceSizes {
  image?: number[]
  video?: number[]
  audio?: number[]
}

export interface MediaRequestFacts {
  prompt: string
  /** The model the caller asked for; the channel's default fills in when absent. */
  model?: string
  /** Explicit request shape. Derived from the inputs when omitted. */
  mode?: VideoMode
  params?: Record<string, string | number>
  counts?: MediaReferenceCounts
  firstFrame?: boolean
  lastFrame?: boolean
  sizes?: MediaReferenceSizes
}

const invalid = (detail: string, field: string): MediaFailure =>
  new MediaFailure('generate', detail, { code: 'invalid_request', field })

/** The declared capabilities for this channel's model, or `null` when it is not catalogued. */
export function capabilitiesOf(
  channel: Pick<MediaChannel, 'modelCatalogId'>,
  model?: string | null,
): MediaModelCapabilities | null {
  const id = catalogIdOf(channel, model)
  return mediaModelCatalogEntry(id)?.capabilities ?? null
}

const countsOf = (facts: MediaRequestFacts) => ({
  image: facts.counts?.image ?? 0,
  video: facts.counts?.video ?? 0,
  audio: facts.counts?.audio ?? 0,
})

/**
 * Throw `MediaFailure('generate', …, { code: 'invalid_request' })` when the request cannot work.
 *
 * Runs before any upload or provider call. Unknown models pass the capability checks; their
 * explicitly chosen parameters are still checked against the channel's own list.
 */
export function validateMediaRequest(
  channel: MediaChannel,
  facts: MediaRequestFacts,
): void {
  const prompt = facts.prompt.trim()
  if (!prompt) throw invalid('提示词不能为空。', 'prompt')

  const model = mediaChannelModel(channel, facts.model)
  const counts = countsOf(facts)
  const mode =
    facts.mode ??
    videoModeOf(channel, model, {
      ...counts,
      firstFrame: facts.firstFrame,
      lastFrame: facts.lastFrame,
    })

  checkParams(channel, model, facts.params, mode)

  if (mode === 'video_edit') {
    const problem = videoEditProblem({
      videos: counts.video,
      images: counts.image,
      audios: counts.audio,
      frames: (facts.firstFrame ? 1 : 0) + (facts.lastFrame ? 1 : 0),
    })
    if (problem === 'needs-one-video') {
      throw invalid(`「${channel.name}」的视频编辑模型需要且只需要一个视频输入。`, 'inputs')
    }
    if (problem === 'video-only') {
      throw invalid(
        `「${channel.name}」的视频编辑模型只接收一个视频，不能再带图片、音频或首尾帧。`,
        'inputs',
      )
    }
    return
  }

  const caps = capabilitiesOf(channel, model)
  if (!caps) return

  if (caps.maxPromptCharacters !== undefined && [...prompt].length > caps.maxPromptCharacters) {
    throw invalid(`提示词最多 ${caps.maxPromptCharacters} 个字符。`, 'prompt')
  }

  if (facts.firstFrame && caps.frameRoles && !caps.frameRoles.includes('first_frame')) {
    throw invalid(`「${channel.name}」的 ${model} 不接受首帧。`, 'firstFrame')
  }
  if (facts.lastFrame && caps.frameRoles && !caps.frameRoles.includes('last_frame')) {
    throw invalid(`「${channel.name}」的 ${model} 不接受尾帧。`, 'lastFrame')
  }
  if (facts.lastFrame && !facts.firstFrame && caps.supportsLastFrameOnly === false) {
    throw invalid(`「${channel.name}」的 ${model} 只给尾帧时无法生成，请同时给首帧。`, 'lastFrame')
  }

  if (mode === 'reference' && caps.allowsReferenceMode === false) {
    throw invalid(`「${channel.name}」的 ${model} 不使用参考素材模式。`, 'references')
  }

  const total = counts.image + counts.video + counts.audio
  if (caps.maxReferences !== undefined && total > caps.maxReferences) {
    throw invalid(
      `「${channel.name}」的 ${model} 最多接收 ${caps.maxReferences} 个参考素材，当前 ${total} 个。`,
      'references',
    )
  }

  for (const kind of ['image', 'video', 'audio'] as const) {
    const limit = caps.references?.[kind]
    if (!limit) continue
    const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
    if (limit.maxCount !== undefined && counts[kind] > limit.maxCount) {
      throw invalid(
        `「${channel.name}」的 ${model} 最多接收 ${limit.maxCount} 个${label}参考，当前 ${counts[kind]} 个。`,
        'references',
      )
    }
    if (limit.maxSizeMb !== undefined) {
      const limitBytes = limit.maxSizeMb * 1024 * 1024
      const oversized = (facts.sizes?.[kind] ?? []).some((bytes) => bytes > limitBytes)
      if (oversized) {
        throw invalid(
          `「${channel.name}」的 ${model} 每个${label}参考不能超过 ${limit.maxSizeMb} MB。`,
          'references',
        )
      }
    }
  }
}

/** Explicit parameter choices must be ones the channel listed for this model. */
function checkParams(
  channel: MediaChannel,
  model: string,
  params: Record<string, string | number> | undefined,
  mode: VideoMode,
): void {
  if (!params) return
  const declared = paramSpecsOf(channel)
  // A channel that declares no parameters has no contract to enforce (an older or hand-written
  // file); one that does is authoritative — sending a field it never listed would mean guessing
  // the vendor's schema and where it goes in the body.
  if (!declared?.length) return
  const specs = paramsForModel(declared, model)
  const accepted = new Set(specs.map((spec) => spec.key))
  const unknown = Object.keys(params).filter((key) => !accepted.has(key))
  if (unknown.length > 0) {
    throw invalid(
      `「${channel.name}」的 ${model} 不接受参数 ${unknown.join('、')}。可用参数：${
        [...accepted].join(' / ') || '无'
      }。`,
      unknown[0]!,
    )
  }
  for (const spec of specs) {
    // A video edit keeps the input's length, so a duration is not a choice to validate.
    if (mode === 'video_edit' && spec.key === 'duration') continue
    if (!Object.prototype.hasOwnProperty.call(params, spec.key)) continue
    const value = params[spec.key]
    if (value === undefined) continue
    const label = spec.label ?? spec.key

    // A list that is merely a suggestion (voices, sizes) accepts a value it does not name; the
    // provider is the authority on what it knows.
    if (spec.type === 'select' && spec.options?.length && !spec.allowCustom) {
      if (!spec.options.some((option) => String(option) === String(value))) {
        throw invalid(
          `「${channel.name}」的 ${model} 不支持${label}「${value}」。可选：${spec.options.join(' / ')}。`,
          spec.key,
        )
      }
      continue
    }

    if (spec.type === 'number') {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric)) {
        throw invalid(`${label}需要填写数字。`, spec.key)
      }
      if (spec.min !== undefined && numeric < spec.min) {
        throw invalid(`${label}不能小于 ${spec.min}。`, spec.key)
      }
      if (spec.max !== undefined && numeric > spec.max) {
        throw invalid(`${label}不能大于 ${spec.max}。`, spec.key)
      }
    }
  }
}
