import { PANEL_RADIUS_EDGE, PANEL_RADIUS_INNER } from './panel-geometry'

export type BrowserLiveFxPlatform = 'darwin' | 'win32' | 'linux' | 'other'

export interface BrowserLiveFxCornerRadii {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
}

export const BROWSER_LIVE_FX_BORDER = {
  width: '1.5px',
  style: 'solid',
  color: 'var(--accent)',
  boxShadow:
    'inset 0 0 0 1px color-mix(in oklab, var(--accent) 45%, transparent), inset 0 0 20px color-mix(in oklab, var(--accent) 28%, transparent)',
} as const

/**
 * The hairline around the page area — the app's own panel ring, in a form a document without
 * the app's CSS variables can use.
 *
 * The app's panels are ringed by `shadow-middle` (`renderer/index.css`): 1px of the foreground
 * at 6%. The page area is a `BrowserView` framed by the overlay document (a generated
 * document, with no theme variables in scope), so the ring is resolved to a concrete colour
 * here — the same treatment {@link resolveBrowserLiveFxBorder} gives the accent.
 */
export const PAGE_PANEL_RING = {
  width: '1px',
  alpha: 0.06,
  /** `--foreground-rgb` per mode, matching `renderer/index.css`. */
  foregroundRgb: {
    light: '38, 36, 42',
    dark: '227, 226, 229',
  },
} as const

export function resolvePagePanelRing(isDark: boolean): string {
  const rgb = isDark ? PAGE_PANEL_RING.foregroundRgb.dark : PAGE_PANEL_RING.foregroundRgb.light
  return `rgba(${rgb}, ${PAGE_PANEL_RING.alpha})`
}

/**
 * Return border color + boxShadow with a concrete accent color value.
 * Use this when injecting styles into a foreign DOM (e.g. CDP overlay)
 * where `var(--accent)` would resolve against the website's stylesheet.
 */
export function resolveBrowserLiveFxBorder(accentColor: string): { color: string; boxShadow: string } {
  return {
    color: accentColor,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accentColor} 45%, transparent), inset 0 0 20px color-mix(in oklab, ${accentColor} 28%, transparent)`,
  }
}

export function getBrowserLiveFxCornerRadii(platform: BrowserLiveFxPlatform): BrowserLiveFxCornerRadii {
  /**
   * The page area is a **panel** like the app's own (plan §22), so its corners follow the app's
   * panel radii: interior corners get `PANEL_RADIUS_INNER`, and the one corner that is also the
   * window's — the bottom-right, with the rail on the left, the bar above and the window's own
   * inset on the right and below — gets the platform's window radius (`PANEL_RADIUS_EDGE`).
   */
  const edgeRadius = platform === 'darwin' ? PANEL_RADIUS_EDGE.darwin : PANEL_RADIUS_EDGE.other
  const inner = `${PANEL_RADIUS_INNER}px`

  return {
    topLeft: inner,
    topRight: inner,
    bottomLeft: inner,
    bottomRight: `${edgeRadius}px`,
  }
}
