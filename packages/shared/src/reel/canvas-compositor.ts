/**
 * One composition, painted once — the code the exporter and the preview share.
 *
 * A cut is drawn the same way whether it is going into an encoder or onto the player's canvas:
 * the picture under a moment, its transition from the clip before it, then the overlays back to
 * front. Keeping the painting here is what makes a paused preview and an exported frame agree;
 * each side only has to say **where a frame comes from** (`PictureSource`), which is the one thing
 * that genuinely differs — MediaBunny's samples in the export page, a hidden `<video>` in the
 * panel.
 *
 * Pure of time and of the DOM beyond `CanvasRenderingContext2D`: it draws at the moment it is
 * handed, so it can run for an encoder frame or a player frame without knowing which it is.
 */

import {
  arrivalStyle,
  clipVisualAt,
  isLayeredTransition,
  maskAt,
  type ClipTransform,
  type CropRect,
  type EditMask,
  type TransformKeyframe,
  type TransitionKind,
} from './document.ts'
import { traceMaskShape } from './masks.ts'
import {
  overlaysAt,
  resolveOverlayBox,
  resolveTextStyle,
  textAnimationAt,
  type EditOverlay,
} from './overlay.ts'
import { effectFilter, resolveEffect, type BlurRegion, type ClipEffect } from './effects.ts'

/** The clip fields the painter needs — `ExportClip` and `EditClip` both satisfy this. */
export interface RenderClip {
  /** Source path; only used by the caller's picture source. */
  path: string
  in: number
  duration: number
  /** Where this piece sits on the timeline. */
  start: number
  kind: 'video' | 'image' | 'audio'
  /** Higher tracks cover lower ones when pictures overlap. */
  track: number
  transform?: ClipTransform
  /** 0..1; omitted means fully opaque. */
  opacity?: number
  /** Placement over time. When present these replace `transform`/`opacity` for this clip — the
   * painter asks `clipVisualAt` what the moment looks like rather than reading the static fields. */
  keyframes?: TransformKeyframe[]
  /** A window onto the source, in fractions of its frame. */
  crop?: CropRect
  /** A held frame: the source time stays at `in` for the whole clip. */
  freeze?: true
  /** Colour grading, as the same filter string CSS and canvas understand. */
  effect?: ClipEffect
  /** The transition that brings this clip in from the clip immediately before it. */
  transition?: { kind: TransitionKind; duration: number }
  /** Playback speed; not painted, but a frame source needs it to run the element at the rate. */
  speed?: number
  /** The track is hidden: its sound is mixed, its picture is not drawn. */
  hidden?: boolean
  /** Shape masks over this clip, combined in order (normal adds, inverted subtracts). */
  masks?: EditMask[]
}

/** One decoded frame, ready to paint at a rectangle. */
export interface Picture {
  width: number
  height: number
  draw: (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) => void
  /** Free the frame after it has been drawn (an encoded sample owns memory). */
  release?: () => void
}

/** Where a clip's picture at a local moment comes from. May be async — the export decodes. */
export type PictureSource = (
  clip: RenderClip,
  local: number,
) => Picture | null | Promise<Picture | null>

/** Where a media overlay's picture at a local moment comes from. */
export type OverlayPictureSource = (
  overlay: EditOverlay,
  local: number,
) => Picture | null | Promise<Picture | null>

/**
 * Draw one picture at its contain fit, after the clip's transform. The transform is applied about
 * the composition centre, the same convention the inspector's numbers use.
 */
export function drawPicture(
  ctx: CanvasRenderingContext2D,
  canvas: { width: number; height: number },
  clip: RenderClip,
  naturalWidth: number,
  naturalHeight: number,
  draw: (x: number, y: number, width: number, height: number) => void,
  alphaScale = 1,
): void {
  const transform = clip.transform
  const x = transform?.x ?? 0
  const y = transform?.y ?? 0
  const scale = transform?.scale ?? 1
  const rotation = transform?.rotation ?? 0
  const radius = transform?.radius ?? 0

  ctx.save()
  ctx.globalAlpha = Math.min(1, Math.max(0, clip.opacity ?? 1)) * Math.min(1, Math.max(0, alphaScale))
  // Canvas accepts the same filter functions CSS does, so a graded frame matches the preview.
  const filter = effectFilter(resolveEffect(clip.effect))
  if (filter !== 'none') ctx.filter = filter
  ctx.translate(canvas.width / 2 + x * canvas.width, canvas.height / 2 + y * canvas.height)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.scale(scale, scale)
  // Mirror in the clip's own frame, so a crop window and its content flip together.
  if (transform?.flipX) ctx.scale(-1, 1)

  const crop = clip.crop
  if (crop) {
    // The crop is fitted as if it were the frame: a 4:3 window of a 16:9 source fills a 4:3
    // composition. The whole picture is then drawn shifted so that window lands at the origin,
    // and the clip removes everything outside it.
    const cropWidth = Math.max(1, naturalWidth * crop.w)
    const cropHeight = Math.max(1, naturalHeight * crop.h)
    const fit = Math.min(canvas.width / cropWidth, canvas.height / cropHeight)
    const windowWidth = cropWidth * fit
    const windowHeight = cropHeight * fit
    const fullWidth = naturalWidth * fit
    const fullHeight = naturalHeight * fit
    const left = -windowWidth / 2
    const top = -windowHeight / 2
    if (radius > 0) {
      roundedRect(ctx, left, top, windowWidth, windowHeight, Math.min(windowWidth, windowHeight) * radius)
      ctx.clip()
    }
    const offsetX = (crop.x + crop.w / 2 - 0.5) * fullWidth
    const offsetY = (crop.y + crop.h / 2 - 0.5) * fullHeight
    draw(-fullWidth / 2 - offsetX, -fullHeight / 2 - offsetY, fullWidth, fullHeight)
    ctx.restore()
    return
  }

  const fit = Math.min(canvas.width / naturalWidth, canvas.height / naturalHeight)
  const width = naturalWidth * fit
  const height = naturalHeight * fit
  const left = -width / 2
  const top = -height / 2
  if (radius > 0) {
    roundedRect(ctx, left, top, width, height, Math.min(width, height) * radius)
    ctx.clip()
  }
  draw(left, top, width, height)
  ctx.restore()
}

export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** Break words the way the preview does: per character, honouring explicit newlines. */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('')
      continue
    }
    let line = ''
    for (const char of Array.from(paragraph)) {
      const candidate = line + char
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line)
        line = char
      } else {
        line = candidate
      }
    }
    lines.push(line)
  }
  return lines.length > 0 ? lines : ['']
}

/** Paint one text overlay: background band, stroke, glow, then the words. */
export function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: EditOverlay,
  canvas: { width: number; height: number },
  local: number,
): void {
  const box = resolveOverlayBox(overlay)
  const style = resolveTextStyle(overlay)
  const animation = textAnimationAt(overlay, local)
  const x = box.x * canvas.width
  const y = box.y * canvas.height
  const width = box.w * canvas.width
  const height = box.h * canvas.height
  const padding = style.backgroundColor ? Math.max(6, style.fontSize * 0.3) : 0

  ctx.save()
  ctx.globalAlpha = (overlay.opacity ?? 1) * animation.opacity
  // The arrival motion is applied about the box centre, exactly as the preview does.
  if (animation.offsetX !== 0 || animation.offsetY !== 0 || animation.scale !== 1) {
    const centreX = x + width / 2
    const centreY = y + height / 2
    ctx.translate(centreX + animation.offsetX * width, centreY + animation.offsetY * height)
    ctx.scale(animation.scale, animation.scale)
    ctx.translate(-centreX, -centreY)
  }
  ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${style.fontSize}px ${
    style.fontFamily ?? 'system-ui, sans-serif'
  }`
  ctx.textBaseline = 'top'
  ctx.textAlign = style.align

  // A typewriter shows only the characters it has typed so far.
  const words = (overlay.text ?? '').slice(0, animation.visible)
  const lines = wrapLines(ctx, words, Math.max(10, width - padding * 2))
  const lineHeight = style.fontSize * (style.lineHeight ?? 1.3)
  const blockHeight = Math.max(lineHeight, lines.length * lineHeight)
  const blockWidth = Math.min(
    Math.max(10, width - padding * 2),
    Math.max(0, ...lines.map((line) => ctx.measureText(line).width)),
  )
  const top = y + (height - blockHeight) / 2
  const left =
    style.align === 'left' ? x + padding : style.align === 'right' ? x + width - padding : x + width / 2

  if (style.backgroundColor) {
    const backgroundWidth = Math.min(width, blockWidth + padding * 2)
    const backgroundX =
      style.align === 'left'
        ? x
        : style.align === 'right'
          ? x + width - backgroundWidth
          : x + (width - backgroundWidth) / 2
    ctx.fillStyle = style.backgroundColor
    roundedRect(
      ctx,
      backgroundX,
      y + (height - blockHeight - padding * 2) / 2,
      backgroundWidth,
      blockHeight + padding * 2,
      Math.min(14, padding),
    )
    ctx.fill()
  }

  if (style.shadowColor) {
    ctx.shadowColor = style.shadowColor
    ctx.shadowBlur = style.shadowBlur ?? 12
  }

  lines.forEach((line, index) => {
    const lineY = top + index * lineHeight
    if (style.strokeWidth) {
      ctx.lineWidth = style.strokeWidth
      ctx.strokeStyle = style.strokeColor ?? '#000000'
      ctx.strokeText(line, left, lineY)
    }
    ctx.fillStyle = style.color
    ctx.fillText(line, left, lineY)
  })
  ctx.restore()
}

/** Paint a picture-in-picture box: contain fit inside the overlay's box. */
export function drawOverlayPicture(
  ctx: CanvasRenderingContext2D,
  overlay: EditOverlay,
  canvas: { width: number; height: number },
  picture: Picture,
): void {
  const box = resolveOverlayBox(overlay)
  const x = box.x * canvas.width
  const y = box.y * canvas.height
  const width = box.w * canvas.width
  const height = box.h * canvas.height
  const scale = Math.min(width / picture.width, height / picture.height)
  const drawnWidth = picture.width * scale
  const drawnHeight = picture.height * scale
  const frame = overlay.frame
  const radius = frame?.radius ? Math.min(width, height) * frame.radius : 0
  const alpha = Math.min(1, Math.max(0, overlay.opacity ?? 1))

  ctx.save()
  ctx.globalAlpha = alpha
  if (frame) {
    // A frame implies a matte: the box is filled black behind the picture, so a 16:9 clip in a
    // square box reads as a framed window rather than a picture floating over the film.
    roundedRect(ctx, x, y, width, height, radius)
    ctx.fillStyle = '#000000'
    ctx.fill()
    roundedRect(ctx, x, y, width, height, radius)
    ctx.clip()
  }
  picture.draw(ctx, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight)
  ctx.restore()

  if (frame && frame.width > 0) {
    // Half the stroke sits inside the edge and half outside — the same reading as a CSS border.
    const inset = Math.min(frame.width / 2, width / 2, height / 2)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = frame.color
    ctx.lineWidth = frame.width
    roundedRect(
      ctx,
      x + inset,
      y + inset,
      Math.max(1, width - inset * 2),
      Math.max(1, height - inset * 2),
      Math.max(0, radius - inset),
    )
    ctx.stroke()
    ctx.restore()
  }
}

/** The clip that owns the picture at a moment: the topmost track with a clip under it. */
export function ownerAt(clips: readonly RenderClip[], time: number): RenderClip | null {
  let owner: RenderClip | null = null
  for (const clip of clips) {
    if (clip.kind === 'audio' || clip.hidden) continue
    if (time < clip.start || time >= clip.start + clip.duration) continue
    // On one track, the clip that starts later covers the earlier one — the same rule as
    // `videoClipAt`, so the document's answer and the painted picture agree when clips overlap.
    if (
      !owner ||
      clip.track > owner.track ||
      (clip.track === owner.track && clip.start >= owner.start)
    ) {
      owner = clip
    }
  }
  return owner
}

/** Picture clips grouped by track, so a transition can find both of its sides. */
export function pictureTracksOf(clips: readonly RenderClip[]): Map<number, RenderClip[]> {
  const tracks = new Map<number, RenderClip[]>()
  for (const clip of clips) {
    if (clip.kind === 'audio' || clip.hidden) continue
    const list = tracks.get(clip.track) ?? []
    list.push(clip)
    tracks.set(clip.track, list)
  }
  for (const list of tracks.values()) list.sort((left, right) => left.start - right.start)
  return tracks
}

/** A transition covering a moment, with both sides' local times. */
export interface TransitionFrame {
  kind: TransitionKind
  progress: number
  from: { clip: RenderClip; local: number }
  to: { clip: RenderClip; local: number }
}

const held = (target: RenderClip, local: number) =>
  Math.min(Math.max(0, local), Math.max(0, target.duration - 1e-3))

/**
 * Mirrors `transitionAt` in the document, over a flat clip list. A transition is centred on the
 * cut; whichever side is outside its own window holds its edge frame.
 */
export function transitionFrameAt(
  tracks: Map<number, RenderClip[]>,
  time: number,
): TransitionFrame | null {
  const trackIndexes = [...tracks.keys()].sort((left, right) => right - left)
  for (const trackIndex of trackIndexes) {
    const clips = tracks.get(trackIndex)!
    const current = clips.find((item) => time >= item.start && time < item.start + item.duration)
    if (!current) continue
    const next = clips.find((item) => Math.abs(item.start - (current.start + current.duration)) < 1e-6)
    const previous = clips.find((item) => Math.abs(item.start + item.duration - current.start) < 1e-6)
    if (next?.transition) {
      const half = next.transition.duration / 2
      const cut = current.start + current.duration
      if (time >= cut - half) {
        return {
          kind: next.transition.kind,
          progress: Math.min(1, Math.max(0, (time - (cut - half)) / next.transition.duration)),
          from: { clip: current, local: held(current, time - current.start) },
          to: { clip: next, local: held(next, time - next.start) },
        }
      }
    }
    if (current.transition && previous) {
      const half = current.transition.duration / 2
      if (time < current.start + half) {
        return {
          kind: current.transition.kind,
          progress: Math.min(
            1,
            Math.max(0, (time - (current.start - half)) / current.transition.duration),
          ),
          from: { clip: previous, local: held(previous, time - previous.start) },
          to: { clip: current, local: held(current, time - current.start) },
        }
      }
    }
    return null
  }
  return null
}

/** Await only when a source actually returns a promise, so a synchronous preview draws atomically. */
const isThenable = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof (value as Promise<T> | null)?.then === 'function'

type LayerCanvas = HTMLCanvasElement | OffscreenCanvas

interface MaskScratch {
  width: number
  height: number
  layer: LayerCanvas
  layerCtx: CanvasRenderingContext2D
  mask: LayerCanvas
  maskCtx: CanvasRenderingContext2D
}

/** One reusable pair of canvases: masking allocates nothing per frame. */
let maskScratch: MaskScratch | null = null

function layerCanvas(width: number, height: number): LayerCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      return new OffscreenCanvas(width, height)
    } catch {
      return null
    }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }
  return null
}

function scratchFor(width: number, height: number): MaskScratch | null {
  if (maskScratch && maskScratch.width === width && maskScratch.height === height) {
    return maskScratch
  }
  const layer = layerCanvas(width, height)
  const mask = layerCanvas(width, height)
  if (!layer || !mask) return null
  const layerCtx = layer.getContext('2d') as CanvasRenderingContext2D | null
  const maskCtx = mask.getContext('2d') as CanvasRenderingContext2D | null
  if (!layerCtx || !maskCtx) return null
  maskScratch = { width, height, layer, layerCtx, mask, maskCtx }
  return maskScratch
}

/**
 * Paint the combined mask: normal shapes add, inverted shapes cut away, and the first inverted
 * one starts from a full frame. `feather` blurs each shape as it is painted, so an edge stays soft
 * rather than becoming a hard staircase.
 */
function paintMask(
  ctx: CanvasRenderingContext2D,
  masks: readonly EditMask[],
  width: number,
  height: number,
): void {
  ctx.save()
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#ffffff'
  ctx.filter = 'none'
  let first = true
  for (const mask of masks) {
    const opacity = Math.min(1, Math.max(0, Number.isFinite(mask.opacity) ? mask.opacity : 1))
    if (opacity <= 0) continue
    if (first && mask.inverted) {
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillRect(0, 0, width, height)
    }
    first = false
    ctx.globalAlpha = opacity
    ctx.globalCompositeOperation = mask.inverted ? 'destination-out' : 'source-over'
    ctx.filter = mask.feather > 0 ? `blur(${mask.feather}px)` : 'none'
    traceMaskShape(ctx, mask, width, height)
    ctx.fill()
  }
  ctx.restore()
}

function applyMasks(
  layerCtx: CanvasRenderingContext2D,
  masks: readonly EditMask[],
  width: number,
  height: number,
): boolean {
  const scratch = scratchFor(width, height)
  if (!scratch) return false
  paintMask(scratch.maskCtx, masks, width, height)
  layerCtx.save()
  layerCtx.globalCompositeOperation = 'destination-in'
  layerCtx.filter = 'none'
  layerCtx.drawImage(scratch.mask, 0, 0)
  layerCtx.restore()
  return true
}

/**
 * Blur or pixelate rectangles of the painted clip. The region is sampled from the layer itself,
 * so it covers whatever the clip drew there — a watermark, a logo, a face — after the grade and
 * before any mask.
 */
function applyRegions(
  layerCtx: CanvasRenderingContext2D,
  regions: readonly BlurRegion[],
  width: number,
  height: number,
): void {
  if (regions.length === 0) return
  const scratch = scratchFor(width, height)
  if (!scratch) return
  const { mask, maskCtx } = scratch

  for (const region of regions) {
    const x = Math.max(0, Math.min(width - 1, region.x * width))
    const y = Math.max(0, Math.min(height - 1, region.y * height))
    const w = Math.max(1, Math.min(width - x, region.w * width))
    const h = Math.max(1, Math.min(height - y, region.h * height))

    maskCtx.save()
    maskCtx.globalCompositeOperation = 'source-over'
    maskCtx.globalAlpha = 1
    maskCtx.clearRect(0, 0, width, height)
    if (region.mode === 'mosaic') {
      const cell = Math.max(2, Math.min(64, region.strength))
      const smallWidth = Math.max(1, Math.floor(w / cell))
      const smallHeight = Math.max(1, Math.floor(h / cell))
      maskCtx.imageSmoothingEnabled = true
      maskCtx.drawImage(layerCtx.canvas, x, y, w, h, 0, 0, smallWidth, smallHeight)
      layerCtx.save()
      layerCtx.beginPath()
      layerCtx.rect(x, y, w, h)
      layerCtx.clip()
      layerCtx.imageSmoothingEnabled = false
      layerCtx.drawImage(mask, 0, 0, smallWidth, smallHeight, x, y, w, h)
      layerCtx.imageSmoothingEnabled = true
      layerCtx.restore()
    } else {
      maskCtx.filter = `blur(${Math.max(1, Math.min(60, region.strength))}px)`
      maskCtx.drawImage(layerCtx.canvas, 0, 0)
      layerCtx.save()
      layerCtx.beginPath()
      layerCtx.rect(x, y, w, h)
      layerCtx.clip()
      layerCtx.filter = 'none'
      layerCtx.drawImage(mask, 0, 0)
      layerCtx.restore()
    }
    maskCtx.restore()
  }
}

export interface CompositionFrame {
  ctx: CanvasRenderingContext2D
  /** Composition size in pixels. */
  canvas: { width: number; height: number }
  clips: readonly RenderClip[]
  overlays: readonly EditOverlay[]
  /** Timeline seconds. */
  time: number
  pictureOf: PictureSource
  overlayPictureOf: OverlayPictureSource
}

/**
 * Paint one composition frame: black ground, the picture (and its transition), then overlays back
 * to front. Callers supply the frame sources; everything else is the document's own answer.
 */
export async function drawComposition(frame: CompositionFrame): Promise<void> {
  const { ctx, canvas, clips, overlays, time, pictureOf, overlayPictureOf } = frame
  ctx.save()
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()

  const pictures = pictureTracksOf(clips)
  const transition = transitionFrameAt(pictures, time)
  const owner = ownerAt(clips, time)

  const drawClip = async (clip: RenderClip, local: number, alphaScale: number) => {
    const source = pictureOf(clip, local)
    const picture = isThenable(source) ? await source : source
    if (!picture) return
    // Keyframed placement is resolved here, so the preview, the snapshot and the export all read
    // the same interpolated transform for the same moment.
    const visual = clipVisualAt(clip, local)
    const styled: RenderClip = { ...clip, transform: visual.transform, opacity: visual.opacity }
    const paint = (target: CanvasRenderingContext2D): void =>
      drawPicture(
        target,
        canvas,
        styled,
        picture.width,
        picture.height,
        (x, y, width, height) => picture.draw(target, x, y, width, height),
        alphaScale,
      )

    // A keyframed mask is resolved at the same clip-local moment as placement, so a moving box
    // reads from one place on every path that paints this clip.
    const masks = (clip.masks ?? []).map((mask) => maskAt(mask, local))
    const regions = clip.effect?.regions ?? []
    if (masks.length === 0 && regions.length === 0) {
      paint(ctx)
    } else {
      // Masking and regional blur both need the clip as its own layer: the picture is drawn
      // whole, edited in place, and only then does the layer reach the frame.
      const scratch = scratchFor(canvas.width, canvas.height)
      if (!scratch) {
        paint(ctx)
      } else {
        scratch.layerCtx.clearRect(0, 0, canvas.width, canvas.height)
        paint(scratch.layerCtx)
        applyRegions(scratch.layerCtx, regions, canvas.width, canvas.height)
        if (masks.length === 0 || applyMasks(scratch.layerCtx, masks, canvas.width, canvas.height)) {
          ctx.save()
          ctx.globalAlpha = 1
          ctx.filter = 'none'
          ctx.globalCompositeOperation = 'source-over'
          ctx.drawImage(scratch.layer, 0, 0)
          ctx.restore()
        } else {
          paint(ctx)
        }
      }
    }
    picture.release?.()
  }

  if (transition) {
    if (isLayeredTransition(transition.kind)) {
      // The outgoing picture is the base; the incoming one arrives on top with its own motion.
      await drawClip(transition.from.clip, transition.from.local, 1)
      const arrival = arrivalStyle(transition.kind, transition.progress)
      ctx.save()
      if (arrival.wipe < 1) {
        ctx.beginPath()
        ctx.rect(0, 0, canvas.width * arrival.wipe, canvas.height)
        ctx.clip()
      }
      if (arrival.slide > 0) ctx.translate(canvas.width * arrival.slide, 0)
      if (arrival.scale !== 1) {
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.scale(arrival.scale, arrival.scale)
        ctx.translate(-canvas.width / 2, -canvas.height / 2)
      }
      await drawClip(transition.to.clip, transition.to.local, arrival.opacity)
      ctx.restore()
    } else {
      const phase = transition.progress < 0.5 ? transition.from : transition.to
      await drawClip(phase.clip, phase.local, 1)
      const strength = 1 - Math.abs(transition.progress * 2 - 1)
      ctx.save()
      ctx.globalAlpha = strength
      ctx.fillStyle = transition.kind === 'dip-black' ? '#000000' : '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
    }
  } else if (owner) {
    await drawClip(owner, time - owner.start, 1)
  }

  // Overlays are painted back to front: words, then boxes with a picture.
  for (const overlay of overlaysAt(overlays, time)) {
    const local = time - overlay.start
    if (overlay.kind === 'text') {
      drawTextOverlay(ctx, overlay, canvas, local)
      continue
    }
    const source = overlayPictureOf(overlay, local)
    const picture = isThenable(source) ? await source : source
    if (!picture) continue
    drawOverlayPicture(ctx, overlay, canvas, picture)
    picture.release?.()
  }
}
