import { describe, it, expect } from 'bun:test'
import { PAN_SLOP_PX, beginPan, panTravel } from '../pan-gesture'

describe('pan gesture', () => {
  it('reports nothing for a press that stayed inside the slop — it is a click', () => {
    const pan = beginPan(100, 100)

    expect(panTravel(pan, 100 + PAN_SLOP_PX - 1, 100 - (PAN_SLOP_PX - 1))).toBeNull()
    expect(pan.moved).toBe(false)
  })

  it('reports a pan, with no travel yet, for the move that travelled further', () => {
    const pan = beginPan(100, 100)

    // The move that makes it a pan is also the one that sets the origin, so it has nothing to
    // report — the drawing picks up from where it was instead of jumping by the slop.
    expect(panTravel(pan, 300, 140)).toEqual({ dx: 0, dy: 0 })
    expect(pan.moved).toBe(true)
  })

  it('measures every move after that from where it became a pan', () => {
    const pan = beginPan(100, 100)
    panTravel(pan, 200, 100)

    expect(panTravel(pan, 210, 130)).toEqual({ dx: 10, dy: 30 })
    expect(panTravel(pan, 190, 100)).toEqual({ dx: -10, dy: 0 })
  })

  it('keeps reading a pan as one, however small the later moves get', () => {
    const pan = beginPan(100, 100)
    panTravel(pan, 200, 100)

    expect(panTravel(pan, 201, 100)).toEqual({ dx: 1, dy: 0 })
    expect(pan.moved).toBe(true)
  })

  it('reads a diagonal press as a pan once either axis has travelled', () => {
    const pan = beginPan(100, 100)

    expect(panTravel(pan, 100, 100 + PAN_SLOP_PX)).toEqual({ dx: 0, dy: 0 })
    expect(pan.moved).toBe(true)
  })
})
