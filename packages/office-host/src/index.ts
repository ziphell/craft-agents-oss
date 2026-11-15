/**
 * The document hosts: what the editors' own calls land on.
 *
 * Four formats, and where each document lives is the reason this package exists:
 *
 * | format | the document is in | the host does |
 * | --- | --- | --- |
 * | `.docx`, `.pdf` | the renderer | nothing but bytes (`file:readBinary` / `writeBinary`) |
 * | `.pptx` | **here** (engine + snapshot stack) | open, apply ops, save |
 * | `.xlsx` | a sidecar process | open, read ranges, save through the CLI |
 *
 * Everything here is plain Node — no `electron` import anywhere — so the same hosts answer in the
 * desktop app and on a hub. `runtime.ts` is the single thing that differs between them, and
 * `setOfficeRuntime` is how a process says which.
 *
 * The save guard is here for the same reason: a document edited in two places is a property of the
 * *file*, not of the app, and a hub hosting the same editors needs the same refusal.
 */

export {
  setOfficeRuntime,
  officeRuntime,
  electronRuntime,
  hostRuntime,
  setOfficePrint,
  officePrint,
  setOfficeDeliver,
  officeDeliver,
  type OfficeRuntime,
  type OfficePrint,
  type OfficePrintInput,
  type OfficeDeliver,
  type OfficeDelivery,
  type OfficeProducedFile,
} from './runtime'

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
} from './renderer'

export { officeDeckCall, deckSave, deckIsDirty, deckClose } from './deck'

export {
  officePageDriver,
  OFFICE_PAGE_WINDOW,
  PAGE_CAPTURE_TIMEOUT_MS,
  type PageClip,
  type PageSurface,
  type PageCaptureRequest,
  setOfficePageCapture,
  officePageCapture,
  type PageCapture,
  type PageCaptureInput,
  setOfficeWebShot,
  officeWebShot,
  type WebShot,
  type WebShotInput,
  setOfficeMarkdownShot,
  officeMarkdownShot,
  type MarkdownShot,
  type MarkdownShotInput,
} from './page-capture'

export {
  officeWorkbookCall,
  stopWorkbookHost,
} from './workbook'

export { officePdfCall } from './pdf'

/**
 * Pages as pixels, with the pdfium that already ships beside the document engine.
 *
 * No window and no editor: measured at ~80–180 ms a page, which is what makes a poster of a
 * document affordable when the document itself takes seconds to open.
 */
export { extractPageTexts, pdfPageCount, renderPagePng, type PdfRect, type RenderPageInput } from './pdf-raster'

export {
  acknowledgeDocument,
  checkDocument,
  clearRecords,
  conflictMessage,
  hasRecord,
  recordDocument,
  recordFromDisk,
  setDocumentWrittenListener,
  writeDocument,
} from './guard'
