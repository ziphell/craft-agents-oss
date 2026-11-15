/**
 * Markdown component exports for @craft-agent/ui
 */

export { Markdown, MemoizedMarkdown, type MarkdownProps, type RenderMode, type DisablablePreviewBlock } from './Markdown'
export { CodeBlock, InlineCode, type CodeBlockProps } from './CodeBlock'
export { preprocessLinks, detectLinks, hasLinks } from './linkify'
export { CollapsibleSection } from './CollapsibleSection'
export { CollapsibleMarkdownProvider, useCollapsibleMarkdown } from './CollapsibleMarkdownContext'
export { MarkdownDatatableBlock, type MarkdownDatatableBlockProps } from './MarkdownDatatableBlock'
export { MarkdownSpreadsheetBlock, type MarkdownSpreadsheetBlockProps } from './MarkdownSpreadsheetBlock'
export { MarkdownImageBlock, type MarkdownImageBlockProps } from './MarkdownImageBlock'
export { MarkdownImage, type MarkdownImageProps } from './MarkdownImage'
export { MarkdownDocBlock, type MarkdownDocBlockProps } from './MarkdownDocBlock'
export { MarkdownEditorPane, type MarkdownEditorPaneProps } from './MarkdownEditorPane'
export {
  fenceSpec,
  fenceSpecs,
  fenceDrawing,
  registerFence,
  unregisterFence,
  PREVIEW_BLOCK_LANGUAGES,
  isPreviewBlockLanguage,
  type FenceSpec,
  type FenceDrawing,
  type FenceKind,
  type PreviewBlockLanguage,
} from './fences'
export {
  parseMarkdownPreviewSpec,
  normalizePreviewItems,
  type MarkdownPreviewItem,
  type MarkdownPreviewSpec,
} from './markdown-preview-helpers'
export { ImageCardStack, type ImageCardStackProps, type ImageCardStackItem } from './ImageCardStack'
export { TiptapMarkdownEditor, type TiptapMarkdownEditorProps, type MarkdownEngine } from './TiptapMarkdownEditor'
export { FrontmatterPanel, type FrontmatterPanelProps } from './FrontmatterPanel'

export { SourceText, type SourceTextProps } from '../editors/SourceText'

// The document-relative rule a picture or a link follows (`![](logo.png)`), shared with the poster.
export { documentDir, resolveDocumentPath } from './document-path'
