/**
 * What draws each fence — the heavy half of `fences`, kept apart from it.
 *
 * `fences` is the table everything can afford to read (the code block, the picker, the type of a
 * fence name). This module is the one that has to import a PDF viewer and a spreadsheet, so only the
 * two callers that actually draw something import it: the reader (`Markdown`) and the editor's
 * in-place blocks (`SourceEditor`).
 *
 * **One implementation per block, and one place that says how each is called.** Before this, the
 * `minimal` and `full` render modes each had their own chain of `if`s naming the same nine
 * components, and the rich editor had a third copy of the mapping with slightly different arguments
 * (a drawio block told to leave the mouse alone, for instance). A fence's arguments are a property
 * of the fence, so they live here with it rather than at each call site.
 */

import * as React from 'react'
import { MarkdownDatatableBlock } from './MarkdownDatatableBlock'
import { MarkdownDiffBlock } from './MarkdownDiffBlock'
import { MarkdownDocBlock } from './MarkdownDocBlock'
import { MarkdownDrawioBlock } from './MarkdownDrawioBlock'
import { MarkdownHtmlBlock } from './MarkdownHtmlBlock'
import { MarkdownImageBlock } from './MarkdownImageBlock'
import { MarkdownJsonBlock } from './MarkdownJsonBlock'
import { MarkdownLatexBlock } from './MarkdownLatexBlock'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'
import { MarkdownMindmapBlock } from './MarkdownMindmapBlock'
import { MarkdownOfficeBlock } from './MarkdownOfficeBlock'
import { MarkdownPdfBlock } from './MarkdownPdfBlock'
import { MarkdownSpreadsheetBlock } from './MarkdownSpreadsheetBlock'
import type { FenceDrawing } from './fences'

export interface FenceRenderContext {
  /** A link inside the block goes where the document's links go. */
  onUrlClick?: (url: string) => void
  /** A file named inside the block opens where the document's files open. */
  onFileClick?: (path: string) => void
  /**
   * A diagram's own expand button.
   *
   * False for the first mermaid fence of a message, whose corner is already taken by the turn's
   * fullscreen button — the rule the renderer has always applied, kept with the block it applies to.
   */
  showExpandButton?: boolean
  /**
   * Whether a block may take the mouse.
   *
   * A conversation is read, so its diagrams and pages are live. An *editor* is not: a click there
   * belongs to the document — it places the cursor — so the blocks drawn in one are told to leave
   * the mouse alone.
   */
  interactive?: boolean
}

export interface FenceRenderProps {
  /** The fence's body, verbatim. */
  code: string
  className?: string
  ctx: FenceRenderContext
}

/** A component that draws one fence. Uniform, so the table below can be exhaustive. */
export type FenceRenderer = React.ComponentType<FenceRenderProps>

/**
 * The implementation of every drawing.
 *
 * Typed as a complete record of `FenceDrawing` rather than a lookup, so the two cannot drift: a
 * drawing this table is missing is a type error, and a key it should not have is one too. That is
 * the check the old `preview-block-languages` docstring described, in the one place it still holds.
 */
const FENCE_COMPONENTS: Record<FenceDrawing, FenceRenderer> = {
  datatable: ({ code, className }) => <MarkdownDatatableBlock code={code} className={className} />,
  spreadsheet: ({ code, className }) => <MarkdownSpreadsheetBlock code={code} className={className} />,
  diff: ({ code, className }) => <MarkdownDiffBlock code={code} className={className} />,
  json: ({ code, className }) => <MarkdownJsonBlock code={code} className={className} />,
  latex: ({ code, className }) => <MarkdownLatexBlock code={code} className={className} />,
  mermaid: ({ code, className, ctx }) => (
    <MarkdownMermaidBlock
      code={code}
      className={className}
      showExpandButton={ctx.showExpandButton ?? true}
      interactive={ctx.interactive ?? true}
    />
  ),
  mindmap: ({ code, className, ctx }) => (
    <MarkdownMindmapBlock
      code={code}
      className={className}
      showExpandButton={ctx.showExpandButton ?? true}
      interactive={ctx.interactive ?? true}
    />
  ),
  'drawio-preview': ({ code, className, ctx }) => (
    <MarkdownDrawioBlock code={code} className={className} interactive={ctx.interactive ?? true} />
  ),
  'html-preview': ({ code, className }) => <MarkdownHtmlBlock code={code} className={className} />,
  'office-preview': ({ code, className }) => <MarkdownOfficeBlock code={code} className={className} />,
  'pdf-preview': ({ code, className }) => <MarkdownPdfBlock code={code} className={className} />,
  'image-preview': ({ code, className }) => <MarkdownImageBlock code={code} className={className} />,
  'markdown-preview': ({ code, className, ctx }) => (
    <MarkdownDocBlock
      code={code}
      className={className}
      onUrlClick={ctx.onUrlClick}
      onFileClick={ctx.onFileClick}
    />
  ),
}

/** The block for a drawing, or null for one this build has no component for. */
export function renderFence(
  drawing: FenceDrawing,
  code: string,
  className: string | undefined,
  ctx: FenceRenderContext,
): React.ReactElement | null {
  const Block = FENCE_COMPONENTS[drawing]
  if (!Block) return null
  return <Block code={code} className={className} ctx={ctx} />
}

export { FENCE_COMPONENTS }
