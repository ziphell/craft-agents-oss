import { describe, expect, it } from 'bun:test'

import { getBrowserLiveFxCornerRadii, resolvePagePanelRing } from '../browser-live-fx'

/**
 * The page area is drawn as a panel like the app's own: interior corners at the panel radius,
 * and the one corner that is also the window's — the bottom-right — at the platform's window
 * radius. Which corner that is comes from the window's chrome: the rail on the left, the bar
 * on top, and the window's own inset to the right and below.
 */
describe('getBrowserLiveFxCornerRadii', () => {
  it('uses the window radius on the bottom-right only, on macOS', () => {
    expect(getBrowserLiveFxCornerRadii('darwin')).toEqual({
      topLeft: '10px',
      topRight: '10px',
      bottomLeft: '10px',
      bottomRight: '14px',
    })
  })

  it('uses the window radius on the bottom-right only, on Windows', () => {
    expect(getBrowserLiveFxCornerRadii('win32')).toEqual({
      topLeft: '10px',
      topRight: '10px',
      bottomLeft: '10px',
      bottomRight: '8px',
    })
  })

  it('uses the non-macOS window radius on Linux and fallback platforms', () => {
    expect(getBrowserLiveFxCornerRadii('linux')).toEqual({
      topLeft: '10px',
      topRight: '10px',
      bottomLeft: '10px',
      bottomRight: '8px',
    })

    expect(getBrowserLiveFxCornerRadii('other')).toEqual({
      topLeft: '10px',
      topRight: '10px',
      bottomLeft: '10px',
      bottomRight: '8px',
    })
  })
})

/** The frame's hairline: the app's panel ring (1px of the foreground at 6%), per mode. */
describe('resolvePagePanelRing', () => {
  it('resolves the foreground ring for each mode', () => {
    expect(resolvePagePanelRing(false)).toBe('rgba(38, 36, 42, 0.06)')
    expect(resolvePagePanelRing(true)).toBe('rgba(227, 226, 229, 0.06)')
  })
})
