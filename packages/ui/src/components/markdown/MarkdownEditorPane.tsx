/**
 * A markdown file, shown and changed.
 *
 * **Two faces, one file**, and they are different kinds of thing on purpose:
 *
 * - **Reading is the renderer.** The document is drawn by the same `Markdown` the conversation
 *   draws messages with, so a `.md` looks the same here as a message quoting it, and the preview
 *   blocks inside it — a `drawio-preview`, an `html-preview`, a table, a diff — are the app's own
 *   blocks rather than a second rendering of them.
 * - **Editing is the source.** The file as text, and what is written back is exactly what is on
 *   screen. Nothing goes through a document model on the way out, so a construct the app has no
 *   node for cannot be silently dropped from somebody's file — which is the failure a rich editor
 *   risks every time it parses a document it then saves. The blocks the file names are drawn *in
 *   place* while the caret is elsewhere (`SourceEditor`), which is the part that used to
 *   need a switch to the reading face to check.
 *
 * Which face is shown belongs to the caller (`mode`): a block inside a conversation only ever
 * reads, and the full-size window is where the two are switched. When to write, whether the write
 * will be allowed, and what to do when the file changed underneath are not decided here at all —
 * they are `useFileWriter` (see §2⑪ of the workbench notes).
 */

import * as React from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePlatform } from '../../context/PlatformContext'
import { useSourceDraft } from '../editors/useSourceDraft'
import { FileSaveStatus } from '../editors/FileSaveStatus'
import { cn } from '../../lib/utils'
import { digestOf } from '../../lib/digest'
import { Markdown, type DisablablePreviewBlock } from './Markdown'
import { preprocessLinks } from './linkify'
import { SourceText } from '../editors/SourceText'
import { TiptapMarkdownEditor } from './TiptapMarkdownEditor'
import { FrontmatterPanel } from './FrontmatterPanel'
import { parseDocText, serializeDocText } from '../editors/markdown-envelope'
import { documentDir } from './document-path'

/**
 * A document may name another document, and drawing that one inside this one has no floor: the
 * fence falls through to a code block instead. The same guard the renderer's own nesting needs.
 */
const NO_NESTED_DOCUMENTS: ReadonlySet<DisablablePreviewBlock> = new Set(['markdown-preview'])

/**
 * Above this size the reading face is plain text.
 *
 * Only a safety net for absurd files now: the reading engine builds in batches, so a 300 KB note
 * is opened by Tiptap. A multi-megabyte file is the one case where the editor would still be the
 * wrong tool for a click.
 */
const PLAIN_PREVIEW_MAX_CHARS = 2_000_000

export interface MarkdownEditorPaneProps {
  /** Absolute path of the `.md` file. */
  src: string
  /**
   * Which face to show. Reading by default — editing is what a caller asks for explicitly.
   *
   * `view` reads, `edit` writes with the blocks drawn in place, and `source` writes with nothing but
   * the text: the same file, saved the same way, for the editing that a picture in the middle of a
   * document only gets in the way of (a fence body, a table of numbers, a diff someone is fixing).
   */
  mode?: 'view' | 'edit' | 'source'
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
  const { onWriteFile, onSendToChat, onReadFileDataUrl } = usePlatform()
  const { draft, change, problem, saveState, conflict, keepMine, reloadFromDisk, reloadToken } =
    useSourceDraft(src, onSaved)

  /**
   * The working copy, shared by both faces: the editor edits it, the renderer draws it (`useSourceDraft`).
   *
   * Keeping it above the two faces is why the reading face shows what is on screen rather than what
   * was last saved — a document is read back to check what was just typed.
   */

  /**
   * Where the caret is, in the document the pane holds.
   *
   * The offsets are the point: they are what an outside writer can act on, and they survive a
   * sentence that occurs twice. Cleared when the selection collapses, so the affordance appears
   * exactly while somebody has something selected.
   */
  const [selection, setSelection] = React.useState<{ from: number; to: number } | null>(null)

  /**
   * The file's own parts, read off the working copy: its YAML frontmatter, which is not part of the document.
   *
   * It is edited by its own strip above the text (`FrontmatterPanel`) and put back by `serializeDocText`, so the
   * document a save serializes never contains it and cannot damage it.
   */
  const envelope = React.useMemo(
    // Only the editing faces draw the frontmatter strip; a preview neither reads nor writes it.
    () => (draft === null || mode === 'view' ? null : parseDocText(draft)),
    [draft, mode],
  )

  /**
   * The YAML block this window removed, so it can be put back.
   *
   * Removing the file's metadata is the one edit here that leaves no trace in the text: the document is the body
   * either way, so the only sign is that a strip stopped being drawn — and the removal reaches the disk on the same
   * debounce as typing. A removal nobody meant is therefore a file that lost its frontmatter a second later, which is
   * what happened (`示例文档.md`, 2026-11-03: body byte-identical, header gone). The panel now asks before removing;
   * this is the way back when the answer was a mistake.
   */
  const [removedFrontmatter, setRemovedFrontmatter] = React.useState<string | null>(null)

  const setFrontmatter = React.useCallback(
    (frontmatter: string) => {
      if (draft === null) return
      const current = parseDocText(draft)
      if (current.frontmatter !== '' && frontmatter === '') setRemovedFrontmatter(current.frontmatter)
      else if (frontmatter !== '') setRemovedFrontmatter(null)
      change(serializeDocText({ ...current, frontmatter }, current.body))
    },
    [draft, change],
  )

  // A removal belongs to the file it was made in: another file, or this one read again, starts with nothing to undo.
  React.useEffect(() => {
    setRemovedFrontmatter(null)
  }, [src, reloadToken])

  const sendSelection = React.useCallback(() => {
    if (!selection || !onSendToChat || draft === null) return
    const text = draft.slice(selection.from, selection.to)
    if (!text) return
    void digestOf(draft).then((hash) => {
      onSendToChat({ path: src, text, start: selection.from, end: selection.to, hash, coords: 'file' })
    })
  }, [selection, draft, onSendToChat, src])

  /**
   * How a block the engine cannot carry is drawn on the reading face: the reader, on the same column and with the same
   * links. Stable, because the editor puts it in a context every node view reads.
   */
  const renderLiteralBlock = React.useCallback(
    (text: string) => (
      <Markdown
        mode="minimal"
        baseDir={documentDir(src)}
        onUrlClick={onUrlClick}
        onFileClick={onFileClick}
        disablePreviewBlocks={NO_NESTED_DOCUMENTS}
      >
        {text}
      </Markdown>
    ),
    [src, onUrlClick, onFileClick],
  )

  /**
   * The reading copy: bare URLs and file paths made into links, as the reading face has always done
   * (`preprocessLinks` — it is a display step, so it never touches what the file holds).
   */
  const readingText = React.useMemo(
    () =>
      draft === null || mode !== 'view' || draft.length > PLAIN_PREVIEW_MAX_CHARS
        ? ''
        : preprocessLinks(draft),
    [draft, mode],
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

  const editing = mode !== 'view'
  /** A document too large for the reading engine: the text is drawn, and the editor is the pencil. */
  const plainPreview = mode === 'view' && draft !== null && draft.length > PLAIN_PREVIEW_MAX_CHARS

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
          /* Not keyed by the reload, deliberately. A re-read is a new *value* for the rich face: it is handed to
             the editor as content and landed as one transaction over the blocks that changed, which is what keeps
             the caret of whoever is typing. The source face is a plain textarea and has nowhere to put a
             transaction, so it takes the remount (`key` below) and comes up at the top of the new text. */
          <div className="relative flex-1 min-h-0 flex flex-col">
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
                {/* Only above the rich face. The source face shows the whole file, frontmatter and all — putting a
                    YAML editor above it would show the same bytes twice, both editable, and invite the two copies to
                    disagree. A dozen lines of `---` are not what the source face needs help with. */}
                {mode === 'edit' && envelope ? (
                  envelope.frontmatter ? (
                    <FrontmatterPanel
                      frontmatter={envelope.frontmatter}
                      onChange={setFrontmatter}
                      readOnly={!onWriteFile}
                    />
                  ) : removedFrontmatter ? (
                    /* Where the strip was, what became of it — and the one click that puts it back. */
                    <div className="shrink-0 flex items-center gap-2 border-b border-border/60 bg-muted/25 px-3 py-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t('preview.frontmatterRemoved')}
                      </span>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => setFrontmatter(removedFrontmatter)}
                        className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {t('common.undo')}
                      </button>
                    </div>
                  ) : null
                ) : null}
                <div className="relative flex-1 min-h-0 flex flex-col">
                  {/* Two editing faces over one file, and they answer different questions. `source` is the file as
                      text — nothing is modelled, so nothing can be lost. `edit` is a document: blocks, a caret, an
                      undo stack, and edits arriving from outside as transactions (`landMarkdown`). It is the
                      official markdown engine, because that is the one whose parse the block layer was measured
                      against and the only one that exposes `editor.markdown` at all. */}
                  {mode === 'edit' ? (
                    <TiptapMarkdownEditor
                      key={src}
                      content={draft}
                      onUpdate={change}
                      editable={!!onWriteFile}
                      /*
                       * No `autoFocus`: a document opens to be read, and the caret is put where a person clicks. A
                       * caret appearing on its own also promised typing that the rest of the window has not
                       * acknowledged — the file is written by what is typed, not by being opened.
                       */
                      markdownEngine="official"
                      className={className}
                      placeholder={placeholder}
                      onUrlClick={onUrlClick}
                      onFileClick={onFileClick}
                      // A picture beside the document is read from the document's folder in both faces, and drawn as a
                      // data URL — the renderer's origin is not where the file is (`DocumentImage`).
                      baseDir={documentDir(src)}
                      readFileDataUrl={onReadFileDataUrl}
                    />
                  ) : (
                    <SourceText
                      key={reloadToken}
                      value={draft}
                      language="markdown"
                      onChange={change}
                      readOnly={!onWriteFile}
                      autoFocus
                      className={className}
                      placeholder={placeholder}
                      onSelectionChange={setSelection}
                    />
                  )}
                  {/* The selection, handed over with its offsets. A pill rather than a toolbar button:
                      it belongs to the selection, and goes away with it. The offsets are the source face's (a
                      document has no single string to slice), so this appears there and not in the rich face. */}
                  {selection && onSendToChat && (
                    <button
                      type="button"
                      onClick={sendSelection}
                      className={cn(
                        'absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-[7px] px-2 py-1',
                        'text-[11px] font-medium bg-background/90 backdrop-blur shadow-minimal',
                        'text-muted-foreground hover:text-foreground transition-colors',
                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      )}
                      title={t('preview.sendSelection')}
                    >
                      <MessageSquarePlus className="h-3 w-3" aria-hidden />
                      {t('preview.sendSelection')}
                    </button>
                  )}
                </div>
            </div>
          ) : (
            /* Reading is the *same document*, drawn by the same renderer as editing (`presentation`).
               That is the point of the two faces sharing an engine: what a person reads is what they
               would edit, block for block, so switching faces cannot change what the file says. The
               width and the padding are the document column's, as before. */
            <div className="flex-1 min-h-0 overflow-auto">
              {plainPreview ? (
                <div className={cn('pb-6', className)}>
                  <p className="mb-3 text-[12px] text-muted-foreground">{t('preview.largeFilePlain')}</p>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground/80">
                    {draft}
                  </pre>
                </div>
              ) : (
                <TiptapMarkdownEditor
                  content={readingText}
                  presentation
                  markdownEngine="official"
                  className={className}
                  onUrlClick={onUrlClick}
                  onFileClick={onFileClick}
                  baseDir={documentDir(src)}
                  readFileDataUrl={onReadFileDataUrl}
                  suppressedFenceDrawings={NO_NESTED_DOCUMENTS}
                  renderLiteralBlock={renderLiteralBlock}
                />
              )}
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
