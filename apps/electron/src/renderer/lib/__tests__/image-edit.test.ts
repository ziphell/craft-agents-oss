import { describe, expect, it } from 'bun:test'
import { computeImageEditGeometry, fitNodeToImage, imageFormat } from '../image-edit'

describe('local image edits', () => {
  it('crops the middle at the requested aspect', () => {
    const geometry = computeImageEditGeometry(100, 50, { op: 'crop', params: { ratio: 1 } })
    expect(geometry).toMatchObject({ sx: 25, sy: 0, sw: 50, sh: 50, width: 50, height: 50 })
    expect(geometry.params).toEqual({ ratio: 1, left: 25, top: 0, width: 50, height: 50 })
  })

  it('keeps a crop inside the picture', () => {
    const geometry = computeImageEditGeometry(100, 50, {
      op: 'crop',
      params: { left: 90, top: 40, width: 50, height: 50 },
    })
    expect(geometry).toMatchObject({ sx: 90, sy: 40, sw: 10, sh: 10 })
  })

  it('turns a right angle into swapped dimensions', () => {
    expect(computeImageEditGeometry(100, 50, { op: 'rotate', params: { angle: 90 } })).toMatchObject({
      angle: 90,
      width: 50,
      height: 100,
    })
    expect(computeImageEditGeometry(100, 50, { op: 'rotate', params: { angle: 180 } })).toMatchObject({
      angle: 180,
      width: 100,
      height: 50,
    })
  })

  it('refuses an angle that is not a right angle', () => {
    expect(() => computeImageEditGeometry(100, 50, { op: 'rotate', params: { angle: 45 } })).toThrow(
      /90, 180 or 270/,
    )
  })

  it('mirrors on the named axis', () => {
    expect(computeImageEditGeometry(100, 50, { op: 'flip', params: { axis: 'horizontal' } })).toMatchObject({
      flipX: true,
      flipY: false,
    })
    expect(computeImageEditGeometry(100, 50, { op: 'flip', params: { axis: 'vertical' } })).toMatchObject({
      flipX: false,
      flipY: true,
    })
  })

  it('scales both sides and refuses a non-positive scale', () => {
    expect(computeImageEditGeometry(100, 50, { op: 'resize', params: { scale: 0.5 } })).toMatchObject({
      width: 50,
      height: 25,
    })
    expect(() => computeImageEditGeometry(100, 50, { op: 'resize', params: { scale: 0 } })).toThrow()
  })

  it('follows the source format unless a format is chosen', () => {
    expect(imageFormat('assets/a.png', { op: 'resize', params: { scale: 0.5 } })).toMatchObject({ ext: 'png' })
    expect(imageFormat('assets/a.jpg', { op: 'resize', params: { scale: 0.5 } })).toMatchObject({ ext: 'jpg' })
    expect(imageFormat('assets/a.gif', { op: 'resize', params: { scale: 1 } })).toMatchObject({ ext: 'png' })
    expect(imageFormat('assets/a.png', { op: 'convert', params: { format: 'webp' } })).toMatchObject({
      ext: 'webp',
      mime: 'image/webp',
    })
  })

  it('keeps the card footprint while matching the new aspect', () => {
    expect(fitNodeToImage({ w: 480, h: 320 }, 320, 480)).toEqual({ w: 320, h: 480 })
    expect(fitNodeToImage({ w: 480, h: 320 }, 640, 320)).toEqual({ w: 480, h: 240 })
    expect(fitNodeToImage({ w: 480, h: 320 }, 0, 0)).toEqual({ w: 480, h: 320 })
  })
})
