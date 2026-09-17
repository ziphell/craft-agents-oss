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
 * The frame's line: the app's **focused panel** border — 1px of the foreground, graded from 10%
 * at the top to 30% at the bottom (`shadow-panel-focused::before`), per mode. The page is the
 * content of its window, so it is that panel; the quieter 6% ring read as no line at all.
 */
describe('resolvePagePanelRing', () => {
  it('resolves the focused panel border for each mode', () => {
    expect(resolvePagePanelRing(false)).toBe(
      'linear-gradient(to bottom, rgba(38, 36, 42, 0.1), rgba(38, 36, 42, 0.3))',
    )
    expect(resolvePagePanelRing(true)).toBe(
      'linear-gradient(to bottom, rgba(237, 236, 240, 0.1), rgba(237, 236, 240, 0.3))',
    )
  })
})
