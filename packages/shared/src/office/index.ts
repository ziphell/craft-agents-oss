/**
 * The office editor bridge: the protocol both ends speak (`./types`) and the script that
 * stands in for an editor's preload (`./shim`).
 *
 * The split is not cosmetic. The renderer may import *values* only from a `<family>/types`
 * module (docs/renderer-imports.md), and the shim is main/server code — so the frame-facing
 * React components import `@craft-agent/shared/office/types`, while the hosts that serve the
 * bundles import this entry.
 */
export * from './types'
export * from './disk'
export { officeShimScript } from './shim'
export {
  clearOpenDocuments,
  closeDocument,
  documentShownBy,
  type OfficeEditRequest,
  isDocumentDirty,
  isDocumentOpen,
  openDocument,
  openDocuments,
  setDocumentDirty,
} from './open-documents'
export { prepareEditorDocument } from './document'
export {
  cellValue,
  plainInline,
  sheetName,
  splitTableRow,
  tablesFromHtml,
  tablesFromMarkdown,
  workbookFromDocument,
} from './sheets-from-document'
