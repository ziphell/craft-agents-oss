/**
 * PrototypeInfoPage
 *
 * Workspace-prototype detail page: the workbench control plane for a single
 * prototype. Shows what the derived status report already knows
 * (base.html, patches by lane, per-service contract coverage, dist/, ownership)
 * and exposes the three actions that mutate or re-read it: Open, Export, Refresh.
 *
 * The status is recomputed on the main side on every call — this page never
 * caches it beyond the current render, and re-reads on every `prototypes:changed`
 * broadcast (the watcher itself is owned by `usePrototypes` in AppShell).
 */

import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { AppWindow, Camera, CopyPlus, Download, ExternalLink, FileCode, FlaskConical, FolderOpen, Link2, MessageSquare, RefreshCw, TriangleAlert, Unlink, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { activeBrowserInstanceIdAtom } from '@/atoms/browser-pane'
import { Info_Page, Info_Section, Info_Table, Info_Alert } from '@/components/info'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PrototypeSourceEditorDialog } from '@/components/prototypes/PrototypeSourceEditorDialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import type { ImportedPrototype, PrototypeEntry, PrototypeExportResult, PrototypeStatus } from '@craft-agent/shared/prototypes'

interface PrototypeInfoPageProps {
  prototypeSlug: string
}

/** File name without a path module — handles both `/` and `\` separators. */
function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}

export default function PrototypeInfoPage({ prototypeSlug }: PrototypeInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { onCreateSession } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const [status, setStatus] = useState<PrototypeStatus | null>(null)
  /** Every prototype in the workspace — references are resolved against it. */
  const [allStatuses, setAllStatuses] = useState<PrototypeStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<PrototypeExportResult | null>(null)
  const [applying, setApplying] = useState(false)
  const [capturing, setCapturing] = useState(false)
  /** Capture is armed but waiting for the user to accept overwriting base.html. */
  const [confirmingCapture, setConfirmingCapture] = useState(false)
  /** The "add a reference" form, which is hidden until it is asked for. */
  const [referenceFormOpen, setReferenceFormOpen] = useState(false)
  const [referenceName, setReferenceName] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [linkingReference, setLinkingReference] = useState(false)
  /** The "import another prototype" picker, hidden until it is asked for. */
  const [importPanelOpen, setImportPanelOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  /** Source slug armed for an import that would overwrite this prototype's page. */
  const [confirmingImport, setConfirmingImport] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ImportedPrototype | null>(null)
  /** Artifact open in the source editor — null when the editor is closed. */
  const [editing, setEditing] = useState<{ path: string; name: string } | null>(null)
  /** Failure from Open or Export — both surface the throwing RPC's message verbatim. */
  const [actionError, setActionError] = useState<string | null>(null)

  // Apply and Capture both act on the browser window the user is currently
  // looking at: patches are injected into whatever page that window shows, and
  // Capture reads the rendered document out of it.
  const activeBrowserInstanceId = useAtomValue(activeBrowserInstanceIdAtom)

  // Load the status report for this prototype. `listPrototypes` is the only
  // read path for a single prototype's status, so pick our slug out of it.
  // `silent` skips the spinner so a post-export refresh doesn't flash the page.
  const loadStatus = useCallback(async (silent = false) => {
    if (!workspaceId) return
    if (!silent) setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.listPrototypes(workspaceId)
      const list = Array.isArray(result) ? (result as PrototypeStatus[]) : []
      setAllStatuses(list)
      const found = list.find((item) => item.slug === prototypeSlug)
      if (!found) {
        setStatus(null)
        setError(t('prototypeInfo.notFound'))
        return
      }
      setStatus(found)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to load prototype status:', err)
      setStatus(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [workspaceId, prototypeSlug, t])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // Re-read on artifact changes (event carries only the changed file name).
  // Silent so a burst of patch writes doesn't flash the spinner.
  useEffect(() => {
    if (!workspaceId) return
    const off = window.electronAPI.onPrototypesChanged((wsId: string) => {
      if (wsId === workspaceId) loadStatus(true)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [workspaceId, loadStatus])

  // Every "open this in a browser window" action is the same three steps, so
  // they share one helper rather than three drifting copies.
  const openInBrowserPane = useCallback(async (url: string) => {
    const instanceId = await window.electronAPI.browserPane.create({ show: true })
    await window.electronAPI.browserPane.navigate(instanceId, url)
    await window.electronAPI.browserPane.focus(instanceId)
  }, [])

  // Open the prototype in a browser pane: its origin root, which the host renders
  // from base.html with every patch applied. Never the exported deliverable — that
  // is a snapshot of an earlier state, and the page here is the one you can go on
  // editing. `getPrototypeEntry` throws when there is no base page to render.
  const handleOpen = useCallback(async () => {
    if (!workspaceId) return
    setActionError(null)
    try {
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, prototypeSlug)) as PrototypeEntry
      await openInBrowserPane(entry.url)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open prototype:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug, openInBrowserPane])

  const handleExport = useCallback(async () => {
    if (!workspaceId) return
    setExporting(true)
    setActionError(null)
    setExportResult(null)
    try {
      const result = (await window.electronAPI.exportPrototype(workspaceId, prototypeSlug)) as PrototypeExportResult
      setExportResult(result)
      // dist/ just changed on disk — reflect it without waiting for the watcher.
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to export prototype:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }, [workspaceId, prototypeSlug, loadStatus])

  // Inject this prototype's patches into the live page the user is looking at.
  // On a page opened from here there is usually nothing to do — it arrives with
  // its patches inlined — so say which case this was instead of reporting a bare
  // "0 patches", which reads as a failure.
  const handleApply = useCallback(async () => {
    if (!workspaceId || !activeBrowserInstanceId) return
    setApplying(true)
    setActionError(null)
    try {
      const result = (await window.electronAPI.applyPrototype(
        workspaceId,
        activeBrowserInstanceId,
        prototypeSlug,
      )) as { applied: number; skipped: string[] }
      if (result.applied > 0) {
        toast.success(t('prototypeInfo.applySuccess', { applied: result.applied }))
      } else if (result.skipped.length > 0) {
        toast.success(t('prototypeInfo.applyAlreadyInlined', { skipped: result.skipped.length }))
      } else {
        toast.success(t('prototypeInfo.applyNoPatches'))
      }
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to apply patches:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [workspaceId, activeBrowserInstanceId, prototypeSlug, t])

  // Store the rendered page as base.html. Goes through the browser, so it works
  // for client-rendered apps and authenticated sessions where a fetch would not.
  const runCapture = useCallback(async () => {
    if (!workspaceId || !activeBrowserInstanceId) return
    setCapturing(true)
    setConfirmingCapture(false)
    setActionError(null)
    try {
      const result = (await window.electronAPI.capturePrototypeBase(
        workspaceId,
        activeBrowserInstanceId,
        prototypeSlug,
      )) as { bytes: number }
      toast.success(t('prototypeInfo.captureSuccess', { bytes: result.bytes }))
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to capture base page:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setCapturing(false)
    }
  }, [workspaceId, activeBrowserInstanceId, prototypeSlug, t, loadStatus])

  // Capture overwrites base.html outright. For an overlay that is the documented
  // remedy (base.html is a snapshot, and re-capturing is how it is refreshed),
  // but for a scratch the same file is the user's own document — seeding it from
  // a page is fine, silently replacing edits is not. So the destructive case
  // asks first; the sanctioned case does not.
  const handleCapture = useCallback(() => {
    if (!status) return
    if (status.kind === 'scratch' && status.baseHtmlPresent) {
      setConfirmingCapture(true)
      return
    }
    void runCapture()
  }, [status, runCapture])

  // Take another prototype's page and patches as this one's starting point. The
  // third way a base.html comes into existence, alongside writing and capturing.
  const runImport = useCallback(async (sourceSlug: string) => {
    if (!workspaceId) return
    setImporting(true)
    setConfirmingImport(null)
    setActionError(null)
    setImportResult(null)
    try {
      const result = (await window.electronAPI.importPrototype(
        workspaceId,
        prototypeSlug,
        sourceSlug,
      )) as ImportedPrototype
      setImportResult(result)
      setImportPanelOpen(false)
      // base.html and patches/ both changed on disk — reflect it now rather than
      // waiting for the watcher's debounce.
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to import a prototype:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [workspaceId, prototypeSlug, loadStatus])

  // Same reasoning as Capture: an import replaces base.html outright, so it asks
  // first when this prototype already has a page of its own.
  const handleImport = useCallback((sourceSlug: string) => {
    if (status?.baseHtmlPresent) {
      setConfirmingImport(sourceSlug)
      return
    }
    void runImport(sourceSlug)
  }, [status?.baseHtmlPresent, runImport])

  // Conversations already bound to this prototype (any session bound to it, from
  // any entry point). `prototypeSlug` is on the persisted header, so this is a
  // pure read of what the sidebar already has.
  const prototypeSessions = useMemo(() => {
    const result: Array<{ id: string; name: string }> = []
    for (const meta of sessionMetaMap.values()) {
      if ((meta as { prototypeSlug?: string }).prototypeSlug === prototypeSlug) {
        result.push({ id: meta.id, name: meta.name ?? meta.id })
      }
    }
    return result
  }, [sessionMetaMap, prototypeSlug])

  // Open the conversation for this prototype, reusing the existing one when there
  // is one. A prototype is long-lived and gets revisited, so always creating a new
  // session would both pile up sessions and lose the earlier discussion.
  const handleOpenChat = useCallback(async () => {
    if (!workspaceId) return
    setActionError(null)

    const existing = prototypeSessions[0]
    if (existing) {
      navigate(routes.view.allSessions(existing.id))
      return
    }

    try {
      const session = await onCreateSession(workspaceId, { prototypeSlug, name: prototypeSlug })
      if (session?.id) navigate(routes.view.allSessions(session.id))
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open a conversation:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSessions, onCreateSession, prototypeSlug])

  // Open the recorded target page in a browser panel. This is the entry that was
  // missing before kinds existed: an overlay prototype is *about* an external
  // page, so "open my target" has to be one click, not a URL the user retypes.
  const handleOpenTargetPage = useCallback(async () => {
    if (!status?.targetUrl) return
    setActionError(null)
    try {
      await openInBrowserPane(status.targetUrl)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open the target page:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [status?.targetUrl, openInBrowserPane])

  // Open a reference *for study*. Its live page is the point (that is what you
  // reverse-engineer), so prefer `targetUrl` and only fall back to its captured
  // or exported document when no page was recorded.
  const handleOpenReference = useCallback(async (referenceSlug: string) => {
    if (!workspaceId) return
    setActionError(null)
    try {
      const reference = allStatuses.find((item) => item.slug === referenceSlug)
      if (reference?.targetUrl) {
        await openInBrowserPane(reference.targetUrl)
        return
      }
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, referenceSlug)) as PrototypeEntry
      await openInBrowserPane(entry.url)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open the reference:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, allStatuses, openInBrowserPane])

  // Add a reference: create the prototype that will hold it, then link it.
  //
  // Two steps rather than one RPC, and in this order, so the page being built is
  // never the thing left half-made: if the reference's name is taken, the create
  // fails and this prototype is untouched.
  const handleAddReference = useCallback(async () => {
    if (!workspaceId) return
    const name = referenceName.trim()
    const url = referenceUrl.trim()
    if (!name) return

    setLinkingReference(true)
    setActionError(null)
    try {
      const created = (await window.electronAPI.createPrototype(workspaceId, {
        name,
        kind: 'overlay',
        targetUrl: url || undefined,
      })) as { slug: string }
      await window.electronAPI.linkPrototypeReference(workspaceId, prototypeSlug, created.slug)
      setReferenceFormOpen(false)
      setReferenceName('')
      setReferenceUrl('')
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to add a reference:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setLinkingReference(false)
    }
  }, [workspaceId, referenceName, referenceUrl, prototypeSlug, loadStatus])

  const handleRemoveReference = useCallback(async (referenceSlug: string) => {
    if (!workspaceId) return
    setActionError(null)
    try {
      await window.electronAPI.unlinkPrototypeReference(workspaceId, prototypeSlug, referenceSlug)
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to remove the reference:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug, loadStatus])

  // Link a prototype that already exists. Any kind qualifies: the relation is
  // about two projects being independent, not about what either of them is — so
  // studying another scratch is the same thing as studying an overlay.
  const handleLinkExistingReference = useCallback(async (referenceSlug: string) => {
    if (!workspaceId) return
    setLinkingReference(true)
    setActionError(null)
    try {
      await window.electronAPI.linkPrototypeReference(workspaceId, prototypeSlug, referenceSlug)
      setReferenceFormOpen(false)
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to link the reference:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setLinkingReference(false)
    }
  }, [workspaceId, prototypeSlug, loadStatus])

  /** Anything that could be linked, minus this prototype and what is already linked. */
  const referenceCandidates = useMemo(() => {
    const linked = new Set(status?.references ?? [])
    return allStatuses.filter((item) => item.slug !== prototypeSlug && !linked.has(item.slug))
  }, [allStatuses, prototypeSlug, status?.references])

  /**
   * Prototypes an import could take material from: any of them that has a page.
   * A prototype whose only deliverable is an export is not a source — its HTML
   * already has the patches inlined, so importing it would apply them twice.
   */
  const importCandidates = useMemo(
    () => allStatuses.filter((item) => item.slug !== prototypeSlug && item.baseHtmlPresent),
    [allStatuses, prototypeSlug],
  )

  // Open a browser window with nothing in it. Without this, a prototype whose
  // page does not exist yet has no way forward from this screen at all: Apply and
  // Capture both need a window to act on, and the only other thing that opens one
  // ("open the target page") requires a recorded target URL — which an overlay
  // created without one can never gain.
  const handleOpenBrowserWindow = useCallback(async () => {
    setActionError(null)
    try {
      const instanceId = await window.electronAPI.browserPane.create({ show: true })
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open a browser window:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const handleRevealFolder = useCallback(async () => {
    if (!status) return
    try {
      await window.electronAPI.showInFolder(status.dir)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to reveal prototype folder:', err)
    }
  }, [status])
  const laneEntries = status ? Object.entries(status.patches.byLane) : []

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!status && !loading && !error ? t('prototypeInfo.notFound') : undefined}
    >
      <Info_Page.Header title={status?.slug ?? ''} />
      {status && (
        <Info_Page.Content>
          <Info_Page.Hero
            avatar={<FlaskConical className="h-6 w-6 text-foreground/60" />}
            title={status.slug}
            tagline={
              status.kind === 'overlay'
                ? t('prototypeInfo.kindOverlay')
                : t('prototypeInfo.kindScratch')
            }
          />

          {/* Actions — Apply and Capture act on the browser window the user is viewing */}
          <div className="flex flex-wrap items-center gap-2 pl-1">
            {/* Primary action: the conversation is where the prototype gets built,
                and a bound session stops every command needing a slug. */}
            <Button size="sm" onClick={() => void handleOpenChat()}>
              <MessageSquare className="h-3.5 w-3.5" />
              {prototypeSessions.length > 0 ? t('prototypeInfo.openChat') : t('prototypeInfo.startChat')}
            </Button>
            {status.kind === 'overlay' && status.targetUrl && (
              <Button size="sm" variant="outline" onClick={() => void handleOpenTargetPage()}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t('prototypeInfo.openTargetPage')}
              </Button>
            )}
            {/* The generic "give me a window" entry. Suppressed when the target
                button above already provides one, so there are never two buttons
                that both just open a window. */}
            {!activeBrowserInstanceId && !(status.kind === 'overlay' && status.targetUrl) && (
              <Button size="sm" variant="outline" onClick={() => void handleOpenBrowserWindow()}>
                <AppWindow className="h-3.5 w-3.5" />
                {t('prototypeInfo.openBrowserWindow')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleApply} disabled={applying || !activeBrowserInstanceId}>
              <Zap className="h-3.5 w-3.5" />
              {applying ? t('prototypeInfo.applying') : t('prototypeInfo.apply')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleCapture} disabled={capturing || !activeBrowserInstanceId}>
              <Camera className="h-3.5 w-3.5" />
              {capturing ? t('prototypeInfo.capturing') : t('prototypeInfo.captureBase')}
            </Button>
            {/* Only a scratch can import: an overlay's base.html is defined as the
                snapshot of its own target page, so replacing it with a copy of
                some other document would make its metadata say something false.
                An overlay's version of this action is Capture, right above. */}
            {status.kind === 'scratch' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImportPanelOpen((open) => !open)}
                disabled={importing || importCandidates.length === 0}
                title={importCandidates.length === 0 ? t('prototypeInfo.importNoSources') : undefined}
              >
                <CopyPlus className="h-3.5 w-3.5" />
                {importing ? t('prototypeInfo.importing') : t('prototypeInfo.importPrototype')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpen}
              // Nothing to open yet: offering the button would only produce an
              // error message written for the agent. The alert below says what to
              // do instead, and it is kind-aware (capture / write / import vs.
              // capture the target page).
              disabled={!status.baseHtmlPresent}
              title={status.baseHtmlPresent ? undefined : t('prototypeInfo.baseHtmlMissing')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('prototypeInfo.open')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExport}
              // Export reads base.html; without it the RPC throws a message that
              // names a filesystem path, which is not something to show a user.
              disabled={exporting || !status.baseHtmlPresent}
              title={status.baseHtmlPresent ? undefined : t('prototypeInfo.baseHtmlMissing')}
            >
              <Download className="h-3.5 w-3.5" />
              {exporting ? t('prototypeInfo.exporting') : t('prototypeInfo.export')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => loadStatus()} disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('common.refresh')}
            </Button>
          </div>

          {!activeBrowserInstanceId && (
            <p className="pl-1 text-xs text-muted-foreground">{t('prototypeInfo.needBrowser')}</p>
          )}

          {/* The import picker: which prototype to take a page and patches from.
              Same shape as "link an existing reference" — a row of what exists —
              because both answer "which other prototype", with opposite effects:
              a reference stays where it is, an import moves a copy in here. */}
          {importPanelOpen && status.kind === 'scratch' && (
            <div className="space-y-2 pl-1">
              <div className="flex flex-wrap gap-2">
                {importCandidates.map((candidate) => (
                  <Button
                    key={candidate.slug}
                    size="sm"
                    variant="outline"
                    disabled={importing}
                    onClick={() => handleImport(candidate.slug)}
                  >
                    {candidate.slug}
                    <span className="ml-1 font-mono text-[10px] text-muted-foreground">{candidate.kind}</span>
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{t('prototypeInfo.importHint')}</p>
            </div>
          )}

          {/* base.html is the precondition for export — say so loudly, and say
              the right thing: an overlay captures it, a scratch authors it. */}
          {!status.baseHtmlPresent && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.baseHtmlMissing')}</Info_Alert.Title>
              <Info_Alert.Description>
                {status.kind === 'overlay'
                  ? t('prototypeInfo.baseHtmlMissingHintOverlay')
                  : t('prototypeInfo.baseHtmlMissingHintScratch')}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {exportResult && (
            <Info_Alert variant="success">
              <Info_Alert.Title>
                {t('prototypeInfo.exportSuccess', { applied: exportResult.applied })}
              </Info_Alert.Title>
              <Info_Alert.Description>
                <span className="font-mono text-xs break-all">{exportResult.htmlPath}</span>
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {actionError && (
            <Info_Alert variant="error" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.actionFailed')}</Info_Alert.Title>
              <Info_Alert.Description>{actionError}</Info_Alert.Description>
            </Info_Alert>
          )}

          {/* An import reports two numbers, and the second one matters: patches
              that were already here were left alone, so the two patch sets are
              not merged. Saying only "imported" would hide that. */}
          {importResult && (
            <Info_Alert variant="success">
              <Info_Alert.Title>
                {t('prototypeInfo.importSuccess', {
                  source: importResult.sourceSlug,
                  patches: importResult.copiedPatches.length,
                })}
              </Info_Alert.Title>
              {importResult.skippedPatches.length > 0 && (
                <Info_Alert.Description>
                  {t('prototypeInfo.importSkipped', {
                    skipped: importResult.skippedPatches.length,
                    files: importResult.skippedPatches.join(', '),
                  })}
                </Info_Alert.Description>
              )}
            </Info_Alert>
          )}

          {confirmingCapture && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.captureOverwriteTitle')}</Info_Alert.Title>
              <Info_Alert.Description>
                <div>{t('prototypeInfo.captureOverwriteHint')}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void runCapture()} disabled={capturing}>
                    {capturing ? t('prototypeInfo.capturing') : t('prototypeInfo.captureOverwriteConfirm')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingCapture(false)} disabled={capturing}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {confirmingImport && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.importOverwriteTitle')}</Info_Alert.Title>
              <Info_Alert.Description>
                <div>{t('prototypeInfo.importOverwriteHint')}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void runImport(confirmingImport)} disabled={importing}>
                    {importing ? t('prototypeInfo.importing') : t('prototypeInfo.importOverwriteConfirm')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingImport(null)} disabled={importing}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* References — the prototypes this one is studied from. Each stays a
              separate project, which is what keeps its patches out of this
              prototype's deliverable (plan §14). */}
          <Info_Section
            title={t('prototypeInfo.references')}
            description={status.references.length > 0 ? t('prototypeInfo.referencesHint') : undefined}
          >
            {status.references.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.referencesEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.references.map((referenceSlug) => {
                  const reference = allStatuses.find((item) => item.slug === referenceSlug)
                  return (
                    <li key={referenceSlug} className="flex items-center gap-2 px-4 py-2">
                      <button
                        type="button"
                        onClick={() => navigate(routes.view.prototypes(referenceSlug))}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="truncate text-sm font-medium">{referenceSlug}</div>
                        {/* A scratch reference has no target page *by design* — say
                            what it actually is rather than reporting a missing URL. */}
                        <div className="truncate font-mono text-xs text-foreground/60">
                          {reference?.targetUrl
                            ?? t(reference?.kind === 'scratch'
                              ? 'prototypeInfo.referenceOwnPage'
                              : 'prototypeInfo.referenceNoTarget')}
                        </div>
                      </button>
                      <Button size="sm" variant="ghost" onClick={() => void handleOpenReference(referenceSlug)}>
                        <ExternalLink className="h-3.5 w-3.5" />
                        {t('prototypeInfo.open')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('prototypeInfo.removeReference')}
                        onClick={() => void handleRemoveReference(referenceSlug)}
                      >
                        <Unlink className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="px-4 py-3">
              {referenceFormOpen ? (
                <div className="space-y-3">
                  {/* Linking an existing prototype comes first: it creates nothing,
                      and it is the only way to study another one of your own. */}
                  {referenceCandidates.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">{t('prototypeInfo.referenceLinkExisting')}</p>
                      <div className="flex flex-wrap gap-2">
                        {referenceCandidates.map((candidate) => (
                          <Button
                            key={candidate.slug}
                            size="sm"
                            variant="outline"
                            onClick={() => void handleLinkExistingReference(candidate.slug)}
                            disabled={linkingReference}
                          >
                            {candidate.slug}
                            <span className="ml-1 font-mono text-[10px] text-muted-foreground">{candidate.kind}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        value={referenceName}
                        onChange={(event) => setReferenceName(event.target.value)}
                        placeholder={t('prototypeInfo.referenceNamePlaceholder')}
                        className="h-8 w-48"
                      />
                      <Input
                        value={referenceUrl}
                        onChange={(event) => setReferenceUrl(event.target.value)}
                        placeholder={t('prototypeInfo.referenceUrlPlaceholder')}
                        className="h-8 w-72"
                      />
                      <Button
                        size="sm"
                        onClick={() => void handleAddReference()}
                        disabled={!referenceName.trim() || linkingReference}
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        {t('prototypeInfo.referenceAdd')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setReferenceFormOpen(false)}
                        disabled={linkingReference}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                    {/* Says out loud that this creates a whole prototype — a side
                        effect nobody would guess from a button labelled "Add". */}
                    <p className="text-xs text-muted-foreground">{t('prototypeInfo.addReferenceHint')}</p>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setReferenceFormOpen(true)}>
                  <Link2 className="h-3.5 w-3.5" />
                  {t('prototypeInfo.addReference')}
                </Button>
              )}
            </div>
          </Info_Section>

          {/* Patches — total + per-lane distribution */}
          <Info_Section title={t('prototypeInfo.patches')}>
            <Info_Table>
              <Info_Table.Row label={t('prototypeInfo.patchTotal')} value={String(status.patches.total)} />
              {laneEntries.map(([lane, count]) => (
                <Info_Table.Row
                  key={lane}
                  label={lane}
                  value={
                    <span>
                      {count}
                      {status.lanes[lane] && (
                        <span className="ml-2 text-xs text-muted-foreground">{status.lanes[lane]}</span>
                      )}
                    </span>
                  }
                />
              ))}
            </Info_Table>
          </Info_Section>

          {/* Artifacts — the files that actually make up the prototype, each
              editable in place. This is the "edit the injected HTML" entry: the
              write goes straight to disk, so an external editor sees the same
              bytes and the watcher refreshes this page either way. */}
          <Info_Section title={t('prototypeInfo.files')}>
            {!status.baseHtmlPath && status.patches.files.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.filesEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.baseHtmlPath && (
                  <ArtifactRow
                    path={status.baseHtmlPath}
                    label={t('prototypeInfo.baseHtml')}
                    onOpen={setEditing}
                  />
                )}
                {status.patches.files.map((file) => (
                  <ArtifactRow key={file} path={file} onOpen={setEditing} />
                ))}
              </ul>
            )}
          </Info_Section>

          {/* Services — contract coverage per service */}
          <Info_Section title={t('prototypeInfo.services')}>
            {status.services.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.servicesEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.services.map((service) => (
                  <li key={service.slug} className="px-4 py-3">
                    <div className="text-sm font-medium">{service.slug}</div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-foreground/60">
                      <span>
                        {t('prototypeInfo.endpoints')}: {service.endpoints}
                      </span>
                      <span>
                        {t('prototypeInfo.mockedEndpoints')}: {service.mockedEndpoints}
                      </span>
                      <span>
                        {t('prototypeInfo.fragments')}: {service.fragments}
                      </span>
                      <span>
                        {t('prototypeInfo.fixtures')}: {service.fixtures}
                      </span>
                    </div>
                    {service.missingFixtures.length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs font-medium text-destructive">
                          {t('prototypeInfo.missingFixtures')}
                        </div>
                        <ul className="mt-1 space-y-0.5">
                          {service.missingFixtures.map((fixture) => (
                            <li key={fixture} className="font-mono text-xs text-destructive break-all">
                              {fixture}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* dist/ contents */}
          <Info_Section title={t('prototypeInfo.dist')}>
            {status.distFiles.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.distEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.distFiles.map((file) => (
                  <li key={file} className="px-4 py-2 font-mono text-xs break-all">
                    {file}
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* Ownership — lane violations are the loud part; silence means clean */}
          <Info_Section
            title={t('prototypeInfo.ownership')}
            description={
              status.ownership.violations.length > 0
                ? t('prototypeInfo.violations', { violations: status.ownership.violations.length })
                : undefined
            }
          >
            {status.ownership.violations.length === 0 ? (
              <div className="px-4 py-3 text-sm text-foreground/70">
                {t('prototypeInfo.ownershipOk', { inspected: status.ownership.inspected })}
              </div>
            ) : (
              <ul className="divide-y divide-border/30 bg-destructive/5">
                {status.ownership.violations.map((violation) => (
                  <li key={`${violation.path}:${violation.reason}`} className="px-4 py-2">
                    <div className="font-mono text-xs text-destructive break-all">{violation.path}</div>
                    <div className="text-xs text-foreground/60">{violation.reason}</div>
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* Metadata read-out for quick reference */}
          <Info_Section title={t('prototypeInfo.metadata')}>
            <Info_Table>
              <Info_Table.Row label={t('common.slug')} value={status.slug} />
              {status.kind === 'overlay' && (
                <Info_Table.Row
                  label={t('prototypeInfo.targetPage')}
                  value={
                    status.targetUrl
                      ? <span className="font-mono text-xs break-all">{status.targetUrl}</span>
                      : <span className="text-muted-foreground">{t('prototypeInfo.targetPageUnset')}</span>
                  }
                />
              )}
              <Info_Table.Row label={t('common.location')}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex-1 min-w-0 truncate font-mono text-xs">{status.dir}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleRevealFolder}
                        className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors"
                        aria-label={t('prototypeInfo.openLocation')}
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('prototypeInfo.openLocation')}</TooltipContent>
                  </Tooltip>
                </div>
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>
        </Info_Page.Content>
      )}

      <PrototypeSourceEditorDialog
        path={editing?.path ?? null}
        name={editing ? editing.name : ''}
        onClose={() => setEditing(null)}
        // The file on disk just changed, so re-read rather than trusting the
        // stale patch list — and re-apply is still the user's explicit choice.
        onSaved={() => loadStatus(true)}
      />
    </Info_Page>
  )
}

interface ArtifactRowProps {
  path: string
  /** Optional right-hand hint, e.g. which role the file plays. */
  label?: string
  onOpen: (artifact: { path: string; name: string }) => void
}

/** One prototype artifact, opened in the source editor on click. */
function ArtifactRow({ path, label, onOpen }: ArtifactRowProps) {
  const name = basename(path)
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen({ path, name })}
        className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <FileCode className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
        <span className="flex-1 min-w-0 truncate font-mono text-xs">{name}</span>
        {label && <span className="shrink-0 text-xs text-muted-foreground">{label}</span>}
      </button>
    </li>
  )
}
