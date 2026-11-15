/**
 * The asset library — the project's files, and what people and agents said about them.
 *
 * The list is always what the folder holds; this panel only adds the meaning that was written
 * beside it. That is why a file dropped in with Explorer shows up without an import step, and why
 * a file deleted outside the app disappears instead of becoming an error.
 *
 * Tagging goes through the same index the agent's tool writes, so a word typed here and a word
 * written by an agent are the same word in the same place. A draft started here is the same draft
 * the board draws (`asset-drafts`): its composer runs in the detail column, and the result joins
 * the grid like any other asset.
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Captions, EyeOff, File, FileAudio, FileText, FileVideo, ImageOff, LayoutGrid, Loader2, Music, Plus, RefreshCw, Search, Sparkles, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { PanelsTopLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { classifyFile, usePlatform } from '@craft-agent/ui'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { mediaUrl } from '@/lib/media-url'
import { openSidePanelTab } from '@/atoms/side-panel'
import { windowIsRemoteAtom } from '@/atoms/window-mode'
import type { AssetKind, AssetLayout, LibraryAsset, TagFacet } from '@craft-agent/shared/library'
import type { MediaTaskLookup } from '@craft-agent/shared/media'
import { AssetBoard } from './AssetBoard'
import { cachedDataUrl, cachedText, TEXT_PREVIEW_BYTES } from './asset-thumb-cache'
import { DraftComposer } from './DraftComposer'
import { ImageTools } from './ImageTools'
import { DRAFT_ICON, DRAFT_KINDS, useAssetDrafts, type Draft, type DraftKind } from './asset-drafts'
import { renderImageEdit, type ImageEditOp, type ImageEditSpec } from '@/lib/image-edit'

const KIND_ICON: Record<AssetKind, React.ComponentType<{ className?: string }>> = {
  text: FileText,
  image: ImageOff,
  video: FileVideo,
  audio: FileAudio,
  other: File,
}

const KIND_LABEL_KEY: Record<AssetKind, string> = {
  text: 'library.text',
  image: 'library.image',
  video: 'library.video',
  audio: 'library.audio',
  other: 'library.other',
}

const DRAFT_KIND_LABEL_KEY: Record<DraftKind, string> = {
  image: 'canvas.addImage',
  video: 'canvas.addVideo',
  audio: 'canvas.addAudio',
  text: 'canvas.addText',
}

const KINDS: AssetKind[] = ['text', 'image', 'video', 'audio', 'other']

const joinPath = (folder: string, relative: string): string =>
  `${folder.replace(/[\\/]+$/, '')}/${relative}`

/** A clip's first frame, from the host's thumbnail cache (the board uses the same address). */
const videoPosterUrl = (absolutePath: string): string =>
  `thumbnail://thumb/${encodeURIComponent(absolutePath)}`

/** A file name safe to start a derived asset from: the source's stem, without punctuation. */
const assetSlug = (name: string): string =>
  name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A readable stamp for names that come from the clipboard: 20261115-143005. */
const pasteStamp = (): string => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Whether a paste belongs to a field rather than to the library.
 *
 * A paste that lands in a note, the composer or the search box must stay text. Contenteditable
 * comes in several spellings (`""`, `plaintext-only`, inherited), so the check looks at the live
 * element instead of one attribute value; some hosts also dispatch the event on <body> while the
 * caret is in a field, hence the activeElement fallback.
 */
const isEditablePasteTarget = (target: EventTarget | null): boolean => {
  const element = target instanceof HTMLElement ? target : null
  if (
    element?.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    )
  ) {
    return true
  }
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  return active.isContentEditable || !!active.closest('input, textarea, select')
}

/**
 * A name for a pasted file.
 *
 * Copied files keep their name; a screenshot arrives as literally `image.png`, so it gets a stamp
 * instead — otherwise the second screenshot becomes `image-2.png` forever.
 */
const pastedFileName = (file: File, index: number): string => {
  const name = file.name?.trim()
  if (name && !/^image\.(png|jpe?g|webp|gif)$/i.test(name)) return name
  const subtype = file.type.split('/')[1] ?? 'png'
  const ext = subtype === 'jpeg' ? 'jpg' : (subtype.split('+')[0] || 'png')
  return `pasted-${pasteStamp()}-${index + 1}.${ext}`
}

/**
 * A picked file as base64, without blocking the window.
 *
 * The old path walked every byte with `String.fromCharCode` on the UI thread: a 100 MB clip froze
 * the app for the whole conversion. `FileReader.readAsDataURL` does the same encoding off the
 * render loop, and only the payload is sent over IPC (the data-URL prefix is not file content).
 */
function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

/** A picture reads its bytes only when it is about to be seen; a video never reads them at all. */
function AssetThumb({ asset, absolutePath }: { asset: LibraryAsset; absolutePath: string }) {
  const [url, setUrl] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  /** A clip whose first frame the host could not decode still has a face of its own. */
  const [posterFailed, setPosterFailed] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  const Icon = KIND_ICON[asset.kind]

  React.useEffect(() => {
    setPosterFailed(false)
  }, [asset.path, asset.modifiedAt])

  React.useEffect(() => {
    // A pending or missing record has no bytes to read; the status is the thing to show.
    if (asset.kind !== 'image' || asset.status !== 'ready') return
    const element = ref.current
    if (!element) return
    let cancelled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void cachedDataUrl(`${absolutePath}:${asset.modifiedAt ?? ''}`, () =>
          window.electronAPI.readFileDataUrl(absolutePath),
        )
          .then((value) => {
            if (!cancelled) setUrl(value)
          })
          .catch(() => {
            if (!cancelled) setFailed(true)
          })
      },
      { rootMargin: '240px' },
    )
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [absolutePath, asset.kind, asset.modifiedAt, asset.status])

  return (
    <div
      ref={ref}
      className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-foreground/[0.04]"
    >
      {asset.status === 'pending' ? (
        <Loader2 className="h-5 w-5 animate-spin text-foreground/25" />
      ) : asset.status === 'missing' || asset.status === 'failed' ? (
        asset.kind === 'image' || asset.kind === 'video' ? (
          <ImageOff className="h-6 w-6 text-foreground/25" />
        ) : (
          <Icon className="h-7 w-7 text-foreground/25" />
        )
      ) : url ? (
        <img src={url} alt={asset.name} className="h-full w-full object-cover" draggable={false} />
      ) : asset.kind === 'video' ? (
        posterFailed ? (
          <Icon className="h-7 w-7 text-foreground/30" />
        ) : (
          <img
            key={`${asset.path}:${asset.modifiedAt}`}
            src={videoPosterUrl(absolutePath)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            draggable={false}
            onError={() => setPosterFailed(true)}
          />
        )
      ) : asset.kind === 'audio' ? (
        <Music className="h-7 w-7 text-foreground/35" />
      ) : failed ? (
        <ImageOff className="h-6 w-6 text-foreground/25" />
      ) : asset.kind === 'image' ? (
        <Loader2 className="h-5 w-5 animate-spin text-foreground/25" />
      ) : (
        <Icon className="h-7 w-7 text-foreground/30" />
      )}
    </div>
  )
}

/**
 * A text asset shows its own words in the grid.
 *
 * A generated answer that reads as an icon is a card that says nothing; the first lines are
 * what tells one note from another. The bytes are read when the tile comes near the viewport,
 * like a picture's, so a library of many notes does not read them all at once.
 */
function AssetTextThumb({ asset, absolutePath }: { asset: LibraryAsset; absolutePath: string }) {
  const [text, setText] = React.useState<string | null>(null)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setText(null)
    if (asset.status !== 'ready') return
    const element = ref.current
    if (!element) return
    let cancelled = false
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        // A preview reads only the head of the file: a long transcript must not be sent whole to
        // draw its first few lines.
        void cachedText(`${absolutePath}:${asset.modifiedAt ?? ''}`, () =>
          window.electronAPI.readFile(absolutePath, TEXT_PREVIEW_BYTES + 1),
        )
          .then((value) => {
            if (!cancelled) {
              setText(
                value.length > TEXT_PREVIEW_BYTES
                  ? `${value.slice(0, TEXT_PREVIEW_BYTES)}…`
                  : value,
              )
            }
          })
          .catch(() => {
            if (!cancelled) setText('')
          })
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [absolutePath, asset.modifiedAt, asset.status])

  return (
    <div
      ref={ref}
      className="aspect-[4/3] overflow-hidden rounded-md bg-foreground/[0.04] px-2 py-1.5"
    >
      {asset.status !== 'ready' ? null : text === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-foreground/25" />
      ) : (
        <div className="line-clamp-[7] whitespace-pre-wrap break-words text-[10px] leading-4 text-foreground/70">
          {text.trim()}
        </div>
      )}
    </div>
  )
}

function TagChip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/80">
      <span className="truncate">{label}</span>
      {onRemove ? (
        <button type="button" className="text-foreground/40 hover:text-foreground" onClick={onRemove}>
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  )
}

export function AssetLibrary({
  workspaceId,
  projectId,
  projectSlug,
  folderPath,
  active = true,
}: {
  workspaceId: string | undefined
  projectId: string
  projectSlug: string
  folderPath: string
  /** The visible tab. Hidden tabs stay mounted, so only the visible one may claim a paste. */
  active?: boolean
}) {
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const { onOpenFile, onRevealInFinder } = usePlatform()
  /** A path picked here belongs to this machine, so only a local workspace can copy from it. */
  const isRemoteWindow = useAtomValue(windowIsRemoteAtom)
  const [assets, setAssets] = React.useState<LibraryAsset[]>([])
  const [facets, setFacets] = React.useState<TagFacet[]>([])
  const [warning, setWarning] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [query, setQuery] = React.useState('')
  const [kind, setKind] = React.useState<AssetKind | 'all'>('all')
  const [tag, setTag] = React.useState<string | null>(null)
  /**
   * Paths checked in the grid.
   *
   * One is "the card being looked at" and opens its details; several open the batch tag editor,
   * which is the only thing worth doing to a group without reading each file.
   */
  const [selectedPaths, setSelectedPaths] = React.useState<ReadonlySet<string>>(() => new Set())
  const selected = selectedPaths.size === 1 ? [...selectedPaths][0] : null
  const setSelected = React.useCallback((path: string | null) => {
    setSelectedPaths(path ? new Set([path]) : new Set())
  }, [])
  const [tagDraft, setTagDraft] = React.useState('')
  const [view, setView] = React.useState<'grid' | 'board'>('grid')
  /** The board is built on first visit and then kept, so a look at the grid does not reset it. */
  const [boardMounted, setBoardMounted] = React.useState(false)
  /** Where the board is looking, so the library's "generate" menu can place a card in view. */
  const boardCenterRef = React.useRef<{ x: number; y: number } | null>(null)
  /** Where the selected draft card sits on screen, so its composer floats beside it. */
  const [draftAnchor, setDraftAnchor] = React.useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  /** A running multi-file upload the person asked to stop. */
  const uploadCancelRef = React.useRef(false)
  /** The grid asking the board to show what it has checked, once per switch. */
  const [focusSelection, setFocusSelection] = React.useState<{
    paths: string[]
    draftIds?: string[]
    nonce: number
  } | null>(null)
  const focusNonceRef = React.useRef(0)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  /** Which recording is being read, and into which shape. */
  const [transcribing, setTranscribing] = React.useState<{ path: string; format: 'text' | 'srt' } | null>(null)
  /** Which picture is having its words read, and which one is being edited. */
  const [readingImage, setReadingImage] = React.useState<string | null>(null)
  const [editingImage, setEditingImage] = React.useState<{ path: string; op: ImageEditOp } | null>(null)
  /** The generation behind the selected pending/failed card, so it can be stopped or retried. */
  const [task, setTask] = React.useState<MediaTaskLookup | null>(null)
  const [taskBusy, setTaskBusy] = React.useState(false)
  /** How far a multi-file upload has got, so the control can say so instead of looking dead. */
  const [uploading, setUploading] = React.useState<{ done: number; total: number } | null>(null)
  /** A file is being dragged over the grid — the same answer the board gives. */
  const [gridDropping, setGridDropping] = React.useState(false)
  /** The tile menu lives at the pointer, and acts on the checked set when the tile is inside it. */
  const [gridMenu, setGridMenu] = React.useState<{ path: string; x: number; y: number } | null>(
    null,
  )
  /** The tag the batch editor is about to add to every checked file. */
  const [batchTagDraft, setBatchTagDraft] = React.useState('')

  /**
   * Which read is the newest.
   *
   * The watcher, focus and the refresh button all call `load`, and a read that started earlier can
   * finish later. Only the newest one is allowed to replace the list.
   */
  const loadSeqRef = React.useRef(0)

  const load = React.useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!workspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const snapshot = await window.electronAPI.getProjectLibrary(workspaceId, projectSlug)
      if (seq !== loadSeqRef.current) return
      setAssets(snapshot.assets)
      setFacets(snapshot.facets)
      setWarning(snapshot.warning ?? null)
    } catch (error) {
      if (seq !== loadSeqRef.current) return
      console.error('[AssetLibrary] Failed to read the library:', error)
      toast.error(t('library.readFailed'))
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [workspaceId, projectSlug, t])

  React.useEffect(() => {
    void load()
  }, [load])

  /**
   * Start a failed or cancelled task again from the request it stored.
   *
   * There is deliberately no stop action here: a card owns one task, and a submitted async job
   * cannot be stopped by the providers we use. Detaching would leave the same card waiting, so the
   * panel says so instead of offering a button that changes nothing.
   */
  const retryTask = React.useCallback(
    async (asset: LibraryAsset) => {
      setTaskBusy(true)
      try {
        const reply = await window.electronAPI.retryMediaTask(joinPath(folderPath, asset.path))
        if (reply.ok) toast.success(t('library.taskRetryStarted'))
        else toast.error(reply.message ?? t('canvas.generateFailed'))
        await load()
        const lookup = await window.electronAPI
          .getMediaTask(joinPath(folderPath, asset.path))
          .catch(() => null)
        setTask(lookup)
      } finally {
        setTaskBusy(false)
      }
    },
    [folderPath, load, t],
  )

  // A generation writes a task, then a file, then a note. Reloading on those changes is what turns
  // a pending card into a ready one without the person pressing refresh.
  React.useEffect(() => {
    if (!workspaceId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer) clearTimeout(timer)
      // The server's watcher already batches for 100ms; a short second wait keeps a burst of
      // file + task + note writes to one reload while still feeling immediate.
      timer = setTimeout(() => void load(), 150)
    }
    const offFiles = window.electronAPI.onProjectFilesChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) schedule()
    })
    const offTasks = window.electronAPI.onMediaTaskChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) schedule()
    })
    // Focus is the recovery path: a watcher that missed a burst (or a window that was asleep)
    // catches up as soon as the person comes back.
    window.addEventListener('focus', schedule)
    return () => {
      if (timer) clearTimeout(timer)
      offFiles()
      offTasks()
      window.removeEventListener('focus', schedule)
    }
  }, [load, workspaceId])

  const kinds = React.useMemo(
    () => KINDS.map((value) => ({ value, count: assets.filter((asset) => asset.kind === value).length })).filter((entry) => entry.count > 0),
    [assets],
  )

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return assets.filter((asset) => {
      if (kind !== 'all' && asset.kind !== kind) return false
      if (tag && !asset.tags.includes(tag)) return false
      if (!needle) return true
      return (
        asset.name.toLowerCase().includes(needle) ||
        asset.path.toLowerCase().includes(needle) ||
        asset.note.toLowerCase().includes(needle) ||
        asset.tags.some((value) => value.toLowerCase().includes(needle)) ||
        asset.source?.prompt.toLowerCase().includes(needle) ||
        asset.source?.model?.toLowerCase().includes(needle) ||
        asset.source?.channel?.toLowerCase().includes(needle)
      )
    })
  }, [assets, kind, query, tag])

  // A checked tile the grid no longer shows is a second, invisible selection: narrowing a filter
  // drops it from the set with everything else it hides.
  React.useEffect(() => {
    if (selectedPaths.size === 0) return
    const shown = new Set(visible.map((asset) => asset.path))
    const next = [...selectedPaths].filter((path) => shown.has(path))
    if (next.length === selectedPaths.size) return
    setSelectedPaths(new Set(next))
  }, [selectedPaths, visible])

  const current = assets.find((asset) => asset.path === selected) ?? null
  const selectedAssets = React.useMemo(
    () => assets.filter((asset) => selectedPaths.has(asset.path)),
    [assets, selectedPaths],
  )
  /** The words every checked file already carries — the only ones a group can remove together. */
  const commonTags = React.useMemo(
    () =>
      selectedAssets.length > 1
        ? selectedAssets.reduce<string[]>(
            (shared, asset) => shared.filter((value) => asset.tags.includes(value)),
            selectedAssets[0]?.tags ?? [],
          )
        : [],
    [selectedAssets],
  )
  const gridMenuAsset = gridMenu
    ? (assets.find((asset) => asset.path === gridMenu.path) ?? null)
    : null
  /** A tile inside the checked set acts on the whole set; a tile outside it acts alone. */
  const gridMenuPaths = gridMenuAsset
    ? selectedPaths.has(gridMenuAsset.path)
      ? [...selectedPaths]
      : [gridMenuAsset.path]
    : []
  /** When every checked card is off the board, the menu offers the way back. */
  const gridMenuHidden =
    gridMenuPaths.length > 0 &&
    gridMenuPaths.every(
      (path) => assets.find((entry) => entry.path === path)?.layout?.hidden === true,
    )
  const taskStatus = task?.task?.status
  const taskLabel = taskStatus
    ? taskStatus === 'submission_unknown'
      ? t('library.taskUnknown')
      : taskStatus === 'cancelled'
        ? t('library.taskFailed')
        : taskStatus === 'queued'
          ? t('library.taskQueued')
          : taskStatus === 'failed'
            ? t('library.taskFailed')
            : t('library.taskRunning')
    : current?.status === 'failed'
      ? t('library.taskFailed')
      : t('library.taskRunning')

  // A pending or failed card is more than a file: it is a generation that can still be stopped or
  // started again. It is re-read whenever the card's status or the asset list moves.
  React.useEffect(() => {
    let cancelled = false
    if (!current || (current.status !== 'pending' && current.status !== 'failed')) {
      setTask(null)
      return
    }
    window.electronAPI
      .getMediaTask(joinPath(folderPath, current.path))
      .then((lookup) => {
        if (!cancelled) setTask(lookup)
      })
      .catch(() => {
        if (!cancelled) setTask(null)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.path, current?.status, folderPath, assets])

  const applyMeta = React.useCallback(
    async (assetPath: string, patch: { tags?: string[]; note?: string; layout?: AssetLayout | null }) => {
      if (!workspaceId) return
      try {
        const snapshot = await window.electronAPI.updateProjectAssetMeta(workspaceId, projectSlug, assetPath, patch)
        setAssets(snapshot.assets)
        setFacets(snapshot.facets)
        setWarning(snapshot.warning ?? null)
      } catch (error) {
        console.error('[AssetLibrary] Failed to update the asset:', error)
        toast.error(t('library.saveFailed'))
      }
    },
    [workspaceId, projectSlug, t],
  )

  const saveLayout = React.useCallback(
    async (assetPath: string, layout: AssetLayout | null) => {
      await applyMeta(assetPath, { layout })
    },
    [applyMeta],
  )

  // The composer writes real files, so a grid-made card and a board-made card are the same card.
  const {
    drafts,
    selectedDraftId,
    selectedDraft,
    setSelectedDraftId,
    channels,
    llmConnections,
    createDraft,
    createTextNode,
    updateDraft,
    removeDraft,
    restoreDrafts,
    setDraftParam,
    setTextSource,
    toggleReference,
    moveReference,
    setFrame,
    swapFrames,
    generateDraft,
  } = useAssetDrafts({
    projectFolder: folderPath,
    libraryAssets: assets,
    onLayoutChange: saveLayout,
    onRefresh: load,
  })

  // A draft is not tagged, so a tag filter hides it; the kind and the words still narrow it the
  // same way they narrow the files beside it.
  const visibleDrafts = React.useMemo(() => {
    if (tag) return []
    const needle = query.trim().toLowerCase()
    return drafts.filter((draft) => {
      if (kind !== 'all' && draft.kind !== kind) return false
      return !needle || draft.prompt.toLowerCase().includes(needle)
    })
  }, [drafts, kind, query, tag])

  const rememberBoardCenter = React.useCallback((center: { x: number; y: number }) => {
    boardCenterRef.current = center
  }, [])

  const updateTags = React.useCallback(
    (assetPath: string, tags: string[]) => applyMeta(assetPath, { tags }),
    [applyMeta],
  )

  const updateNote = React.useCallback(
    (assetPath: string, note: string) => applyMeta(assetPath, { note }),
    [applyMeta],
  )

  /**
   * A link dragged between a draft and an asset.
   *
   * The composer already owns the rules (one audio/video on a text card, a text file becomes the
   * lyrics/context port rather than a numbered reference); this applies them to the card the
   * person dropped on, so drawing a line and picking the same file in the form mean one thing.
   */
  const connectDraftToAsset = React.useCallback(
    (draftId: string, assetPath: string) => {
      const draft = drafts.find((entry) => entry.id === draftId)
      const asset = assets.find((entry) => entry.path === assetPath)
      if (!draft || !asset || asset.status !== 'ready') return

      if (asset.kind === 'text') {
        if (draft.kind === 'text') {
          if (!draft.references.includes(assetPath)) {
            updateDraft(draftId, { references: [...draft.references, assetPath] })
          }
        } else {
          setTextSource(draftId, assetPath)
        }
        return
      }

      let references = draft.references
      // A text card carries at most one audio/video file — the composer's own rule.
      if (draft.kind === 'text' && (asset.kind === 'audio' || asset.kind === 'video')) {
        references = references.filter((path) => {
          const other = assets.find((entry) => entry.path === path)
          return !other || (other.kind !== 'audio' && other.kind !== 'video')
        })
      }
      if (references.includes(assetPath)) return
      updateDraft(draftId, {
        references: [...references, assetPath],
        firstFrame: draft.firstFrame === assetPath ? null : draft.firstFrame,
        lastFrame: draft.lastFrame === assetPath ? null : draft.lastFrame,
      })
    },
    [assets, drafts, setTextSource, updateDraft],
  )

  /**
   * Cut a line the person drew.
   *
   * A pick can be in three places — the numbered references, a frame role, or the text port — so
   * breaking the line means removing the file from whichever of them it currently occupies.
   */
  const disconnectDraftAsset = React.useCallback(
    (draftId: string, assetPath: string) => {
      const draft = drafts.find((entry) => entry.id === draftId)
      if (!draft) return
      updateDraft(draftId, {
        references: draft.references.filter((path) => path !== assetPath),
        firstFrame: draft.firstFrame === assetPath ? null : draft.firstFrame,
        lastFrame: draft.lastFrame === assetPath ? null : draft.lastFrame,
        textSource: draft.textSource === assetPath ? null : draft.textSource,
      })
    },
    [drafts, updateDraft],
  )

  /** A line dropped on a file that has no bytes yet: say why nothing happened. */
  const linkBlocked = React.useCallback(
    (assetPath: string) => {
      const name =
        assets.find((entry) => entry.path === assetPath)?.name ??
        assetPath.split(/[\\/]/).pop() ??
        assetPath
      toast.error(t('library.assetNotReady', { name }))
    },
    [assets, t],
  )

  /** Deleting a file is not undoable, so the library asks first and then reloads the index. */
  const deleteAssets = React.useCallback(
    async (paths: readonly string[]) => {
      if (!workspaceId || !paths.length) return
      const nameOf = (path: string) =>
        assets.find((entry) => entry.path === path)?.name ??
        path.split(/[\\/]/).pop() ??
        path
      const question =
        paths.length === 1
          ? t('library.deleteFileConfirm', { name: nameOf(paths[0]) })
          : t('library.deleteFilesConfirm', { count: paths.length })
      if (!window.confirm(question)) return
      for (const path of paths) {
        try {
          await window.electronAPI.deleteProjectAsset(
            workspaceId,
            projectSlug,
            path.split(/[\\/]/).pop() ?? path,
          )
        } catch (error) {
          console.error('[AssetLibrary] Delete failed:', error)
          toast.error(t('library.deleteFileFailed', { name: nameOf(path) }))
        }
      }
      // A draft that pointed at a deleted file would otherwise hold a line to nothing.
      const gone = new Set(paths)
      for (const draft of drafts) {
        const picks = [
          ...draft.references,
          draft.firstFrame ?? '',
          draft.lastFrame ?? '',
          draft.textSource ?? '',
        ]
        if (!picks.some((path) => gone.has(path))) continue
        updateDraft(draft.id, {
          references: draft.references.filter((path) => !gone.has(path)),
          firstFrame: draft.firstFrame && gone.has(draft.firstFrame) ? null : draft.firstFrame,
          lastFrame: draft.lastFrame && gone.has(draft.lastFrame) ? null : draft.lastFrame,
          textSource: draft.textSource && gone.has(draft.textSource) ? null : draft.textSource,
        })
      }
      setSelectedPaths((current) => {
        const next = new Set(current)
        for (const path of paths) next.delete(path)
        return next
      })
      toast.success(
        paths.length === 1
          ? t('library.deleted', { name: nameOf(paths[0]) })
          : t('library.deletedCount', { count: paths.length }),
      )
      await load()
    },
    [assets, drafts, load, projectSlug, t, updateDraft, workspaceId],
  )

  /**
   * Move cards on or off the canvas from the grid.
   *
   * Hiding keeps the place, so putting the card back returns it to where it was; a card that was
   * never placed simply returns to the automatic shelf.
   */
  const setBoardVisibility = React.useCallback(
    async (paths: readonly string[], visible: boolean) => {
      for (const path of paths) {
        const layout = assets.find((entry) => entry.path === path)?.layout
        await applyMeta(path, {
          layout: visible
            ? layout
              ? { x: layout.x, y: layout.y, w: layout.w, h: layout.h, z: layout.z }
              : null
            : {
                x: layout?.x ?? 0,
                y: layout?.y ?? 0,
                w: layout?.w,
                h: layout?.h,
                z: layout?.z,
                hidden: true,
              },
        })
      }
    },
    [applyMeta, assets],
  )

  /** Apply the same tag change to every checked file. */
  const batchApplyTags = React.useCallback(
    async (mutate: (tags: string[]) => string[]) => {
      for (const asset of selectedAssets) {
        await applyMeta(asset.path, { tags: mutate(asset.tags) })
      }
    },
    [applyMeta, selectedAssets],
  )

  const addBatchTag = React.useCallback(async () => {
    const value = batchTagDraft.trim()
    if (!value) return
    setBatchTagDraft('')
    await batchApplyTags((tags) => (tags.includes(value) ? tags : [...tags, value]))
  }, [batchApplyTags, batchTagDraft])

  // The tile menu belongs to the window, so a click anywhere else, Escape or a resize closes it.
  React.useEffect(() => {
    if (!gridMenu) return
    const onDown = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest('[data-grid-menu]')) return
      setGridMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGridMenu(null)
    }
    const close = () => setGridMenu(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [gridMenu])

  // The tile menu belongs to the grid; the board has a menu of its own.
  React.useEffect(() => {
    if (view !== 'grid') setGridMenu(null)
  }, [view])

  // A card opens where it can be read: formats this app has a pane for get a side-panel tab
  // (the library stays where it was), and only the ones it cannot draw fall back to the
  // system's own viewer.
  const openAsset = React.useCallback(
    (asset: LibraryAsset) => {
      if (asset.status !== 'ready') return
      const path = joinPath(folderPath, asset.path)
      // Media has a pane too (the side panel's player); every other format the app can draw gets
      // the same tab. Only a format this app has no face for goes to the system's viewer.
      if (asset.kind === 'video' || asset.kind === 'audio' || classifyFile(path).canPreview) {
        openSidePanelTab(projectId, path)
        return
      }
      onOpenFile?.(path)
    },
    [folderPath, onOpenFile, projectId],
  )

  /** The board's selection is the grid's selection: one library, two views. */
  const syncBoardSelection = React.useCallback((paths: string[]) => {
    setSelectedPaths(new Set(paths))
  }, [])

  /** Switching to the canvas frames whatever the grid had checked, files and drafts alike. */
  const showBoard = React.useCallback(() => {
    setBoardMounted(true)
    setView('board')
    const paths = [...selectedPaths]
    const draftIds = selectedDraftId ? [selectedDraftId] : []
    if (!paths.length && !draftIds.length) return
    focusNonceRef.current += 1
    setFocusSelection({ paths, draftIds, nonce: focusNonceRef.current })
  }, [selectedDraftId, selectedPaths])

  // Grid keys: reach the search box, open the checked card, delete the checked files.
  React.useEffect(() => {
    if (view !== 'grid') return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (event.key === 'Enter' && current) {
        event.preventDefault()
        openAsset(current)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedPaths.size === 0) return
        event.preventDefault()
        void deleteAssets([...selectedPaths])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, deleteAssets, openAsset, selectedPaths, view])

  const addTag = React.useCallback(async () => {
    const value = tagDraft.trim()
    if (!current || !value) return
    if (current.tags.includes(value)) {
      setTagDraft('')
      return
    }
    setTagDraft('')
    await applyMeta(current.path, { tags: [...current.tags, value] })
  }, [applyMeta, current, tagDraft])

  const upload = React.useCallback(
    async (files: File[]) => {
      if (!workspaceId || uploading) return
      uploadCancelRef.current = false
      setUploading({ done: 0, total: files.length })
      try {
        for (const [index, file] of files.entries()) {
          if (uploadCancelRef.current) break
          try {
            // A file the host can address by path never enters the renderer: the assets folder gets
            // a copy from disk, so a 500 MB clip costs no base64 string and no frozen window. In a
            // remote window the path is this machine's, so the bytes still have to travel.
            const sourcePath = isRemoteWindow ? null : (window.electronAPI.getFilePath?.(file) ?? null)
            await window.electronAPI.uploadProjectAsset(workspaceId, projectSlug, {
              filename: file.name,
              ...(sourcePath ? { sourcePath } : { base64: await readFileBase64(file) }),
            })
          } catch (error) {
            console.error('[AssetLibrary] Upload failed:', error)
            toast.error(t('library.uploadFailed', { name: file.name }))
          }
          setUploading({ done: index + 1, total: files.length })
        }
        await load()
      } finally {
        uploadCancelRef.current = false
        setUploading(null)
      }
    },
    [isRemoteWindow, workspaceId, projectSlug, load, t, uploading],
  )

  /** Plain text from the clipboard becomes a text asset; there is no file to read. */
  const uploadPastedText = React.useCallback(
    async (text: string) => {
      if (!workspaceId) return
      const name = `pasted-${pasteStamp()}.txt`
      try {
        await window.electronAPI.uploadProjectAsset(workspaceId, projectSlug, {
          filename: name,
          text,
        })
        await load()
      } catch (error) {
        console.error('[AssetLibrary] Paste failed:', error)
        toast.error(t('library.uploadFailed', { name }))
      }
    },
    [load, projectSlug, t, workspaceId],
  )

  /**
   * Paste from the system clipboard: a screenshot, copied files, or plain text.
   *
   * The library owns this rather than the board, so both views accept a paste. Fields keep their
   * own behaviour — pasting into a note or the composer must stay text, not become an asset.
   */
  React.useEffect(() => {
    if (!workspaceId || !active) return
    const onPaste = (event: ClipboardEvent) => {
      // A field keeps its own paste: never turn typed text into a file behind the caret.
      if (isEditablePasteTarget(event.target)) return
      const data = event.clipboardData
      if (!data || uploading) return

      const files = Array.from(data.files ?? [])
      if (files.length) {
        event.preventDefault()
        void upload(
          files.map((file, index) => {
            const name = pastedFileName(file, index)
            return name === file.name
              ? file
              : new window.File([file], name, { type: file.type })
          }),
        )
        return
      }

      // Some sources expose a screenshot only as an item, not in `files`.
      const imageItem = Array.from(data.items ?? []).find(
        (item) => item.kind === 'file' && item.type.startsWith('image/'),
      )
      const image = imageItem?.getAsFile()
      if (image) {
        event.preventDefault()
        const name = pastedFileName(image, 0)
        void upload([
          name === image.name
            ? image
            : new window.File([image], name, { type: image.type }),
        ])
        return
      }

      const text = data.getData('text/plain')
      if (text && text.trim()) {
        event.preventDefault()
        void uploadPastedText(text)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [active, upload, uploadPastedText, uploading, workspaceId])

  /**
   * The note beside a derived file.
   *
   * Same shape a generation writes, so the board's provenance line and the library's "source"
   * block read a transcript, an OCR result and an edited copy the same way.
   */
  const writeNote = React.useCallback(
    async (
      outRel: string,
      source: LibraryAsset,
      note: {
        channel: string
        prompt?: string
        model?: string
        params?: Record<string, string | number>
      },
    ) => {
      try {
        // The note's name swaps the artifact's extension (`x.txt` → `x.gen.json`), which is the
        // place every reader of provenance looks — the same convention a generated file uses.
        const noteRel = `${outRel.replace(/\.[^.]+$/, '')}.gen.json`
        await window.electronAPI.writeFile(
          joinPath(folderPath, noteRel),
          `${JSON.stringify(
            {
              file: outRel,
              prompt: note.prompt ?? '',
              references: [source.path],
              channel: note.channel,
              ...(note.model ? { model: note.model } : {}),
              ...(note.params ? { params: note.params } : {}),
              at: Date.now(),
            },
            null,
            2,
          )}\n`,
        )
      } catch {
        // The derived file is the answer; a note that cannot be written is lost provenance.
      }
    },
    [folderPath],
  )

  /**
   * Read a recording into words, saved beside it as a new asset.
   *
   * A transcript is something the project keeps — the agent can read it, the board draws the line
   * from the recording to it — so it is a file in `assets/`, not a panel that disappears.
   */
  const transcribe = React.useCallback(
    async (asset: LibraryAsset, format: 'text' | 'srt') => {
      if (!workspaceId || transcribing) return
      setTranscribing({ path: asset.path, format })
      try {
        const reply = await window.electronAPI.asrTranscribe({
          audioPath: joinPath(folderPath, asset.path),
        })
        if (!reply.ok) {
          toast.error(reply.message ?? t('library.transcribeFailed'))
          return
        }
        const body = format === 'srt' ? reply.srt : reply.text
        if (!body || !body.trim()) {
          toast.error(t('library.transcribeEmpty'))
          return
        }
        const outRel = `assets/${assetSlug(asset.name)}-${Date.now().toString(36)}.${format === 'srt' ? 'srt' : 'txt'}`
        await window.electronAPI.writeFile(
          joinPath(folderPath, outRel),
          body.endsWith('\n') ? body : `${body}\n`,
        )
        await writeNote(outRel, asset, {
          channel: 'asr',
          ...(reply.model ? { model: reply.model } : {}),
        })
        await load()
        setSelectedDraftId(null)
        setSelected(outRel)
        toast.success(t('library.transcribeDone', { name: outRel.split('/').pop() }))
      } catch (error) {
        console.error('[AssetLibrary] Transcription failed:', error)
        toast.error(t('library.transcribeFailed'))
      } finally {
        setTranscribing(null)
      }
    },
    [folderPath, load, setSelected, setSelectedDraftId, t, transcribing, workspaceId, writeNote],
  )

  /**
   * Read the words on a picture, saved beside it as a text asset.
   *
   * The same bargain as a transcript: the words are a file the project keeps, and the picture is
   * never written over.
   */
  const readImageText = React.useCallback(
    async (asset: LibraryAsset) => {
      if (!workspaceId || readingImage || editingImage || transcribing) return
      setReadingImage(asset.path)
      try {
        const reply = await window.electronAPI.imgOcr({
          imagePath: joinPath(folderPath, asset.path),
        })
        if (!reply.ok) {
          toast.error(reply.message ?? t('library.readTextFailed'))
          return
        }
        const text = reply.text?.trim()
        if (!text) {
          toast.error(t('library.readTextEmpty'))
          return
        }
        const outRel = `assets/${assetSlug(asset.name)}-${Date.now().toString(36)}.txt`
        await window.electronAPI.writeFile(joinPath(folderPath, outRel), `${text}\n`)
        await writeNote(outRel, asset, {
          channel: 'ocr',
          ...(reply.engine ? { model: reply.engine } : {}),
        })
        await load()
        setSelectedDraftId(null)
        setSelected(outRel)
        toast.success(t('library.transcribeDone', { name: outRel.split('/').pop() }))
      } catch (error) {
        console.error('[AssetLibrary] Text recognition failed:', error)
        toast.error(t('library.readTextFailed'))
      } finally {
        setReadingImage(null)
      }
    },
    [editingImage, folderPath, load, readingImage, setSelected, setSelectedDraftId, t, transcribing, workspaceId, writeNote],
  )

  /**
   * Write a changed copy of a picture.
   *
   * The arithmetic is the browser's (`lib/image-edit`): decoding a PNG to rotate it needs no child
   * process, and the bytes go straight back into `assets/` as a new file. The source stays as it
   * was, so an edit can be compared with what it came from.
   */
  const editImage = React.useCallback(
    async (asset: LibraryAsset, spec: ImageEditSpec) => {
      if (!workspaceId || readingImage || editingImage || transcribing) return
      setEditingImage({ path: asset.path, op: spec.op })
      try {
        const dataUrl = await window.electronAPI.readFileDataUrl(joinPath(folderPath, asset.path))
        const rendered = await renderImageEdit(dataUrl, asset.path, spec)
        const filename = `${assetSlug(asset.name)}-${spec.op}-${Date.now().toString(36)}.${rendered.ext}`
        const created = await window.electronAPI.uploadProjectAsset(workspaceId, projectSlug, {
          filename,
          base64: rendered.base64,
        })
        const outRel = `assets/${created.filename}`
        await writeNote(outRel, asset, {
          channel: 'local',
          prompt: spec.op,
          params: rendered.params,
        })
        await load()
        setSelectedDraftId(null)
        setSelected(outRel)
        toast.success(t('library.imageEditDone', { name: created.filename }))
      } catch (error) {
        console.error('[AssetLibrary] Image edit failed:', error)
        toast.error(t('library.imageEditFailed'))
      } finally {
        setEditingImage(null)
      }
    },
    [
      editingImage,
      folderPath,
      load,
      projectSlug,
      readingImage,
      setSelected,
      setSelectedDraftId,
      t,
      transcribing,
      workspaceId,
      writeNote,
    ],
  )

  if (loading && assets.length === 0 && view === 'grid') {
    return (
      <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('library.loading')}
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {warning ? (
        <div className="mx-4 mt-3 shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t('library.warning', { message: warning })}
        </div>
      ) : null}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-4 py-2">
        {/* The grid has a filter box; the canvas has its own search (Cmd/Ctrl+F there). Showing a
            box that filters nothing would be a dead control. */}
        {view === 'grid' ? (
          <div className="relative min-w-[160px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('library.search')}
              className="h-8 pl-8 text-xs"
            />
          </div>
        ) : (
          <div className="min-w-[160px] flex-1" />
        )}
        {/* Starting a card is a library action, not the board's: the menu offers the four kinds
            the composer can write, and the card appears right here in the grid. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" className="h-8 gap-1.5 px-2.5 text-xs">
              <Sparkles className="h-3.5 w-3.5" />
              {t('canvas.generate')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {DRAFT_KINDS.map((draftKind) => {
              const Icon = DRAFT_ICON[draftKind]
              return (
                <DropdownMenuItem
                  key={draftKind}
                  className="gap-2 text-xs"
                  onSelect={() => {
                    // The new card is the thing to look at: filters that would hide it are not a
                    // useful answer to "start a picture".
                    setKind('all')
                    setTag(null)
                    setQuery('')
                    createDraft(draftKind, view === 'board' ? (boardCenterRef.current ?? undefined) : undefined)
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(DRAFT_KIND_LABEL_KEY[draftKind])}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex h-8 items-center rounded-[8px] border border-border/60 p-0.5">
          <button
            type="button"
            title={t('library.viewGrid')}
            aria-label={t('library.viewGrid')}
            onClick={() => setView('grid')}
            className={cn(
              'flex size-7 items-center justify-center rounded-[6px] transition-colors',
              view === 'grid' ? 'bg-foreground/[0.09] text-foreground' : 'text-foreground/50 hover:text-foreground',
            )}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t('library.viewBoard')}
            aria-label={t('library.viewBoard')}
            onClick={showBoard}
            className={cn(
              'flex size-7 items-center justify-center rounded-[6px] transition-colors',
              view === 'board' ? 'bg-foreground/[0.09] text-foreground' : 'text-foreground/50 hover:text-foreground',
            )}
          >
            <PanelsTopLeft className="h-3.5 w-3.5" />
          </button>
        </div>
        {uploading ? (
          <div className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-background px-3 text-xs font-medium shadow-minimal">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {uploading.done}/{uploading.total}
            <button
              type="button"
              title={t('library.uploadCancelHint')}
              aria-label={t('common.cancel')}
              onClick={() => {
                uploadCancelRef.current = true
              }}
              className="ml-0.5 flex size-4 items-center justify-center rounded text-foreground/50 transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[8px] bg-background px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.03]">
            <Upload className="h-3.5 w-3.5" />
            {t('library.upload')}
            <input
              type="file"
              className="hidden"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void upload(files)
              }}
            />
          </label>
        )}
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => void load()} title={t('library.refresh')}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {view === 'grid' ? (
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/50 px-4 py-2">
        <button
          type="button"
          onClick={() => setKind('all')}
          className={cn(
            'rounded-full px-2.5 py-1 text-[11px] transition-colors',
            kind === 'all' ? 'bg-foreground/[0.09] font-medium text-foreground' : 'text-foreground/60 hover:bg-foreground/[0.04]',
          )}
        >
          {t('library.all')} {assets.length}
        </button>
        {kinds.map((entry) => (
          <button
            key={entry.value}
            type="button"
            onClick={() => setKind(entry.value)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] transition-colors',
              kind === entry.value ? 'bg-foreground/[0.09] font-medium text-foreground' : 'text-foreground/60 hover:bg-foreground/[0.04]',
            )}
          >
            {t(KIND_LABEL_KEY[entry.value])} {entry.count}
          </button>
        ))}
        {facets.length > 0 ? <span className="mx-1 h-4 w-px bg-border/60" /> : null}
        {facets.map((facet) =>
          facet.values.map((value) => {
            const full = facet.dimension ? `${facet.dimension}:${value}` : value
            return (
              <button
                key={full}
                type="button"
                onClick={() => setTag(tag === full ? null : full)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                  tag === full
                    ? 'border-foreground/25 bg-foreground/[0.09] text-foreground'
                    : 'border-border/60 text-foreground/60 hover:bg-foreground/[0.04]',
                )}
              >
                {full}
              </button>
            )
          }),
        )}
      </div>
      ) : null}

      {/* The board stays mounted while the grid is in front, so its viewport, selection and
          panning survive a look at the grid. It draws the whole library: filters belong to the
          grid, and a filter that is no longer visible must not rearrange the canvas. */}
      {boardMounted ? (
        <div className={cn('min-h-0 flex-1 p-3', view === 'board' ? 'block' : 'hidden')}>
        <AssetBoard
          key={folderPath}
          active={view === 'board'}
          assets={assets}
          allAssets={assets}
          projectFolder={folderPath}
          onLayoutChange={saveLayout}
          onOpen={openAsset}
          onUpload={upload}
          onRefresh={load}
          drafts={drafts}
          selectedDraftId={selectedDraftId}
          onSelectDraft={(id) => {
            if (id) setSelected(null)
            setSelectedDraftId(id)
          }}
          onCreateDraft={createDraft}
          onUpdateDraft={updateDraft}
          onTagsChange={updateTags}
          onNoteChange={updateNote}
          onLinkDraftAsset={connectDraftToAsset}
          onDisconnectDraftAsset={disconnectDraftAsset}
          onLinkBlocked={linkBlocked}
          onDeleteAssets={(paths) => void deleteAssets(paths)}
          onRemoveDraft={removeDraft}
          onRestoreDrafts={restoreDrafts}
          onViewCenterChange={rememberBoardCenter}
          onSelectedDraftAnchorChange={setDraftAnchor}
          onSelectionChange={syncBoardSelection}
          focusSelection={focusSelection}
          transcribing={transcribing}
          onTranscribe={(asset, format) => void transcribe(asset, format)}
          imageTools={{
            reading: readingImage,
            editing: editingImage,
            disabled: transcribing !== null,
            onOcr: (asset) => void readImageText(asset),
            onEdit: (asset, spec) => void editImage(asset, spec),
          }}
        />
        </div>
      ) : null}

      {view === 'grid' ? (
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          onDragOver={(event) => {
            event.preventDefault()
            setGridDropping(true)
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setGridDropping(false)
          }}
          onDrop={(event) => {
            event.preventDefault()
            setGridDropping(false)
            const files = Array.from(event.dataTransfer.files)
            if (files.length) void upload(files)
          }}
        >
        {assets.length === 0 && visibleDrafts.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-10 text-center text-sm text-muted-foreground">{t('library.empty')}</div>
      ) : visible.length === 0 && visibleDrafts.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-10 text-center text-sm text-muted-foreground">{t('library.noMatch')}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] content-start gap-3 overflow-auto p-4">
            {visibleDrafts.map((draft) => (
              <DraftTile
                key={draft.id}
                draft={draft}
                selected={selectedDraftId === draft.id}
                onClick={() => {
                  setSelected(null)
                  setSelectedDraftId(draft.id)
                }}
              />
            ))}
            {visible.map((asset) => (
              <button
                key={asset.path}
                type="button"
                onClick={(event) => {
                  setSelectedDraftId(null)
                  const additive = event.metaKey || event.ctrlKey || event.shiftKey
                  setSelectedPaths((current) => {
                    if (!additive) return new Set([asset.path])
                    const next = new Set(current)
                    if (next.has(asset.path)) next.delete(asset.path)
                    else next.add(asset.path)
                    return next
                  })
                }}
                onDoubleClick={() => openAsset(asset)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!selectedPaths.has(asset.path)) setSelectedPaths(new Set([asset.path]))
                  setSelectedDraftId(null)
                  setGridMenu({ path: asset.path, x: event.clientX, y: event.clientY })
                }}
                className={cn(
                  'group flex min-w-0 flex-col gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-foreground/[0.04]',
                  selectedPaths.has(asset.path) && 'bg-foreground/[0.06]',
                )}
              >
                {asset.kind === 'text' ? (
                  <AssetTextThumb asset={asset} absolutePath={joinPath(folderPath, asset.path)} />
                ) : (
                  <AssetThumb asset={asset} absolutePath={joinPath(folderPath, asset.path)} />
                )}
                <div className="min-w-0 px-0.5">
                  <div className="flex min-w-0 items-center gap-1">
                    <div className="truncate text-xs font-medium">{asset.name}</div>
                    {asset.source ? (
                      <span className="shrink-0" title={t('library.generated')}>
                        <Sparkles className="h-3 w-3 text-foreground/40" />
                      </span>
                    ) : null}
                    {asset.layout?.hidden ? (
                      <span className="shrink-0" title={t('library.hiddenFromBoard')}>
                        <EyeOff className="h-3 w-3 text-foreground/40" />
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {formatBytes(asset.sizeBytes)}
                  </div>
                  {asset.tags.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {asset.tags.slice(0, 3).map((value) => (
                        <TagChip key={value} label={value} />
                      ))}
                    </div>
                  ) : null}
                </div>
              </button>
            ))}
          </div>

          {selectedPaths.size > 1 ? (
            <div className="max-h-[45%] w-full shrink-0 overflow-y-auto border-t border-border/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {t('library.selectedCount', { count: selectedPaths.size })}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {selectedAssets
                      .slice(0, 3)
                      .map((asset) => asset.name)
                      .join(', ')}
                    {selectedAssets.length > 3 ? '…' : ''}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setSelectedPaths(new Set())}
                  title={t('library.close')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div className="mb-3 space-y-1.5">
                <div className="text-[11px] font-medium text-foreground/70">{t('library.tags')}</div>
                <div className="flex flex-wrap gap-1">
                  {commonTags.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t('library.noCommonTags')}
                    </span>
                  ) : (
                    commonTags.map((value) => (
                      <TagChip
                        key={value}
                        label={value}
                        onRemove={() =>
                          void batchApplyTags((tags) => tags.filter((tag) => tag !== value))
                        }
                      />
                    ))
                  )}
                </div>
                <div className="flex gap-1">
                  <Input
                    value={batchTagDraft}
                    onChange={(event) => setBatchTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void addBatchTag()
                    }}
                    placeholder={t('library.addTag')}
                    className="h-7 text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 shrink-0 p-0"
                    onClick={() => void addBatchTag()}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ) : selectedDraft ? (
            <div className="max-h-[55%] w-full shrink-0 overflow-y-auto border-t border-border/50 p-4">
              <DraftComposer
                variant="pane"
                draft={selectedDraft}
                channels={channels}
                llmConnections={llmConnections}
                libraryAssets={assets}
                projectFolder={folderPath}
                onUpdate={updateDraft}
                onSetParam={setDraftParam}
                onToggleReference={toggleReference}
                onMoveReference={moveReference}
                onSetFrame={setFrame}
                onSwapFrames={swapFrames}
                onSetTextSource={setTextSource}
                onCreateTextNode={createTextNode}
                onGenerate={(draft) => void generateDraft(draft)}
                onRemove={removeDraft}
                onClose={() => setSelectedDraftId(null)}
              />
            </div>
          ) : current ? (
            <div className="max-h-[45%] w-full shrink-0 overflow-y-auto border-t border-border/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{current.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{current.path}</div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => setSelected(null)}
                    title={t('library.close')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {current.status === 'pending' || current.status === 'failed' ? (
                <div className="mb-3 rounded-md border border-border/60 p-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/70">
                    {current.status === 'pending' ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    ) : null}
                    <span>{taskLabel}</span>
                  </div>
                  {task?.task?.error ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {task.task.error}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {current.status === 'failed' && task?.task ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={taskBusy}
                        onClick={() => void retryTask(current)}
                      >
                        {t('library.taskRetry')}
                      </Button>
                    ) : current.status === 'pending' &&
                      (taskStatus === 'submission_unknown' || current.cancellable === false) ? (
                      <span className="text-[10px] text-muted-foreground">
                        {taskStatus === 'submission_unknown'
                          ? t('library.taskUnknownHint')
                          : t('library.taskNoCancel')}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* A clip or a recording plays here, in the column that describes it: the file's
                  details and the thing itself belong together. Double-clicking the tile opens the
                  same file in its own tab, where there is room for it. */}
              {current.status === 'ready' && current.kind === 'video' ? (
                <div className="mb-3 overflow-hidden rounded-md bg-black/90">
                  <video
                    key={`${current.path}:${current.modifiedAt}`}
                    src={mediaUrl(joinPath(folderPath, current.path))}
                    controls
                    className="max-h-52 w-full"
                  />
                </div>
              ) : null}
              {current.status === 'ready' && current.kind === 'audio' ? (
                <div className="mb-3 rounded-md border border-border/60 p-2">
                  <audio
                    key={`${current.path}:${current.modifiedAt}`}
                    src={mediaUrl(joinPath(folderPath, current.path))}
                    controls
                    className="w-full"
                  />
                </div>
              ) : null}

              <div className="mb-3 space-y-1.5">
                <div className="text-[11px] font-medium text-foreground/70">{t('library.source')}</div>
                {current.source ? (
                  <div className="space-y-1 rounded-md bg-foreground/[0.03] p-2">
                    <div className="text-[11px] text-foreground/70">
                      {[current.source.model, current.source.channel].filter(Boolean).join(' · ') ||
                        t('library.generated')}
                    </div>
                    {current.source.prompt ? (
                      <div className="line-clamp-3 text-[11px] leading-relaxed text-foreground/60" title={current.source.prompt}>
                        {current.source.prompt}
                      </div>
                    ) : null}
                    {current.source.references.length > 0 ? (
                      <div className="text-[11px] text-foreground/50">
                        {t('library.builtFrom', { files: current.source.references.join(', ') })}
                      </div>
                    ) : null}
                    {current.source.session ? (
                      <button
                        type="button"
                        className="text-left text-[11px] underline underline-offset-2 hover:text-foreground"
                        onClick={() =>
                          navigate(routes.view.allSessions(current.source!.session!))
                        }
                      >
                        {t('library.fromSession', { defaultValue: 'From this conversation' })}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <span className="text-[11px] text-muted-foreground">{t('library.noSource')}</span>
                )}
              </div>

              {/* A picture's local tools: read its words, or write a changed copy. Both make a
                  new asset and leave the picture being read as it was. */}
              {current.kind === 'image' && current.status === 'ready' ? (
                <div className="mb-3 space-y-1.5">
                  <div className="text-[11px] font-medium text-foreground/70">{t('library.imageTools')}</div>
                  <div className="flex items-center gap-1.5">
                    <ImageTools
                      reading={readingImage === current.path}
                      editing={editingImage?.path === current.path}
                      disabled={readingImage !== null || editingImage !== null || transcribing !== null}
                      onOcr={() => void readImageText(current)}
                      onEdit={(spec) => void editImage(current, spec)}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground">{t('library.imageToolsHint')}</div>
                </div>
              ) : null}

              {/* A recording's words are the one thing an audio asset can become without leaving
                  the library: two shapes, two buttons, saved beside the recording. */}
              {current.kind === 'audio' && current.status === 'ready' ? (
                <div className="mb-3 space-y-1.5">
                  <div className="text-[11px] font-medium text-foreground/70">{t('library.transcribe')}</div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 gap-1 px-2 text-[11px]"
                      disabled={transcribing !== null}
                      onClick={() => void transcribe(current, 'text')}
                    >
                      {transcribing?.path === current.path && transcribing.format === 'text' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                      {t('library.transcribeText')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-7 gap-1 px-2 text-[11px]"
                      disabled={transcribing !== null}
                      onClick={() => void transcribe(current, 'srt')}
                    >
                      {transcribing?.path === current.path && transcribing.format === 'srt' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Captions className="h-3.5 w-3.5" />
                      )}
                      {t('library.transcribeSrt')}
                    </Button>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {transcribing?.path === current.path
                      ? t('library.transcribing')
                      : t('library.transcribeHint')}
                  </div>
                </div>
              ) : null}

              <div className="mb-3 space-y-1.5">
                <div className="text-[11px] font-medium text-foreground/70">{t('library.tags')}</div>
                <div className="flex flex-wrap gap-1">
                  {current.tags.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">{t('library.noTags')}</span>
                  ) : (
                    current.tags.map((value) => (
                      <TagChip
                        key={value}
                        label={value}
                        onRemove={() => void applyMeta(current.path, { tags: current.tags.filter((tag) => tag !== value) })}
                      />
                    ))
                  )}
                </div>
                <div className="flex gap-1">
                  <Input
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void addTag()
                    }}
                    placeholder={t('library.addTag')}
                    className="h-7 text-xs"
                  />
                  <Button variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" onClick={() => void addTag()}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="mb-3 space-y-1.5">
                <div className="text-[11px] font-medium text-foreground/70">{t('library.note')}</div>
                <Input
                  defaultValue={current.note}
                  key={`${current.path}:${current.note}`}
                  placeholder={t('library.notePlaceholder')}
                  className="h-7 text-xs"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  onBlur={(event) => {
                    if (event.target.value !== current.note) void applyMeta(current.path, { note: event.target.value })
                  }}
                />
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={current.status !== 'ready'}
                  onClick={() => openAsset(current)}
                >
                  {t('library.open')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={current.status !== 'ready'}
                  onClick={() => onRevealInFinder?.(joinPath(folderPath, current.path))}
                >
                  {t('library.openLocation')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        )}
          {gridDropping ? (
            <div className="pointer-events-none absolute inset-2 z-50 rounded-lg border-2 border-dashed border-primary/50 bg-primary/5" />
          ) : null}

          {gridMenu && gridMenuAsset
            ? createPortal(
                <div
                  data-grid-menu
                  style={{
                    position: 'fixed',
                    left: Math.min(gridMenu.x, window.innerWidth - 200),
                    top: Math.min(gridMenu.y, window.innerHeight - 150),
                  }}
                  className="z-[90] w-48 overflow-hidden rounded-lg border border-border/60 bg-popover p-1 shadow-modal-small"
                >
                  <button
                    type="button"
                    onClick={() => {
                      openAsset(gridMenuAsset)
                      setGridMenu(null)
                    }}
                    className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
                  >
                    {t('library.open')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onRevealInFinder?.(joinPath(folderPath, gridMenuAsset.path))
                      setGridMenu(null)
                    }}
                    className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
                  >
                    {t('library.openLocation')}
                  </button>
                  <div className="my-1 border-t border-border/60" />
                  <button
                    type="button"
                    onClick={() => {
                      void setBoardVisibility(gridMenuPaths, gridMenuHidden)
                      setGridMenu(null)
                    }}
                    className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-foreground/[0.06]"
                  >
                    {gridMenuHidden ? t('library.sendToCanvas') : t('library.hideFromBoard')}
                  </button>
                  <div className="my-1 border-t border-border/60" />
                  <button
                    type="button"
                    onClick={() => {
                      void deleteAssets(gridMenuPaths)
                      setGridMenu(null)
                    }}
                    className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/[0.08]"
                  >
                    {gridMenuPaths.length > 1
                      ? t('library.deleteFiles', { count: gridMenuPaths.length })
                      : t('library.deleteFile')}
                  </button>
                </div>,
                document.body,
              )
            : null}
        </div>
      ) : null}

      {/* On the board the same composer floats over the card it is writing; the grid has no canvas
          to float over, so there it sits in the detail column instead. It is a portal because the
          card's screen rectangle is measured against the window: a transformed ancestor would make
          `fixed` mean something else. */}
      {view === 'board' && selectedDraft
        ? createPortal(
            <DraftComposer
              variant="float"
              anchor={draftAnchor}
              draft={selectedDraft}
              channels={channels}
              llmConnections={llmConnections}
              libraryAssets={assets}
              projectFolder={folderPath}
              onUpdate={updateDraft}
              onSetParam={setDraftParam}
              onToggleReference={toggleReference}
              onMoveReference={moveReference}
              onSetFrame={setFrame}
              onSwapFrames={swapFrames}
              onSetTextSource={setTextSource}
              onCreateTextNode={createTextNode}
              onGenerate={(draft) => void generateDraft(draft)}
              onRemove={removeDraft}
              onClose={() => setSelectedDraftId(null)}
            />,
            document.body,
          )
        : null}
    </div>
  )
}

/**
 * A card being written, drawn as a tile so the grid can show a draft before it is a file.
 *
 * It is the same object the board draws (`DraftCard`), not a second kind of draft: selecting it
 * opens the composer in the detail column, exactly as selecting a file opens its details.
 */
function DraftTile({
  draft,
  selected,
  onClick,
}: {
  draft: Draft
  selected: boolean
  onClick: () => void
}) {
  const { t } = useTranslation()
  const Icon = DRAFT_ICON[draft.kind]
  const label = t(DRAFT_KIND_LABEL_KEY[draft.kind])
  // The prompt names the card while there is one; a card that only carries a file says the file.
  const attached = draft.firstFrame ?? draft.lastFrame ?? draft.textSource ?? draft.references[0]
  const title = draft.prompt.trim() || attached?.split(/[\\/]/).pop() || label
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex min-w-0 flex-col gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-foreground/[0.04]',
        selected && 'bg-foreground/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex aspect-[4/3] items-center justify-center rounded-md border-2 border-dashed bg-foreground/[0.02]',
          selected ? 'border-primary/70' : 'border-border/70',
        )}
      >
        {draft.generating ? (
          <Loader2 className="h-5 w-5 animate-spin text-foreground/30" />
        ) : (
          <Icon className="h-7 w-7 text-foreground/25" />
        )}
      </div>
      <div className="min-w-0 px-0.5">
        <div className="truncate text-xs font-medium">{title}</div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{label}</div>
      </div>
    </button>
  )
}
