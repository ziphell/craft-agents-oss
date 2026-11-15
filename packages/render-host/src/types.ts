/**
 * The renderer seam, as this host sees it.
 *
 * The **types** live in `@craft-agent/office-host/renderer`, the package both hosts already depend
 * on — a desktop that had to import *this* package to name the interface would drag
 * `playwright-core` into an installer that can never use it. What stays here is what only a
 * Playwright driver has: the network policy a printed page is held to, and the Chromium launcher.
 */

export {
  RenderError,
  type DocumentPrintRequest,
  type DrawioRenderRequest,
  type OfficeApp,
  type PrintGeometry,
  type PrintSource,
  type Renderer,
  type RendererInfo,
  type RendererKind,
  type RenderErrorCode,
} from '@craft-agent/office-host'

/**
 * Which origins a printed page may reach.
 *
 * Everything not named here is **aborted**. A document may name an image by URL, and a renderer that
 * follows it is two problems at once: the hub becomes a way to reach the inside of its own network,
 * and the PDF silently depends on whether that URL answered today. `file:`, `data:`, `blob:` and
 * `about:` are always allowed — that is how a local document and the bytes of an open file travel,
 * and none of it touches the network stack.
 */
export interface NetworkPolicy {
  /** `scheme://host:port` values a page may load from, beyond the four that always are. */
  allowedOrigins?: string[]
}
