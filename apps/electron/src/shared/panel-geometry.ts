/**
 * How this app's panels are shaped — the numbers, in one place.
 *
 * Two processes draw panels and they are not the same process: the app shell draws the
 * conversation panels (renderer, `components/app-shell/panel-constants.ts`), and the main
 * process draws the browser window's page area (a `BrowserView`, with the frame around it
 * drawn in the overlay document). A radius copied into both files drifts the first time one
 * of them is tuned, and the drift shows up as a browser window that no longer looks like the
 * app it belongs to.
 *
 * Platform is a parameter rather than a decision made here: the renderer resolves it from
 * `@/lib/platform`, the main process from `process.platform`, and they must not disagree
 * about which one they are on.
 */

/** Gap between adjacent surfaces (sidebar ↔ navigator ↔ content, and the rail ↔ the page). */
export const PANEL_GAP = 6

/** Inset from the window's edge to the surface nearest it (right, and the bottom). */
export const PANEL_EDGE_INSET = 6

/** Corner radius for an interior corner — one that is not the window's own. */
export const PANEL_RADIUS_INNER = 10

/**
 * Corner radius for a corner that **is** the window's own.
 *
 * macOS rounds its windows harder than Windows and Linux do, so a panel corner that is also
 * the window's corner has to be drawn to the platform's own radius or it reads as a square
 * corner inside a rounded window (the browser page panel now sits inset, so its bottom-right
 * is the only such corner).
 */
export const PANEL_RADIUS_EDGE = { darwin: 14, other: 8 } as const
