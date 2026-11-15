/**
 * Text and picture-in-picture overlays — the layer that sits on top of the cut.
 *
 * A subtitle and a 花字 are the same thing structurally: words with a time window, a box and a
 * look. A picture-in-picture is the same box with a source instead of words. Keeping them one
 * shape means the person, the agent and the exporter all reason about one list.
 *
 * Pure functions only: the document, the renderer and the export page import this module, and
 * none of them should drag a DOM or `fs` along with it.
 */

export type TextPreset = 'subtitle' | 'title' | 'neon' | 'label'

export interface OverlayBox {
  /** Fractions of the composition, top-left origin. */
  x: number
  y: number
  w: number
  h: number
}

export type TextAlign = 'left' | 'center' | 'right'

/** How an overlay's words arrive and leave — MiniMax's `ta.*`. */
export type TextAnimationPreset =
  | 'fade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'scale'
  | 'typewriter'

export const TEXT_ANIMATIONS: Record<TextAnimationPreset, { label: string }> = {
  fade: { label: '淡入' },
  'slide-left': { label: '左滑入' },
  'slide-right': { label: '右滑入' },
  'slide-up': { label: '上滑入' },
  'slide-down': { label: '下滑入' },
  scale: { label: '缩放' },
  typewriter: { label: '打字机' },
}

export interface TextAnimation {
  preset: TextAnimationPreset
  /** Seconds it takes to arrive; omitted means 0.4, 0 means it is there at once. */
  inDuration?: number
  /** Seconds it takes to leave; omitted means 0.3, 0 means it leaves with the cut. */
  outDuration?: number
}

export interface TextStyle {
  fontFamily?: string
  /** Pixels at the composition's own resolution. */
  fontSize?: number
  color?: string
  align?: TextAlign
  bold?: boolean
  italic?: boolean
  strokeColor?: string
  strokeWidth?: number
  backgroundColor?: string
  shadowColor?: string
  shadowBlur?: number
  lineHeight?: number
}

export interface EditOverlay {
  id: string
  /** `text` is words; `media` is a picture or a clip. */
  kind: 'text' | 'media'
  text?: string
  /** Project-relative path for `media`. */
  src?: string
  start: number
  duration: number
  /** Seconds into a video source where the window starts. */
  in?: number
  box?: OverlayBox
  /**
   * A frame around a media overlay's picture — the "picture-in-picture border". Width is in
   * composition pixels (so it reads the same at 1080p and 4K), and the box is matted black behind
   * the picture, so a 16:9 clip in a square box looks framed rather than floating.
   */
  frame?: OverlayFrame
  /** A named look; `style` overrides it. */
  preset?: TextPreset
  style?: TextStyle
  /** 0..1; omitted means fully opaque. */
  opacity?: number
  /** 0..1 for a media overlay's sound. Omitted means 1. */
  volume?: number
  /**
   * Picture-in-picture sound is **off unless it says otherwise** (`muted: false`). A clip in a box
   * usually plays beside the main sound, and a second voice appearing without being asked for is
   * worse than silence; the inspector turns it on deliberately.
   */
  muted?: boolean
  /** Paint order; higher is nearer. */
  z?: number
  /** Words arriving and leaving; a media overlay ignores it. */
  animation?: TextAnimation
}

export interface TextPresetDefinition {
  label: string
  box: OverlayBox
  style: TextStyle
}

/** A frame drawn around a media overlay: stroke width, colour, and corner rounding. */
export interface OverlayFrame {
  /** Composition pixels, 0..40. Zero means no frame (the field is dropped). */
  width: number
  /** Any CSS colour. */
  color: string
  /** Corner radius as a fraction of the box's smaller side, 0..0.5. */
  radius?: number
}

export const TEXT_PRESETS: Record<TextPreset, TextPresetDefinition> = {
  subtitle: {
    label: '字幕',
    box: { x: 0.08, y: 0.78, w: 0.84, h: 0.16 },
    style: {
      fontSize: 46,
      color: '#ffffff',
      align: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      lineHeight: 1.3,
    },
  },
  title: {
    label: '标题',
    box: { x: 0.1, y: 0.36, w: 0.8, h: 0.28 },
    style: {
      fontSize: 96,
      color: '#ffffff',
      align: 'center',
      bold: true,
      strokeColor: '#000000',
      strokeWidth: 4,
      lineHeight: 1.15,
    },
  },
  neon: {
    label: '花字',
    box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 },
    style: {
      fontSize: 84,
      color: '#7df9ff',
      align: 'center',
      bold: true,
      strokeColor: '#0a2a3a',
      strokeWidth: 3,
      shadowColor: '#38f6ff',
      shadowBlur: 24,
      lineHeight: 1.15,
    },
  },
  label: {
    label: '标签',
    box: { x: 0.06, y: 0.08, w: 0.4, h: 0.08 },
    style: {
      fontSize: 36,
      color: '#111111',
      align: 'center',
      bold: true,
      backgroundColor: '#ffe066',
      lineHeight: 1.2,
    },
  },
}

const PRESETS = new Set<string>(Object.keys(TEXT_PRESETS))
const ANIMATIONS = new Set<string>(Object.keys(TEXT_ANIMATIONS))

/** A named text look, checked rather than cast: a typo should be refused, not stored. */
export const isTextPreset = (value: unknown): value is TextPreset =>
  typeof value === 'string' && PRESETS.has(value)

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The box an overlay paints into, with the preset's default and a safe clamp. */
export function resolveOverlayBox(overlay: EditOverlay): OverlayBox {
  const preset = overlay.preset ? TEXT_PRESETS[overlay.preset] : undefined
  const box =
    overlay.box ??
    preset?.box ??
    (overlay.kind === 'media'
      ? { x: 0.68, y: 0.06, w: 0.28, h: 0.28 }
      : { x: 0.08, y: 0.78, w: 0.84, h: 0.16 })
  return {
    x: clamp(box.x, 0, 1),
    y: clamp(box.y, 0, 1),
    w: clamp(box.w, 0.01, 1),
    h: clamp(box.h, 0.01, 1),
  }
}

/** The look of a text overlay: defaults, then the preset, then the overlay's own overrides. */
export function resolveTextStyle(overlay: EditOverlay): Required<
  Pick<TextStyle, 'fontSize' | 'color' | 'align' | 'lineHeight'>
> &
  TextStyle {
  const preset = overlay.preset ? TEXT_PRESETS[overlay.preset] : undefined
  return {
    fontSize: 48,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.3,
    ...preset?.style,
    ...overlay.style,
  }
}

/** How loud a media overlay is: silence unless it was explicitly turned on. */
export function resolveOverlayVolume(overlay: EditOverlay): number {
  if (overlay.kind !== 'media' || overlay.muted !== false) return 0
  return clamp(overlay.volume ?? 1, 0, 1)
}

/** Where an animated overlay is at `local` seconds into its own window. */
export interface TextAnimationFrame {
  /** Multiply into the overlay's own opacity. */
  opacity: number
  /** Offset as a fraction of the overlay box's width. */
  offsetX: number
  /** Offset as a fraction of the overlay box's height. */
  offsetY: number
  /** Scale about the box's centre. */
  scale: number
  /** How many characters are shown — `typewriter`; the full text for every other preset. */
  visible: number
}

const easeOut = (progress: number) => 1 - Math.pow(1 - progress, 3)

/** Offsets for slide presets, as a fraction of the box — the same number preview and canvas use. */
const SLIDE_DISTANCE = 0.2

/**
 * Evaluate a text animation at a moment. Pure, so the preview (Canvas) and the exporter (Canvas)
 * cannot drift: both read this one answer.
 */
export function textAnimationAt(overlay: EditOverlay, local: number): TextAnimationFrame {
  const length = (overlay.text ?? '').length
  const idle: TextAnimationFrame = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1, visible: length }
  const animation = overlay.animation
  if (!animation) return idle

  const inDuration = Math.max(0, animation.inDuration ?? 0.4)
  const outDuration = Math.max(0, animation.outDuration ?? 0.3)
  const arrive = inDuration > 0 ? clamp(local / inDuration, 0, 1) : 1
  const leave =
    outDuration > 0 ? clamp((local - (overlay.duration - outDuration)) / outDuration, 0, 1) : 0
  const entered = easeOut(arrive)
  const left = easeOut(leave)
  const opacity = entered * (1 - left)

  switch (animation.preset) {
    case 'fade':
      return { ...idle, opacity }
    case 'slide-left':
      return {
        ...idle,
        opacity,
        offsetX: -SLIDE_DISTANCE * (1 - entered) - SLIDE_DISTANCE * left,
      }
    case 'slide-right':
      return {
        ...idle,
        opacity,
        offsetX: SLIDE_DISTANCE * (1 - entered) + SLIDE_DISTANCE * left,
      }
    case 'slide-up':
      return {
        ...idle,
        opacity,
        offsetY: -SLIDE_DISTANCE * (1 - entered) - SLIDE_DISTANCE * left,
      }
    case 'slide-down':
      return {
        ...idle,
        opacity,
        offsetY: SLIDE_DISTANCE * (1 - entered) + SLIDE_DISTANCE * left,
      }
    case 'scale':
      return { ...idle, opacity, scale: (0.6 + 0.4 * entered) * (1 - 0.2 * left) }
    case 'typewriter':
      return { ...idle, opacity: 1 - left, visible: Math.round(entered * length) }
    default:
      return idle
  }
}

/** Everything under a moment, back to front. */
export function overlaysAt(overlays: readonly EditOverlay[], time: number): EditOverlay[] {
  return overlays
    .map((overlay, index) => ({ overlay, index }))
    .filter(({ overlay }) => time >= overlay.start && time < overlay.start + overlay.duration)
    .sort((a, b) => (a.overlay.z ?? 0) - (b.overlay.z ?? 0) || a.index - b.index)
    .map(({ overlay }) => overlay)
}

function normalizeStyle(raw: unknown): TextStyle | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const style: TextStyle = {}
  if (typeof value.fontFamily === 'string' && value.fontFamily.trim()) style.fontFamily = value.fontFamily.trim()
  const fontSize = finite(value.fontSize)
  if (fontSize !== undefined && fontSize > 0) style.fontSize = fontSize
  if (typeof value.color === 'string' && value.color.trim()) style.color = value.color.trim()
  if (value.align === 'left' || value.align === 'center' || value.align === 'right') style.align = value.align
  if (typeof value.bold === 'boolean') style.bold = value.bold
  if (typeof value.italic === 'boolean') style.italic = value.italic
  if (typeof value.strokeColor === 'string' && value.strokeColor.trim()) style.strokeColor = value.strokeColor.trim()
  const strokeWidth = finite(value.strokeWidth)
  if (strokeWidth !== undefined && strokeWidth >= 0) style.strokeWidth = strokeWidth
  if (typeof value.backgroundColor === 'string' && value.backgroundColor.trim()) {
    style.backgroundColor = value.backgroundColor.trim()
  }
  if (typeof value.shadowColor === 'string' && value.shadowColor.trim()) style.shadowColor = value.shadowColor.trim()
  const shadowBlur = finite(value.shadowBlur)
  if (shadowBlur !== undefined && shadowBlur >= 0) style.shadowBlur = shadowBlur
  const lineHeight = finite(value.lineHeight)
  if (lineHeight !== undefined && lineHeight > 0) style.lineHeight = lineHeight
  return Object.keys(style).length > 0 ? style : undefined
}

/** A hand-written animation becomes a usable one, or nothing at all. */
function normalizeAnimation(raw: unknown): TextAnimation | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.preset !== 'string' || !ANIMATIONS.has(value.preset)) return undefined
  const inDuration = finite(value.inDuration)
  const outDuration = finite(value.outDuration)
  return {
    preset: value.preset as TextAnimationPreset,
    ...(inDuration !== undefined && inDuration >= 0 ? { inDuration: Math.min(3, inDuration) } : {}),
    ...(outDuration !== undefined && outDuration >= 0 ? { outDuration: Math.min(3, outDuration) } : {}),
  }
}

function normalizeBox(raw: unknown): OverlayBox | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const x = finite(value.x)
  const y = finite(value.y)
  const w = finite(value.w)
  const h = finite(value.h)
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: clamp(w, 0.01, 1), h: clamp(h, 0.01, 1) }
}

/** A frame with no width is no frame: the field is dropped rather than stored as a no-op. */
function normalizeFrame(raw: unknown): OverlayFrame | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const width = finite(value.width)
  if (width === undefined || width <= 0) return undefined
  const color = typeof value.color === 'string' && value.color.trim() ? value.color.trim() : '#ffffff'
  const radius = finite(value.radius)
  return {
    width: clamp(width, 0.5, 40),
    color,
    ...(radius !== undefined ? { radius: clamp(radius, 0, 0.5) } : {}),
  }
}

/** A half-written or hand-edited overlay becomes a usable one, or nothing at all. */
export function normalizeOverlay(raw: unknown, index: number): EditOverlay | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const kind = value.kind === 'media' ? 'media' : 'text'
  const text = typeof value.text === 'string' ? value.text : undefined
  const src = typeof value.src === 'string' && value.src.trim() ? value.src.trim() : undefined
  if (kind === 'media' && !src) return null
  const start = Math.max(0, finite(value.start) ?? 0)
  const duration = Math.max(0.05, finite(value.duration) ?? 2.5)
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `ov-${index + 1}`
  const box = normalizeBox(value.box)
  const frame = normalizeFrame(value.frame)
  const style = normalizeStyle(value.style)
  const animation = normalizeAnimation(value.animation)
  const offset = finite(value.in)
  const opacity = finite(value.opacity)
  const volume = finite(value.volume)
  const z = finite(value.z)
  return {
    id,
    kind,
    ...(kind === 'text' ? { text: text ?? '' } : { src }),
    start,
    duration,
    ...(offset !== undefined ? { in: Math.max(0, offset) } : {}),
    ...(box ? { box } : {}),
    ...(kind === 'media' && frame ? { frame } : {}),
    ...(typeof value.preset === 'string' && PRESETS.has(value.preset)
      ? { preset: value.preset as TextPreset }
      : {}),
    ...(style ? { style } : {}),
    ...(opacity !== undefined ? { opacity: clamp(opacity, 0, 1) } : {}),
    ...(volume !== undefined ? { volume: clamp(volume, 0, 1) } : {}),
    ...(typeof value.muted === 'boolean' ? { muted: value.muted } : {}),
    ...(z !== undefined ? { z } : {}),
    ...(kind === 'text' && animation ? { animation } : {}),
  }
}
