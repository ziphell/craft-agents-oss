/**
 * The renderer seam, as a package.
 *
 * A host that can print picks one implementation and keeps it: the desktop hands in its Electron
 * window printer, a hub constructs `ChromiumRenderer`. Nothing above this line knows which — that
 * is the point, and the reason a document behaves the same whether it is exported from the app or
 * from a server with no desktop anywhere near it.
 */

export {
  RenderError,
  type DocumentPrintRequest,
  type DrawioRenderRequest,
  type NetworkPolicy,
  type OfficeApp,
  type PrintGeometry,
  type PrintSource,
  type Renderer,
  type RendererInfo,
  type RendererKind,
} from './types.ts'

export { ChromiumRenderer, isAllowedUrl, type ChromiumRendererOptions } from './chromium.ts'
export { OfficeOrigin, type OfficeAnswer, type OfficeOriginOptions } from './office-origin.ts'
export { createDocumentAnswerer, type DocumentAnswerContext } from './document-answers.ts'
