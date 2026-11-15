import { describe, expect, it } from 'bun:test'
import { resizeBox, snapMove, handleCursors } from '../canvas-snap'

describe('snapMove', () => {
  it('leaves a drag alone when nothing is close', () => {
    const result = snapMove({ x: 100, y: 100, w: 100, h: 100 }, 47, -31, [], 6)
    expect(result).toEqual({ dx: 47, dy: -31, guides: [] })
  })

  it('does not invent an origin on an infinite board', () => {
    const result = snapMove({ x: 40, y: 100, w: 100, h: 100 }, -37, 0, [], 6)
    expect(result.dx).toBe(-37)
    expect(result.guides).toEqual([])
  })

  it('snaps a centre to another card and reports the line', () => {
    // Moving card's centre lands at 249; the other card's centre is 250.
    const result = snapMove(
      { x: 100, y: 100, w: 100, h: 100 },
      99,
      0,
      [{ x: 200, y: 300, w: 100, h: 100 }],
      6,
    )
    expect(result.dx).toBe(100)
    expect(result.guides).toEqual([{ axis: 'x', at: 250 }])
  })

  it('snaps both axes independently', () => {
    const result = snapMove(
      { x: 100, y: 100, w: 100, h: 100 },
      3,
      -98,
      [{ x: 0, y: 0, w: 100, h: 2 }],
      6,
    )
    expect(result.dx).toBe(0) // left edge 103 → 100
    expect(result.dy).toBe(-98) // bottom edge 102 → 100
    expect(result.guides).toEqual([
      { axis: 'x', at: 100 },
      { axis: 'y', at: 2 },
    ])
  })

  it('prefers the closest line when several are in range', () => {
    const result = snapMove(
      { x: 100, y: 100, w: 100, h: 100 },
      9,
      0,
      [{ x: 210, y: 0, w: 10, h: 10 }],
      6,
    )
    // left 109, other left 210 is far; right 209 → 210 is 1 away, so it wins over other lines.
    expect(result.dx).toBe(10)
  })
})

describe('resizeBox', () => {
  const start = { x: 100, y: 100, w: 200, h: 100 }

  it('pulls the south-east corner and leaves the opposite corner still', () => {
    expect(resizeBox(start, 'se', 50, 30)).toEqual({ x: 100, y: 100, w: 250, h: 130 })
  })

  it('pulls the north-west corner, moving the origin', () => {
    expect(resizeBox(start, 'nw', 20, 10)).toEqual({ x: 120, y: 110, w: 180, h: 90 })
  })

  it('keeps the aspect from the width when a corner is dragged', () => {
    const box = resizeBox(start, 'se', 100, 0, { aspect: 2 })
    expect(box).toEqual({ x: 100, y: 100, w: 300, h: 150 })
  })

  it('centres the other axis for an edge handle with an aspect', () => {
    const box = resizeBox(start, 'e', 100, 0, { aspect: 2 })
    expect(box).toEqual({ x: 100, y: 75, w: 300, h: 150 })
  })

  it('never shrinks below the floor', () => {
    const box = resizeBox(start, 'se', -500, -500)
    expect(box.w).toBe(24)
    expect(box.h).toBe(24)
  })

  it('names the cursor for each handle', () => {
    expect(handleCursors('n')).toBe('ns-resize')
    expect(handleCursors('w')).toBe('ew-resize')
    expect(handleCursors('nw')).toBe('nwse-resize')
    expect(handleCursors('ne')).toBe('nesw-resize')
  })
})
