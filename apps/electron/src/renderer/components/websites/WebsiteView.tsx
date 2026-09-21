import * as React from 'react'
import { AlertTriangle, ArrowLeft, Check, FolderKanban, FolderOpen, Globe2, KeyRound, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { websitesAtom } from '@/atoms/websites'
import { sessionMetaMapAtom } from '@/atoms/sessions'
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
import type { LoadedWebsite, WebsiteDataSnapshot, WebsiteRenderLease } from '@craft-agent/shared/websites/types'
import { WebsiteFrame } from './WebsiteFrame'
import { WebsiteFreshness, WebsiteKindBadge } from './website-visuals'
import { DeleteWebsiteDialog } from './DeleteWebsiteDialog'
import { WebsiteGrantsDialog } from './WebsiteGrantsDialog'
import { WebsiteSourceAuthBanner } from './WebsiteSourceAuthBanner'
import { ShareWebsiteDialog, useWebsiteShareCapabilities } from './ShareWebsiteDialog'

interface WebsiteViewProps {
  websiteSlug: string
}

interface LeaseState {
  lease: WebsiteRenderLease
  content: string
}

/**
 * One website, rendered embedded in the main content area.
 *
 * Owns the render-lease lifecycle: a lease is created per (website, content
 * digest) and released on unmount or when the digest changes — a content
 * change (agent edit, refresh script rewriting index.html) re-leases and
 * remounts the frame with the new exact content. The data snapshot is
 * re-read whenever website.json is stamped (refresh completion), which for
 * live websites flows into the frame as a replacement snapshot.
 */
export function WebsiteView({ websiteSlug }: WebsiteViewProps) {
  const { activeWorkspaceId, onOpenFile, enabledSources } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()
  const websites = useAtomValue(websitesAtom)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  // Prefer the live atom copy; fall back to a direct fetch for deep links
  // that land before the initial websites load.
  const websiteFromAtom = React.useMemo(
    () => websites.find(p => p.config.slug === websiteSlug) ?? null,
    [websites, websiteSlug],
  )
  const [fallback, setFallback] = React.useState<{ slug: string; website: LoadedWebsite | null } | null>(null)
  const website = websiteFromAtom ?? (fallback?.slug === websiteSlug ? fallback.website : null)
  const fallbackResolved = fallback?.slug === websiteSlug

  React.useEffect(() => {
    if (websiteFromAtom || !activeWorkspaceId) return
    let stale = false
    window.electronAPI
      .getWebsite(activeWorkspaceId, websiteSlug)
      .then(loaded => { if (!stale) setFallback({ slug: websiteSlug, website: loaded }) })
      .catch(() => { if (!stale) setFallback({ slug: websiteSlug, website: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, websiteSlug, websiteFromAtom])

  // ------------------------------------------------------------------
  // Render lease (keyed by content digest; released on cleanup)
  // ------------------------------------------------------------------
  const contentDigest = website?.config.contentDigest
  const hasContent = Boolean(contentDigest)
  const websiteLoaded = Boolean(website)
  const [leaseState, setLeaseState] = React.useState<LeaseState | null>(null)
  const [leaseError, setLeaseError] = React.useState<string | null>(null)
  const [leaseRetry, setLeaseRetry] = React.useState(0)

  React.useEffect(() => {
    if (!activeWorkspaceId || !websiteLoaded || !hasContent) return
    let stale = false
    let heldLeaseId: string | null = null
    setLeaseState(null)
    setLeaseError(null)

    window.electronAPI
      .createWebsiteLease(activeWorkspaceId, websiteSlug)
      .then(result => {
        if (stale) {
          void window.electronAPI.releaseWebsiteLease(activeWorkspaceId, result.lease.leaseId)
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
      if (heldLeaseId) void window.electronAPI.releaseWebsiteLease(activeWorkspaceId, heldLeaseId)
    }
  }, [activeWorkspaceId, websiteSlug, contentDigest, hasContent, websiteLoaded, leaseRetry])

  // ------------------------------------------------------------------
  // Data snapshot (re-read when a refresh stamps website.json)
  // ------------------------------------------------------------------
  const refreshStamp = website?.config.lastRefresh?.at ?? 0
  const updatedStamp = website?.config.updatedAt ?? 0
  const [snapshotState, setSnapshotState] = React.useState<{
    slug: string
    loaded: boolean
    data: WebsiteDataSnapshot | null
  }>({ slug: websiteSlug, loaded: false, data: null })

  React.useEffect(() => {
    if (!activeWorkspaceId || !websiteLoaded) return
    let stale = false
    window.electronAPI
      .getWebsiteData(activeWorkspaceId, websiteSlug)
      .then(data => { if (!stale) setSnapshotState({ slug: websiteSlug, loaded: true, data }) })
      .catch(() => { if (!stale) setSnapshotState({ slug: websiteSlug, loaded: true, data: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, websiteSlug, websiteLoaded, refreshStamp, updatedStamp])

  const snapshotReady = snapshotState.slug === websiteSlug && snapshotState.loaded

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const [grantsOpen, setGrantsOpen] = React.useState(false)
  const { sharingEnabled } = useWebsiteShareCapabilities()
  const { projects } = useProjects(activeWorkspaceId)

  // Inline rename: null = display mode, string = the draft being edited.
  const [nameDraft, setNameDraft] = React.useState<string | null>(null)

  const commitRename = React.useCallback(async () => {
    const next = (nameDraft ?? '').trim()
    setNameDraft(null)
    if (!activeWorkspaceId || !website || !next || next === website.config.name) return
    try {
      await window.electronAPI.updateWebsite(activeWorkspaceId, website.config.slug, { name: next })
    } catch (err) {
      toast.error(t('toast.websiteUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [nameDraft, activeWorkspaceId, website, t])

  const moveToProject = React.useCallback(async (projectId: string | null) => {
    if (!activeWorkspaceId || !website) return
    if ((website.config.projectId ?? null) === projectId) return
    try {
      // Explicit null clears the binding (updateWebsite normalizes null → absent).
      await window.electronAPI.updateWebsite(activeWorkspaceId, website.config.slug, { projectId })
    } catch (err) {
      toast.error(t('toast.websiteUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, website, t])

  const handleDesignWithAgent = React.useCallback(() => {
    if (!website) return
    navigate(routes.action.newSession({
      input: t('websites.designWithAgentPrompt', { name: website.config.name, slug: website.config.slug }),
    }))
  }, [website, navigate, t])

  const handleBack = React.useCallback(() => navigate(routes.view.websites()), [navigate])

  const handleOpenFolder = React.useCallback(() => {
    if (website) onOpenFile(website.folderPath)
  }, [website, onOpenFile])

  const handleRefreshPreview = React.useCallback(() => {
    if (!activeWorkspaceId || !website) return
    void window.electronAPI
      .regenerateWebsiteThumbnail(activeWorkspaceId, website.config.slug)
      .then((queued) => {
        if (queued) toast.success(t('toast.websitePreviewQueued'))
        else toast.error(t('toast.websitePreviewFailed'))
      })
      .catch(() => toast.error(t('toast.websitePreviewFailed')))
  }, [activeWorkspaceId, website, t])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !website) return
    setConfirmingDelete(false)
    try {
      const result = await window.electronAPI.deleteWebsite(activeWorkspaceId, website.config.slug)
      if (result?.publicCopyMayRemain) {
        toast.warning(t('toast.websiteDeleted', { name: website.config.name }), {
          description: t('toast.websitePublicCopyMayRemain'),
        })
      } else {
        toast.success(t('toast.websiteDeleted', { name: website.config.name }))
      }
      navigate(routes.view.websites())
    } catch (err) {
      toast.error(t('toast.websiteDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, website, t, navigate])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!website) {
    return (
      <div className="flex h-full items-center justify-center">
        {fallbackResolved ? (
          <div className="flex flex-col items-center gap-3 text-sm text-foreground/50">
            <span>{t('websites.notFound')}</span>
            <button
              onClick={handleBack}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {t('websites.backToWebsites')}
            </button>
          </div>
        ) : (
          <LoadingIndicator label={t('common.loading')} />
        )}
      </div>
    )
  }

  const { config } = website
  const refreshFailed = config.lastRefresh && !config.lastRefresh.ok
  // Why this website exists: the conversation that asked for it. A weak reference —
  // the row appears only while that conversation is still around.
  const originSession = config.originSessionId ? sessionMetaMap.get(config.originSessionId) : undefined

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header: back, title, kind, freshness, overflow */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t('websites.backToWebsites')}
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
            aria-label={t('websites.renameWebsite')}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-ring"
          />
        ) : (
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={t('websites.renameWebsite')}
            onDoubleClick={() => setNameDraft(config.name)}
          >
            {config.name}
          </span>
        )}
        <WebsiteKindBadge kind={config.kind} />
        <WebsiteFreshness config={config} className="hidden @[28rem]/panel:inline-flex" />
        {originSession && (
          <button
            type="button"
            onClick={() => navigate(routes.view.allSessions(config.originSessionId!))}
            aria-label={t('websites.originChipOpen')}
            title={t('websites.originChipOpen')}
            className="hidden h-7 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground @[28rem]/panel:inline-flex"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span className="truncate text-xs">
              {originSession.name ?? originSession.preview ?? t('websites.originChip')}
            </span>
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {(sharingEnabled || config.share) && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              aria-label={t('websites.share.title')}
              title={config.share ? t('websites.shared') : t('websites.share.title')}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <Globe2 className={config.share ? 'h-4 w-4 text-sky-600 dark:text-sky-400' : 'h-4 w-4'} />
              {config.share && (
                <span className="hidden text-xs @[28rem]/panel:inline">{t('websites.shared')}</span>
              )}
            </button>
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
                {t('websites.renameWebsite')}
              </StyledDropdownMenuItem>
              {projects.length > 0 && (
                <DropdownMenuSub>
                  <StyledDropdownMenuSubTrigger>
                    <FolderKanban className="h-3.5 w-3.5" />
                    <span className="flex-1">{t('websites.moveToProject')}</span>
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
              <StyledDropdownMenuItem onClick={handleOpenFolder}>
                <FolderOpen />
                {t('websites.openFolder')}
              </StyledDropdownMenuItem>
              <StyledDropdownMenuItem onClick={handleRefreshPreview}>
                <RefreshCw />
                {t('websites.refreshPreview')}
              </StyledDropdownMenuItem>
              {(config.grants?.length ?? 0) > 0 && (
                <StyledDropdownMenuItem onClick={() => setGrantsOpen(true)}>
                  <KeyRound />
                  {t('websites.grants.manage')}
                </StyledDropdownMenuItem>
              )}
              <StyledDropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                <Trash2 />
                {t('websites.deleteWebsite')}
              </StyledDropdownMenuItem>
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Granted sources that lost auth get a reconnect row above the frame */}
      {activeWorkspaceId && (
        <WebsiteSourceAuthBanner
          workspaceId={activeWorkspaceId}
          website={website}
          sources={enabledSources ?? []}
          className="mx-3 mt-2"
        />
      )}

      {/* Last-refresh failure surfaces above the frame, not inside it */}
      {refreshFailed && (
        <Info_Alert
          variant="error"
          inline
          icon={<AlertTriangle className="h-4 w-4" />}
          className="mx-3 mt-2"
        >
          <Info_Alert.Title>{t('websites.refreshFailed')}</Info_Alert.Title>
          {config.lastRefresh?.error && (
            <Info_Alert.Description className="break-all">
              {config.lastRefresh.error}
            </Info_Alert.Description>
          )}
        </Info_Alert>
      )}

      {/* Body: edge-to-edge sandboxed frame on a neutral canvas */}
      <div className="relative min-h-0 flex-1 p-3">
        {!hasContent ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="text-sm font-medium text-foreground/70">{t('websites.noContentTitle')}</span>
            <span className="max-w-md text-xs text-foreground/50">{t('websites.noContentDescription')}</span>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={handleDesignWithAgent}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t('websites.designWithAgent')}
              </button>
              <button
                type="button"
                onClick={handleOpenFolder}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t('websites.openFolder')}
              </button>
            </div>
          </div>
        ) : leaseError ? (
          <div className="mx-auto max-w-xl pt-8">
            <Info_Alert variant="error" icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('websites.loadFailed')}</Info_Alert.Title>
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
          <div className="h-full w-full overflow-hidden rounded-lg border border-border/60 shadow-minimal">
            <WebsiteFrame
              key={leaseState.lease.leaseId}
              workspaceId={activeWorkspaceId}
              website={website}
              lease={leaseState.lease}
              content={leaseState.content}
              snapshot={snapshotState.data}
            />
          </div>
        )}
      </div>

      <DeleteWebsiteDialog
        websiteName={confirmingDelete ? config.name : null}
        shared={Boolean(config.share)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />

      {activeWorkspaceId && (
        <ShareWebsiteDialog
          workspaceId={activeWorkspaceId}
          website={website}
          hasSnapshot={snapshotState.data !== null}
          sharingEnabled={sharingEnabled}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}

      {activeWorkspaceId && (
        <WebsiteGrantsDialog
          workspaceId={activeWorkspaceId}
          website={website}
          open={grantsOpen}
          onOpenChange={setGrantsOpen}
        />
      )}
    </div>
  )
}
