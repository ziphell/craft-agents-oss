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
 * The hairline around the page area — the app's own **focused panel** border, in a form a
 * document without the app's CSS variables can use.
 *
 * The app draws that border with `shadow-panel-focused::before` (`renderer/index.css`): 1px of
 * the foreground, graded from 10% at the top to 30% at the bottom. A panel that is the content
 * of its window is the focused one, which is exactly what the page is here; the quieter 6% ring
 * (`shadow-middle`) is for panels that are not, and at 6% it reads as "there is no line" — which
 * is what it looked like before this was taken from the focused recipe.
 *
 * The overlay document is generated and has no theme variables in scope, so the ring is resolved
 * to a concrete gradient here — the same treatment {@link resolveBrowserLiveFxBorder} gives the
 * accent.
 */
export const PAGE_PANEL_RING = {
  width: '1px',
  topAlpha: 0.1,
  bottomAlpha: 0.3,
  /** `--foreground-rgb` per mode, from the renderer's stylesheet — the one the browser window's
   * chrome is drawn with (`apps/electron/src/renderer/index.css`), not the UI package's defaults:
   * the chrome overrides both, and a ring mixed from the wrong foreground shows up as a line that
   * is too bright or too dim beside it. */
  foregroundRgb: {
    light: '38, 36, 42',
    dark: '237, 236, 240',
  },
} as const

export function resolvePagePanelRing(isDark: boolean): string {
  const rgb = isDark ? PAGE_PANEL_RING.foregroundRgb.dark : PAGE_PANEL_RING.foregroundRgb.light
  return `linear-gradient(to bottom, rgba(${rgb}, ${PAGE_PANEL_RING.topAlpha}), rgba(${rgb}, ${PAGE_PANEL_RING.bottomAlpha}))`
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
