/**
 * TweakView
 *
 * One tweak, laid out like the app's other info pages (Info_Page: hero, then
 * sections) — it is one more thing with a name, a state, and a few facts about
 * it, so it should not have a page of its own shape.
 *
 * The switch is the one mutation this page owns: a tweak injects into pages
 * somebody is signed in to, so running this code in them is a separate decision
 * from naming them. It sits in the hero, and the line under the name says the
 * same state in words. Those two are one control, and the line is one line
 * either way — flip the switch and nothing on the page moves.
 *
 * The details are fetched rather than read from the list atom: `targets` is
 * derived from the hit record, which moves under the page while it is open.
 */

import * as React from 'react'
import { AlertTriangle, Download, FolderOpen, Sparkles, Trash2, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { routes } from '@/lib/navigate'
import { tweaksAtom } from '@/atoms/tweaks'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Info_Alert, Info_Page, Info_Section } from '@/components/info'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { cn } from '@/lib/utils'
import type { TweakDetails, TweakRunAt } from '@craft-agent/shared/tweaks'
import { DeleteTweakDialog } from './DeleteTweakDialog'

/** The app's own translation signature, so the helpers below can take `t`. */
type Translate = (key: string, options?: Record<string, unknown>) => string

interface TweakViewProps {
  tweakSlug: string
}

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

  // The selectors the tweak needs and the last apply did not find. Only the stale ones:
  // a target that has never matched is the expected state before it has run anywhere.
  const staleTargets = details?.targets.filter(target => target.stale) ?? []

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
  /**
   * The way this tweak gets changed. Its code is written by an agent — a tweak
   * is code for a page this app does not own, so there is no form that could
   * produce it and no editor here that should. What this does is open a
   * conversation with the tweak's name already in the draft; nothing is sent,
   * so the person still says what they want changed.
   */
  const handleAskAgent = React.useCallback(() => {
    if (!details) return
    navigate(routes.action.newSession({ input: t('tweaks.askAgentChange', { name: details.name }) }))
  }, [details, navigate, t])

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
  return (
    <Info_Page
      loading={!resolved}
      empty={resolved && !details ? t('tweaks.notFound') : undefined}
    >
      <Info_Page.Header
        title={details?.name ?? ''}
        actions={details ? (
          <>
            <HeaderIconButton
              icon={<Sparkles className="h-4 w-4" />}
              tooltip={t('tweaks.askAgent')}
              onClick={handleAskAgent}
            />
            <HeaderIconButton
              icon={<Download className="h-4 w-4" />}
              tooltip={t('tweaks.exportExtension')}
              onClick={() => pickExportFolder()}
              disabled={!activeWorkspaceId}
            />
            <HeaderIconButton
              icon={<Trash2 className="h-4 w-4" />}
              tooltip={t('tweaks.deleteTweak')}
              onClick={() => setConfirmingDelete(true)}
            />
          </>
        ) : undefined}
      />

      {details && (
        <Info_Page.Content>
          {/* Hero: what it is, whether it runs, and the switch. */}
          <div className="flex items-start gap-3">
            <div className="mt-[2px] flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[4px] ring-1 ring-border/30">
              <Wand2 className="h-4 w-4 text-foreground/60" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold leading-tight text-foreground">
                {details.name}
              </h2>
              {details.description && (
                <p className="mt-0.5 text-sm leading-snug text-foreground/60">
                  {details.description}
                </p>
              )}
              {/* The switch, said in words. Always exactly one line, on or off —
                  this is the line that must never grow, or the switch moves when
                  somebody flips it. */}
              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-foreground/50">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    details.enabled ? 'bg-success' : 'bg-foreground/25',
                  )}
                />
                {statusLine(t, details)}
              </p>
            </div>
            <Switch
              className="mt-1"
              checked={details.enabled}
              disabled={!activeWorkspaceId || toggling}
              onCheckedChange={next => void handleToggle(next)}
              aria-label={t('tweaks.runLabel')}
            />
          </div>

          {/* The news, and neither piece is about the switch: nothing to inject at
              all, or a `@target` that was there last time and is not any more. */}
          {!details.hasCode && (
            <Info_Alert variant="warning" icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('tweaks.noCodeTitle')}</Info_Alert.Title>
              <Info_Alert.Description>{t('tweaks.noCodeDescription')}</Info_Alert.Description>
            </Info_Alert>
          )}
          {staleTargets.length > 0 && (
            <Info_Alert variant="warning" icon={<AlertTriangle className="h-4 w-4" />}>
              <Info_Alert.Title>{t('tweaks.pageChangedTitle')}</Info_Alert.Title>
              <Info_Alert.Description>
                <span className="flex flex-wrap items-center gap-1">
                  {staleTargets.map(target => (
                    <code
                      key={`${target.file}:${target.selector}`}
                      className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {target.selector}
                    </code>
                  ))}
                </span>
                <span className="mt-1 block">{t('tweaks.pageChangedHint')}</span>
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* Where it runs */}
          <Info_Section title={t('tweaks.matchesTitle')} description={t('tweaks.runHint')}>
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
              {details.matches.map(pattern => (
                <code
                  key={pattern}
                  className="rounded bg-foreground/5 px-1.5 py-0.5 font-mono text-[11px] text-foreground/70"
                >
                  {pattern}
                </code>
              ))}
            </div>
          </Info_Section>

          {/* What it changes, and when it does it. The files are the answer to the first
              half, and `@run-at` — which lives in the tweak's own code — to the second. The
              selectors it needs are not listed: while it is working they are all there, and
              the ones that are not are the warning above. */}
          {details.hasCode && (
            <Info_Section
              title={t('tweaks.whatItChanges')}
              actions={
                <Button size="sm" variant="ghost" onClick={handleOpenFolder}>
                  <FolderOpen /> {t('tweaks.openFolder')}
                </Button>
              }
            >
              <div className="divide-y divide-border/30">
                {/* Only the files that are there: naming one nobody wrote reads as "this
                    exists", which is the one thing a file list must not say wrongly. The
                    moment is the point of the line — code that runs too late looks like
                    broken code. */}
                {details.hasCss && <FileLine name="tweak.css" note={t('tweaks.cssTiming')} />}
                {details.hasJs && (
                  <FileLine name="tweak.js" note={t(runAtMessageKey(details.runAt))} />
                )}
              </div>
            </Info_Section>
          )}
        </Info_Page.Content>
      )}

      <DeleteTweakDialog
        tweakName={confirmingDelete ? details?.name ?? null : null}
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
    </Info_Page>
  )
}

/** One code file and the moment it runs — the whole of "what it changes". */
function FileLine({ name, note }: { name: string; note: string }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2.5">
      <code className="w-[68px] shrink-0 font-mono text-xs text-foreground/70">{name}</code>
      <span className="text-xs text-foreground/60">{note}</span>
    </div>
  )
}

/** The switch's state, in words — one line whether it is on or off. */
function statusLine(t: Translate, details: TweakDetails): string {
  if (!details.enabled) return t('tweaks.offNotice')
  if (details.appliedAt === null) return t('tweaks.notAppliedYet')
  return t('tweaks.appliedAt', { when: formatRelativeTime(details.appliedAt, t) })
}

/** `@run-at`, said the way the person looking at the page would put it. */
function runAtMessageKey(runAt: TweakRunAt): string {
  if (runAt === 'document_start') return 'tweaks.jsRunAtStart'
  if (runAt === 'document_idle') return 'tweaks.jsRunAtIdle'
  return 'tweaks.jsRunAtEnd'
}

/** Relative time, reusing the app's own phrasing (never a raw timestamp). */
function formatRelativeTime(timestamp: number, t: Translate): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return t('common.justNow')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: days })
}
