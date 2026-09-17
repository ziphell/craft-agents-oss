import { describe, expect, it } from 'bun:test'

import { getBrowserLiveFxCornerRadii, resolvePagePanelRing } from '../browser-live-fx'

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
 * The frame's line: one flat pixel of the foreground at 20% (the person's call: no gradient) —
 * the weight the app's focused panel border reads as, grading 10%→30% as it does. The page is
 * the content of its window, so it is that panel; the quieter 6% ring read as no line at all.
 */
describe('resolvePagePanelRing', () => {
  it('resolves the flat panel line for each mode', () => {
    expect(resolvePagePanelRing(false)).toBe('rgba(38, 36, 42, 0.2)')
    expect(resolvePagePanelRing(true)).toBe('rgba(237, 236, 240, 0.2)')
  })
})
