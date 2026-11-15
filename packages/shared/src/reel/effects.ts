/**
 * Colour grading for a clip — the 滤镜 tab.
 *
 * The shape is deliberately the intersection of what CSS and Canvas can both do: brightness,
 * contrast, saturation, hue rotation and blur, which become one `filter` string. Both the preview
 * and the exporter set it on `ctx.filter`, so a graded frame looks the same in both — no second
 * colour pipeline, no per-renderer constants.
 *
 * Pure functions only: the document, the panel and the export page import this module.
 */

export type EffectPreset = 'none' | 'cinema' | 'warm' | 'cool' | 'vivid' | 'mono' | 'fade'

export type BlurRegionMode = 'blur' | 'mosaic'

/**
 * A rectangle of the picture to blur or pixelate — a watermark, a logo, a face.
 *
 * Bounds are fractions of the composition, like a mask, so the region stays put while the clip
 * moves under it. `strength` is the blur radius or the mosaic cell size, in composition pixels.
 */
export interface BlurRegion {
  x: number
  y: number
  w: number
  h: number
  mode: BlurRegionMode
  strength: number
}

/** A clip's grade, stored as only the values that differ from neutral. */
export interface ClipEffect {
  /** 0..2, 1 is untouched. */
  brightness?: number
  /** 0..2, 1 is untouched. */
  contrast?: number
  /** 0..2, 1 is untouched; 0 is black and white. */
  saturation?: number
  /** Degrees, -180..180; 0 is untouched. */
  hue?: number
  /** Gaussian blur in composition pixels, 0..20; 0 is off. */
  blur?: number
  /** The named look this was started from; explicit numbers still win over it. */
  preset?: EffectPreset
  /** Local blurs and mosaics over this clip, applied after the grade. */
  regions?: BlurRegion[]
}

/** Every value, filled in — what the renderers actually apply. */
export interface ResolvedEffect {
  brightness: number
  contrast: number
  saturation: number
  hue: number
  blur: number
}

export const NEUTRAL_EFFECT: ResolvedEffect = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  blur: 0,
}

export const EFFECT_PRESETS: Record<EffectPreset, { label: string; effect: ResolvedEffect }> = {
  none: { label: '原片', effect: NEUTRAL_EFFECT },
  cinema: {
    label: '电影',
    effect: { brightness: 0.97, contrast: 1.14, saturation: 0.88, hue: -4, blur: 0 },
  },
  warm: {
    label: '暖阳',
    effect: { brightness: 1.04, contrast: 1.02, saturation: 1.08, hue: -10, blur: 0 },
  },
  cool: {
    label: '冷调',
    effect: { brightness: 0.98, contrast: 1.04, saturation: 1.02, hue: 12, blur: 0 },
  },
  vivid: {
    label: '鲜艳',
    effect: { brightness: 1.02, contrast: 1.08, saturation: 1.35, hue: 0, blur: 0 },
  },
  mono: { label: '黑白', effect: { brightness: 1, contrast: 1.06, saturation: 0, hue: 0, blur: 0 } },
  fade: {
    label: '褪色',
    effect: { brightness: 1.06, contrast: 0.9, saturation: 0.72, hue: 0, blur: 0 },
  },
}

const PRESETS = new Set<string>(Object.keys(EFFECT_PRESETS))

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Preset first, then whatever the clip pins explicitly. */
export function resolveEffect(effect?: ClipEffect): ResolvedEffect {
  if (!effect) return NEUTRAL_EFFECT
  const preset = effect.preset && effect.preset !== 'none' ? EFFECT_PRESETS[effect.preset]?.effect : undefined
  return {
    brightness: clamp(effect.brightness ?? preset?.brightness ?? 1, 0, 2),
    contrast: clamp(effect.contrast ?? preset?.contrast ?? 1, 0, 2),
    saturation: clamp(effect.saturation ?? preset?.saturation ?? 1, 0, 2),
    hue: clamp(effect.hue ?? preset?.hue ?? 0, -180, 180),
    blur: clamp(effect.blur ?? preset?.blur ?? 0, 0, 20),
  }
}

export function isNeutralEffect(effect: ResolvedEffect): boolean {
  return (
    effect.brightness === 1 &&
    effect.contrast === 1 &&
    effect.saturation === 1 &&
    effect.hue === 0 &&
    effect.blur === 0
  )
}

const round = (value: number) => Math.round(value * 1000) / 1000

/**
 * One filter string for both renderers. `brightness/contrast/saturate/hue-rotate/blur` are the
 * CSS filter functions Canvas also accepts in `ctx.filter`.
 */
export function effectFilter(effect: ResolvedEffect): string {
  const parts: string[] = []
  if (effect.brightness !== 1) parts.push(`brightness(${round(effect.brightness)})`)
  if (effect.contrast !== 1) parts.push(`contrast(${round(effect.contrast)})`)
  if (effect.saturation !== 1) parts.push(`saturate(${round(effect.saturation)})`)
  if (effect.hue !== 0) parts.push(`hue-rotate(${round(effect.hue)}deg)`)
  if (effect.blur > 0) parts.push(`blur(${round(effect.blur)}px)`)
  return parts.length > 0 ? parts.join(' ') : 'none'
}

/**
 * A hand-edited grade becomes a usable one, or nothing at all. Values equal to neutral are
 * dropped so a file only carries what it actually changes.
 */
export function normalizeEffect(raw: unknown): ClipEffect | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const effect: ClipEffect = {}

  const brightness = finite(value.brightness)
  if (brightness !== undefined && brightness !== 1) effect.brightness = clamp(brightness, 0, 2)
  const contrast = finite(value.contrast)
  if (contrast !== undefined && contrast !== 1) effect.contrast = clamp(contrast, 0, 2)
  const saturation = finite(value.saturation)
  if (saturation !== undefined && saturation !== 1) effect.saturation = clamp(saturation, 0, 2)
  const hue = finite(value.hue)
  if (hue !== undefined && hue !== 0) effect.hue = clamp(hue, -180, 180)
  const blur = finite(value.blur)
  if (blur !== undefined && blur > 0) effect.blur = clamp(blur, 0, 20)

  if (typeof value.preset === 'string' && value.preset !== 'none' && PRESETS.has(value.preset)) {
    effect.preset = value.preset as EffectPreset
  }

  if (Array.isArray(value.regions)) {
    const regions: BlurRegion[] = []
    for (const entry of value.regions) {
      if (!entry || typeof entry !== 'object') continue
      const region = entry as Record<string, unknown>
      const mode: BlurRegionMode = region.mode === 'mosaic' ? 'mosaic' : 'blur'
      const w = clamp(finite(region.w) ?? 0.2, 0.01, 1)
      const h = clamp(finite(region.h) ?? 0.2, 0.01, 1)
      const x = clamp(finite(region.x) ?? 0, 0, 1 - w)
      const y = clamp(finite(region.y) ?? 0, 0, 1 - h)
      const strength = clamp(finite(region.strength) ?? (mode === 'mosaic' ? 16 : 12), 1, 60)
      regions.push({ x, y, w, h, mode, strength })
    }
    if (regions.length > 0) effect.regions = regions
  }

  return Object.keys(effect).length > 0 ? effect : undefined
}
