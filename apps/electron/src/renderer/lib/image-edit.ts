/**
 * Local image edits — the picture's own arithmetic.
 *
 * Crop, right angles, mirrors, scaling and format changes need no provider, no workflow and no key.
 * Kept out of the canvas component so the geometry can be checked without a DOM, and kept in the
 * renderer because the browser already decodes every format the person can drop on the board.
 */

import type { CanvasNode } from '@craft-agent/shared/canvas/document'

export type ImageEditOp = 'crop' | 'rotate' | 'flip' | 'resize' | 'convert'

export interface ImageEditSpec {
  op: ImageEditOp
  params: Record<string, string | number>
}

export interface RenderedImageEdit {
  base64: string
  ext: string
  width: number
  height: number
  /** The params worth remembering: a crop is resolved to source pixels so a replay is exact. */
  params: Record<string, string | number>
}

/** Aspect presets for the crop dialog, in the order a person reaches for them. */
export const CROP_RATIOS = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
] as const

export const RESIZE_SCALES = [0.25, 0.5, 0.75, 1.5, 2] as const

export interface ImageEditGeometry {
  /** Source rectangle, in source pixels. */
  sx: number
  sy: number
  sw: number
  sh: number
  /** Clockwise, degrees. Only 0, 90, 180 and 270. */
  angle: number
  flipX: boolean
  flipY: boolean
  /** Output size after rotation and scaling. */
  width: number
  height: number
  scale: number
  /** What to remember on the node, with a crop resolved to pixels. */
  params: Record<string, string | number>
}

/**
 * Where the pixels come from and how they are placed.
 *
 * A crop either names a rectangle or a ratio; a ratio means "the middle of the picture, at this
 * aspect", because a dialog with no frame to drag can only mean the middle.
 */
export function computeImageEditGeometry(
  naturalW: number,
  naturalH: number,
  spec: ImageEditSpec,
): ImageEditGeometry {
  if (!naturalW || !naturalH) throw new Error('The image has no readable size.')

  let sx = 0
  let sy = 0
  let sw = naturalW
  let sh = naturalH
  let angle = 0
  let flipX = false
  let flipY = false
  let scale = 1
  const params: Record<string, string | number> = { ...spec.params }

  if (spec.op === 'crop') {
    const rect = ['left', 'top', 'width', 'height'].map((key) => Number(spec.params[key]))
    const [left, top, width, height] = rect
    if (rect.every(Number.isFinite) && width! > 0 && height! > 0) {
      sx = Math.max(0, Math.round(left!))
      sy = Math.max(0, Math.round(top!))
      sw = Math.max(1, Math.min(naturalW - sx, Math.round(width!)))
      sh = Math.max(1, Math.min(naturalH - sy, Math.round(height!)))
    } else {
      const ratio = Number(spec.params.ratio ?? 1)
      if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('The crop ratio must be greater than zero.')
      sw = Math.min(naturalW, Math.round(naturalH * ratio))
      sh = Math.max(1, Math.round(sw / ratio))
      sx = Math.round((naturalW - sw) / 2)
      sy = Math.round((naturalH - sh) / 2)
    }
    Object.assign(params, { left: sx, top: sy, width: sw, height: sh })
  } else if (spec.op === 'rotate') {
    angle = ((Number(spec.params.angle ?? 90) % 360) + 360) % 360
    if (angle !== 90 && angle !== 180 && angle !== 270) {
      throw new Error('A local rotation is 90, 180 or 270 degrees.')
    }
  } else if (spec.op === 'flip') {
    const axis = spec.params.axis === 'vertical' ? 'vertical' : 'horizontal'
    flipX = axis === 'horizontal'
    flipY = axis === 'vertical'
    params.axis = axis
  } else if (spec.op === 'resize') {
    scale = Number(spec.params.scale ?? 1)
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('The scale must be greater than zero.')
  }

  const swapped = angle === 90 || angle === 270
  return {
    sx,
    sy,
    sw,
    sh,
    angle,
    flipX,
    flipY,
    scale,
    width: Math.max(1, Math.round((swapped ? sh : sw) * scale)),
    height: Math.max(1, Math.round((swapped ? sw : sh) * scale)),
    params,
  }
}

/** What to encode, following the source unless the person chose a format. */
export function imageFormat(
  src: string,
  spec: ImageEditSpec,
): { ext: string; mime: string; quality?: number } {
  const chosen = typeof spec.params.format === 'string' ? spec.params.format : ''
  const source = (src.split('.').pop() ?? 'png').toLowerCase()
  const ext = (chosen || source).toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return { ext: 'jpg', mime: 'image/jpeg', quality: 0.92 }
  if (ext === 'webp') return { ext: 'webp', mime: 'image/webp', quality: 0.92 }
  return { ext: 'png', mime: 'image/png' }
}

/** Keep a node's footprint while making its aspect match the new picture. */
export function fitNodeToImage(
  node: Pick<CanvasNode, 'w' | 'h'>,
  width: number,
  height: number,
): { w: number; h: number } {
  if (!width || !height) return { w: node.w, h: node.h }
  const base = Math.max(node.w, node.h)
  return width >= height
    ? { w: base, h: Math.max(48, Math.round((base * height) / width)) }
    : { w: Math.max(48, Math.round((base * width) / height)), h: base }
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.src = url
  return image.decode().then(() => image)
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('The browser could not read the encoded image.'))
    reader.readAsDataURL(blob)
  })
}

/** Draw the edit into a canvas and hand back the bytes. The source file is never touched. */
export async function renderImageEdit(
  dataUrl: string,
  src: string,
  spec: ImageEditSpec,
): Promise<RenderedImageEdit> {
  const image = await loadImage(dataUrl)
  const geometry = computeImageEditGeometry(image.naturalWidth, image.naturalHeight, spec)

  const canvas = document.createElement('canvas')
  canvas.width = geometry.width
  canvas.height = geometry.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This window cannot draw images.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.translate(geometry.width / 2, geometry.height / 2)
  context.rotate((geometry.angle * Math.PI) / 180)
  context.scale(geometry.flipX ? -1 : 1, geometry.flipY ? -1 : 1)
  // Drawn in the unrotated frame; the transforms above turn it into the canvas.
  const drawnW = geometry.sw * geometry.scale
  const drawnH = geometry.sh * geometry.scale
  context.drawImage(image, geometry.sx, geometry.sy, geometry.sw, geometry.sh, -drawnW / 2, -drawnH / 2, drawnW, drawnH)

  const format = imageFormat(src, spec)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('The image could not be encoded.'))),
      format.mime,
      format.quality,
    ),
  )
  return {
    base64: await blobBase64(blob),
    ext: format.ext,
    width: geometry.width,
    height: geometry.height,
    params: geometry.params,
  }
}
