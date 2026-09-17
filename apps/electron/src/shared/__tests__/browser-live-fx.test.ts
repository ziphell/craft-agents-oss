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

/** The frame's hairline: the app's panel ring (1px of the foreground at 6%), per mode. */
describe('resolvePagePanelRing', () => {
  it('resolves the foreground ring for each mode', () => {
    expect(resolvePagePanelRing(false)).toBe('rgba(38, 36, 42, 0.06)')
    expect(resolvePagePanelRing(true)).toBe('rgba(237, 236, 240, 0.06)')
  })
})
