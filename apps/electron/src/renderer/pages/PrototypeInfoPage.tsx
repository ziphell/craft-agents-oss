/**
 * PrototypeInfoPage
 *
 * Workspace-prototype detail page: the workbench control plane for a single
 * prototype. Shows what the derived status report already knows (its **pages in
 * flow order**, patches by writer, per-service contract coverage, dist/,
 * ownership) and exposes the actions that mutate or re-read it: Open, Export,
 * and the page-table edits (entry, address, rename, remove).
 *
 * A prototype is a **flow** (plan §19): its pages are the thing being worked on,
 * and their order, kind and entry are the flow's shape. So the page list comes
 * first, one page is marked as what the address root opens, and everything that
 * describes the prototype as a whole (patch totals, services, the deliverable)
 * follows.
 *
 * The status is recomputed on the main side on every call — this page never
 * caches it beyond the current render, and re-reads on every `prototypes:changed`
 * broadcast (the watcher itself is owned by `usePrototypes` in AppShell).
 */

import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Download, ExternalLink, Flag, FlagOff, FlaskConical, FolderOpen, Globe, Layers, Link2, MessageSquare, Pencil, Trash2, TriangleAlert, Unlink } from 'lucide-react'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { prototypeAutoReplayAtom, setPrototypeAutoReplayAtom } from '@/atoms/prototypes'
import { Info_Page, Info_Section, Info_Table, Info_Badge, Info_Alert } from '@/components/info'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { EditTargetPageDialog } from '@/components/prototypes/EditTargetPageDialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import type { CreatedPrototype, PrototypeCommitResult, PrototypeEntry, PrototypeExportResult, PrototypePage, PrototypeStatus } from '@craft-agent/shared/prototypes'

interface PrototypeInfoPageProps {
  prototypeSlug: string
}

/**
 * The page name a reference created from an address gets.
 *
 * A reference is a prototype whose one page is the site being studied, and the
 * page has to be marked as *its* entry for `prototype-open` to have somewhere to
 * go. `entry` is the name the data layer itself gives a legacy overlay's page
 * when it promotes it to a row (plan §19.7) — an ordinary page name, not a
 * reserved one.
 */
const REFERENCE_PAGE_NAME = 'entry'

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
  /** The "add a reference" form, which is hidden until it is asked for. */
  const [referenceFormOpen, setReferenceFormOpen] = useState(false)
  const [referenceName, setReferenceName] = useState('')
  const [referenceUrl, setReferenceUrl] = useState('')
  const [linkingReference, setLinkingReference] = useState(false)
  /** The live page whose address the dialog is changing, if any. */
  const [targetPage, setTargetPage] = useState<PrototypePage | null>(null)
  /** The page the rename dialog is editing, if any. */
  const [renamePage, setRenamePage] = useState<string | null>(null)
  const [renamePageValue, setRenamePageValue] = useState('')
  /** Failure from Open or Export — both surface the throwing RPC's message verbatim. */
  const [actionError, setActionError] = useState<string | null>(null)
  /** A recording is being sampled — the import shells out to a decoder, so it takes a moment. */
  const [importingVideo, setImportingVideo] = useState(false)
  /** The delta layer is being folded — a write per scope, so it takes a moment. */
  const [committing, setCommitting] = useState(false)
  /** What the last commit did (or why it did nothing), in one line. */
  const [commitOutcome, setCommitOutcome] = useState<string | null>(null)
  /** Whether an edit under `patches/` is replayed into the open windows (§21.4). */
  const autoReplay = useAtomValue(prototypeAutoReplayAtom)
  const setAutoReplay = useSetAtom(setPrototypeAutoReplayAtom)

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

  // Conversations already bound to this prototype (any session bound to it, from
  // any entry point). `prototypeSlug` is on the persisted header, so this is a
  // pure read of what the sidebar already has.
  //
  // Declared before the open actions because opening a preview binds the window
  // to that conversation (see `openInBrowserPane`).
  const prototypeSessions = useMemo(() => {
    const result: Array<{ id: string; name: string }> = []
    for (const meta of sessionMetaMap.values()) {
      if ((meta as { prototypeSlug?: string }).prototypeSlug === prototypeSlug) {
        result.push({ id: meta.id, name: meta.name ?? meta.id })
      }
    }
    return result
  }, [sessionMetaMap, prototypeSlug])

  // Every "open this in a browser window" action is the same steps, so they share
  // one helper rather than several drifting copies.
  //
  // `injectPatches` is a live page's extra step: it is someone else's page, which
  // knows nothing about the prototype until the patches are replayed into it —
  // that replay is what turns the address into *this* prototype. A page of ours
  // arrives with its patches already inlined by the host, so it needs none.
  //
  // `prototype` is the window's **identity**: it is told, at open time, which
  // prototype it is for. Nothing else could tell it later — a live page is a
  // third-party address, so the URL stops naming the prototype the moment the
  // view loads it. This is what makes the address bar read as the prototype and
  // the two prototype actions available even when the prototype has no
  // conversation yet, which is exactly the state right after creating it.
  //
  // `bindToSessionId` is a different thing: it says which conversation owns the
  // window (the toolbar's prototype actions are resolved through it, and the
  // agent's windows are locked to their session). Only set when this prototype
  // already has a conversation — opening a preview must not create one. A
  // reference is opened with neither on purpose: it is not this prototype, so its
  // window must not behave as if it were.
  const openInBrowserPane = useCallback(async (
    url: string,
    options?: { injectPatchesFor?: string; bindToSessionId?: string; prototype?: { slug: string; origin: string } },
  ) => {
    const instanceId = await window.electronAPI.browserPane.create({
      show: true,
      ...(options?.bindToSessionId ? { bindToSessionId: options.bindToSessionId } : {}),
      ...(options?.prototype ? { prototype: options.prototype } : {}),
    })
    await window.electronAPI.browserPane.navigate(instanceId, url)
    if (options?.injectPatchesFor && workspaceId) {
      await window.electronAPI.applyPrototype(workspaceId, instanceId, options.injectPatchesFor)
    }
    await window.electronAPI.browserPane.focus(instanceId)
  }, [workspaceId])

  // Where this prototype is shown. `getPrototypeEntry` answers per the page table
  // (the entry page, or the generated page index) and throws when there is
  // nothing to open; the button is disabled in that case, so this only runs when
  // there is something.
  //
  // For a page of ours the address *is* the host's own root — the host renders
  // the entry document there with every applicable patch — while a live page
  // opens on its own address and needs the replay.
  const handleOpen = useCallback(async () => {
    if (!workspaceId) return
    setActionError(null)
    try {
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, prototypeSlug)) as PrototypeEntry
      await openInBrowserPane(entry.url, {
        ...(entry.injectPatches ? { injectPatchesFor: prototypeSlug } : {}),
        ...(prototypeSessions[0] ? { bindToSessionId: prototypeSessions[0].id } : {}),
        // `origin`, not `url`: the window's identity is the prototype itself. For a
        // live page the two differ, and only the origin survives the view
        // navigating to that page — without it the bar would read the third-party
        // address and the prototype actions would be greyed out, which is exactly
        // the case right after adding the page.
        ...(entry.origin ? { prototype: { slug: prototypeSlug, origin: entry.origin } } : {}),
      })
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open prototype:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug, openInBrowserPane, prototypeSessions])

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

  /**
   * Fold the delta layer into what owns it (plan §21.3).
   *
   * Asked for first, because it is the one action on this page with no undo: the
   * patches it folds are deleted as files, and what they changed lives on in a
   * page of ours or in a consolidated patch. The outcome is reported in one line
   * — including anything left alone, which is the only part a person has to act
   * on.
   */
  const handleCommit = useCallback(async () => {
    if (!workspaceId || !status) return
    if (!window.confirm(t('prototypeInfo.commitConfirm', { slug: status.slug }))) return

    setCommitting(true)
    setActionError(null)
    setCommitOutcome(null)
    try {
      const result = (await window.electronAPI.commitPrototype(workspaceId, status.slug)) as PrototypeCommitResult
      const folded = result.scopes.reduce((total, scope) => total + scope.folded.length + scope.promoted.length, 0)
      const refused = result.scopes.reduce((total, scope) => total + scope.refused.length, 0)
      const unverified = result.scopes.reduce((total, scope) => total + scope.unverified.length, 0)

      const parts = [
        result.nothingToCommit
          ? t('prototypeInfo.commitNothing')
          : t('prototypeInfo.commitDone', { count: folded }),
      ]
      if (refused + unverified > 0) {
        parts.push(t('prototypeInfo.commitIssues', { count: refused + unverified }))
      }
      setCommitOutcome(parts.join(' · '))
      // The patches/ directory just changed — reflect it without waiting for the
      // watcher, so the list below matches what was just reported.
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to commit prototype:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setCommitting(false)
    }
  }, [workspaceId, status, loadStatus, t])

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

  // Open a reference for study: its own entry page. No patches are injected — a
  // reference is evidence, and its own changes must not land on the page you are
  // studying.
  const handleOpenReference = useCallback(async (referenceSlug: string) => {
    if (!workspaceId) return
    setActionError(null)
    try {
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, referenceSlug)) as PrototypeEntry
      await openInBrowserPane(entry.url)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open the reference:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, openInBrowserPane])

  // Repoint one live page at the same page in another environment (plan §13.2.1).
  //
  // The dialog owns the warning and the error message; here we only write it and
  // re-read the status, because the address is on screen in the page's own row and
  // in whatever the next export writes. The page name goes along: a prototype may
  // hold several live addresses, so "which one" is part of the change.
  const handleSetTarget = useCallback(async (pageName: string, targetUrl: string) => {
    if (!workspaceId) return
    await window.electronAPI.setPrototypeTarget(workspaceId, prototypeSlug, targetUrl, pageName)
    await loadStatus(true)
    setTargetPage(null)
  }, [workspaceId, prototypeSlug, loadStatus])

  /**
   * Mark which page the address root opens — or clear it, so the root shows the
   * generated page index again (plan §19.3).
   *
   * Every edit is one call to the page table, the same data the agent reaches
   * through `prototype-entry`: the panel is a caller, not a second rule about
   * what a flow is.
   */
  /**
   * Import a recording the user made elsewhere and sample frames out of it.
   *
   * The file is chosen in the main process, so no path ever passes through this
   * page; a dismissed dialog comes back as null and is not an error. Frames land
   * in `research/frames/`, the same place a live capture writes them, which is
   * what lets a finding cite either without caring which it was (plan §20.5).
   */
  const handleImportVideo = useCallback(async () => {
    if (!workspaceId) return
    setImportingVideo(true)
    setActionError(null)
    try {
      const result = (await window.electronAPI.importPrototypeVideo(workspaceId, prototypeSlug, {
        mode: 'timeline',
        everyMs: 2000,
        maxFrames: 40,
      })) as { frames: number } | null
      // Null means the dialog was dismissed — nothing to re-read.
      if (result) await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to import the recording:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingVideo(false)
    }
  }, [workspaceId, prototypeSlug, loadStatus])

  const handleSetEntryPage = useCallback(async (pageName: string | null) => {
    if (!workspaceId) return
    setActionError(null)
    try {
      await window.electronAPI.setPrototypePages(workspaceId, prototypeSlug, { op: 'entry', name: pageName })
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to change the entry page:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug, loadStatus])

  const handleRenamePageSubmit = useCallback(async () => {
    if (!workspaceId || !renamePage) return
    const next = renamePageValue.trim()
    if (!next || next === renamePage) {
      setRenamePage(null)
      return
    }
    setActionError(null)
    try {
      // One call moves the document, its own patches and the entry flag together.
      await window.electronAPI.setPrototypePages(workspaceId, prototypeSlug, {
        op: 'rename',
        from: renamePage,
        to: next,
      })
      setRenamePage(null)
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to rename the page:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug, renamePage, renamePageValue, loadStatus])

  /**
   * Remove one page.
   *
   * What goes with it depends on what the page *is* (plan §19.2): a page of ours
   * takes its document and its own patches, while a live page exists only as a
   * row — the page itself is someone else's and is left alone. So the question
   * differs, and it is asked before anything is written.
   */
  const handleRemovePage = useCallback(async (page: PrototypePage) => {
    if (!workspaceId) return
    const confirmed = window.confirm(
      page.kind === 'overlay'
        ? t('prototypeInfo.pageRemoveConfirmOverlay', { name: page.name })
        : t('prototypeInfo.pageRemoveConfirm', { name: page.name, file: page.file ?? page.name }),
    )
    if (!confirmed) return
    setActionError(null)
    try {
      await window.electronAPI.setPrototypePages(workspaceId, prototypeSlug, { op: 'remove', name: page.name })
      await loadStatus(true)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to remove the page:', err)
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [workspaceId, prototypeSlug, loadStatus, t])

  // Add a reference: create the prototype that will hold it, give it the page
  // being studied, and link it.
  //
  // Three steps rather than one RPC, and in this order, so the page being built
  // is never the thing left half-made: if the reference's name is taken, the
  // create fails and this prototype is untouched.
  //
  // The address becomes an **overlay page** marked as that prototype's entry —
  // the kind and the entry are facts about a page now (plan §19), and a reference
  // with no entry has nothing to open.
  const handleAddReference = useCallback(async () => {
    if (!workspaceId) return
    const name = referenceName.trim()
    const url = referenceUrl.trim()
    if (!name || !url) return

    setLinkingReference(true)
    setActionError(null)
    try {
      const created = (await window.electronAPI.createPrototype(workspaceId, { name })) as CreatedPrototype
      await window.electronAPI.setPrototypePages(workspaceId, created.slug, {
        op: 'add',
        name: REFERENCE_PAGE_NAME,
        url,
      })
      await window.electronAPI.setPrototypePages(workspaceId, created.slug, {
        op: 'entry',
        name: REFERENCE_PAGE_NAME,
      })
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

  // Link a prototype that already exists. Any shape qualifies: a reference is
  // only something to look at, not about what either prototype is — so studying
  // another flow of ours is the same thing as studying someone's page.
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

  const handleRevealFolder = useCallback(async () => {
    if (!status) return
    try {
      await window.electronAPI.showInFolder(status.dir)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to reveal prototype folder:', err)
    }
  }, [status])

  const writerEntries = status ? Object.entries(status.patches.byWriter) : []

  /** The page the address root opens, as the table resolves it. */
  const entryPage = status?.pages.find((page) => page.name === status.entryPage) ?? null

  /**
   * What "Open" will actually do, in terms of the page it lands on (plan §19.3):
   * a live page opens on the real site with the patches replayed, a page of ours
   * opens the host's rendering, and with no entry the root shows the page index.
   */
  const openWillOpen = entryPage
    ? t(entryPage.kind === 'overlay'
      ? 'prototypeInfo.openWillOpenOverlay'
      : 'prototypeInfo.openWillOpenScratch', { page: entryPage.name })
    : t('prototypeInfo.openWillOpenIndex')

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
            // The tagline says where the prototype's address root lands, which is
            // the one thing about a flow that is not visible from its name.
            tagline={
              status.pages.length === 0
                ? t('prototypeInfo.heroNoPages')
                : entryPage
                  ? t('prototypeInfo.heroEntry', { page: entryPage.name })
                  : t('prototypeInfo.heroIndex')
            }
          />

          {/* Three controls: look at the prototype, go where it gets built, and
              everything else behind one menu. The nine flat buttons this replaces
              were mostly variants of "open something", and three of them appeared
              or vanished with the prototype's state — so the row reshuffled
              between prototypes and had to be re-read every time. State-dependent
              actions live in the menu now, which is a fixed list you can learn. */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 pl-1">
              <Button
                size="sm"
                onClick={() => void handleOpen()}
                // Nothing to open yet: the button would only produce an error
                // written for the agent. The alert below says what to do instead,
                // and the line under this row says where Open would land.
                disabled={!status.pageAvailable}
                title={status.pageAvailable ? undefined : t('prototypeInfo.noPageYet')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('prototypeInfo.open')}
              </Button>
              {/* Where the prototype is actually built. A bound session means every
                  command stops needing a slug. */}
              <Button size="sm" variant="outline" onClick={() => void handleOpenChat()}>
                <MessageSquare className="h-3.5 w-3.5" />
                {prototypeSessions.length > 0 ? t('prototypeInfo.openChat') : t('prototypeInfo.startChat')}
              </Button>

              {/* Export belongs in the row rather than behind a menu: with the
                  preparation actions gone there is nothing left to put in one, and
                  a menu holding a single item is just a click tax. */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleExport()}
                // Export needs what its deliverable is built from, and that is the
                // same condition as "is there a page that can be shown": our
                // documents are packaged, a live page's address is what a content
                // script is scoped to. One rule, so one field.
                disabled={exporting || !status.pageAvailable}
                title={status.pageAvailable ? undefined : t('prototypeInfo.noPageYet')}
              >
                <Download className="h-3.5 w-3.5" />
                {exporting ? t('prototypeInfo.exporting') : t('prototypeInfo.export')}
              </Button>
            </div>

            {/* What Open does, said in pages rather than in kinds: which page is
                opened, and on whose address. */}
            {status.pageAvailable && (
              <p className="pl-1 text-xs text-muted-foreground">{openWillOpen}</p>
            )}
          </div>

          {/* The gate, and it belongs above the files rather than only in the
              conversation: what still stands between this work and its handover is
              one verdict, and it is the same list the strict export refuses on and
              the status output prints. `settleBlockers` is the gate in its own
              words, carried as data so this screen cannot answer "is it done?"
              differently from the agent. */}
          {status.settleBlockers.length > 0 && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.notSettled')}</Info_Alert.Title>
              <Info_Alert.Description>
                {status.settleBlockers.map((reason) => (
                  <div key={reason} className="font-mono text-xs break-words">{reason}</div>
                ))}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* And that is the whole screen: look at it, change it, hand it over.
              Opening a browser window, studying the target page, importing
              another prototype, applying patches — every one of those is how the
              *machinery* gets what it needs, not something a user wants to say.
              They live in the conversation ("reference this page"), where the
              agent can do them and explain what it did. One button per mechanism
              is what made this page unreadable. */}


          {/* No page to look at — say what to do about it, and say the right thing:
              a flow with no pages needs its first one, while a flow whose page
              cannot be opened says so in the page issues below. */}
          {!status.pageAvailable && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.noPageYet')}</Info_Alert.Title>
              <Info_Alert.Description>
                {status.pages.length === 0
                  ? t('prototypeInfo.noPageYetHint')
                  : t('prototypeInfo.noPageYetHintUnopenable')}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {exportResult && (
            <Info_Alert variant="success">
              <Info_Alert.Title>
                {t('prototypeInfo.exportSuccess', { applied: exportResult.applied })}
              </Info_Alert.Title>
              <Info_Alert.Description>
                {/* The deliverables and the spec: the extension is the carrier for
                    the live pages and the pages of ours alike, `static/` is the pages
                    of ours as files that need nothing to be looked at, the
                    bookmarklet is the live pages without an extension at all, and
                    the spec sits next to them for whoever implements the change. */}
                {/* The handoff first: it is the index of the rest, and the file a recipient
                    should open before any of them (plan §17 / §20.8). */}
                {[exportResult.handoffPath, exportResult.specPath, exportResult.extensionDir, exportResult.staticPath, exportResult.bookmarkletPath]
                  .filter((file): file is string => Boolean(file))
                  .map((file) => (
                    <div key={file} className="font-mono text-xs break-all">{file}</div>
                  ))}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* What the package could not carry. Named rather than counted, because
              each line is a decision about the deliverable — a document the
              extension had to rewrite, a reference a single static file has no way
              to resolve — and silence here reads as "the deliverable is complete". */}
          {exportResult && [...exportResult.warnings, ...exportResult.staticWarnings].length > 0 && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.exportWarnings')}</Info_Alert.Title>
              <Info_Alert.Description>
                {[...exportResult.warnings, ...exportResult.staticWarnings].map((warning) => (
                  <div key={warning} className="font-mono text-xs break-words">{warning}</div>
                ))}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {actionError && (
            <Info_Alert variant="error" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.actionFailed')}</Info_Alert.Title>
              <Info_Alert.Description>{actionError}</Info_Alert.Description>
            </Info_Alert>
          )}

          {/* Requirements — what the work is *for*, before how it is done. The
              second line is derived from `@requirement R-00x` markers in patch
              headers and page documents, so a row without one is a requirement
              this prototype does not implement (plan §20.1). Findings are shown
              as evidence, never as implementation: "argued for, never built" must
              not read as done. */}
          <Info_Section
            title={t('prototypeInfo.requirements')}
            description={t('prototypeInfo.requirementsHint')}
          >
            {status.requirements.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.requirementsEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.requirements.map((requirement) => {
                  const covered = [
                    ...requirement.pages,
                    ...requirement.patches,
                    ...requirement.findings.map((id) => `${id} (${t('prototypeInfo.findingsShort')})`),
                  ]
                  return (
                    <li key={requirement.id} className="flex items-start gap-3 px-4 py-2">
                      <span className="shrink-0 pt-0.5 font-mono text-xs text-foreground/70">
                        {requirement.id}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">
                          {requirement.title || t('prototypeInfo.requirementUntitled')}
                        </div>
                        <div className="mt-0.5 font-mono text-xs break-words text-foreground/60">
                          {covered.length > 0
                            ? covered.join(', ')
                            : t('prototypeInfo.requirementUncovered')}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Info_Section>

          {/* The argument against the work (plan §3.7), right after what the work
              is for. `unresolved` is every dispute that still stands — open, or a
              record that disagrees with the patches it names — so a stale argument
              is visible as stale rather than as settled. */}
          <Info_Section
            title={t('prototypeInfo.reviews')}
            description={t('prototypeInfo.reviewsHint')}
          >
            {status.reviews.unresolved.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {status.reviews.total === 0
                  ? t('prototypeInfo.reviewsEmpty')
                  : t('prototypeInfo.reviewsSettled', { count: status.reviews.total })}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.reviews.unresolved.map((dispute) => (
                  <li key={dispute.id} className="flex items-start gap-3 px-4 py-2">
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-foreground/70">
                      {dispute.id}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{dispute.claim ?? t('prototypeInfo.reviewNoClaim')}</div>
                      <div className="mt-0.5 font-mono text-xs break-words text-foreground/60">
                        {[dispute.file, dispute.about, dispute.status, dispute.stale ? t('prototypeInfo.reviewStale') : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                      {dispute.stale && dispute.staleReason && (
                        <div className="mt-0.5 text-xs text-foreground/60">{dispute.staleReason}</div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* What the checks in the PRD answered last time (plan §20.7). A fact
              about a run, not about the prototype: nothing here changes a page, and
              what a red check means for the delivery is the reader's call. */}
          <Info_Section
            title={t('prototypeInfo.acceptance')}
            description={t('prototypeInfo.acceptanceHint')}
          >
            {status.acceptance === null ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.acceptanceNeverRun')}
              </div>
            ) : (
              <>
                <Info_Table>
                  <Info_Table.Row
                    label={t('prototypeInfo.acceptanceRound')}
                    value={String(status.acceptance.round)}
                  />
                  <Info_Table.Row
                    label={t('prototypeInfo.acceptancePassed')}
                    value={String(status.acceptance.passed)}
                  />
                  <Info_Table.Row
                    label={t('prototypeInfo.acceptanceFailed')}
                    value={String(status.acceptance.failed)}
                  />
                  <Info_Table.Row
                    label={t('prototypeInfo.acceptanceSkipped')}
                    value={String(status.acceptance.skipped)}
                  />
                </Info_Table>
                {/* The red ones by name: a count nobody can act on is the shape of
                    report this page exists to avoid. */}
                {status.acceptance.red.length > 0 && (
                  <ul className="divide-y divide-border/30 border-t border-border/40">
                    {status.acceptance.red.map((check) => (
                      <li key={check} className="px-4 py-2 font-mono text-xs break-all text-destructive">
                        {check}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Info_Section>

          {/* Research — what was learned about other products. Source and
              requirements are the two edges that make a finding more than a
              bookmark, and neither ships with the delivery (plan §20.2). */}
          <Info_Section title={t('prototypeInfo.research')} description={t('prototypeInfo.researchHint')}>
            {status.findings.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.researchEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.findings.map((finding) => (
                  <li key={finding.id} className="flex items-start gap-3 px-4 py-2">
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-foreground/70">
                      {finding.id}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{finding.claim ?? t('prototypeInfo.findingNoClaim')}</div>
                      <div className="mt-0.5 font-mono text-xs break-words text-foreground/60">
                        {finding.source ?? finding.file}
                        {finding.requirements.length > 0
                          ? ` · ${t('prototypeInfo.findingArguesFor')} ${finding.requirements.join(', ')}`
                          : ''}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* Frame captures — the pictures a finding cites (plan §20.3). Listed
              rather than previewed: the frames are for the model, and the panel's
              job is to say that a capture exists, how big it is, and whether it
              is a sample of the session or all of it. */}
          <Info_Section title={t('prototypeInfo.frames')} description={t('prototypeInfo.framesHint')}>
            {/* A recording made elsewhere is the other way frames arrive, and the
                same evidence once they are here. The picker is the main process's,
                so this button only ever asks for the work. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border/30 px-4 py-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleImportVideo()}
                disabled={importingVideo}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {importingVideo ? t('prototypeInfo.importingVideo') : t('prototypeInfo.importVideo')}
              </Button>
              <span className="text-xs text-muted-foreground">{t('prototypeInfo.importVideoHint')}</span>
            </div>
            {status.frameCaptures.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.framesEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.frameCaptures.map((capture) => (
                  <li key={capture.session} className="flex items-center gap-3 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{capture.session}</span>
                        {capture.truncated && (
                          <Info_Badge color="muted" className="!py-0.5 !pl-1.5 !pr-2 !text-[10px]">
                            {t('prototypeInfo.frameTruncated')}
                          </Info_Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-xs text-foreground/60">{capture.file}</div>
                    </div>
                    <span className="shrink-0 text-xs text-foreground/60">
                      {t('prototypeInfo.frameCount', { count: capture.frames })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* The silent failures of the layer above — a requirement nothing
              implements, a marker naming an id the PRD does not define, a finding
              with no claim or with evidence that is not there (plan §20.1/§20.2).
              Same shape as the page issues, because they are the same kind of fact. */}
          {status.briefIssues.length > 0 && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.briefIssues')}</Info_Alert.Title>
              <Info_Alert.Description>
                {status.briefIssues.map((issue) => (
                  <div key={issue} className="font-mono text-xs break-words">{issue}</div>
                ))}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* Pages — the flow itself, in order. A page is either a document of
              ours (its file is the page) or a live address, and one row carries
              the entry: that flag is what `/` opens, and no row carrying it means
              `/` shows the generated index (plan §19.3). */}
          <Info_Section
            title={t('prototypeInfo.pages')}
            description={status.pages.length > 0
              ? entryPage
                ? t('prototypeInfo.pageEntryIs', { page: entryPage.name })
                : t('prototypeInfo.pageIndexAtRoot')
              : undefined}
          >
            {status.pages.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.pagesEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.pages.map((page) => (
                  <li key={page.name} className="flex items-center gap-2 px-4 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{page.name}</span>
                        <Info_Badge color="muted" className="!py-0.5 !pl-1.5 !pr-2 !text-[10px]">
                          {page.kind === 'overlay'
                            ? t('prototypePage.kindOverlayShort')
                            : t('prototypePage.kindScratchShort')}
                        </Info_Badge>
                        {page.entry && (
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-accent">
                            {t('prototypeInfo.pageEntry')}
                          </span>
                        )}
                      </div>
                      {/* Where the page lives: the document for a page of ours
                          (the name *is* the file), its address for a live one. */}
                      <div className="truncate font-mono text-xs text-foreground/60">
                        {page.kind === 'overlay'
                          ? page.url ?? t('prototypeInfo.pageNoAddress')
                          : page.file ?? t('prototypeInfo.pageDocumentGone')}
                      </div>
                    </div>

                    {/* A live page's address is the page, so it is editable in
                        place — the same page exists in several environments and
                        switching between them is an ordinary edit (plan §13.2.1). */}
                    {page.kind === 'overlay' && page.url && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setTargetPage(page)}
                            className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors"
                            aria-label={t('prototypeInfo.editPageAddress')}
                          >
                            <Globe className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t('prototypeInfo.editPageAddress')}</TooltipContent>
                      </Tooltip>
                    )}

                    {/* The entry is a mark on a row, so setting it is a click on
                        the row that should carry it — and clearing it puts the
                        index back at the root. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => void handleSetEntryPage(page.entry ? null : page.name)}
                          className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors"
                          aria-label={page.entry ? t('prototypeInfo.pageEntryClear') : t('prototypeInfo.pageSetEntry')}
                        >
                          {page.entry ? <FlagOff className="h-3.5 w-3.5" /> : <Flag className="h-3.5 w-3.5" />}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {page.entry ? t('prototypeInfo.pageEntryClear') : t('prototypeInfo.pageSetEntry')}
                      </TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamePageValue(page.name)
                            setRenamePage(page.name)
                          }}
                          className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/5 transition-colors"
                          aria-label={t('prototypeInfo.renamePage')}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t('prototypeInfo.renamePage')}</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => void handleRemovePage(page)}
                          className="shrink-0 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
                          aria-label={t('prototypeInfo.removePage')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{t('prototypeInfo.removePage')}</TooltipContent>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </Info_Section>

          {/* Everything worth saying out loud about the page table, when there is
              anything: a row that cannot be read, a declared page whose document
              is gone, or a `patches/<page>/` that matches no page — each of them a
              silent failure otherwise (plan §19.4/§19.8). */}
          {status.pageIssues.length > 0 && (
            <Info_Section
              title={t('prototypeInfo.pageIssues')}
              description={t('prototypeInfo.pageIssuesHint')}
            >
              <ul className="divide-y divide-border/30 bg-destructive/5">
                {status.pageIssues.map((issue) => (
                  <li key={issue} className="px-4 py-2 text-xs text-destructive break-words">
                    {issue}
                  </li>
                ))}
              </ul>
            </Info_Section>
          )}

          {/* References — the prototypes this one is studied from. Each stays a
              separate prototype, which is what keeps its patches out of this
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
                        {/* What a reference *is* is its flow, so say which of its
                            pages would open rather than reporting a missing URL. */}
                        <div className="truncate font-mono text-xs text-foreground/60">
                          {reference?.entryPage
                            ? t('prototypeInfo.referenceEntry', { page: reference.entryPage })
                            : t('prototypeInfo.referenceNoPages')}
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
                        disabled={!referenceName.trim() || !referenceUrl.trim() || linkingReference}
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

          {/* Patches — the changes, what each is aimed at, and the two controls a
              reader of them needs: whether an edit is replayed into the open
              windows (§21.4), and the action that folds the layer into what owns
              it (§21.3). */}
          <Info_Section title={t('prototypeInfo.patches')}>
            <Info_Table>
              <Info_Table.Row label={t('prototypeInfo.patchTotal')} value={String(status.patches.total)} />
              {writerEntries.map(([writer, count]) => (
                <Info_Table.Row
                  key={writer}
                  label={writer}
                  value={String(count)}
                />
              ))}
            </Info_Table>

            {/* One row per patch, with the markers its header declares: the page it
                belongs to and the selectors it is aimed at. A row with no selector
                is the fact worth seeing — nothing checks what that patch matched. */}
            {status.patches.entries.length > 0 && (
              <ul className="divide-y divide-border/30 border-t border-border/40">
                {status.patches.entries.map((entry) => (
                  <li key={entry.file} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2">
                    <span className="font-mono text-xs break-all">{entry.file}</span>
                    <span className="flex flex-wrap items-center justify-end gap-2">
                      <span className="text-xs text-muted-foreground">
                        {entry.page ?? t('prototypeInfo.patchShared')}
                      </span>
                      {entry.targets.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        entry.targets.map((target) => (
                          <code key={target} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                            {target}
                          </code>
                        ))
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-4 py-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoReplay}
                  onChange={(event) => setAutoReplay(event.target.checked)}
                />
                {t('prototypeInfo.autoReplay')}
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleCommit()}
                disabled={committing || status.patches.total === 0}
                title={t('prototypeInfo.commitHint')}
              >
                <Layers className="h-3.5 w-3.5" />
                {t('prototypeInfo.commit')}
              </Button>
            </div>
            <p className="px-4 pb-3 text-xs text-muted-foreground">{t('prototypeInfo.autoReplayHint')}</p>
            {commitOutcome && <p className="px-4 pb-3 text-xs text-muted-foreground">{commitOutcome}</p>}
          </Info_Section>

          {/* Anchors — what each declared @target matched, and when (plan §21.2).
              This is what makes a selector's health a fact rather than a guess: an
              anchor whose last match is in the past is a page that moved, and the
              patch itself looks exactly like one that works. */}
          <Info_Section title={t('prototypeInfo.anchors')}>
            {status.anchors.files.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">{t('prototypeInfo.anchorsEmpty')}</div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.anchors.files.map((file) => (
                  <li key={file.page ?? 'shared'} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                      {file.page ?? t('prototypeInfo.patchShared')}
                      {file.url && (
                        <span className="font-mono text-xs font-normal text-muted-foreground">{file.url}</span>
                      )}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {file.anchors.map((anchor) => (
                        <li
                          key={anchor.target}
                          className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs"
                        >
                          <code className="font-mono break-all">{anchor.target}</code>
                          <span className={anchor.matched > 0 ? 'text-muted-foreground' : 'text-destructive'}>
                            {anchor.matched > 0
                              ? t('prototypeInfo.anchorMatched', { count: anchor.matched })
                              : t('prototypeInfo.anchorMissing', {
                                  date: anchor.lastMatchedAt.slice(0, 10) || '—',
                                })}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {status.anchors.issues.length > 0 && (
              <ul className="space-y-0.5 border-t border-border/40 px-4 py-3">
                {status.anchors.issues.map((issue) => (
                  <li key={issue} className="text-xs text-destructive">
                    {issue}
                  </li>
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
                      {/* Only when there is something to say: "keeps state: 0" would read like a
                          count of something missing, while the fact worth having is that a screen
                          depends on what the last request did (plan §5.3). */}
                      {service.statefulEndpoints > 0 && (
                        <span className="text-foreground/80">
                          {t('prototypeInfo.statefulEndpoints')}: {service.statefulEndpoints}
                        </span>
                      )}
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

          {/* Ownership — write violations are the loud part; silence means clean */}
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

          {/* Metadata read-out for quick reference. What the flow *is* — its pages,
          their order and its entry — is in the Pages section rather than here, so
          this stays what it says: where the prototype lives. */}
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

      {/* Only a live page has an address, so only one of those can be repointed.
          The dialog is mounted here rather than inside the content block so it
          survives the status re-read that follows a save. */}
      {targetPage && (
        <EditTargetPageDialog
          open={targetPage !== null}
          slug={prototypeSlug}
          page={targetPage.name}
          currentUrl={targetPage.url ?? ''}
          onCancel={() => setTargetPage(null)}
          onSubmit={(url) => handleSetTarget(targetPage.name, url)}
        />
      )}

      {/* Renaming a page renames its document and its own patches with it, so the
          name is asked for in one place instead of being typed into a file. */}
      <RenameDialog
        open={renamePage !== null}
        onOpenChange={(open) => {
          if (!open) setRenamePage(null)
        }}
        title={t('prototypeInfo.pageRenamePrompt', { name: renamePage ?? '' })}
        value={renamePageValue}
        onValueChange={setRenamePageValue}
        onSubmit={() => void handleRenamePageSubmit()}
      />
    </Info_Page>
  )
}

