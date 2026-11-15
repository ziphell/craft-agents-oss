/**
 * A markdown file, opened full size — from a link in a conversation, or from the block that names it.
 *
 * It is the same overlay every other file preview opens (`PreviewOverlay`: one header, one place the
 * file's own menu lives, modal on a wide screen and full screen on a narrow one), filled by
 * `MarkdownEditorPane`. **Two faces: the document as it reads** (rendered by the app's own markdown
 * engine, preview blocks and all) **and the file as its source** (a textarea with markdown
 * highlighting, which is exactly what would be written back). A markdown file here is a document
 * to read, so there is no editing face and no pencil.
 *
 * Which face it opens on comes from the caller (`initialMode`): a `.md` link opens on the reading
 * view. Toggling inside the window is the header's own business — that is what it is for.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Code2, FileText, ListTodo } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { MarkdownEditorPane } from '../markdown/MarkdownEditorPane'

/**
 * The faces a markdown document has in this window: reading, and the file as text.
 */
export type MarkdownFace = 'view' | 'source'

/**
 * The box, the colouring and the hover of every icon button in this header's row — one constant, so
 * the next button added here cannot drift from the ones beside it.
 */
const HEADER_BUTTON_CLASS =
  'p-1.5 rounded-[8px] transition-all select-none bg-background shadow-minimal ' +
  'text-muted-foreground hover:text-foreground'

export interface MarkdownFileOverlayProps {
  isOpen: boolean
  onClose: () => void
  /** Absolute path of the `.md` file to show and edit. */
  filePath: string
  /** The file's own name when it has no better title. */
  title?: string
  theme?: 'light' | 'dark'
  /**
   * What the document *is*, when it is more than a file: the app writes plans into the
   * workspace's plans folder, and a document read to be accepted reads differently from one
   * read for something in it. Same meaning as `DocumentFormattedMarkdownOverlay`'s.
   */
  variant?: 'response' | 'plan'
  /** Which face to open on. 'view' reads, 'source' is the file as text. */
  initialMode?: MarkdownFace
  /**
   * Every document that reached the disk while this was open — including the one written on the way
   * out. Something behind the window that showed the same file needs it: a block in a conversation
   * is a *different* reader of that file, and nothing else tells it a write happened.
   */
  onSaved?: (document: string) => void
  /**
   * Where a link inside the document goes — the same pair the sibling document overlay takes,
   * because a link in a document is the app's to open wherever the document is being read.
   */
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
}

export function MarkdownFileOverlay({
  isOpen,
  onClose,
  filePath,
  title,
  theme,
  variant = 'response',
  initialMode = 'view',
  onSaved,
  onOpenUrl,
  onOpenFile,
}: MarkdownFileOverlayProps) {
  const { t } = useTranslation()
  const name = title ?? filePath.split(/[\\/]/).pop() ?? filePath

  /**
   * **A markdown file is read, not edited.** Opening it shows the document; the only header switch
   * is between the rendered document and its source. Nothing is written from this window.
   */
  const [mode, setMode] = React.useState<MarkdownFace>(initialMode)
  // Each opening takes the face it was opened with: this overlay stays mounted while it is closed,
  // so a mode remembered from last time would answer a request that asked for the other one.
  React.useEffect(() => {
    if (isOpen) setMode(initialMode)
  }, [isOpen, initialMode])

  const sources = mode === 'source'

  const headerActions = (
    <div className="flex items-center gap-2">
      {/* The file as text, beside the document. Not a reading/editing switch: a fence body, a table of numbers, a
          diff someone is repairing — the blocks are a picture of the source, and a picture is exactly what gets in
          the way when the source is what is wrong. Pressed means "this is the source", and pressing it again shows
          the document. */}
      <button
        type="button"
        onClick={() => setMode(sources ? 'view' : 'source')}
        title={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
        aria-label={sources ? t('preview.backToPreview') : t('preview.sourceMode')}
        aria-pressed={sources}
        className={HEADER_BUTTON_CLASS}
      >
        <Code2 className="w-4 h-4" />
      </button>
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{ icon: FileText, label: t('preview.markdownPreview'), variant: 'default' }}
      filePath={filePath}
      title={name}
      headerActions={headerActions}
    >
      {variant === 'plan' && (
        <div className="mx-auto flex w-full max-w-[860px] items-center gap-2 px-10 pt-6">
          <ListTodo className="h-3 w-3 text-success" />
          <span className="text-[13px] font-medium text-success">Plan</span>
        </div>
      )}

      {/* The document is a column rather than the whole window: prose set across 1900px is not
          read, it is scanned. Twenty-four above and below is the column's own breathing room —
          the window's own gutter is the base's — and the pane's chip (`saving`, or the file
          changing underneath) is pinned in its corner, so it never moves this text. */}
      <MarkdownEditorPane
        src={filePath}
        mode={mode}
        layout="pane"
        className="mx-auto w-full max-w-[860px] px-10 py-6"
        onSaved={onSaved}
        onUrlClick={onOpenUrl}
        onFileClick={onOpenFile}
      />
    </PreviewOverlay>
  )
}
