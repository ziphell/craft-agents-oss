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
 * The line around the page area — the same line the address bar's own input wears, in a form a
 * document without the app's CSS variables can use.
 *
 * One pixel of the foreground at 6%: the ring **every** edge in the app uses, `shadow-minimal` and
 * `shadow-middle` alike (`apps/electron/src/renderer/index.css`). NOT a bare hairline, which is why
 * it reads as a line rather than nothing; the weight carried past it is the blur underneath
 * ({@link PAGE_PANEL_SHADOW}).
 *
 * The overlay document is generated and has no theme variables in scope, so the colour is
 * resolved here — the same treatment {@link resolveBrowserLiveFxBorder} gives the accent.
 */
export const PAGE_PANEL_RING = {
  width: '1px',
  alpha: 0.06,
  /** `--foreground-rgb` per mode, from the renderer's stylesheet — what `shadow-minimal`'s ring is
   * mixed from, and the foreground the browser window's chrome is drawn with
   * (`apps/electron/src/renderer/index.css`), not the UI package's defaults: the chrome overrides
   * both, and a line mixed from the wrong foreground shows up as one that is too bright or too dim
   * beside it. */
  foregroundRgb: {
    light: '38, 36, 42',
    dark: '237, 236, 240',
  },
} as const

/**
 * The blur under the ring — the app's **panel** edge, `.shadow-middle`: three layers, one more than
 * the address bar's field edge (`shadow-minimal`) carries.
 *
 * The panel's and not the field's, on purpose: the page area **is** a panel, so it reads a touch
 * heavier than the field beside it — the same relation the app's own panels have to its fields. The
 * opacity is `--shadow-blur-opacity`, which the app raises in dark mode (0.06 → 0.12) — resolved per
 * mode here for the same reason the ring is. Black, like the app's.
 */
export const PAGE_PANEL_SHADOW = {
  layers: [
    { y: 1, blur: 1, spread: -0.5 },
    { y: 3, blur: 3, spread: -1.5 },
    { y: 6, blur: 6, spread: -3 },
  ],
  alpha: { light: 0.06, dark: 0.12 },
} as const

export function resolvePagePanelRing(isDark: boolean): string {
  const rgb = isDark ? PAGE_PANEL_RING.foregroundRgb.dark : PAGE_PANEL_RING.foregroundRgb.light
  return `rgba(${rgb}, ${PAGE_PANEL_RING.alpha})`
}

/** The ring's blur layers as one `box-shadow` value, for the overlay's generated document. */
export function resolvePagePanelShadow(isDark: boolean): string {
  const alpha = isDark ? PAGE_PANEL_SHADOW.alpha.dark : PAGE_PANEL_SHADOW.alpha.light
  return PAGE_PANEL_SHADOW.layers
    .map((layer) => `rgba(0, 0, 0, ${alpha}) 0 ${layer.y}px ${layer.blur}px ${layer.spread}px`)
    .join(', ')
}

/**
 * Return border color + boxShadow with a concrete accent color value.
 * Use this when injecting styles into a foreign DOM (e.g. CDP overlay)
 * where `var(--accent)` would resolve against the page's stylesheet.
 */
export function resolveBrowserLiveFxBorder(accentColor: string): { color: string; boxShadow: string } {
  return {
    color: accentColor,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accentColor} 45%, transparent), inset 0 0 20px color-mix(in oklab, ${accentColor} 28%, transparent)`,
  }
}

export function getBrowserLiveFxCornerRadii(): BrowserLiveFxCornerRadii {
  /**
   * The page is a panel like the app's own, and all four of its corners are the same
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
