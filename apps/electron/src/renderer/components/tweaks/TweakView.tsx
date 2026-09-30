import * as React from 'react'
import { AlertTriangle, ArrowLeft, Download, FolderOpen, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { tweaksAtom } from '@/atoms/tweaks'
import { Switch } from '@/components/ui/switch'
import { LoadingIndicator } from '@craft-agent/ui'
import { Info_Alert } from '@/components/info'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { cn } from '@/lib/utils'
import type { TweakDetails } from '@craft-agent/shared/tweaks'
import { DeleteTweakDialog } from './DeleteTweakDialog'

interface TweakViewProps {
  tweakSlug: string
}

/**
 * One tweak — chiefly, the switch.
 *
 * A tweak injects into pages somebody is signed in to, so naming those pages (`matches`)
 * is not the same consent as agreeing to run this code in them: that is this page's
 * switch, and it is the one mutation a person owns here. Everything else is a read — the
 * code is written by an agent, and the file column below is what points at it.
 *
 * The details are fetched rather than read from the list atom: the targets table is
 * derived from the hit record, which moves under the page while it is open.
 */
export function TweakView({ tweakSlug }: TweakViewProps) {
  const { activeWorkspaceId, onOpenFile } = useAppShellContext()
  const { t } = useTranslation()
  const { navigate } = useNavigation()

  const [state, setState] = React.useState<{ slug: string; loaded: boolean; details: TweakDetails | null }>({
    slug: tweakSlug,
    loaded: false,
    details: null,
  })

  // The list atom's stamp for this tweak: `updatedAt` moves on every write, including the
  // agent's own, so it is what tells this page the record changed under it.
  const tweaks = useAtomValue(tweaksAtom)
  const detailsStamp = React.useMemo(
    () => tweaks.find(candidate => candidate.slug === tweakSlug)?.updatedAt ?? 0,
    [tweaks, tweakSlug],
  )

  // Re-read on a slug change and whenever `tweak.json` is stamped.
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    let stale = false
    window.electronAPI
      .getTweak(activeWorkspaceId, tweakSlug)
      .then(found => { if (!stale) setState({ slug: tweakSlug, loaded: true, details: found }) })
      .catch(() => { if (!stale) setState({ slug: tweakSlug, loaded: true, details: null }) })
    return () => { stale = true }
  }, [activeWorkspaceId, tweakSlug, detailsStamp])

  const resolved = state.slug === tweakSlug && state.loaded
  const details = resolved ? state.details : null

  const [toggling, setToggling] = React.useState(false)
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)

  // ------------------------------------------------------------------
  // The switch
  // ------------------------------------------------------------------
  const handleToggle = React.useCallback(async (next: boolean) => {
    if (!activeWorkspaceId || !details || toggling) return
    setToggling(true)
    try {
      const updated = await window.electronAPI.updateTweak(activeWorkspaceId, details.slug, { enabled: next })
      if (updated) setState({ slug: tweakSlug, loaded: true, details: updated })
    } catch (err) {
      toast.error(t('toast.tweakUpdateFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setToggling(false)
    }
  }, [activeWorkspaceId, details, toggling, tweakSlug, t])

  // ------------------------------------------------------------------
  // Export — the same folder picker an export uses
  // ------------------------------------------------------------------
  const exportTo = React.useCallback(async (destParent: string) => {
    if (!activeWorkspaceId || !details) return
    try {
      const result = await window.electronAPI.exportTweaks(activeWorkspaceId, destParent)
      toast.success(t('toast.tweakExported', { files: result.files }), { description: result.dir })
    } catch (err) {
      toast.error(t('toast.tweakExportFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, details, t])

  const onExportFolderPicked = React.useCallback(
    (destParent: string) => void exportTo(destParent),
    [exportTo],
  )

  const {
    pickDirectory: pickExportFolder,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(onExportFolderPicked)

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  const handleBack = React.useCallback(() => navigate(routes.view.tweaks()), [navigate])

  const handleOpenFolder = React.useCallback(() => {
    if (details) onOpenFile(details.folderPath)
  }, [details, onOpenFile])

  const handleConfirmDelete = React.useCallback(async () => {
    if (!activeWorkspaceId || !details) return
    setConfirmingDelete(false)
    try {
      await window.electronAPI.deleteTweak(activeWorkspaceId, details.slug)
      toast.success(t('toast.tweakDeleted', { name: details.name }))
      navigate(routes.view.tweaks())
    } catch (err) {
      toast.error(t('toast.tweakDeleteFailed'), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [activeWorkspaceId, details, t, navigate])

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (!details) {
    return (
      <div className="flex h-full items-center justify-center">
        {resolved ? (
          <div className="flex flex-col items-center gap-3 text-sm text-foreground/50">
            <span>{t('tweaks.notFound')}</span>
            <button
              onClick={handleBack}
              className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {t('tweaks.backToTweaks')}
            </button>
          </div>
        ) : (
          <LoadingIndicator label={t('common.loading')} />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header: back, name, state, actions */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t('tweaks.backToTweaks')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 truncate text-sm font-medium">{details.name}</span>
        <span className={cn(
          'shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium',
          details.enabled ? 'bg-success/10 text-success' : 'bg-foreground/[0.05] text-foreground/50',
        )}>
          {details.enabled ? t('tweaks.on') : t('tweaks.off')}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => pickExportFolder()}
            disabled={!activeWorkspaceId}
            className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-2.5 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05] disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" /> {t('tweaks.exportExtension')}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={t('tweaks.deleteTweak')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 p-5">
          {/* Plainly, at the top: nothing to inject, or off. */}
          {!details.hasCode && (
            <Info_Alert variant="warning" inline icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('tweaks.noCodeTitle')}</Info_Alert.Title>
              <Info_Alert.Description className="text-foreground/60">
                {t('tweaks.noCodeDescription')}
              </Info_Alert.Description>
            </Info_Alert>
          )}
          {!details.enabled && (
            <Info_Alert variant="info" inline>
              <Info_Alert.Title>{t('tweaks.offNotice')}</Info_Alert.Title>
            </Info_Alert>
          )}

          {/* The switch — the one thing this page is for */}
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 p-4">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('tweaks.runLabel')}</div>
              <p className="mt-1 text-xs text-foreground/50">{t('tweaks.runHint')}</p>
            </div>
            <Switch
              checked={details.enabled}
              disabled={!activeWorkspaceId || toggling}
              onCheckedChange={next => void handleToggle(next)}
              aria-label={t('tweaks.runLabel')}
            />
          </div>

          {/* Where it runs */}
          <section>
            <h3 className="text-[13px] font-medium">{t('tweaks.matchesTitle')}</h3>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {details.matches.map(pattern => (
                <code
                  key={pattern}
                  className="rounded bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-foreground/60"
                >
                  {pattern}
                </code>
              ))}
            </div>
          </section>

          {/* The code: paths, and a way to open the folder — never an editor */}
          <section>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-medium">{t('tweaks.filesTitle')}</h3>
              <button
                type="button"
                onClick={handleOpenFolder}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-foreground/[0.02] px-2.5 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.05]"
              >
                <FolderOpen className="h-3.5 w-3.5" /> {t('tweaks.openFolder')}
              </button>
            </div>
            <div className="mt-2 space-y-1">
              {/* Only the files that are there: a path beside a file nobody wrote reads as
                  "this exists", which is the one thing a file list must not say wrongly. */}
              {[
                ...(details.hasCss ? [{ name: 'tweak.css', path: details.cssPath }] : []),
                ...(details.hasJs ? [{ name: 'tweak.js', path: details.jsPath }] : []),
              ].map(file => (
                <div key={file.name} className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-foreground/60">{file.name}</span>
                  <span className="truncate font-mono text-[11px] text-foreground/40" title={file.path}>
                    {file.path}
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* What it expects to find, and what happened to each selector */}
          <section>
            <h3 className="text-[13px] font-medium">{t('tweaks.targetsTitle')}</h3>
            <p className="mt-1 text-xs text-foreground/50">
              {details.appliedAt === null
                ? t('tweaks.notAppliedYet')
                : t('tweaks.appliedAt', { when: formatRelativeTime(details.appliedAt, t) })}
            </p>
            {details.targets.length === 0 ? (
              <p className="mt-2 text-xs text-foreground/50">{t('tweaks.targetsEmpty')}</p>
            ) : (
              <table className="mt-2 w-full border-collapse text-left">
                <thead>
                  <tr className="text-[11px] text-foreground/40">
                    <th className="py-1 pr-3 font-medium">{t('tweaks.targetColumnSelector')}</th>
                    <th className="py-1 pr-3 font-medium">{t('tweaks.targetColumnFile')}</th>
                    <th className="py-1 font-medium">{t('tweaks.targetColumnMatched')}</th>
                  </tr>
                </thead>
                <tbody>
                  {details.targets.map(target => (
                    <tr key={`${target.file}:${target.selector}`} className="border-t border-border/40">
                      <td className="py-1.5 pr-3">
                        <code className="font-mono text-[11px] text-foreground/80">{target.selector}</code>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[11px] text-foreground/50">{target.file}</td>
                      <td className="py-1.5 text-[11px]">
                        {target.lastMatchedAt === undefined ? (
                          <span className="text-foreground/40">{t('tweaks.neverMatched')}</span>
                        ) : target.stale ? (
                          <span className="text-destructive">
                            {t('tweaks.stoppedMatching')} · {t('tweaks.matchedAt', { when: formatRelativeTime(target.lastMatchedAt, t) })}
                          </span>
                        ) : (
                          <span className="text-foreground/60">
                            {t('tweaks.matchedAt', { when: formatRelativeTime(target.lastMatchedAt, t) })}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>

      <DeleteTweakDialog
        tweakName={confirmingDelete ? details.name : null}
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
      {activeWorkspaceId && (
        <ServerDirectoryBrowser
          open={showServerBrowser}
          mode={serverBrowserMode}
          onSelect={confirmServerBrowser}
          onCancel={cancelServerBrowser}
        />
      )}
    </div>
  )
}

/** Relative time, reusing the app's own phrasing (never a raw timestamp). */
function formatRelativeTime(timestamp: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return t('common.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: days })
}
