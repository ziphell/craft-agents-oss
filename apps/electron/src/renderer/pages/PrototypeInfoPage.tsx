/**
 * PrototypeInfoPage
 *
 * Workspace-prototype detail page: the workbench control plane for a single
 * prototype. It is read in three moments, and the screen is arranged by them
 * rather than by where each fact comes from:
 *
 * 1. **Handing over** — can this go out, and what stands in the way? Both live on
 *    the header's **Delivery** button: the badge beside it is the verdict at a
 *    glance, and opening it gives every outstanding thing in the reader's language
 *    (each with a way to where it is settled), the last export's files, and the
 *    export itself. It is a button rather than the page's first section because
 *    handing work over is a verdict and a package, not a block of prose to read
 *    before the work (plan §19.9, revised).
 * 2. **The work itself**, in this order: the **flow** (the page index — one row per
 *    page: kind, entry, how many changes belong to it, whether its selectors still
 *    match, and everything you can do to it — then the page table's own problems),
 *    then the **requirements** and the **research** behind them.
 * 3. **Looking into the machinery** — the change list, anchors, service coverage,
 *    ownership — is not here at all: it is the agent's report (`prototype_tool status`),
 *    and appears only where a person acts on it, in the Delivery card's gate.
 *
 * What is deliberately **not** here: objections and the last verification round. Both
 * are what one round produced and both are settled in the conversation, so the page
 * only carries them where they block the handover — in the gate, with "hand it to the
 * conversation" as their entry (plan §19.10, revised).
 *
 * Each section costs one line while it is empty, so an untouched prototype is a
 * short screen instead of fourteen sections of "nothing here yet".
 *
 * A prototype is a **flow** (plan §19): its pages are the thing being worked on,
 * and their order, kind and entry are the flow's shape. The page index is also the
 * **only** place a page's facts and actions appear (see `PrototypesListPanel`):
 * a page is looked at in the workspace's browser window, so what a page *is* is
 * read here, beside the flow it belongs to.
 *
 * What the report says about the prototype travels as **notices**
 * (`notices.ts`): `code` + `params` are rendered in the reader's language, and the
 * sentence the agent prints is kept beside it — in full where a person hands work
 * over, as the tooltip where a diagnostic is being read.
 *
 * The status is recomputed on the main side on every call — this page never
 * caches it beyond the current render, and re-reads on every `prototypes:changed`
 * broadcast (the watcher itself is owned by `usePrototypes` in AppShell).
 */

import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronRight, Download, ExternalLink, File, Flag, FlagOff, FlaskConical, FolderOpen, Globe, MessageSquare, MoreHorizontal, PackageCheck, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { usePrototypeAskAgent } from '@/hooks/usePrototypeAskAgent'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { Info_Page, Info_Section, Info_Badge, Info_Alert, Info_Markdown } from '@/components/info'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RenameDialog } from '@/components/ui/rename-dialog'
import { EditTargetPageDialog } from '@/components/prototypes/EditTargetPageDialog'
import {
  CreatePageDialog,
  buildNewPageDocument,
  pageDocumentPath,
  type CreatePageValues,
} from '@/components/prototypes/CreatePageDialog'
import type { PrototypeEntry, PrototypeExportResult, PrototypeNoticeCode, PrototypePage, PrototypeStatus } from '@craft-agent/shared/prototypes'

interface PrototypeInfoPageProps {
  prototypeSlug: string
}

/**
 * What a blocker's action is — where that thing actually gets settled.
 *
 * Two kinds, and the difference is not cosmetic. A page problem or an unmet requirement
 * is settled **on this page**: the page index and the requirements section hold what it
 * names, so the action jumps there. An objection and a verification are settled **in the
 * conversation** — somebody has to answer the objection, a round has to be run — so their
 * action is an entry: the sentence goes into the draft (`usePrototypeAskAgent`). A jump
 * button for those two would have been a door into an empty room; the sections that used
 * to hold them were removed for exactly that reason.
 *
 * The mapping lives on this side on purpose: a notice describes the prototype
 * (`notices.ts`), and which screen settles it is not the prototype's business.
 */
type BlockerAction =
  | { kind: 'section'; id: string; titleKey: string }
  | { kind: 'conversation' }

const BLOCKER_ACTIONS: Partial<Record<PrototypeNoticeCode, BlockerAction>> = {
  'page.documentMissing': { kind: 'section', id: 'pages', titleKey: 'prototypeInfo.pages' },
  'page.patchScopeUnmatched': { kind: 'section', id: 'pages', titleKey: 'prototypeInfo.pages' },
  'requirement.unimplemented': { kind: 'section', id: 'requirements', titleKey: 'prototypeInfo.requirements' },
  'requirement.undefined': { kind: 'section', id: 'requirements', titleKey: 'prototypeInfo.requirements' },
  'gate.requirementUnmet': { kind: 'section', id: 'requirements', titleKey: 'prototypeInfo.requirements' },
  'gate.disputeStanding': { kind: 'conversation' },
  'gate.checkFailed': { kind: 'conversation' },
  'gate.checksNeverRun': { kind: 'conversation' },
  // A response the contract names but nobody wrote is a hole in the delivery, and where it gets
  // filled is the conversation: the fix is a fixture file or the `x-mock` line that points at it.
  // Its state is on the screen too, as the service's own line in the Delivery card (same fact,
  // two readers).
  'gate.serviceUncovered': { kind: 'conversation' },
  // No section for the machinery (plan §21.5, revised): a stale record is cleaned up by
  // the agent — re-applying your patches rewrites the anchors, and a copy whose layer was
  // folded starts without them.
  'anchor.orphaned': { kind: 'conversation' },
}

export default function PrototypeInfoPage({ prototypeSlug }: PrototypeInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { onCreateSession, onOpenFile } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const [status, setStatus] = useState<PrototypeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportResult, setExportResult] = useState<PrototypeExportResult | null>(null)
  /** The live page whose address the dialog is changing, if any. */
  const [targetPage, setTargetPage] = useState<PrototypePage | null>(null)
  /** The page the rename dialog is editing, if any. */
  const [renamePage, setRenamePage] = useState<string | null>(null)
  const [renamePageValue, setRenamePageValue] = useState('')
  /** The page whose row is open in the page index — where its changes and actions are. */
  const [expandedPage, setExpandedPage] = useState<string | null>(null)
  /** The "add a page" dialog, hidden until the page index asks for it. */
  const [createPageOpen, setCreatePageOpen] = useState(false)
  /** The delivery card, opened from its button in the header (plan §19.9, revised). */
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  /** The section a blocker asked to be taken to — scrolled to once it is on screen. */
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  /** Failure from Open or Export — both surface the throwing RPC's message verbatim. */
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * The brief, as the page shows it. The status carries its path rather than its text
   * (`status.ts`), so it is re-read on every status load — an edit has to show up. The rest of
   * the folder is listed, not rendered: any format lives there, and what a `.png` or a workbook
   * wants is its own program.
   */
  const [prdContent, setPrdContent] = useState<string | null>(null)
  /** The entry exists but could not be read: said out loud rather than shown as blank. */
  const [prdUnreadable, setPrdUnreadable] = useState(false)

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

  // A different prototype is a different flow: an open row belongs to the flow you
  // were looking at, not to a page name two prototypes happen to share.
  useEffect(() => {
    setExpandedPage(null)
    setPrdContent(null)
    setPrdUnreadable(false)
  }, [prototypeSlug])

  // `PRD.md`, the one file requirements are read from. Re-read on every status load — the
  // status is what says where it is, and an edit to it arrives as a status change — and
  // kept while re-reading so a reload does not blank the section for a frame.
  // Guarded on the slug because a status from the prototype we just left is still in
  // state for a render: reading it would show the wrong document for that frame.
  const prdPath =
    status && status.slug === prototypeSlug ? (status.entryDocument?.path ?? null) : null
  useEffect(() => {
    if (!prdPath) {
      setPrdContent(null)
      setPrdUnreadable(false)
      return
    }
    let cancelled = false
    window.electronAPI
      .readFile(prdPath)
      .then((text) => {
        if (cancelled) return
        setPrdContent(text)
        setPrdUnreadable(false)
      })
      .catch(() => {
        if (cancelled) return
        setPrdContent(null)
        setPrdUnreadable(true)
      })
    return () => {
      cancelled = true
    }
  }, [prdPath, status])

  // Take the reader to the section a blocker named. The scroll waits for a commit so it
  // cannot run before the section is on screen.
  useEffect(() => {
    if (!focusTarget) return
    document.getElementById(focusTarget)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setFocusTarget(null)
  }, [focusTarget])

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
  // already has a conversation — opening a preview must not create one.
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

  /**
   * Open one page of this prototype, wherever it lives.
   *
   * The address comes from `getPrototypeEntry` *with the page's name*: a live
   * page's real address is not in the page table at all, and a document's address
   * exists only while a host is serving prototypes. Passing the page is what makes
   * "open" mean *this* page rather than the entry — without it the window would
   * land on whatever `/` happens to open.
   */
  const handleOpenPage = useCallback(async (page: PrototypePage) => {
    if (!workspaceId) return
    setActionError(null)
    try {
      const entry = (await window.electronAPI.getPrototypeEntry(workspaceId, prototypeSlug, page.name)) as PrototypeEntry
      await openInBrowserPane(entry.url, {
        ...(entry.injectPatches ? { injectPatchesFor: prototypeSlug } : {}),
        ...(prototypeSessions[0] ? { bindToSessionId: prototypeSessions[0].id } : {}),
        ...(entry.origin ? { prototype: { slug: prototypeSlug, origin: entry.origin } } : {}),
      })
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to open the page:', err)
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

  // "Hand this to the conversation" — for the blockers that are only settled in one
  // (an objection to answer, a round to run). The rule for which conversation lives in
  // the hook, because the prototype panel will need the same one (plan §23.4).
  const askAgent = usePrototypeAskAgent(prototypeSlug)

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
   * through `entry`: the panel is a caller, not a second rule about
   * what a flow is.
   */
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

  /**
   * Add one page to this flow.
   *
   * The kind decides what has to exist first (plan §19.8): a live page *is* its
   * address, while a page of ours *is* a document — and the control plane refuses
   * to declare one that is not there, so the minimal document is written first,
   * through the one write the host confines to the workspace prototypes folder.
   *
   * Adding a page is a decision about this flow, which is why the dialog is here
   * and not on the sidebar row: the flow is what this section shows.
   */
  const handleCreatePage = useCallback(async (values: CreatePageValues) => {
    if (!workspaceId || !status) return
    if (values.kind === 'scratch') {
      await window.electronAPI.writeFile(
        pageDocumentPath(status.dir, values.name),
        buildNewPageDocument(values.name),
      )
    }
    // Deliberately not caught: the dialog shows the control plane's own refusal
    // (a name already in the table, a name that cannot be a file).
    await window.electronAPI.setPrototypePages(
      workspaceId,
      prototypeSlug,
      values.kind === 'overlay'
        ? { op: 'add', name: values.name, url: values.url }
        : { op: 'add', name: values.name },
    )
    setCreatePageOpen(false)
    await loadStatus(true)
  }, [workspaceId, prototypeSlug, status, loadStatus])

  const handleRevealFolder = useCallback(async () => {
    if (!status) return
    try {
      await window.electronAPI.showInFolder(status.dir)
    } catch (err) {
      console.error('[PrototypeInfoPage] Failed to reveal prototype folder:', err)
    }
  }, [status])

  /**
   * Take the reader to the section that holds whatever a blocker named — the page
   * index or the requirements, the two things a person can act on from here. The
   * scroll itself happens in the effect above, after the commit.
   */
  const focusSection = useCallback((id: string) => {
    setFocusTarget(id)
  }, [])

  /** The page the address root opens, as the table resolves it. */
  const entryPage = status?.pages.find((page) => page.name === status.entryPage) ?? null

  /**
   * What the header says about the gate.
   *
   * A **state**, not the absence of one: "nothing is outstanding" used to be said
   * by the fact that no warning was on screen, which is not a thing anybody can
   * read. What it means in detail — what stands in the way, and where each of
   * those is fixed — is behind the Delivery button it sits next to; this is the
   * one-line answer to the question the page gets opened with.
   */
  const gate = !status
    ? null
    : status.pages.length === 0
      ? { color: 'muted' as const, label: t('prototypesList.noPages') }
      : status.settleBlockers.length > 0
        ? {
            color: 'warning' as const,
            label: t('prototypesList.notSettled', { count: status.settleBlockers.length }),
          }
        : { color: 'success' as const, label: t('prototypeInfo.deliveryReady') }

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!status && !loading && !error ? t('prototypeInfo.notFound') : undefined}
    >
      <Info_Page.Header title={status?.slug ?? ''} />
      {status && (
        <Info_Page.Content>
          <Info_Page.Hero avatar={<FlaskConical className="h-6 w-6 text-foreground/60" />} title={status.slug} />

          {/* The state, and the things done from here.
              The badge answers "can this go out?" on arrival; *why* not, and where
              each of those is fixed, is behind the Delivery button beside it. Where
              the address root lands is said once, in the page index — it used to be
              here, under the buttons and in the index at the same time. */}
          <div className="flex flex-wrap items-center gap-2 pl-1">
            {gate && (
              <Info_Badge color={gate.color} className="!py-0.5 !pl-1.5 !pr-2 !text-[11px]">
                {gate.label}
              </Info_Badge>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              {/* Delivery, on the button that does it. It used to be the page's first
                  section; handing work over is a verdict and a package, and both belong
                  on the action rather than between the reader and the flow (plan §19.9,
                  revised). The badge beside it is the verdict at a glance — this is the
                  list behind it, what the last run produced, and Export.

                  Each gate line is a notice (`notices.ts`): the top line is this
                  reader's language, the mono line under it is the sentence the agent
                  prints — kept in full because it is what a person pastes into the
                  conversation, and two wordings of one verdict would be two answers. */}
              <Popover open={deliveryOpen} onOpenChange={setDeliveryOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline">
                    <PackageCheck className="h-3.5 w-3.5" />
                    {t('prototypeInfo.delivery')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[26rem] p-0">
                  <div className="max-h-[70vh] overflow-y-auto">
                    {status.settleBlockers.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-foreground/70">
                        {t('prototypeInfo.deliveryReady')}
                      </div>
                    ) : (
                      <>
                        <div className="px-4 pt-3 text-xs font-medium text-foreground/70">
                          {t('prototypeInfo.notSettled')}
                        </div>
                        <ul className="divide-y divide-border/30">
                          {status.settleBlockers.map((blocker) => {
                            const action = BLOCKER_ACTIONS[blocker.code]
                            return (
                              <li key={blocker.text} className="flex items-start gap-3 px-4 py-2.5">
                                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info-text)]" />
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm">
                                    {t(`prototypeNotice.${blocker.code}`, blocker.params)}
                                  </div>
                                  <div className="mt-0.5 font-mono text-xs break-words text-muted-foreground">
                                    {blocker.text}
                                  </div>
                                </div>
                                {/* The popover closes on the way out: both actions land
                                    somewhere else (a section, the conversation). */}
                                {action?.kind === 'section' && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="shrink-0 px-2"
                                    onClick={() => {
                                      setDeliveryOpen(false)
                                      focusSection(action.id)
                                    }}
                                  >
                                    {t(action.titleKey)}
                                  </Button>
                                )}
                                {action?.kind === 'conversation' && (
                                  // Settled in the conversation, so the action is an
                                  // entry: the agent's own sentence goes into the draft,
                                  // and nothing is sent until the person adds what they
                                  // want (`usePrototypeAskAgent`).
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="shrink-0 px-2"
                                    onClick={() => {
                                      setDeliveryOpen(false)
                                      void askAgent(blocker.text)
                                    }}
                                  >
                                    {t('prototypeInfo.askAgent')}
                                  </Button>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )}

                    {/* What the requests do once this is somewhere else. It is the one
                        service fact a person decides on: a service whose responses are
                        all faked runs anywhere, one that reaches a real backend needs it
                        there. Fragments, fixture counts and state belong to the agent's
                        report — this is one line per service, and the one case that stops
                        a hand-over is also a line above (plan §21.5). */}
                    {status.services.length > 0 && (
                      <div className="border-t border-border/40 px-4 py-3">
                        <div className="text-xs font-medium text-foreground/70">
                          {t('prototypeInfo.services')}
                        </div>
                        <ul className="mt-1 space-y-1">
                          {status.services.map((service) => {
                            const live = service.endpoints - service.mockedEndpoints
                            return (
                              <li key={service.slug} className="text-xs">
                                <span className="font-medium">{service.slug}</span>
                                <span className="text-muted-foreground">
                                  {' — '}
                                  {service.endpoints === 0
                                    ? t('prototypeInfo.serviceEmpty')
                                    : live === 0
                                      ? t('prototypeInfo.serviceFaked')
                                      : t('prototypeInfo.serviceLive', { count: live })}
                                </span>
                                {service.missingFixtures.length > 0 && (
                                  <span className="ml-1 text-destructive">
                                    {t('prototypeInfo.serviceMissing', {
                                      names: service.missingFixtures.join(', '),
                                    })}
                                  </span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}

                    {/* What the last export left behind, in the names the folder actually
                        has — a deliverable nobody can point at is a promise, not a result. */}
                    <div className="border-t border-border/40 px-4 py-3">
                      <div className="text-xs font-medium text-foreground/70">
                        {t('prototypeInfo.dist')}
                      </div>
                      {status.distFiles.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t('prototypeInfo.distEmpty')}</p>
                      ) : (
                        <ul className="mt-1 space-y-0.5">
                          {status.distFiles.map((file) => (
                            <li key={file} className="font-mono text-xs break-all">
                              {file}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-4 py-3">
                      <Button
                        size="sm"
                        onClick={() => void handleExport()}
                        // Export needs what its deliverable is built from, and that is
                        // the same condition as "is there a page that can be shown": our
                        // documents are packaged, a live page's address is what a content
                        // script is scoped to. One rule, so one field.
                        disabled={exporting || !status.pageAvailable}
                        title={status.pageAvailable ? undefined : t('prototypeInfo.noPageYet')}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {exporting ? t('prototypeInfo.exporting') : t('prototypeInfo.export')}
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              <Button
                size="sm"
                onClick={() => void handleOpen()}
                // Nothing to open yet: the button would only produce an error
                // written for the agent. The alert below says what to do instead.
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
              {/* Where it lives on disk — the person's occasional business rather than
                  the page's. The machinery this used to sit next to is not shown at all
                  (see the note at the end of this content block). */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="px-2"
                    aria-label={t('prototypeInfo.moreActions')}
                    title={status.dir}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <StyledDropdownMenuContent align="end">
                  <StyledDropdownMenuItem onSelect={() => void handleRevealFolder()}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('prototypeInfo.openLocation')}
                  </StyledDropdownMenuItem>
                </StyledDropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

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

          {/* Pages — the flow itself, and the record of every page in it. One row
              per page, in flow order: what it is (kind, address or document),
              whether it carries the entry, how many changes belong to it, and
              whether its selectors still match. Expanding a row is where that
              page's changes are read and where everything you can do to it lives.

              This is the *only* place a page's facts and actions are shown. The
              sidebar has no second level for them (see PrototypesListPanel): a page
              is looked at in the browser window, and what a page *is* — its type,
              its entry, the changes it carries — is read here, next to the flow it
              belongs to. Two surfaces for the same page is how they drift. */}
          <Info_Section
            id="pages"
            title={t('prototypeInfo.pages')}
            description={status.pages.length > 0
              ? entryPage
                ? t('prototypeInfo.pageEntryIs', { page: entryPage.name })
                : t('prototypeInfo.pageIndexAtRoot')
              : undefined}
            actions={
              <Button size="sm" variant="outline" onClick={() => setCreatePageOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                {t('prototypesList.newPage')}
              </Button>
            }
          >
            {status.pages.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">
                {t('prototypeInfo.pagesEmpty')}
              </div>
            ) : (
              <ul className="divide-y divide-border/30">
                {status.pages.map((page) => {
                  // The page's own slice of the two records: the changes filed
                  // under it (`patches/<page>/`, plan §19.4) and what this page's
                  // selectors last matched (plan §21.2). Shared patches replay on
                  // every page, so they are counted rather than listed here — the
                  // changes section below is where their own list lives.
                  const ownChanges = status.patches.entries.filter((entry) => entry.page === page.name)
                  const sharedChanges = status.patches.entries.filter((entry) => entry.page === null)
                  const record = status.anchors.files.find((file) => file.page === page.name) ?? null
                  const stale = (record?.anchors ?? []).filter((anchor) => anchor.matched === 0)
                  const open = expandedPage === page.name
                  const addressMissing = page.kind === 'overlay'
                    ? t('prototypeInfo.pageNoAddress')
                    : t('prototypeInfo.pageDocumentGone')

                  return (
                    <li key={page.name}>
                      <div className="flex items-center gap-2 px-4 py-2">
                        {/* The whole left side toggles, not just the chevron: a
                            disclosure control the size of its glyph is one nobody
                            hits. The open button stays outside it, so the two
                            never both fire. */}
                        <button
                          type="button"
                          onClick={() => setExpandedPage(open ? null : page.name)}
                          aria-expanded={open}
                          aria-label={open ? t('prototypesList.collapse') : t('prototypesList.expand')}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left"
                        >
                          <ChevronRight
                            className={cn(
                              'h-3.5 w-3.5 shrink-0 text-foreground/50 transition-transform',
                              open && 'rotate-90',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
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
                            </span>
                            {/* Where the page lives: the document for a page of ours
                                (the name *is* the file), its address for a live one. */}
                            <span className="block truncate font-mono text-xs text-foreground/60">
                              {page.kind === 'overlay'
                                ? page.url ?? t('prototypeInfo.pageNoAddress')
                                : page.file ?? t('prototypeInfo.pageDocumentGone')}
                            </span>
                          </span>
                        </button>

                        <span className="shrink-0 text-xs text-foreground/60">
                          {t('prototypesList.patchCount', { count: ownChanges.length })}
                        </span>
                        {stale.length > 0 && (
                          <span
                            className="shrink-0 text-xs text-destructive"
                            title={stale
                              .map((anchor) =>
                                t('prototypeInfo.anchorMissing', {
                                  date: anchor.lastMatchedAt.slice(0, 10) || '—',
                                }),
                              )
                              .join('\n')}
                          >
                            {t('prototypeInfo.pageStaleTargets', { count: stale.length })}
                          </span>
                        )}

                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!page.url}
                          title={page.url ? undefined : addressMissing}
                          onClick={() => void handleOpenPage(page)}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('prototypeInfo.open')}
                        </Button>
                      </div>

                      {open && (
                        <div className="space-y-3 border-t border-border/30 bg-foreground/[0.02] px-4 py-3">
                          <div>
                            <div className="text-xs font-medium text-foreground/70">
                              {t('prototypeInfo.pageChanges')}
                            </div>
                            {ownChanges.length === 0 ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {t('prototypeInfo.pageChangesEmpty')}
                              </p>
                            ) : (
                              <ul className="mt-1.5 space-y-1.5">
                                {ownChanges.map((change) => (
                                  <li
                                    key={change.file}
                                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                                  >
                                    <span className="font-mono text-xs break-all">{change.file}</span>
                                    {change.targets.length === 0 ? (
                                      // A change that names no selector is the fact
                                      // worth seeing: nothing can check what it
                                      // matched (plan §21.1).
                                      <span className="text-xs text-muted-foreground">
                                        {t('prototypeInfo.pageNoTarget')}
                                      </span>
                                    ) : (
                                      change.targets.map((target) => {
                                        const anchor =
                                          record?.anchors.find((item) => item.target === target) ?? null
                                        const lost = anchor !== null && anchor.matched === 0
                                        return (
                                          <code
                                            key={target}
                                            title={
                                              lost
                                                ? t('prototypeInfo.anchorMissing', {
                                                    date: anchor.lastMatchedAt.slice(0, 10) || '—',
                                                  })
                                                : undefined
                                            }
                                            className={cn(
                                              'rounded px-1 py-0.5 font-mono text-xs',
                                              lost ? 'bg-destructive/10 text-destructive' : 'bg-muted',
                                            )}
                                          >
                                            {target}
                                          </code>
                                        )
                                      })
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {sharedChanges.length > 0 && (
                              <p className="mt-1.5 text-xs text-muted-foreground">
                                {t('prototypeInfo.pageSharedChanges', { count: sharedChanges.length })}
                              </p>
                            )}
                          </div>

                          {/* Everything you can do to a page, in one row: the entry
                              is a mark on a row, the address is what a live page
                              *is*, and the last two are the ones that change the
                              flow's shape. */}
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleSetEntryPage(page.entry ? null : page.name)}
                            >
                              {page.entry ? <FlagOff className="h-3.5 w-3.5" /> : <Flag className="h-3.5 w-3.5" />}
                              {page.entry ? t('prototypeInfo.pageEntryClear') : t('prototypeInfo.pageSetEntry')}
                            </Button>
                            {page.kind === 'overlay' && page.url && (
                              <Button size="sm" variant="outline" onClick={() => setTargetPage(page)}>
                                <Globe className="h-3.5 w-3.5" />
                                {t('prototypeInfo.editPageAddress')}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setRenamePageValue(page.name)
                                setRenamePage(page.name)
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {t('prototypeInfo.renamePage')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void handleRemovePage(page)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('prototypeInfo.removePage')}
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
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
                  // The translated line is the message; the sentence the agent
                  // prints is a hover away (`notices.ts`).
                  <li
                    key={issue.text}
                    title={issue.text}
                    className="px-4 py-2 text-xs text-destructive break-words"
                  >
                    {t(`prototypeNotice.${issue.code}`, issue.params)}
                  </li>
                ))}
              </ul>
            </Info_Section>
          )}

          {/* Requirements — what the work is *for*, before how it is done (plan §20.1).
              `PRD.md` is the brief and the one file requirements are read from, so what is
              shown here is the document itself rather than a paraphrase of it — a PRD is
              prose written to be read, and a list of ids is not the argument. What the
              document cannot say about itself is which requirement nothing implements: that
              list is read off `@requirement R-00x` markers in patch headers and page
              documents, and the findings appear in it as evidence, never as implementation
              — "argued for, never built" must not read as done. The folder around the brief
              is the author's, in any format, so its files are only listed by name and opened
              with whatever program the OS has for them. */}
          <Info_Section
            id="requirements"
            title={t('prototypeInfo.requirements')}
            description={status.entryDocument ? t('prototypeInfo.requirementsHint') : undefined}
            bare={!status.entryDocument}
          >
            {!status.entryDocument ? (
              <p className="pl-1 text-sm text-muted-foreground">
                {t('prototypeInfo.requirementsEmpty')}
              </p>
            ) : (
              <>
                {prdUnreadable ? (
                  <p className="px-6 pb-3 text-sm text-destructive">
                    {t('prototypeInfo.documentUnreadable')}
                  </p>
                ) : prdContent !== null ? (
                  <Info_Markdown fullscreen>{prdContent}</Info_Markdown>
                ) : null}

                {status.requirements.length > 0 && (
                  <div className="px-6 pb-3">
                    <div className="pb-1 text-xs font-medium text-muted-foreground">
                      {t('prototypeInfo.requirementsCoverage')}
                    </div>
                    <ul className="divide-y divide-border/30">
                      {status.requirements.map((requirement) => {
                        const covered = [
                          ...requirement.pages,
                          ...requirement.patches,
                          ...requirement.findings.map((id) => `${id} (${t('prototypeInfo.findingsShort')})`),
                        ]
                        return (
                          <li key={requirement.id} className="flex items-start gap-3 py-1.5">
                            <span className="shrink-0 pt-0.5 font-mono text-xs text-foreground/70">
                              {requirement.id}
                            </span>
                            <div
                              className={cn(
                                'min-w-0 flex-1 font-mono text-xs break-words',
                                covered.length > 0 ? 'text-foreground/60' : 'text-destructive',
                              )}
                            >
                              {covered.length > 0
                                ? covered.join(', ')
                                : t('prototypeInfo.requirementUncovered')}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}

                {status.files.length > 0 && (
                  <div className="px-6 pb-3">
                    <div className="pb-1 text-xs font-medium text-muted-foreground">
                      {t('prototypeInfo.requirementsFiles')}
                    </div>
                    <ul className="divide-y divide-border/30">
                      {status.files.map((file) => (
                        <li key={file.name}>
                          <button
                            type="button"
                            onClick={() => onOpenFile(file.path)}
                            className="flex w-full items-center gap-2 py-1.5 text-left"
                          >
                            <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">
                              {file.name}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Info_Section>

          {/* Objections and the last verification round are **not** shown here.
              Both are what one round produced, and both are settled in the conversation:
              somebody has to answer the objection, a verification has to be run — so a
              section for either could only offer a jump into an empty room. Nothing is
              lost: the objections that still stand and the checks that came back red are
              named one by one in the gate above, and their entry is "hand it to the
              conversation" (plan §19.10, revised). */}

          {/* Research — what was learned about other products. Source and
              requirements are the two edges that make a finding more than a
              bookmark, and neither ships with the delivery (plan §20.2). */}
          <Info_Section
            title={t('prototypeInfo.research')}
            description={t('prototypeInfo.researchHint')}
            bare={status.findings.length === 0}
          >
            {status.findings.length === 0 ? (
              <p className="pl-1 text-sm text-muted-foreground">
                {t('prototypeInfo.researchEmpty')}
              </p>
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

          {/* Frame captures are **not** listed here either (plan §20.3, revised).
              They are pictures for the model, read from `research/frames/*` — a recording
              somebody else made is brought in by the agent (`sample-video`), which is the
              same conversation that cites the frames it produced. */}

          {/* The silent failures of the layer above — a requirement nothing
              implements, a marker naming an id the PRD does not define, a finding
              with no claim or with evidence that is not there (plan §20.1/§20.2).
              Same shape as the page issues, because they are the same kind of fact. */}
          {status.briefIssues.length > 0 && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.briefIssues')}</Info_Alert.Title>
              <Info_Alert.Description>
                {status.briefIssues.map((issue) => (
                  // Translated line, agent's sentence on hover — one wording each,
                  // both from the same notice (`notices.ts`).
                  <div key={issue.text} title={issue.text} className="text-xs break-words">
                    {t(`prototypeNotice.${issue.code}`, issue.params)}
                  </div>
                ))}
              </Info_Alert.Description>
            </Info_Alert>
          )}

          {/* Changes, anchors, services and ownership are **not** shown here.
              They answer "how is this made, and is the machinery healthy" — the agent's
              questions, not a person's: file names, `@target` selectors, matched counts,
              mocked endpoints, write violations. The people this page is for meet the
              same facts where they can act on them: a selector that stopped matching is a
              red mark on the page's own row in the index above, a missing mock is the page
              failing in the window, and "can this go out" is the Delivery card.
              The machinery's reader is `prototype_tool status` (plan §21.5, revised). */}

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

      {/* Adding a page. The kind it asks for decides what has to exist: an
          address, or a document this writes before declaring the row. */}
      {status && (
        <CreatePageDialog
          open={createPageOpen}
          slug={prototypeSlug}
          dir={status.dir}
          existingNames={status.pages.map((page) => page.name)}
          onCancel={() => setCreatePageOpen(false)}
          onSubmit={handleCreatePage}
        />
      )}
    </Info_Page>
  )
}

