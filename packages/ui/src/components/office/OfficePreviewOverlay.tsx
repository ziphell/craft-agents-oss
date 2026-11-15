/**
 * A document, at window size, editable in place.
 *
 * The overlay is the app's own shell (`PreviewOverlay`): badge, file menu, Escape, the responsive
 * modal/fullscreen switch. Inside it sits one `OfficeFrame` — an `<iframe>` at the office origin
 * with a shim standing in for the editor's preload, so what runs here is the vendored GenOffice
 * editor, unmodified, and what it can do to a file is exactly what the host answers.
 *
 * Two things this component decides, both of which the editor cannot:
 *
 * - **Which editor.** `app` comes from the file's extension (`docs` for .docx, `sheets` for
 *   .xlsx, `slides` for .pptx) — see `officeAppFor` in the app's file classification.
 * - **Whether it can be used at all.** The origin is asked of the host (a `craft-local://` label
 *   in Electron, `/office` on the hub), and a host without one — or a build without the bundles
 *   — is a sentence rather than an empty frame.
 */

import * as React from 'react'
import { ArrowLeft, FileText, MessageSquarePlus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { PreviewOverlay, type BadgeVariant } from '../overlay/PreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { OfficeFrame, type OfficeFrameHandle } from './OfficeFrame'
import { useOfficeDocument } from './useOfficeDocument'
import { registerOfficeEditTarget } from './office-edits'
import { FileSaveStatus } from '../editors/FileSaveStatus'
import { officeLanguage, type OfficeApp } from '@craft-agent/shared/office/types'

export interface OfficePreviewOverlayProps {
  /** A remark the frame wants said without taking the document off screen. */
  onNotice?: (key: string) => void
  isOpen: boolean
  onClose: () => void
  /** Absolute path of the document. */
  filePath: string
  /** Which editor opens it. */
  app: OfficeApp
  title?: string
  theme?: 'light' | 'dark'
  /** Draw in place (a panel column) instead of in a window of its own. */
  embedded?: boolean
  /** Draw the header or leave the chrome to the caller. Embedded only. */
  chrome?: boolean
  /**
   * The way back to a reader that shares this window, when the host shows one (the pdf overlay:
   * a pen enters editing, this arrow returns to the pages). Absent, nothing is drawn — an editor
   * opened on its own has nowhere to go back to.
   */
  onBack?: () => void
}

const APP_LABEL: Record<string, string> = {
  docs: 'Word',
  sheets: 'Excel',
  slides: 'PowerPoint',
  pdf: 'PDF',
  markdown: 'Markdown',
  html: 'HTML',
}

/**
 * A document, expanded, editable.
 *
 * This is the **deliberate** surface: a person opened it (the expand button on a block, a file
 * link, a library row), so editing happens here. A preview embedded in a message is the opposite
 * case — it draws the same editor with `readOnly` on the frame, and never this overlay.
 */
export function OfficePreviewOverlay({ isOpen, onClose, filePath, app, title, theme = 'light', embedded = false, chrome = true, onNotice, onBack }: OfficePreviewOverlayProps) {
  const platform = usePlatform()
  const { t, i18n } = useTranslation()
  // The editors key their strings by `Lang` ('zh', not 'zh-Hans') — see officeLanguage.
  const language = officeLanguage(i18n.resolvedLanguage ?? i18n.language)

  const [origin, setOrigin] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // What the person has selected in the editor, reported by the frame itself (it is another
  // document; the host cannot read its selection). The hand-off is offered only when there is
  // something to hand over — a button that does nothing is worse than no button.
  const [selection, setSelection] = React.useState<{
    text: string
    from?: number | null
    to?: number | null
  } | null>(null)
  const [sent, setSent] = React.useState(false)

  // The origin is the host's to give: only it can serve one, and only it knows the label.
  React.useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setError(null)
    const ask = platform.onGetOfficeOrigin
    if (!ask) {
      setError(t('preview.officeUnavailable'))
      return
    }
    ask()
      .then((value) => {
        if (cancelled) return
        // Null is the host's answer for "the editors were never built in" — see
        // `officeOriginUrl`. It is not a pending state: waiting for it would spin forever.
        if (!value) {
          setError(t('preview.officeUnavailable'))
          return
        }
        setOrigin(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, platform.onGetOfficeOrigin, t])

  const readBytes = platform.onReadFileBinary
  const writeBytes = platform.onWriteFileBinary
  /**
   * The file, as bytes, with the same three answers a text editor gets (`useFileWriter`): when to
   * write, whether the write is allowed, and what to do when the file changed underneath. The frame
   * is handed the two endpoints — `read` on open, `save` when ⌘S arrives — so the editor stays
   * unaware of all of it.
   */
  const doc = useOfficeDocument(filePath, isOpen)

  /**
   * Closing is the one moment an editor can lose work, and it is the host's to get right: the
   * frame is asked to save (it is the only one that knows whether anything is unsaved), and the
   * overlay stays up — saying so — until it answers.
   *
   * What this deliberately does not do: keep the person here. A save that fails still closes; the
   * failure is reported, not turned into a window that will not go away.
   */
  const frameRef = React.useRef<OfficeFrameHandle | null>(null)

  /**
   * Make this frame findable by path, so an anchored replacement can reach the editor that is
   * actually showing the document. Registered only while the overlay is open: a closed overlay has
   * no frame, and an offer that arrives then must answer "nothing is showing this".
   */
  React.useEffect(() => {
    if (!isOpen || !filePath) return
    return registerOfficeEditTarget(filePath, {
      applyEdit: (edit) => frameRef.current?.applyEdit(edit) ?? Promise.resolve({ ok: false, message: 'the editor is not on screen' }),
    })
  }, [isOpen, filePath])
  const [closing, setClosing] = React.useState(false)
  /**
   * The copy the editor just wrote, as a picture of its first page.
   *
   * For a redaction this is the only proof a person can check: the marks were made inside the
   * editor and never left it, so "is it gone" can only be answered by the file — which is what the
   * host rendered, not what the editor claims.
   */
  const [savedCopy, setSavedCopy] = React.useState<{ path: string; png: string } | null>(null)
  const handleClose = React.useCallback(() => {
    const frame = frameRef.current
    if (!frame?.isDirty()) {
      onClose()
      return
    }
    setClosing(true)
    void frame.flushAndClose().finally(() => {
      setClosing(false)
      onClose()
    })
  }, [onClose])

  /** The frame is only built once the document is in hand: it opens by asking for those bytes, and
   *  a frame mounted before they arrive would have to be built a second time to show them. */
  const ready = origin && readBytes && writeBytes && doc.bytes !== null

  const readForFrame = React.useCallback((path: string) => doc.read(path), [doc.read])
  const writeForFrame = React.useCallback(
    (path: string, next: Uint8Array) => doc.save(next),
    [doc.save],
  )

  const file = React.useMemo(
    () => ({ id: filePath, path: filePath, name: filePath.split(/[\\/]/).pop() ?? filePath }),
    [filePath],
  )

  const handOff = React.useCallback(() => {
    if (!selection?.text || !platform.onSendToChat) return
    // The editor's own positions go with the words when it reports them: without an address, a
    // passage that appears twice in the document makes "change this" ambiguous.
    platform.onSendToChat({
      path: filePath,
      text: selection.text,
      ...(typeof selection.from === 'number' ? { start: selection.from } : {}),
      ...(typeof selection.to === 'number' ? { end: selection.to } : {}),
      coords: 'editor',
    })
    setSent(true)
    window.setTimeout(() => setSent(false), 2500)
  }, [filePath, platform, selection])

  /**
   * The way back, for a host that shows this editor **instead of** a reader in the same window
   * (the pdf overlay: a pen enters editing, this arrow returns to the pages). Absent in a host
   * that opens the editor on its own — there would be nothing to go back to.
   */
  const backAction = onBack ? (
    <button
      type="button"
      onClick={onBack}
      aria-label={t('preview.backToPreview')}
      title={t('preview.backToPreview')}
      className="flex h-7 w-7 items-center justify-center rounded-[6px] bg-background text-muted-foreground shadow-minimal transition-colors hover:text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
    </button>
  ) : null

  const headerActions = (
    <>
      {backAction}
      {platform.onSendToChat && selection?.text ? (
        <button
          type="button"
          onClick={handOff}
          className="flex items-center gap-1.5 rounded-[6px] bg-background px-2 py-1 text-[12px] text-muted-foreground shadow-minimal transition-colors hover:text-foreground"
          title={t('preview.officeSendSelection')}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {sent ? t('preview.officeSentToChat') : t('preview.officeSendSelection')}
        </button>
      ) : null}
    </>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={handleClose}
      theme={theme}
      embedded={embedded}
      chrome={chrome}
      /**
       * The same badge the reader in this window draws for a pdf (`orange`), because the two
       * states are one window: a colour that changes with the state would read as a different file.
       */
      typeBadge={{
        icon: FileText,
        label: `${APP_LABEL[app] ?? 'Document'}`,
        variant: (app === 'pdf' ? 'orange' : 'default') as BadgeVariant,
      }}
      filePath={filePath}
      title={title}
      headerActions={headerActions}
    >
      {error && (
        <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
          {error}
        </div>
      )}
      {/* A read that failed is the other way this never becomes ready: the frame has no bytes to
          open, so saying so is the difference between an error and an endless "loading". */}
      {!error && doc.problem && (
        <div className="flex h-full items-center justify-center p-8 text-center text-[13px] text-muted-foreground">
          {doc.problem}
        </div>
      )}
      {!error && !doc.problem && !ready && (
        <div className="flex h-full items-center justify-center p-8 text-[13px] text-muted-foreground">
          {t('common.loading')}
        </div>
      )}
      {!error && !doc.problem && ready && (
        /**
         * A box with a **floor**, and the frame fills it by `inset-0` — not `h-full`, in either.
         *
         * Measured in the app (`[office-frame]`): `box.h = 0` and the editor's own viewport
         * `0×0`, with the document loaded and drawing into nothing. The cause was the chain, not
         * the editor: the overlay's content box is `min-h-full` (a *min*-height, height auto), and
         * a percentage height does not resolve against a min-height — it falls back to `auto`, and
         * an auto box whose children are all absolutely positioned is zero tall.
         *
         * So: a flex item with a 420px floor for the box, and `absolute inset-0` for the frame —
         * an inset resolves against the box's *used* size, floor included.
         */
        <div className="relative flex-1 min-h-[420px] w-full">
          {/* `reloadToken` is a key on purpose: reloading means the frame is built again from the
              bytes on disk, because an editor cannot be asked to discard its own model. */}
          <OfficeFrame
            key={`${filePath}:${doc.reloadToken}`}
            ref={frameRef}
            origin={origin}
            app={app}
            file={file}
            readBytes={readForFrame}
            writeBytes={writeForFrame}
            labels={{ language, theme: theme === 'dark' ? 'dark' : 'light', documentTheme: theme === 'dark' ? 'dark' : 'light' }}
            /* `absolute inset-0`, not `h-full`: the box above is sized by `min-height`, and a
               percentage height does not resolve against a min-height — it falls back to `auto`,
               with only absolutely positioned children inside, which is zero. Measured in the app:
               `box.h = 0`, and the frame's own viewport came back `0×0` with it. Filling the
               positioned box by inset resolves against its used size (the 420px floor included). */
            className="absolute inset-0"
            onSelectionChange={setSelection}
            onOfficeDeck={platform.onOfficeDeck}
            onOfficeWorkbook={platform.onOfficeWorkbook}
            onOfficePdf={platform.onOfficePdf}
            onSaveProducedFile={platform.onSaveProducedFile}
            onSaveFileDialog={platform.onSaveFileDialog}
            onCopySaved={setSavedCopy}
            onError={setError}
            onNotice={onNotice}
          />
          {/* The decision, over the middle of the document — the same component the page and the
              diagram use, so the words and the two answers are the app's, not this file's. The
              save itself is the header's word, reported to the window chrome by the same slot. */}
          <FileSaveStatus
            saveState={doc.saveState}
            conflict={doc.conflict}
            onReloadFromDisk={doc.reloadFromDisk}
            onKeepMine={() => void doc.keepMine()}
          />
          {/* The window is on its way out and a write is in flight: the one moment a busiest state
              is the honest thing to draw, because the alternative is closing over the save. */}
          {savedCopy && (
            <div className="absolute bottom-3 left-3 z-20 w-[280px] overflow-hidden rounded-[8px] border bg-background shadow-lg">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="truncate">{t('preview.copySaved')}</span>
                <button
                  type="button"
                  onClick={() => setSavedCopy(null)}
                  className="rounded px-1 leading-none hover:text-foreground"
                  aria-label={t('common.close')}
                >
                  ×
                </button>
              </div>
              <img src={savedCopy.png} alt="" className="max-h-[220px] w-full object-contain" />
              <div className="truncate px-2 py-1 text-[11px] text-muted-foreground" title={savedCopy.path}>
                {savedCopy.path}
              </div>
            </div>
          )}
          {closing && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 text-[13px] text-muted-foreground">
              {t('preview.savingBeforeClose')}
            </div>
          )}
        </div>
      )}
    </PreviewOverlay>
  )
}
