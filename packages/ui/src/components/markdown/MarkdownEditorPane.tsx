/**
 * A markdown file, shown and changed.
 *
 * **Two faces, one file**, and they are different kinds of thing on purpose:
 *
 * - **Reading is the renderer.** The document is drawn by the same `Markdown` the conversation
 *   draws messages with, so a `.md` looks the same here as a message quoting it, and the preview
 *   blocks inside it — a `drawio-preview`, an `html-preview`, a table, a diff — are the app's own
 *   blocks rather than a second rendering of them.
 * - **Editing is the source.** The file as text, in a small editor with markdown highlighting, and
 *   what is written back is exactly what is on screen. Nothing goes through a document model on the
 *   way out, so a construct the app has no node for cannot be silently dropped from somebody's
 *   file — which is the failure a rich editor risks every time it parses a document it then saves.
 *
 * Which face is shown belongs to the caller (`mode`): a block inside a conversation only ever
 * reads, and the full-size window is where the two are switched. When to write, whether the write
 * will be allowed, and what to do when the file changed underneath are not decided here at all —
 * they are `useFileWriter` (see §2⑪ of the workbench notes).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'
import { useFileWriter } from '../editors/useFileWriter'
import { FileSaveStatus } from '../editors/FileSaveStatus'
import { cn } from '../../lib/utils'
import { Markdown, type DisablablePreviewBlock } from './Markdown'
import { documentDir } from './document-path'
import { ShikiCodeEditor } from '../code-viewer/ShikiCodeEditor'

/**
 * A document may name another document, and drawing that one inside this one has no floor: the
 * fence falls through to a code block instead. The same guard the renderer's own nesting needs.
 */
const NO_NESTED_DOCUMENTS: ReadonlySet<DisablablePreviewBlock> = new Set(['markdown-preview'])

export interface MarkdownEditorPaneProps {
  /** Absolute path of the `.md` file. */
  src: string
  /** Which face to show. Reading by default — editing is what a caller asks for explicitly. */
  mode?: 'view' | 'edit'
  /**
   * Where this pane sits, which decides how much room it takes while it is loading.
   *
   * A pane of its own (`'pane'`, the default) is the window's surface, so it takes a pane's worth
   * (`min-h-[400px]`). A block inside a message is a fixed-height look at a document and does not
   * want its own floor pushing the conversation around (`min-h-[80px]`).
   */
  layout?: 'pane' | 'inline'
  /** The source editor's placeholder, when the file is empty. */
  placeholder?: string
  /** The document column's own padding and width, shared by both faces. */
  className?: string
  /** Every document that reached the disk, including the one this pane writes on its way out. */
  onSaved?: (document: string) => void
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}

export function MarkdownEditorPane({
  src,
  mode = 'view',
  layout = 'pane',
  placeholder,
  className,
  onSaved,
  onUrlClick,
  onFileClick,
}: MarkdownEditorPaneProps) {
  const { t } = useTranslation()
  const { onWriteFile } = usePlatform()
  const { document, problem, report, saveState, conflict, keepMine, reloadFromDisk, reloadToken } =
    useFileWriter(src, onSaved)

  /**
   * The working copy: what is on screen, which is **not** the same thing as the file as last read.
   *
   * `useFileWriter`'s `document` deliberately does not follow an edit — a document is real when it
   * is saved — and the source editor is a controlled textarea, so handing it that value rewrites the
   * textarea out from under the caret on every keystroke (measured: the caret jumps to the end and
   * nothing lands). So both faces read this: the editor edits it, the renderer draws it, and it is
   * re-seeded whenever the file is read again — from outside, or by taking the version on disk.
   */
  const [draft, setDraft] = React.useState<string | null>(null)

  React.useEffect(() => {
    setDraft(document)
  }, [document, reloadToken])

  const handleChange = React.useCallback(
    (next: string) => {
      setDraft(next)
      report(next)
    },
    [report],
  )

  /** A pane's worth of room for the two things that are said instead of the document. */
  const placeholderHeight = layout === 'pane' ? 'min-h-[400px]' : 'min-h-[80px]'

  if (problem) {
    return (
      <div className={`flex-1 min-h-0 ${placeholderHeight} flex items-center justify-center px-6 text-center`}>
        <span className="text-destructive/70 text-[13px]">{problem}</span>
      </div>
    )
  }

  const editing = mode === 'edit'

  return (
    /* A column, and it fills the box it is given — because a pane in the full-size window *is* that
       window's surface, so the document inside gets a height to fill rather than one of its own to
       state. Where nothing hands it a height (a block in a message) `flex-1` means nothing and
       `placeholderHeight` is the floor while there is nothing to show. */
    <div className="relative flex-1 min-h-0 flex flex-col">
      {draft === null ? (
        <div
          className={`flex-1 min-h-0 ${placeholderHeight} flex items-center justify-center text-muted-foreground text-[13px]`}
        >
          {t('common.loading')}
        </div>
      ) : (
        /* Keyed by the reload: reading the file again is a new document rather than a new value —
           the editor is a textarea, and it should come up at the top of the new text. */
        <div key={reloadToken} className="relative flex-1 min-h-0 flex flex-col">
          {editing ? (
            /* The source is framed by a box of a *definite* height, absolutely. In this chain the
               overlay's `min-h-full` is a minimum rather than a size, so a flexed box is sized by
               the very content it is meant to be scrolling — measured on 3000px of source, both
               `flex-1 min-h-0` and `h-full` produced a 3000px editor and a window that scrolled,
               while `absolute inset-0` produced a 232px editor with the page unscrolled. It is the
               same primitive `DrawioEditorFrame` uses, for the same reason: an absolutely
               positioned box takes the *used* height of its container, which is what "the editor is
               always the size of the pane" means. */
            <div className="absolute inset-0 flex flex-col">
              <ShikiCodeEditor
                value={draft}
                onChange={handleChange}
                readOnly={!onWriteFile}
                autoFocus
                className={className}
                placeholder={placeholder}
              />
            </div>
          ) : (
            /* The document column: prose set across 1900px is not read, it is scanned — so the
               width and the padding come from the caller, and both faces share them. */
            <div className={cn('flex-1 min-h-0 overflow-auto', className)}>
              <Markdown
                mode="minimal"
                onUrlClick={onUrlClick}
                onFileClick={onFileClick}
                hideFirstMermaidExpand={false}
                baseDir={documentDir(src)}
                disablePreviewBlocks={NO_NESTED_DOCUMENTS}
              >
                {draft}
              </Markdown>
            </div>
          )}
        </div>
      )}

      {/* What is happening to the file: a word in the corner, and the decision in the middle if
          the file changed underneath — see `FileSaveStatus`. A document has nothing to say about a
          selection, so this is the only thing this pane floats. */}
      <FileSaveStatus
        saveState={saveState}
        conflict={conflict !== null}
        onReloadFromDisk={reloadFromDisk}
        onKeepMine={keepMine}
      />
    </div>
  )
}
