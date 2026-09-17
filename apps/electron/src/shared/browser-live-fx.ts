import { PANEL_RADIUS_INNER } from './panel-geometry'

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
 * The line around the page area — the app's own panel border, in a form a document without the
 * app's CSS variables can use.
 *
 * One flat pixel of the foreground (the person's call: no gradient), at the weight the app's
 * **focused** panel border comes to — that border grades 10%→30% down the panel, so 20% is what
 * it reads as all over, and the quieter 6% ring (`shadow-middle`, for panels that are not the
 * content of their window) reads as no line at all.
 *
 * The overlay document is generated and has no theme variables in scope, so the colour is
 * resolved here — the same treatment {@link resolveBrowserLiveFxBorder} gives the accent.
 */
export const PAGE_PANEL_RING = {
  width: '1px',
  alpha: 0.2,
  /** `--foreground-rgb` per mode, from the renderer's stylesheet — the one the browser window's
   * chrome is drawn with (`apps/electron/src/renderer/index.css`), not the UI package's defaults:
   * the chrome overrides both, and a line mixed from the wrong foreground shows up as one that is
   * too bright or too dim beside it. */
  foregroundRgb: {
    light: '38, 36, 42',
    dark: '237, 236, 240',
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

export function getBrowserLiveFxCornerRadii(): BrowserLiveFxCornerRadii {
  /**
   * The page is a panel like the app's own (plan §22), and all four of its corners are the same
   * corner: the page's view rounds them itself (`applyPageCornerRadius`) and a view takes one
   * radius, so the hairline and the mask behind it follow that one number. The app's own panels
   * draw the corner nearest the window a couple of pixels tighter — that corner is the window's
   * only when a panel reaches it, and this panel is inset from every window edge.
   */
  const inner = `${PANEL_RADIUS_INNER}px`

  return {
    topLeft: inner,
    topRight: inner,
    bottomLeft: inner,
    bottomRight: inner,
  }
}
