/**
 * The drawio surfaces: the engine that draws a document and the two ways its markup is shown, the
 * editor that is a document surface of its own, the file-bound editor that goes in either, the
 * window both are opened through, the pages of a multi-page document as the row both show, how the
 * window is sized and dragged, and the origin all of them need.
 */

export { DrawioViewer, DrawioViewerShell, DrawioEditorFrame } from './frame'
export { useDrawioOrigin, type DrawioOrigin } from './useDrawioOrigin'
export { DrawioEditorPane, type DrawioEditorPaneProps } from './DrawioEditorPane'
export { DrawioOverlay, type DrawioOverlayProps } from './DrawioOverlay'
export { DrawioPages, type DrawioPagesProps } from './Pages'
export {
  DrawioViewControls,
  useDrawioView,
  type DrawioView,
} from './view'
