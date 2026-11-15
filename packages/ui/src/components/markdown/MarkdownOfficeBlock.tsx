/**
 * `office-preview` — a document in a message, edited where it is shown.
 *
 * The fence names a file, and the app draws it with the vendored editor (see `OfficeFrame`),
 * so a Word/Excel/PowerPoint file an agent produced can be read in the conversation and fixed
 * without leaving it.
 *
 * What is deliberately *not* here: tabs, an edit/view toggle, a "pencil". A page block opens a
 * separate editor overlay because editing a page means clicking elements in it; a document is
 * edited by typing into it, so the frame in the block already is the editor, and the one action
 * worth offering is the same document at window size.
 *
 * Cost, stated so it is not discovered later: each block mounts its own editor bundle (~27 MB of
 * assets for Docs, cached by the host). A conversation that quotes five documents is five
 * frames — see §"Performance" in `docs/requirements/office-embed.md`.
 */

import * as React from 'react'
import { FileText, Maximize2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'
import { useInView } from '../../hooks/useInView'
import { usePlatform } from '../../context/PlatformContext'
import { OfficeFrame } from '../office/OfficeFrame'
import { OfficePreviewOverlay } from '../office/OfficePreviewOverlay'
import { digest } from '../office/digest'
import { useProjectFilesWatch } from '../../hooks/useProjectFilesWatch'
import { sameFilePath } from '../../lib/file-paths'
import { officeLanguage, type OfficeApp } from '@craft-agent/shared/office/types'
import { CodeBlock } from './CodeBlock'

interface OfficeBlockSpec {
  src?: string
  title?: string
  /** Overrides the extension; normally inferred (`docs` for .docx, …). */
  app?: OfficeApp
}

/** Which editor opens this file, from its extension. The app's classification says the same. */
export function officeAppForPath(path: string): OfficeApp | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'docx' || ext === 'doc' || ext === 'odt') return 'docs'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'tsv' || ext === 'ods') return 'sheets'
  if (ext === 'pptx' || ext === 'ppt' || ext === 'odp') return 'slides'
  return null
}

/**
 * A path as a message leaves it.
 *
 * Paths in a transcript are rendered as links, so a spec that was copied out of a message often
 * reads `[C:\x\brief.docx](C:\x\brief.docx)` — or `file:///C:/x/brief.docx` if it went through a
 * browser. Both name the same file, and a preview that refuses them is a preview that works
 * only for whoever typed the JSON by hand.
 */
export function normalizeOfficeSrc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let src = value.trim()
  const link = /^\[[^\]]*\]\(([^)]+)\)$/.exec(src)
  if (link) src = link[1]!.trim()
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1).trim()
  if (src.startsWith('file://')) {
    try {
      src = decodeURIComponent(new URL(src).pathname)
      // `file:///C:/x` keeps the drive's colon and loses the leading slash
      if (/^\/[A-Za-z]:/.test(src)) src = src.slice(1)
    } catch {
      return null
    }
  }
  return src || null
}

/**
 * The fence's spec, from either form it is written in.
 *
 * JSON is the documented one (`{"src": …}`), but a bare path — the whole body — is what a person
 * pastes, so it is read as the same thing rather than as a malformed block.
 */
export function parseOfficeSpec(code: string): OfficeBlockSpec | null {
  const raw = code.trim()
  if (!raw) return null

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const src = normalizeOfficeSrc(parsed.src)
      if (!src) return null
      const app = typeof parsed.app === 'string' ? (parsed.app as OfficeApp) : undefined
      const title = typeof parsed.title === 'string' ? parsed.title : undefined
      return { src, ...(title ? { title } : {}), ...(app ? { app } : {}) }
    } catch {
      return null
    }
  }

  const src = normalizeOfficeSrc(raw)
  return src ? { src } : null
}

export function parseSpec(code: string): OfficeBlockSpec | null {
  return parseOfficeSpec(code)
}

export function MarkdownOfficeBlock({ code, className }: { code: string; className?: string }) {
  const platform = usePlatform()
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const [origin, setOrigin] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /**
   * "The file changed on disk" — said, not acted on.
   *
   * A read-only preview that reloaded itself would move the page under the person reading it (an
   * office document takes a second to draw again), so the block says the file is newer and offers a
   * refresh. The digest below is the version *on screen*, taken from the bytes the frame itself read
   * — so knowing whether the file moved costs no extra read.
   */
  const [revision, setRevision] = React.useState(0)
  const [stale, setStale] = React.useState(false)
  const seenDigestRef = React.useRef<string | null>(null)

  const spec = parseSpec(code)
  const path = spec?.src ?? ''
  const app = spec?.app ?? (path ? officeAppForPath(path) : null)

  const canRender = Boolean(spec && path && app && platform.onGetOfficeOrigin && platform.onReadFileBinary && platform.onWriteFileBinary)

  React.useEffect(() => {
    if (!canRender) return
    let cancelled = false
    platform
      .onGetOfficeOrigin!()
      .then((value) => {
        if (!cancelled) setOrigin(value)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [canRender, platform.onGetOfficeOrigin])

  /**
   * The frame is a whole editor application (8 MB of script for Word, 20 MB for Excel) and it asks
   * the host for the document's bytes — so one per block, mounted eagerly, is how a long history
   * ends up booting a dozen editors before anything is scrolled into view. A conversation renders
   * every turn it has.
   *
   * So the frame exists only while the block is near the viewport, and the 460px box is drawn
   * whether or not the frame is inside it (the height never changes, so mounting cannot move the
   * scroll position). Leaving is safe for a second reason that is not an accident: this copy is
   * **read-only** — there is no unsaved state to lose when it goes away.
   *
   * Called above the early returns below: a hook behind a branch is a hook that is sometimes not
   * called, which React refuses.
   */
  const [viewportRef, inView] = useInView<HTMLDivElement>()

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  /*
   * Everything below reads the file, so it is set up **before** any early return: a hook that runs
   * on some renders and not others is not a hook, it is a crash waiting for `canRender` to flip.
   */
  const readBytes = platform.onReadFileBinary
  const writeBytes = platform.onWriteFileBinary

  /** The frame's own read, with the digest kept as a side effect. */
  const trackedReadBytes = React.useCallback(
    async (filePath: string) => {
      if (!readBytes) throw new Error('This host cannot read files.')
      const bytes = await readBytes(filePath)
      seenDigestRef.current = await digest(bytes)
      return bytes
    },
    [readBytes],
  )

  /**
   * Does the file on disk still hold what this frame is showing?
   *
   * Off-screen blocks do not ask — a conversation can hold several of these, and a read on every
   * change anywhere in the project tree would be paid by all of them. `inView` turning true asks
   * once, so scrolling back to a block that went stale while away still says so.
   */
  const checkForExternalChange = React.useCallback(async () => {
    if (!path || !inView || !readBytes) return
    try {
      const onDisk = await readBytes(path)
      const next = await digest(onDisk)
      if (seenDigestRef.current !== null && next !== seenDigestRef.current) setStale(true)
    } catch {
      // Gone or unreadable: the overlay's own reader reports that when it is opened.
    }
  }, [path, inView, readBytes])

  useProjectFilesWatch(() => void checkForExternalChange())

  /**
   * The host's own announcement, which is the one path that works for a file outside the project
   * tree. It carries an absolute path, so this block only reacts to its own file.
   */
  const onFileWritten = platform.onOfficeFileWritten
  React.useEffect(() => {
    if (!onFileWritten || !path) return
    return onFileWritten((written) => {
      if (sameFilePath(written, path)) void checkForExternalChange()
    })
  }, [onFileWritten, path, checkForExternalChange])

  React.useEffect(() => {
    if (inView) void checkForExternalChange()
  }, [inView, checkForExternalChange])

  /**
   * The project watcher only knows the project tree, so a file somewhere else (a download, a temp
   * export) can be written without it saying anything. Coming back to the window is the moment a
   * person would notice anyway, and one read then costs less than polling for it.
   */
  React.useEffect(() => {
    if (!inView) return
    const check = () => void checkForExternalChange()
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [inView, checkForExternalChange])

  if (!spec || !path) return fallback
  if (!app) {
    // A path whose editor we cannot name is worth saying out loud: falling back to a code block
    // is what an unrendered block looked like, which is the wrong thing to debug first.
    return (
      <div className={cn('rounded-[8px] border bg-muted/10 px-3 py-2 text-[13px] text-muted-foreground', className)}>
        {t('preview.officeUnsupported', { path })}
      </div>
    )
  }
  if (!canRender) {
    return (
      <div className={cn('rounded-[8px] border bg-muted/10 px-3 py-2 text-[13px] text-muted-foreground', className)}>
        {t('preview.officeUnavailable')}
      </div>
    )
  }

  const file = { id: path, path, name: path.split(/[\\/]/).pop() ?? path }
  const language = officeLanguage(i18n.resolvedLanguage ?? i18n.language)

  return (
    <>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground font-medium flex-1 truncate">
            {spec.title || file.name}
          </span>
          {/* Said, not acted on: the file on disk is newer than this preview, and reloading it here
              would move the page under whoever is reading. One press of this line redraws it. */}
          {stale && (
            <button
              type="button"
              onClick={() => {
                setStale(false)
                setRevision((value) => value + 1)
              }}
              className={cn(
                'flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium',
                'bg-accent/15 text-accent hover:bg-accent/25 transition-colors',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              )}
              title={t('preview.fileChanged')}
            >
              <RefreshCw className="w-3 h-3" />
              {/* Says what happened, not what the button does: "refresh" read as a control, so a
                  reader could not tell the file had moved under them. The press is still theirs. */}
              {t('preview.fileChangedShort')}
            </button>
          )}
          <button
            onClick={() => setExpanded(true)}
            className={cn(
              'p-1 rounded-[6px] transition-all select-none bg-background shadow-minimal',
              'text-muted-foreground/50 hover:text-foreground',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
            title={t('common.viewFullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {error ? (
          <div className="px-3 py-6 text-center text-[13px] text-destructive/70">{error}</div>
        ) : origin ? (
          // The editor is live in the message — the real one, drawing the real document — and it is
          // **read-only**: the small preview is a look, and the overlay behind the expand button is
          // where editing happens. This is not a hidden button: the shim refuses every write that
          // leaves this frame, so a Save in here cannot reach the disk.
          <div ref={viewportRef} className="relative" style={{ height: 460 }}>
            {inView && (
              <OfficeFrame
                /* A refresh remounts the frame, which is what makes it read the file again. */
                key={`${path}:${revision}`}
                origin={origin}
                app={app}
                file={file}
                readBytes={trackedReadBytes}
                writeBytes={writeBytes!}
                labels={{ language }}
                readOnly
                onOfficeDeck={platform.onOfficeDeck}
                onOfficeWorkbook={platform.onOfficeWorkbook}
                onOfficePdf={platform.onOfficePdf}
                className="relative h-full w-full"
                onError={setError}
              />
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-[13px] text-muted-foreground">{t('common.loading')}</div>
        )}
      </div>

      {/* The overlay is where editing happens: the frame above is a look, and this is the
          deliberate step from it. It stays writable on purpose — the small preview is what must
          not accept edits, not the surface a person expanded into. */}
      <OfficePreviewOverlay
        isOpen={expanded}
        onClose={() => setExpanded(false)}
        filePath={path}
        app={app}
        title={spec.title}
      />
    </>
  )
}
