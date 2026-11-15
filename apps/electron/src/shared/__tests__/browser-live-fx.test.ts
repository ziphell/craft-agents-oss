import { describe, expect, it } from 'bun:test'

import { getBrowserLiveFxCornerRadii, resolvePagePanelRing, resolvePagePanelShadow } from '../browser-live-fx'

/**
 * The page area is drawn as a panel like the app's own, and its four corners are the same
 * corner: the page's own view rounds them (`WebContentsView.setBorderRadius`, one radius for
 * all four), so the hairline drawn just outside them and the mask behind them follow that one
 * number.
 */
describe('getBrowserLiveFxCornerRadii', () => {
  it('rounds all four corners by the panel radius', () => {
    expect(getBrowserLiveFxCornerRadii()).toEqual({
      topLeft: '10px',
      topRight: '10px',
      bottomLeft: '10px',
      bottomRight: '10px',
    })
  })
})

/**
 * The frame's line: one pixel of the foreground at 6% — the ring half of the app's
 * `shadow-minimal` edge, the same one the address bar's input wears, so the page's panel and the
 * field beside it are the same weight (the blur half is `resolvePagePanelShadow`).
 */
describe('resolvePagePanelRing', () => {
  it('resolves the panel ring for each mode', () => {
    expect(resolvePagePanelRing(false)).toBe('rgba(38, 36, 42, 0.06)')
    expect(resolvePagePanelRing(true)).toBe('rgba(237, 236, 240, 0.06)')
  })
})

/**
 * The blur half of that edge: the app's panel edge (`shadow-middle`) — three layers at the mode's
 * `--shadow-blur-opacity` (6% light, 12% dark), one more layer than the address bar's field edge,
 * so the page reads a touch heavier than the field beside it.
 */
describe('resolvePagePanelShadow', () => {
  it('emits the app panel edge blur layers, at the mode’s blur opacity', () => {
    expect(resolvePagePanelShadow(false)).toBe(
      'rgba(0, 0, 0, 0.06) 0 1px 1px -0.5px, rgba(0, 0, 0, 0.06) 0 3px 3px -1.5px, rgba(0, 0, 0, 0.06) 0 6px 6px -3px',
    )
    expect(resolvePagePanelShadow(true)).toBe(
      'rgba(0, 0, 0, 0.12) 0 1px 1px -0.5px, rgba(0, 0, 0, 0.12) 0 3px 3px -1.5px, rgba(0, 0, 0, 0.12) 0 6px 6px -3px',
    )
  })
})
