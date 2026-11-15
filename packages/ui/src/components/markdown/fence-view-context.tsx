/**
 * What a fence's node view is allowed to do, said by whoever mounted the document.
 *
 * A `previewBlock` and a `literalBlock` are drawn by their own React tree, mounted through a portal into the editor's
 * DOM — so they can read this context, and they cannot read the editor's props. Two questions they have to ask:
 *
 * - **Which drawings are off?** The reading face of a `.md` file refuses to nest another document
 *   (`markdown-preview`); a poster refuses every fence that *points somewhere else*, because a picture of a document
 *   must show what an outside reader would see, and must not read a file of the document's choosing. That is a policy
 *   of the host, not of the block, so it travels here.
 * - **Where does a link inside a block go?** A `datatable` cell, a line of a nested document — the same place the
 *   document's own links go. The editor's props are on the other side of a portal, so the answers travel here too.
 *
 * The default is "nothing suppressed, no links claimed", which is what an editor wants: a document being edited draws
 * every fence it knows, and a click inside one is the document's to place the caret.
 */

import * as React from 'react'

export interface MarkdownFenceView {
  /**
   * Drawings this host does not draw — the block falls through to nothing rather than to its subject.
   *
   * Named by {@link FenceDrawing} but typed as `string` so this module does not have to import the fence table (which
   * is read by the code block on every keystroke).
   */
  suppressed?: ReadonlySet<string>
  /** The folder the document lives in, for a picture named beside it. */
  baseDir?: string
  /** Where a link inside a block goes. */
  onUrlClick?: (url: string) => void
  /** Where a file named inside a block opens. */
  onFileClick?: (path: string) => void
  /**
   * How to draw a block the engine cannot carry — the reading face's own renderer, supplied by the host.
   *
   * The editor does not own this: the answer is `Markdown`, and importing it here would make the editor depend on the
   * whole reader (PDF viewer and office blocks included) for one node view. Absent means "draw the bytes as text",
   * which is what an editor does with such a block anyway.
   */
  renderLiteral?: (text: string) => React.ReactNode
}

const EMPTY: MarkdownFenceView = {}

export const MarkdownFenceViewContext = React.createContext<MarkdownFenceView>(EMPTY)

export function useMarkdownFenceView(): MarkdownFenceView {
  return React.useContext(MarkdownFenceViewContext)
}

export const MarkdownFenceViewProvider = MarkdownFenceViewContext.Provider
