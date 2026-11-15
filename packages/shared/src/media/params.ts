/**
 * What a card may adjust, as data.
 *
 * A channel used to describe only its option *values* (`duration: [4, 5, 6]`), which left the panel
 * deciding which keys to show and how. A spec says the same thing with a type and a default, so the
 * panel, the agent and the adapter read one list instead of three ad-hoc checks.
 *
 * Parameters that only some models accept name those models in `models`; absent means the channel's
 * whole list. Whether a parameter is worth exposing stays a product decision — it is one entry here,
 * not a branch in the UI.
 */

import { MediaFailure } from './types.ts'

export interface MediaParamSpec {
  key: string
  /** Only used where the value alone is not a label (number/text inputs). */
  label?: string
  type: 'select' | 'number' | 'text'
  options?: Array<string | number>
  default?: string | number
  min?: number
  max?: number
  step?: number
  /** Only these models accept it; absent means every model on the channel. */
  models?: string[]
  /**
   * The options are suggestions, not a closed set.
   *
   * A voice list is the vendor's documented voices, not every voice an account may have; a size
   * list is the common shapes, not the only ones. This keeps the panel offering them while an
   * explicit value outside the list still reaches the provider.
   */
  allowCustom?: boolean
  /**
   * The provider's own field name, when the card's word differs.
   *
   * The card speaks `quality`; MiniMax calls the same decision `area` and Wan calls it
   * `resolution`. Declaring the alias here keeps one vocabulary above the wire.
   */
  wire?: string
  /**
   * The pixel size a ratio × quality pair means to a model that only accepts one `size` string.
   *
   * Declared on the `quality` spec as `sizes[ratio][quality]`. A missing pair is a refusal, not a
   * rounded guess: vendors accept specific pixel grids, and arithmetic gets them wrong.
   */
  sizes?: Record<string, Record<string, string>>
}

/** The old shape, kept because channels on disk and presets still describe values this way. */
export interface MediaParamOptions {
  duration?: number[]
  resolution?: string[]
  ratio?: string[]
  size?: string[]
  voice?: string[]
  format?: string[]
}

const LEGACY_KEYS = ['duration', 'resolution', 'ratio', 'size', 'voice', 'format'] as const

/** The specs a channel offers: its own, or its legacy `options` turned into selects. */
export function paramSpecsOf(channel: {
  paramSpecs?: MediaParamSpec[]
  options?: MediaParamOptions
  /** The channel's generation defaults; when one names an offered value it becomes the default. */
  params?: Record<string, string | number>
}): MediaParamSpec[] | undefined {
  if (channel.paramSpecs?.length) return channel.paramSpecs
  if (!channel.options) return undefined
  const specs: MediaParamSpec[] = []
  for (const key of LEGACY_KEYS) {
    const values = channel.options[key]
    if (!values?.length) continue
    const preferred = channel.params?.[key]
    const fallback =
      (typeof preferred === 'string' || typeof preferred === 'number') &&
      (values as Array<string | number>).includes(preferred)
        ? preferred
        : values[0]
    // Voices and sizes are examples, not a closed set: an account may know voices and shapes the
    // vendor's public list does not.
    const open = key === 'voice' || key === 'size'
    specs.push({ key, type: 'select', options: values, default: fallback, ...(open ? { allowCustom: true } : {}) })
  }
  return specs.length > 0 ? specs : undefined
}

/**
 * The specs that apply to a model. No model named → everything the channel offers.
 *
 * A capability may declare the same key twice with different model scopes (one `size` for
 * Qwen-Image, another for Wan). Once a model is known only one of them survives; when no model is
 * named the first declaration wins, so the list is never ambiguous to a panel or a default fill.
 */
export function paramsForModel(
  specs: MediaParamSpec[] | undefined,
  model?: string | null,
): MediaParamSpec[] {
  if (!specs?.length) return []
  const byKey = new Map<string, MediaParamSpec>()
  for (const spec of specs) {
    if (spec.models?.length && model && !spec.models.includes(model)) continue
    if (!byKey.has(spec.key)) byKey.set(spec.key, spec)
  }
  return [...byKey.values()]
}

/** A readable name for the parameters every provider shares; a spec's own label still wins. */
const PARAM_LABELS: Record<string, string> = {
  size: '尺寸',
  duration: '时长',
  resolution: '分辨率',
  ratio: '比例',
  voice: '音色',
  format: '格式',
  speed: '速度',
  vol: '音量',
  pitch: '音调',
  emotion: '情绪',
  lyrics: '歌词',
  sample_rate: '采样率',
  bitrate: '码率',
  subtitle: '字幕',
  area: '面积',
  compression: '压缩',
  quality: '画质',
  count: '数量',
  negative_prompt: '反向提示词',
}

export function paramLabelOf(spec: { key: string; label?: string }): string {
  return spec.label ?? PARAM_LABELS[spec.key] ?? spec.key
}

/** What the panel shows: the chosen value, else the default, else the first option. */
export function paramValue(
  spec: MediaParamSpec,
  params: Record<string, string | number>,
): string | number | undefined {
  return params[spec.key] ?? spec.default ?? spec.options?.[0]
}

/**
 * The request's params: defaults first, so what the panel showed is what is sent, then the
 * caller's explicit values. This is a mechanical merge — whether a key is allowed at all is the
 * validator's job, so a misspelt name is refused instead of quietly reaching the provider.
 */
export function withParamDefaults(
  specs: MediaParamSpec[] | undefined,
  params: Record<string, string | number>,
): Record<string, string | number> {
  const next: Record<string, string | number> = {}
  for (const spec of specs ?? []) {
    const value = paramValue(spec, params)
    if (value !== undefined) next[spec.key] = value
  }
  return { ...next, ...params }
}

/** Drop parameters the model does not accept. Used when the person switches models. */
export function pruneParams(
  params: Record<string, string | number>,
  specs: MediaParamSpec[] | undefined,
): Record<string, string | number> {
  if (!specs?.length) return params
  const allowed = new Set(specs.map((spec) => spec.key))
  return Object.fromEntries(Object.entries(params).filter(([key]) => allowed.has(key)))
}

/**
 * The parameters in the provider's vocabulary.
 *
 * Above the wire a card speaks `ratio` + `quality`; a pixel-only model speaks one `size` string.
 * When the quality spec carries a chart, the pair is looked up and replaced. Other keys are only
 * renamed when a spec names its wire field.
 *
 * A pair the chart does not hold is refused: vendors accept specific pixel grids, and rounding to
 * the nearest one would silently change what was asked for.
 */
export function wireParams(
  params: Record<string, string | number>,
  specs: MediaParamSpec[] | undefined,
): Record<string, string | number> {
  const pixel = specs?.find((spec) => spec.sizes)
  if (pixel?.sizes) {
    const ratio = params.ratio
    const tier = params[pixel.key]
    const size = ratio === undefined ? undefined : pixel.sizes[String(ratio)]?.[String(tier ?? '')]
    if (!size) {
      const label = paramLabelOf(pixel)
      throw new MediaFailure(
        'generate',
        ratio === undefined
          ? `请先选一个比例，再选${label}。`
          : `这个模型没有「${String(ratio)} · ${tier === undefined ? '默认' : String(tier)}」这个尺寸，换一个比例或${label}。`,
        { code: 'invalid_request', field: pixel.key },
      )
    }
    const next: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(params)) {
      if (key === 'ratio' || key === pixel.key) continue
      const spec = specs?.find((entry) => entry.key === key)
      next[spec?.wire ?? key] = value
    }
    next.size = size
    return next
  }

  const next: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params)) {
    const spec = specs?.find((entry) => entry.key === key)
    next[spec?.wire ?? key] = value
  }
  return next
}
