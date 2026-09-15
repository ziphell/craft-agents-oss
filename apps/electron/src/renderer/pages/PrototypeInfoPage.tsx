/**
 * PrototypeInfoPage
 *
 * Workspace-prototype detail page: the workbench control plane for a single
 * prototype project. Shows what the derived status report already knows
 * (base.html, patches by lane, per-service contract coverage, dist/, ownership)
 * and exposes the three actions that mutate or re-read it: Open, Export, Refresh.
 *
 * The status is recomputed on the main side on every call — this page never
 * caches it beyond the current render, and re-reads on every `prototypes:changed`
 * broadcast (the watcher itself is owned by `usePrototypes` in AppShell).
 */

import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { Camera, Download, ExternalLink, FileCode, FlaskConical, FolderOpen, RefreshCw, TriangleAlert, Zap } from 'lucide-react'
import { toast } from 'sonner'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { activeBrowserInstanceIdAtom } from '@/atoms/browser-pane'
import { Info_Page, Info_Section, Info_Table, Info_Alert } from '@/components/info'
import { Button } from '@/components/ui/button'
import { PrototypeSourceEditorDialog } from '@/components/prototypes/PrototypeSourceEditorDialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import type { PrototypeEntry, PrototypeExportResult, PrototypeStatus } from '@craft-agent/shared/prototypes'

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

  const [status, setStatus] = useState<PrototypeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<PrototypeExportResult | null>(null)
  const [applying, setApplying] = useState(false)
  const [capturing, setCapturing] = useState(false)
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

  // Open the prototype in a browser pane. Prefers the exported deliverable,
  // else base.html — `getPrototypeEntry` throws when neither exists.
  const handleOpen = useCallback(async () => {
    if (!workspaceId) return
    setActionError(null)
    try {
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, prototypeSlug)) as PrototypeEntry
      const instanceId = await window.electronAPI.browserPane.create({ show: true })
      await window.electronAPI.browserPane.navigate(instanceId, entry.url)
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open prototype:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug])

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
  const handleApply = useCallback(async () => {
    if (!workspaceId || !activeBrowserInstanceId) return
    setApplying(true)
    setActionError(null)
    try {
      const result = (await window.electronAPI.applyPrototype(
        workspaceId,
        activeBrowserInstanceId,
        prototypeSlug,
      )) as { applied: number }
      toast.success(t('prototypeInfo.applySuccess', { applied: result.applied }))
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to apply patches:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }, [workspaceId, activeBrowserInstanceId, prototypeSlug, t])

  // Store the rendered page as base.html. Goes through the browser, so it works
  // for client-rendered apps and authenticated sessions where a fetch would not.
  const handleCapture = useCallback(async () => {
    if (!workspaceId || !activeBrowserInstanceId) return
    setCapturing(true)
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
            tagline={status.dir}
          />

          {/* Actions — Apply and Capture act on the browser window the user is viewing */}
          <div className="flex flex-wrap items-center gap-2 pl-1">
            <Button size="sm" variant="outline" onClick={handleApply} disabled={applying || !activeBrowserInstanceId}>
              <Zap className="h-3.5 w-3.5" />
              {applying ? t('prototypeInfo.applying') : t('prototypeInfo.apply')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleCapture} disabled={capturing || !activeBrowserInstanceId}>
              <Camera className="h-3.5 w-3.5" />
              {capturing ? t('prototypeInfo.capturing') : t('prototypeInfo.captureBase')}
            </Button>
            <Button size="sm" onClick={handleOpen}>
              <ExternalLink className="h-3.5 w-3.5" />
              {t('prototypeInfo.open')}
            </Button>
            <Button size="sm" variant="outline" onClick={handleExport} disabled={exporting}>
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

          {/* base.html is the precondition for export — say so loudly. */}
          {!status.baseHtmlPresent && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.baseHtmlMissing')}</Info_Alert.Title>
              <Info_Alert.Description>
                {t('prototypeInfo.baseHtmlMissingHint')}
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
