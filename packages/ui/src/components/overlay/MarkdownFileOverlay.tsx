/**
 * A markdown file, opened full size — from a link in a conversation, or from the block that names it.
 *
 * It is the same overlay every other file preview opens (`PreviewOverlay`: one header, one place the
 * file's own menu lives, modal on a wide screen and full screen on a narrow one), filled by
 * `MarkdownEditorPane`. **Two faces, and a pencil in the header between them**: the document as it
 * reads (rendered by the app's own markdown renderer, preview blocks and all) and the file as its
 * source (a textarea with markdown highlighting, which is exactly what would be written back).
 *
 * Which face it opens on comes from the caller (`initialMode`): a block's pencil asks for the
 * source, its full-screen button asks for the reading view, and a `.md` link asks for reading too.
 * Toggling inside the window is the pencil's own business — that is what it is for.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, FileText, ListTodo, Pencil } from 'lucide-react'
import { usePlatform } from '../../context/PlatformContext'
import { PreviewOverlay } from './PreviewOverlay'
import { MarkdownEditorPane } from '../markdown/MarkdownEditorPane'

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
  /** Which face to open on. 'view' reads; 'edit' is the source, with the caret already in it. */
  initialMode?: 'view' | 'edit'
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
  const { onWriteFile } = usePlatform()
  const name = title ?? filePath.split(/[\\/]/).pop() ?? filePath

  const [mode, setMode] = React.useState<'view' | 'edit'>(initialMode)
  // Each opening takes the face it was opened with: this overlay stays mounted while it is closed,
  // so a mode remembered from last time would answer a request that asked for the other one.
  React.useEffect(() => {
    if (isOpen) setMode(initialMode)
  }, [isOpen, initialMode])

  const editing = mode === 'edit'
  /** Editing needs somewhere to write: a host with no write action reads the document, full stop. */
  const canEdit = Boolean(onWriteFile)

  const headerActions = canEdit ? (
    <button
      type="button"
      onClick={() => setMode(editing ? 'view' : 'edit')}
      title={editing ? t('preview.backToPreview') : t('common.edit')}
      aria-label={editing ? t('preview.backToPreview') : t('common.edit')}
      aria-pressed={editing}
      className={
        /* The same box, and the same colouring, as the buttons beside it in this row: one colour
           for both modes, because the icon already says which way the switch goes and a dimmer or
           darker one reads as a state of the button rather than as the control that changes the
           mode. */
        'p-1.5 rounded-[8px] transition-all select-none bg-background shadow-minimal ' +
        'text-muted-foreground hover:text-foreground'
      }
    >
      {editing ? <Eye className="w-4 h-4" /> : <Pencil className="w-4 h-4" />}
    </button>
  ) : undefined

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
