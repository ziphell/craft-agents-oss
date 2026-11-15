/**
 * Mask geometry — where a shape lands on the composition, in pixels.
 *
 * A mask is stored in fractions of the composition so the same file renders at any size. This
 * module turns it into the pixels the painter draws, and it is the only place that decides what
 * `expansion` means: each edge moves out (or in) by that many pixels, keeping the shape's centre.
 *
 * `feather` is not geometry — it is a blur applied when the mask is composited — so it lives in
 * the painter, not here.
 */

import { DEFAULT_MASK_POLYGON, type EditMask, type MaskPoint } from './document.ts'

export interface MaskBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The mask's box in composition pixels, after `expansion`. */
export function maskBoundsPx(mask: EditMask, width: number, height: number): MaskBounds {
  const centreX = (mask.x + mask.width / 2) * width
  const centreY = (mask.y + mask.height / 2) * height
  const boxWidth = Math.max(2, mask.width * width + mask.expansion * 2)
  const boxHeight = Math.max(2, mask.height * height + mask.expansion * 2)
  return {
    x: centreX - boxWidth / 2,
    y: centreY - boxHeight / 2,
    width: boxWidth,
    height: boxHeight,
  }
}

/** A polygon's vertices in composition pixels. */
export function maskPolygonPx(mask: EditMask, width: number, height: number): MaskPoint[] {
  const bounds = maskBoundsPx(mask, width, height)
  const points = mask.points?.length && mask.points.length >= 3 ? mask.points : DEFAULT_MASK_POLYGON
  return points.map((point) => ({
    x: bounds.x + point.x * bounds.width,
    y: bounds.y + point.y * bounds.height,
  }))
}

/** Trace the mask's shape on a canvas. The caller decides fill, stroke and compositing. */
export function traceMaskShape(
  ctx: CanvasRenderingContext2D,
  mask: EditMask,
  width: number,
  height: number,
): void {
  const bounds = maskBoundsPx(mask, width, height)
  ctx.beginPath()
  if (mask.shape === 'ellipse') {
    ctx.ellipse(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      bounds.width / 2,
      bounds.height / 2,
      0,
      0,
      Math.PI * 2,
    )
    ctx.closePath()
    return
  }
  if (mask.shape === 'polygon') {
    const points = maskPolygonPx(mask, width, height)
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.closePath()
    return
  }
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height)
  ctx.closePath()
}
