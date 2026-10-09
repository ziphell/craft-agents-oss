import * as React from 'react'
import { AlertTriangle, ArrowLeft, Check, Download, FolderKanban, FolderOpen, Globe2, KeyRound, Maximize2, MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { designsAtom } from '@/atoms/designs'
import { LoadingIndicator } from '@craft-agent/ui'
import { Info_Alert } from '@/components/info'
import {
  DropdownMenu,
  DropdownMenuSub,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubContent,
  StyledDropdownMenuSubTrigger,
} from '@/components/ui/styled-dropdown'
import { useProjects } from '@/hooks/useProjects'
import type { LoadedDesign, DesignDataSnapshot, DesignRenderLease, DesignExportFormat } from '@craft-agent/shared/designs/types'
import { DesignFrame } from './DesignFrame'
import { DesignFreshness, DesignKindBadge } from './design-visuals'
import { DeleteDesignDialog } from './DeleteDesignDialog'
import { DesignGrantsDialog } from './DesignGrantsDialog'
import { DesignSourceAuthBanner } from './DesignSourceAuthBanner'
import { ShareDesignDialog, useDesignShareCapabilities } from './ShareDesignDialog'

interface DesignViewProps {
  designSlug: string
  /**
   * This render IS the design's own window (docs/design-plan.md §2.7), and it is
   * meant to look exactly like the design's page opened on its own. Every trace
   * of the host is dropped — the header, the Present row, the deck bar, the
   * status banners, and the frame's own margin, border, rounding and shadow —
   * leaving the sandboxed render edge to edge. The page's no-content and failure
   * states stay: a blank window would explain nothing.
   */
  standalone?: boolean
}

interface LeaseState {
  lease: DesignRenderLease
  content: string
  /** The design folder's own address, when the host serves it (see design-preview-host). */
  previewUrl?: string
}

/**
 * One design, rendered embedded in the main content area.
 *
 * Owns the render-lease lifecycle: a lease is created per (design, content
 * digest) and released on unmount or when the digest changes — a content
 * change (agent edit, refresh script rewriting index.html) re-leases and
 * remounts the frame with the new exact content. The data snapshot is
 * re-read whenever design.json is stamped (refresh completion), which for
 * live designs flows into the frame as a replacement snapshot.
 */
export function DesignView({ designSlug, standalone = false }: DesignViewProps) {
  const { activeWorkspaceId, onOpenFile, enabledSources } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const designs = useAtomValue(designsAtom)

  // Prefer the live atom copy; fall back to a direct fetch for deep links
  // that land before the initial designs load.
  const designFromAtom = React.useMemo(
    () => designs.find(p => p.config.slug === designSlug) ?? null,
    [designs, designSlug],
  )
  const [fallback, setFallback] = React.useState<{ slug: string; design: LoadedDesign | null } | null>(null)
  const design = designFromAtom ?? (fallback?.slug === designSlug ? fallback.design : null)
  const fallbackResolved = fallback?.slug === designSlug

  React.useEffect(() => {
    if (designFromAtom || !activeWorkspaceId) return
    let stale = false
    window.electronAPI
      .getDesign(activeWorkspaceId, designSlug)
      .then(loaded => { if (!stale) setFallback({ slug: designSlug, design: loaded }) })
      .catch(() => { if (!stale) setFallback({ slug: designSlug, design: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, designSlug, designFromAtom])

  // ------------------------------------------------------------------
  // Render lease (keyed by content digest; released on cleanup)
  // ------------------------------------------------------------------
  const contentDigest = design?.config.contentDigest
  const hasContent = Boolean(contentDigest)
  const designLoaded = Boolean(design)
  const [leaseState, setLeaseState] = React.useState<LeaseState | null>(null)
  const [leaseError, setLeaseError] = React.useState<string | null>(null)
  const [leaseRetry, setLeaseRetry] = React.useState(0)

  React.useEffect(() => {
    if (!activeWorkspaceId || !designLoaded || !hasContent) return
    let stale = false
    let heldLeaseId: string | null = null
    setLeaseState(null)
    setLeaseError(null)

    window.electronAPI
      .createDesignLease(activeWorkspaceId, designSlug)
      .then(result => {
        if (stale) {
          void window.electronAPI.releaseDesignLease(activeWorkspaceId, result.lease.leaseId)
          return
        }
        heldLeaseId = result.lease.leaseId
        setLeaseState(result)
      })
      .catch(err => {
        if (!stale) setLeaseError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      stale = true
      if (heldLeaseId) void window.electronAPI.releaseDesignLease(activeWorkspaceId, heldLeaseId)
    }
  }, [activeWorkspaceId, designSlug, contentDigest, hasContent, designLoaded, leaseRetry])

  // ------------------------------------------------------------------
  // Data snapshot (re-read when a refresh stamps design.json)
  // ------------------------------------------------------------------
  const refreshStamp = design?.config.lastRefresh?.at ?? 0
  const updatedStamp = design?.config.updatedAt ?? 0
  const [snapshotState, setSnapshotState] = React.useState<{
    slug: string
    loaded: boolean
    data: DesignDataSnapshot | null
  }>({ slug: designSlug, loaded: false, data: null })

  React.useEffect(() => {
    if (!activeWorkspaceId || !designLoaded) return
    let stale = false
    window.electronAPI
      .getDesignData(activeWorkspaceId, designSlug)
      .then(data => { if (!stale) setSnapshotState({ slug: designSlug, loaded: true, data }) })
      .catch(() => { if (!stale) setSnapshotState({ slug: designSlug, loaded: true, data: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, designSlug, designLoaded, refreshStamp, updatedStamp])

  const snapshotReady = snapshotState.slug === designSlug && snapshotState.loaded

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [grantsOpen, setGrantsOpen] = React.useState(false)
  const [exporting, setExporting] = React.useState<DesignExportFormat | null>(null)
  const { sharingEnabled } = useDesignShareCapabilities()
  const { projects } = useProjects(activeWorkspaceId)

  // Inline rename: null = display mode, string = the draft being edited.
  const [nameDraft, setNameDraft] = React.useState<string | null>(null)
  /**
   * Deck chrome: the deck reports slides/current; the host only displays it.
   * Declared up here with the other hooks — the component returns early when
   * the design is missing, and a hook after that return would be conditional.
   */
  const [deckState, setDeckState] = React.useState<{ slides: number; current: number } | null>(null)
  const presentRef = React.useRef<HTMLDivElement>(null)
  const handlePresent = React.useCallback(() => {
    void presentRef.current?.requestFullscreen?.()
  }, [])

  const commitRename = React.useCallback(async () => {
    const next = (nameDraft ?? '').trim()
    setNameDraft(null)
    if (!activeWorkspaceId || !design || !next || next === design.config.name) return
    try {
      await window.electronAPI.updateDesign(activeWorkspaceId, design.config.slug, { name: next })
    } catch (err) {
      toast.error(t('toast.designUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nameDraft, activeWorkspaceId, design, t])

  const moveToProject = React.useCallback(async (projectId: string | null) => {
    if (!activeWorkspaceId || !design) return
    if ((design.config.projectId ?? null) === projectId) return
    try {
      // Explicit null clears the binding (updateDesign normalizes null → absent).
      await window.electronAPI.updateDesign(activeWorkspaceId, design.config.slug, { projectId })
    } catch (err) {
      toast.error(t('toast.designUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, design, t])

  // Pinning is a local tray preference: presence of the field IS the pin, so
  // unpinning is an explicit null (see DesignConfig.pinnedToTrayAt).
  const togglePin = React.useCallback(async () => {
    if (!activeWorkspaceId || !design) return
    try {
      await window.electronAPI.updateDesign(activeWorkspaceId, design.config.slug, {
        pinnedToTrayAt: design.config.pinnedToTrayAt ? null : Date.now(),
      })
    } catch (err) {
      toast.error(t('toast.designUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, design, t])

  const handleDesignWithAgent = React.useCallback(() => {
    if (!design) return
    navigate(routes.action.newSession({
      input: t('designs.designWithAgentPrompt', { name: design.config.name, slug: design.config.slug }),
    }))
  }, [design, navigate, t])

  // The design's folder is the truth and the agent already has get_design/update_design
  // in every conversation — so this hands over a reference (name + slug), not a copy of
  // the markup, and starts a new conversation on it.
  const handleContinueInChat = React.useCallback(() => {
    if (!design) return
    navigate(routes.action.newSession({
      input: t('designs.continueInChatPrompt', { name: design.config.name, slug: design.config.slug }),
    }))
  }, [design, navigate, t])

  const handleBack = React.useCallback(() => navigate(routes.view.designs()), [navigate])

  const handleOpenFolder = React.useCallback(() => {
    if (design) onOpenFile(design.folderPath)
  }, [design, onOpenFile])

  const handleRefreshPreview = React.useCallback(() => {
    if (!activeWorkspaceId || !design) return
    void window.electronAPI
      .regenerateDesignThumbnail(activeWorkspaceId, design.config.slug)
      .then((queued) => {
        if (queued) toast.success(t('toast.designPreviewQueued'))
        else toast.error(t('toast.designPreviewFailed'))
      })
      .catch(() => toast.error(t('toast.designPreviewFailed')))
  }, [activeWorkspaceId, design, t])

  // The picker and the write both happen behind this call (the destination is
  // chosen on this client); PDF/PNG render in a hidden window in the main process.
  const handleExport = React.useCallback(async (format: DesignExportFormat) => {
    if (!activeWorkspaceId || !design) return
    setExporting(format)
    try {
      const result = await window.electronAPI.exportDesign(activeWorkspaceId, design.config.slug, format)
      if (result.canceled) return
      toast.success(t('designs.export.done', { path: result.paths[0] ?? '' }))
    } catch (err) {
      toast.error(t('designs.export.failed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setExporting(null)
    }
  }, [activeWorkspaceId, design, t])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !design) return
    setConfirmingDelete(false)
    try {
      const result = await window.electronAPI.deleteDesign(activeWorkspaceId, design.config.slug)
      if (result?.publicCopyMayRemain) {
        toast.warning(t('toast.designDeleted', { name: design.config.name }), {
          description: t('toast.designPublicCopyMayRemain'),
        })
      } else {
        toast.success(t('toast.designDeleted', { name: design.config.name }))
      }
      navigate(routes.view.designs())
    } catch (err) {
      toast.error(t('toast.designDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, design, t, navigate])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!design) {
    return (
      <div className="flex h-full items-center justify-center">
        {fallbackResolved ? (
          <div className="flex flex-col items-center gap-3 text-sm text-foreground/50">
            <span>{t('designs.notFound')}</span>
            <button
              onClick={handleBack}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {t('designs.backToDesigns')}
            </button>
          </div>
        ) : (
          <LoadingIndicator label={t('common.loading')} />
        )}
      </div>
    )
  }

  const { config } = design
  const deck = config.deck
  /**
   * Every kind but a deck offers Present here: a deck carries it in its own bar, beside the slide
   * counter. A page is worth showing full-screen whatever it is — a canvas to walk through, a motion
   * piece to watch, a wallboard to leave up.
   */
  const showsPresent = config.kind !== 'deck'
  const refreshFailed = config.lastRefresh && !config.lastRefresh.ok

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header: back, title, kind, freshness, overflow. Dropped in a design's own
          window — that window's own title bar carries the name (see `standalone`). */}
      {!standalone && (
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t('designs.backToDesigns')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {nameDraft !== null ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={e => {
              if (e.key === 'Enter') void commitRename()
              else if (e.key === 'Escape') setNameDraft(null)
            }}
            aria-label={t('designs.renameDesign')}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-ring"
          />
        ) : (
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={t('designs.renameDesign')}
            onDoubleClick={() => setNameDraft(config.name)}
          >
            {config.name}
          </span>
        )}
        <DesignKindBadge kind={config.kind} />
        <DesignFreshness config={config} className="hidden @[28rem]/panel:inline-flex" />
        <div className="ml-auto flex items-center gap-1">
          {hasContent && (
            <button
              type="button"
              onClick={handleContinueInChat}
              aria-label={t('designs.continueInChat')}
              title={t('designs.continueInChat')}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <MessageSquarePlus className="h-4 w-4" />
              <span className="hidden text-xs @[28rem]/panel:inline">{t('designs.continueInChat')}</span>
            </button>
          )}
          {(sharingEnabled || config.share) && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              aria-label={t('designs.share.title')}
              title={config.share ? t('designs.shared') : t('designs.share.title')}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <Globe2 className={config.share ? 'h-4 w-4 text-sky-600 dark:text-sky-400' : 'h-4 w-4'} />
              {config.share && (
                <span className="hidden text-xs @[28rem]/panel:inline">{t('designs.shared')}</span>
              )}
            </button>
          )}
          {hasContent && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('designs.export.title')}
                  title={t('designs.export.title')}
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/5"
                >
                  <Download className="h-4 w-4" />
                  <span className="hidden text-xs @[28rem]/panel:inline">{t('designs.export.title')}</span>
                </button>
              </DropdownMenuTrigger>
              <StyledDropdownMenuContent align="end">
                {/* PNG is per-slide, so it only exists for a deck; video only
                    exists for a motion composition. PPTX exports any design
                    (a deck to one slide per `.slide`, else one slide) as a
                    fully editable file. Markdown would slot in when it lands. */}
                <StyledDropdownMenuItem disabled={exporting !== null} onClick={() => void handleExport('pdf')}>
                  {t('designs.export.pdf')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem disabled={exporting !== null} onClick={() => void handleExport('pptx')}>
                  {t('designs.export.pptx')}
                </StyledDropdownMenuItem>
                {(config.deck || config.kind === 'prototype') && (
                  <StyledDropdownMenuItem disabled={exporting !== null} onClick={() => void handleExport('png')}>
                    {config.deck ? t('designs.export.png') : t('designs.export.pngFrames')}
                  </StyledDropdownMenuItem>
                )}
                {config.motion && (
                  <StyledDropdownMenuItem disabled={exporting !== null} onClick={() => void handleExport('video')}>
                    {t('designs.export.video')}
                  </StyledDropdownMenuItem>
                )}
                <StyledDropdownMenuItem disabled={exporting !== null} onClick={() => void handleExport('html')}>
                  {t('designs.export.html')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem disabled={exporting !== null} onClick={() => void handleExport('zip')}>
                  {t('designs.export.zip')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('common.more')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground data-[state=open]:bg-foreground/5"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end">
              <StyledDropdownMenuItem onClick={() => setNameDraft(config.name)}>
                <Pencil />
                {t('designs.renameDesign')}
              </StyledDropdownMenuItem>
              {projects.length > 0 && (
                <DropdownMenuSub>
                  <StyledDropdownMenuSubTrigger>
                    <FolderKanban className="h-3.5 w-3.5" />
                    <span className="flex-1">{t('designs.moveToProject')}</span>
                  </StyledDropdownMenuSubTrigger>
                  <StyledDropdownMenuSubContent>
                    <StyledDropdownMenuItem onClick={() => void moveToProject(null)}>
                      {!config.projectId && <Check className="h-3.5 w-3.5" />}
                      <span className={config.projectId ? 'flex-1 ml-[18px]' : 'flex-1'}>
                        {t('sessionMenu.noProject')}
                      </span>
                    </StyledDropdownMenuItem>
                    <StyledDropdownMenuSeparator />
                    {projects.map(p => {
                      const isBound = config.projectId === p.config.id
                      return (
                        <StyledDropdownMenuItem key={p.config.id} onClick={() => void moveToProject(p.config.id)}>
                          {isBound && <Check className="h-3.5 w-3.5" />}
                          <span className={isBound ? 'flex-1' : 'flex-1 ml-[18px]'}>{p.config.name}</span>
                        </StyledDropdownMenuItem>
                      )
                    })}
                  </StyledDropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <StyledDropdownMenuItem onClick={() => void togglePin()}>
                {config.pinnedToTrayAt ? <PinOff /> : <Pin />}
                {config.pinnedToTrayAt ? t('designs.unpinFromTray') : t('designs.pinToTray')}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onClick={handleOpenFolder}>
                <FolderOpen />
                {t('designs.openFolder')}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onClick={handleRefreshPreview}>
                <RefreshCw />
                {t('designs.refreshPreview')}
              </StyledDropdownMenuItem>
              {(config.grants?.length ?? 0) > 0 && (
                <StyledDropdownMenuItem onClick={() => setGrantsOpen(true)}>
                  <KeyRound />
                  {t('designs.grants.manage')}
                </StyledDropdownMenuItem>
              )}
              <StyledDropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                <Trash2 />
                {t('designs.deleteDesign')}
              </StyledDropdownMenuItem>
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      )}

      {/* Granted sources that lost auth get a reconnect row above the frame */}
      {!standalone && activeWorkspaceId && (
        <DesignSourceAuthBanner
          workspaceId={activeWorkspaceId}
          design={design}
          sources={enabledSources ?? []}
          className="mx-3 mt-2"
        />
      )}

      {/* Last-refresh failure surfaces above the frame, not inside it */}
      {!standalone && refreshFailed && (
        <Info_Alert
          variant="error"
          inline
          icon={<AlertTriangle className="h-4 w-4" />}
          className="mx-3 mt-2"
        >
          <Info_Alert.Title>{t('designs.refreshFailed')}</Info_Alert.Title>
          {config.lastRefresh?.error && (
            <Info_Alert.Description className="break-all">
              {config.lastRefresh.error}
            </Info_Alert.Description>
          )}
        </Info_Alert>
      )}

      {/* Deck chrome: a counter and Present. Navigation (keys, wheel, dots)
          belongs to the deck's own runtime — the host never drives it, and a
          design's own window shows none of this. */}
      {!standalone && deck && (
        <div className="mx-3 mt-2 flex items-center gap-2 text-xs text-foreground/60">
          <span className="tabular-nums">
            {deckState ? `${deckState.current + 1} / ${deckState.slides}` : '– / –'}
          </span>
          {deck.theme && <span className="truncate text-foreground/40">{deck.theme}</span>}
          <button
            type="button"
            onClick={handlePresent}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t('common.viewFullscreen')}
          </button>
        </div>
      )}

      {/* Present: a webpage or a prototype is made to be shown big — on a KPI screen or in a
          decision room — and a motion piece is just as much a thing to watch. The deck
          keeps its own copy of this button, beside the slide counter. A design's own
          window drops the whole row. */}
      {!standalone && showsPresent && (
        <div className="mx-3 mt-2 flex items-center gap-2 text-xs text-foreground/60">
          <button
            type="button"
            onClick={handlePresent}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            {t('common.viewFullscreen')}
          </button>
        </div>
      )}

      {/* Body: edge-to-edge sandboxed frame on a neutral canvas. In a design's own
          window the frame IS the window — no margin, no card. */}
      <div className={standalone ? 'relative min-h-0 flex-1' : 'relative min-h-0 flex-1 p-3'}>
        {!hasContent ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-sm font-medium text-foreground/70">{t('designs.noContentTitle')}</span>
            <span className="max-w-md text-xs text-foreground/50">{t('designs.noContentDescription')}</span>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleDesignWithAgent}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t('designs.designWithAgent')}
              </button>
              <button
                type="button"
                onClick={handleOpenFolder}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('designs.openFolder')}
              </button>
            </div>
          </div>
        ) : leaseError ? (
          <div className="mx-auto max-w-xl pt-8">
            <Info_Alert variant="error" icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('designs.loadFailed')}</Info_Alert.Title>
              <Info_Alert.Description className="break-all">{leaseError}</Info_Alert.Description>
            </Info_Alert>
            <button
              onClick={() => setLeaseRetry(n => n + 1)}
              className="mt-3 inline-flex h-7 items-center rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              {t('common.retry')}
            </button>
          </div>
        ) : !leaseState || !snapshotReady || !activeWorkspaceId ? (
          <div className="flex h-full items-center justify-center">
            <LoadingIndicator label={t('common.loading')} />
          </div>
        ) : (
          <div
            ref={presentRef}
            className={
              deck
                ? standalone
                  ? 'flex h-full w-full items-center justify-center bg-neutral-950'
                  : 'flex h-full w-full items-center justify-center rounded-lg bg-neutral-950 p-2'
                : standalone
                  ? 'h-full w-full overflow-hidden'
                  : 'h-full w-full overflow-hidden rounded-lg border border-border/60 shadow-minimal'
            }
          >
            <div
              className={
                deck
                  ? standalone
                    ? 'h-full max-w-full overflow-hidden'
                    : 'h-full max-w-full overflow-hidden rounded-lg border border-border/60 shadow-minimal'
                  : 'h-full w-full'
              }
              // Letterbox to the authored aspect; the deck's own CSS still lays
              // out the slide inside it.
              style={deck ? { aspectRatio: (deck.aspect ?? '16:9').replace(':', ' / ') } : undefined}
            >
              <DesignFrame
                key={leaseState.lease.leaseId}
                workspaceId={activeWorkspaceId}
                design={design}
                lease={leaseState.lease}
                content={leaseState.content}
                previewUrl={leaseState.previewUrl}
                snapshot={snapshotState.data}
                onDeckStateChange={setDeckState}
              />
            </div>
          </div>
        )}
      </div>

      <DeleteDesignDialog
        designName={confirmingDelete ? config.name : null}
        shared={Boolean(config.share)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />

      {activeWorkspaceId && (
        <ShareDesignDialog
          workspaceId={activeWorkspaceId}
          design={design}
          hasSnapshot={snapshotState.data !== null}
          sharingEnabled={sharingEnabled}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}

      {activeWorkspaceId && (
        <DesignGrantsDialog
          workspaceId={activeWorkspaceId}
          design={design}
          open={grantsOpen}
          onOpenChange={setGrantsOpen}
        />
      )}
    </div>
  )
}
