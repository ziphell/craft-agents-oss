/**
 * PrototypeInfoPage
 *
 * Workspace-prototype detail page: the workbench page for a single prototype.
 * It is read in two moments, and the screen is arranged by them rather than by
 * where each fact comes from:
 *
 * 1. **Handing over** — can this go out, and what stands in the way? The header's
 *    badge answers the first half, and it is **only there when something stands in
 *    the way**: a prototype with nothing outstanding says nothing about it. ("Ready
 *    to hand over" is not a state anybody opened the page to read — and an untouched
 *    prototype, one with no requirements at all, passed that gate too, so the badge
 *    used to announce as ready work that did not exist yet.) The second half is that
 *    count spelled out: one line per outstanding notice, in the reader's language
 *    with the agent's own sentence under it, and **one action per line — "hand it to
 *    the conversation"**. Both kinds of notice end there (a requirement nobody
 *    implemented has to be asked for; an objection has to be answered), so the action
 *    says what it does rather than naming the verdict it belongs to.
 * 2. **The work itself**, in this order: the **requirements** (each defining document, and what
 *    refers to each of its requirements) and the **research** behind them.
 *
 * What is deliberately **not** here: objections as a section of their own. They are
 * what a run produced and they are settled in the conversation — the same reason the
 * page does not recount them.
 *
 * Each section costs one line while it is empty, so an untouched prototype is a
 * short screen instead of a stack of "nothing here yet".
 *
 * What the report says about the prototype travels as **notices**
 * (`notices.ts`): `code` + `params` are rendered in the reader's language, and the
 * sentence the agent prints is kept beside it as the tooltip where a diagnostic is
 * being read.
 *
 * The status is recomputed on the main side on every call — this page never
 * caches it beyond the current render, and re-reads on every `prototypes:changed`
 * broadcast (the watcher itself is owned by `usePrototypes` in AppShell).
 */

import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { File, FileText, FlaskConical, FolderOpen, Globe, Image, MessageSquare, MoreHorizontal, Pencil, TriangleAlert, Workflow } from 'lucide-react'
import { classifyFile, DrawioOverlay, HTMLPreviewOverlay, MarkdownFileOverlay } from '@craft-agent/ui'
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
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

interface PrototypeInfoPageProps {
  prototypeSlug: string
}

/**
 * A prototype-relative path as an absolute one, with the separator the folder itself uses.
 */
function absolutePath(dir: string, relative: string): string {
  const separator = dir.includes('\\') ? '\\' : '/'
  return `${dir}${separator}${relative.split('/').join(separator)}`
}

/**
 * What a name in the folder opens **in the app**, as opposed to whatever the system has.
 *
 * Three formats here are things the app can show itself, and all three are materials a prototype
 * is made of rather than documents about it: a diagram (drawio's own viewer and editor, served
 * from the app's bundle), a page (run in the workspace's browser window, and changed in the app's
 * own design editor), and a document written in markdown (read and written as what it will be
 * stored as).
 *
 * A document is the one where *looking* and *changing* are the same surface — there is no
 * lighter read-only pane to open first — so it is the one with a single row action instead of
 * two.
 *
 * Everything else keeps going to its own program — the folder is the author's.
 */
function inAppKind(name: string): 'drawio' | 'html' | 'markdown' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.drawio')) return 'drawio'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown'
  return null
}

export default function PrototypeInfoPage({ prototypeSlug }: PrototypeInfoPageProps) {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()
  const workspaceId = workspace?.id
  const { onCreateSession, onOpenFile, onOpenUrl } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const [status, setStatus] = useState<PrototypeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /**
   * The diagram the overlay is on, which way it was opened — when it is being *looked* at, the
   * document it draws — and which of its pages the person last put on screen.
   *
   * A view reads the file when it opens; the editor reads it itself, because it also owns the
   * write path and has to know the version it started from. The page is held here rather than in the
   * window for the same reason the file is: the window shows what it is given, and a page picked from
   * its row has to outlive the window being closed and opened again.
   */
  const [diagram, setDiagram] = useState<{
    path: string
    mode: 'view' | 'edit'
    xml: string | null
    pageId: string | null
  } | null>(null)
  /**
   * The `.html` file whose editor is open, if any.
   *
   * Only ever the editor: looking at a page is the browser window's job (see `openInApp`), and
   * this overlay is where the design editor lives. Unlike the diagram above, nothing is read on
   * the page's side — `HTMLPreviewOverlay` loads the file it is given (`items` + `onLoadContent`).
   */
  const [htmlFile, setHtmlFile] = useState<string | null>(null)
  /**
   * The document being read, if any.
   *
   * Like the page above and unlike the diagram, nothing is read on this page's side: the pane
   * loads the file it is given, and that is also how it knows the version it started from — the
   * version a save has to agree with before it overwrites anything.
   */
  const [mdFile, setMdFile] = useState<string | null>(null)
  /** Failure from an action this page runs — it surfaces the throwing call's message verbatim. */
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * The specification, as the page shows it: each defining document's text, keyed by absolute path.
   *
   * The status carries paths rather than text (`status.ts`), so every document is re-read on every
   * status load — an edit has to show up. `null` marks a document that exists but could not be read,
   * which is said out loud rather than shown as blank; a missing key is a read still in flight.
   */
  const [specDocs, setSpecDocs] = useState<Record<string, string | null>>({})

  // Load the status report for this prototype. `listPrototypes` is the only
  // read path for a single prototype's status, so pick our slug out of it.
  // `silent` skips the spinner so a background refresh doesn't flash the page.
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

  // A different prototype is a different piece of work: what is on screen belongs to
  // the one you were looking at.
  useEffect(() => {
    setSpecDocs({})
  }, [prototypeSlug])

  // The documents the specification is made of — one file or several. Re-read on every status
  // load (the status is what says which files define requirements, and an edit arrives as a status
  // change) and kept while re-reading, so a reload does not blank the section for a frame.
  // Guarded on the slug because a status from the prototype we just left is still in state for a
  // render: reading it would show the wrong documents for that frame.
  useEffect(() => {
    const files = status && status.slug === prototypeSlug ? status.specificationFiles : []
    if (files.length === 0) {
      setSpecDocs({})
      return
    }
    let cancelled = false
    Promise.all(
      files.map(async (file): Promise<[string, string | null]> => {
        try {
          return [file.path, await window.electronAPI.readFile(file.path)]
        } catch {
          return [file.path, null]
        }
      }),
    ).then((entries) => {
      if (!cancelled) setSpecDocs(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [status, prototypeSlug])

  // Re-read on artifact changes (event carries only the changed file name).
  // Silent so a burst of writes doesn't flash the spinner.
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

  // Open the prototype's own folder — the folder *itself*, not its place among its
  // neighbours: this is the way in to the files, and the person clicking it wants to be
  // inside it. `onOpenFile` is the app's one way to open a path, and a folder has no
  // preview type, so it lands in the file manager — inside it, not with it selected.
  const handleOpenFolder = useCallback(() => {
    if (!status) return
    onOpenFile(status.dir)
  }, [status, onOpenFile])

  /**
   * Open one of the prototype's own files, named the way a document names it — a prototype-relative
   * path from a markdown link. The app's own open path routes it by what it is, so a `.md` opens in
   * the reader and a page in the browser, exactly as it would from the folder's list.
   */
  const openPrototypeFile = useCallback(
    (relative: string) => {
      if (status) onOpenFile(absolutePath(status.dir, relative))
    },
    [status, onOpenFile],
  )

  /**
   * Open a diagram — to look at it, or to edit it.
   *
   * Looking reads the file first, so the overlay opens on a picture rather than on a blank
   * frame, and a file that cannot be read is reported by the page's own error line instead of
   * being shown as an empty diagram.
   */
  const openDiagram = useCallback(async (path: string, mode: 'view' | 'edit') => {
    setActionError(null)
    if (mode === 'edit') {
      setDiagram({ path, mode, xml: null, pageId: null })
      return
    }
    try {
      setDiagram({ path, mode, xml: await window.electronAPI.readFile(path), pageId: null })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  /**
   * Open one of the folder's materials — to look at it, or to edit it.
   *
   * One action for all three kinds because the *intent* is the same in every case; which surface
   * it lands on is what the format decides. A document has only one surface, so the mode it was
   * asked for is not a question it answers: looking at it and changing it are the same thing.
   *
   * A page is *shown*, not run: looking at it hands the path to the app's own way of opening
   * one — the same preview window an `html-preview` block opens, whose header is where the page
   * can be opened for real, in a browser. Changing it is the app's own design editor, that same
   * window on its editing side.
   */
  const openInApp = useCallback(
    (kind: 'drawio' | 'html' | 'markdown', path: string, mode: 'view' | 'edit') => {
      setActionError(null)
      if (kind === 'markdown') {
        setMdFile(path)
        return
      }
      if (kind === 'drawio') {
        // The diagram's viewer is handed a document, so the file is read here; its editor
        // reads the file itself.
        void openDiagram(path, mode)
        return
      }
      if (mode === 'view') {
        // The app's own way of opening a path, not a call of our own: the page is classified
        // there and drawn in the page window — the same answer a `.html` link in a conversation
        // gets, which is why this is not decided here a second time. A failure surfaces the way
        // every other failed open does (the app's toast), not here.
        onOpenFile(path)
        return
      }
      setHtmlFile(path)
    },
    [openDiagram, onOpenFile],
  )

  /**
   * While a diagram is up to be looked at, it follows the file — the way the same picture in a
   * conversation does. The report is re-read on every write to the folder, so an agent's edit
   * lands as a redraw instead of leaving a stale picture on screen. A read that fails right now
   * keeps what is shown: the click that opened it already reported a file it could not read.
   */
  const shownDiagramPath = diagram?.mode === 'view' ? diagram.path : null
  useEffect(() => {
    if (!shownDiagramPath) return
    let cancelled = false
    window.electronAPI
      .readFile(shownDiagramPath)
      .then((text) => {
        if (cancelled) return
        setDiagram((current) => (current?.path === shownDiagramPath ? { ...current, xml: text } : current))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [shownDiagramPath, status])

  /**
   * What the header says about the gate — **and only when there is something to say**.
   *
   * "Settled" is not a state worth a badge. An untouched prototype — one with no requirements
   * at all — satisfies the gate, so the page used to announce it as ready to hand over: a claim
   * about work that does not exist yet, and one nobody opened the page to hear. What stands in
   * the way is worth saying; nothing standing in the way is said by saying nothing.
   *
   * The badge is the one-line state. What it *counts* is listed under it, one notice per line,
   * because "you owe two things" without them is a dead end — and each line carries the action
   * that settles it, in the words of that action rather than of the verdict.
   */
  const blockers = status?.settleBlockers ?? []
  const notSettled = blockers.length > 0
  /**
   * The one way a blocker is settled from here.
   *
   * Both kinds end in the conversation — a requirement nobody implemented has to be asked
   * for, and an objection has to be answered — so there is one action, not a per-notice
   * table of destinations. It puts the agent's own sentence into the draft and sends nothing
   * (`usePrototypeAskAgent`), which is what "hand it over" means: the person still writes
   * what they want done with it.
   */
  const askAgent = usePrototypeAskAgent(prototypeSlug)

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

          {/* The state, and the things done from here. The badge is the one-line answer —
              "not yet" — and what it counts is spelled out under it, each line with the one
              action that settles it. Both are there only when something is outstanding. */}
          <div className="flex flex-wrap items-center gap-2 pl-1">
            {notSettled && (
              <Info_Badge color="warning" className="!py-0.5 !pl-1.5 !pr-2 !text-[11px]">
                {t('prototypesList.notSettled', { count: blockers.length })}
              </Info_Badge>
            )}

            <div className="ml-auto flex shrink-0 items-center gap-2">
              {/* Where the prototype is actually built. A bound session means every
                  command stops needing a slug. */}
              <Button size="sm" variant="outline" onClick={() => void handleOpenChat()}>
                <MessageSquare className="h-3.5 w-3.5" />
                {prototypeSessions.length > 0 ? t('prototypeInfo.openChat') : t('prototypeInfo.startChat')}
              </Button>
              {/* Where it lives on disk — the person's occasional business rather than
                  the page's. Opening it puts the file manager *inside* the folder. */}
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
                  <StyledDropdownMenuItem onSelect={handleOpenFolder}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('prototypeInfo.openFolder')}
                  </StyledDropdownMenuItem>
                </StyledDropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {notSettled && (
            <Info_Alert variant="warning" icon={<TriangleAlert className="h-4 w-4" />}>
              <div className="flex flex-col gap-1.5">
                {blockers.map((blocker) => (
                  <div key={blocker.text} className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      {/* The reader's language, then the sentence the agent prints — the
                          second line is what gets handed over, so it is shown rather than
                          hidden behind a tooltip. */}
                      <div>{t(`prototypeNotice.${blocker.code}`, blocker.params)}</div>
                      <div className="font-mono text-xs break-words text-foreground/50">
                        {blocker.text}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 px-2"
                      onClick={() => void askAgent(blocker.text)}
                    >
                      {t('prototypeInfo.askAgent')}
                    </Button>
                  </div>
                ))}
              </div>
            </Info_Alert>
          )}

          {/* And that is the whole screen: read it, talk about it, hand it over.
              Opening a browser window, studying a target page, importing another
              prototype, writing changes into a page — every one of those is how the
              *machinery* gets what it needs, not something a user wants to say.
              They live in the conversation ("reference this page"), where the agent
              can do them and explain what it did. One button per mechanism is what
              made this page unreadable. */}

          {actionError && (
            <Info_Alert variant="error" icon={<TriangleAlert className="h-4 w-4" />}>
              <Info_Alert.Title>{t('prototypeInfo.actionFailed')}</Info_Alert.Title>
              <Info_Alert.Description>{actionError}</Info_Alert.Description>
            </Info_Alert>
          )}

          {/* Requirements — what the work is *for*, before how it is done.
              The specification is one markdown file or several, so each document that defines
              requirements is shown as itself rather than a paraphrase of it — prose written to be
              read, and a list of ids is not the argument — with the requirements it defines listed
              under it. What a document cannot say about itself is which requirement nothing
              implements: that is read off `@requirement R-00x` markers in the prototype's files,
              and the findings appear as evidence, never as implementation — "argued for, never
              built" must not read as done. The rest of the folder is the author's, in any format,
              so those files are only listed by name and opened with whatever program the OS has
              for them. */}
          <Info_Section
            id="requirements"
            title={t('prototypeInfo.requirements')}
            description={
              status.specificationFiles.length > 0 ? t('prototypeInfo.requirementsHint') : undefined
            }
            bare={status.specificationFiles.length === 0}
          >
            {status.specificationFiles.length === 0 ? (
              <p className="pl-1 text-sm text-muted-foreground">
                {t('prototypeInfo.requirementsEmpty')}
              </p>
            ) : (
              <>
                {status.specificationFiles.map((file) => {
                  const content = specDocs[file.path]
                  // A picture named in a document is read from that document's own folder
                  // (`baseDir`), so a relative destination resolves the way the author wrote it —
                  // true for a document at the root and for one in a subfolder alike.
                  const baseDir = file.path.replace(/[\\/][^\\/]*$/, '')
                  const defined = status.requirements.filter(
                    (requirement) => requirement.file === file.name,
                  )
                  // Documents point at each other with ordinary markdown links — the renderer draws
                  // them, and the app opens a relative destination from the document's own folder —
                  // so all that is read here is the two lists below.
                  const outgoing = status.links.filter(
                    (link) => link.from === file.name && link.to !== null,
                  )
                  const incoming = status.links.filter(
                    (link) => link.to === file.name && link.from !== file.name,
                  )
                  return (
                    <div key={file.path}>
                      <div className="px-6 pt-2 pb-1 font-mono text-xs text-muted-foreground">
                        {file.name}
                      </div>
                      {content === null ? (
                        <p className="px-6 pb-3 text-sm text-destructive">
                          {t('prototypeInfo.documentUnreadable')}
                        </p>
                      ) : typeof content === 'string' ? (
                        <Info_Markdown
                          fullscreen
                          baseDir={baseDir}
                          onFileClick={onOpenFile}
                          onUrlClick={onOpenUrl}
                        >
                          {content}
                        </Info_Markdown>
                      ) : null}

                      {defined.length > 0 && (
                        <div className="px-6 pb-3">
                          <div className="pb-1 text-xs font-medium text-muted-foreground">
                            {t('prototypeInfo.requirementsCoverage')}
                          </div>
                          <ul className="divide-y divide-border/30">
                            {defined.map((requirement) => {
                              const covered = [
                                ...requirement.files,
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

                      {/* The edges between documents, read from both ends: what this one points at,
                          and what points back at it. Navigation only — it says where to read next,
                          never whether a requirement is done. */}
                      {(outgoing.length > 0 || incoming.length > 0) && (
                        <div className="px-6 pb-3 font-mono text-xs text-foreground/60">
                          {outgoing.length > 0 && (
                            <div className="flex flex-wrap items-baseline gap-x-1.5 py-0.5">
                              <span className="text-muted-foreground">
                                {t('prototypeInfo.linksTo')}
                              </span>
                              {outgoing.map((link) => (
                                <button
                                  key={link.target}
                                  type="button"
                                  onClick={() => openPrototypeFile(link.to as string)}
                                  className="text-accent hover:underline"
                                >
                                  {link.target}
                                </button>
                              ))}
                            </div>
                          )}
                          {incoming.length > 0 && (
                            <div className="flex flex-wrap items-baseline gap-x-1.5 py-0.5">
                              <span className="text-muted-foreground">
                                {t('prototypeInfo.linkedFrom')}
                              </span>
                              {incoming.map((link) => (
                                <button
                                  key={link.from}
                                  type="button"
                                  onClick={() => openPrototypeFile(link.from)}
                                  className="text-accent hover:underline"
                                >
                                  {link.from}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {status.files.length > 0 && (
                  <div className="px-6 pb-3">
                    <div className="pb-1 text-xs font-medium text-muted-foreground">
                      {t('prototypeInfo.requirementsFiles')}
                    </div>
                    <ul className="divide-y divide-border/30">
                      {status.files.map((file) => {
                        // A material the app can show is something to *look at* first: the row
                        // opens it — in an overlay here, or in the browser window for a page —
                        // and where there is a second surface, the pencil beside it is the way
                        // in. A document is the exception: it has one surface, and the row opens
                        // it — which is also why there is no pencil on that row. Everything else
                        // is handed to whatever the person has for it. The icon says which is
                        // which before the click.
                        const kind = inAppKind(file.name)
                        // What the rest of the folder opens as. The icon is read off the same
                        // classifier the click itself goes by, so it cannot promise a different
                        // answer than the one the row gives — an image shows a picture here and
                        // opens as one (`ImagePreviewOverlay`, like any image link in the app).
                        const isImage = !kind && classifyFile(file.name).type === 'image'
                        return (
                          <li key={file.name} className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                kind ? openInApp(kind, file.path, 'view') : onOpenFile(file.path)
                              }
                              className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
                            >
                              {kind === 'drawio' ? (
                                <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : kind === 'html' ? (
                                <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : kind === 'markdown' ? (
                                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : isImage ? (
                                <Image className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : (
                                <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                {file.name}
                              </span>
                            </button>
                            {(kind === 'drawio' || kind === 'html') && (
                              <button
                                type="button"
                                onClick={() => openInApp(kind, file.path, 'edit')}
                                title={t('common.edit')}
                                aria-label={t('common.edit')}
                                className="shrink-0 p-1 text-muted-foreground/40 transition-colors hover:text-foreground"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Info_Section>

          {/* Objections are **not** shown here.
              They are what a run produced, and they are settled in the conversation:
              somebody has to answer the objection — so a section for them could only
              offer a jump into an empty room. Nothing is lost: the objections that still
              stand are named one by one in the gate above, and their entry is "hand it
              to the conversation". */}

          {/* Research — what was learned about other products. Source and
              requirements are the two edges that make a finding more than a
              bookmark, and neither is part of the handover. */}
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

          {/* The silent failures of the layer above — a requirement nothing
              implements, a marker naming an id the PRD does not define, a finding
              with no claim or with evidence that is not there. */}
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

        </Info_Page.Content>
      )}

      {/* The diagram a row in the folder opens: the same `DrawioViewer` a `drawio-preview`
          block draws with, and the same `DrawioEditorPane` its pencil opens — so the debounce,
          the prototypes-folder write boundary and the "this file changed underneath" question
          are answered by one chain (`useFileWriter`) rather than once per entry point. Two rows
          in the list say which of the two they open: the name looks, the pencil edits. */}
      {diagram && (
        <DrawioOverlay
          isOpen
          onClose={() => setDiagram(null)}
          filePath={diagram.path}
          initialMode={diagram.mode}
          xml={diagram.xml}
          pageId={diagram.pageId ?? undefined}
          /* Which page was last on screen, so coming back to the diagram comes back to it: the window
             holds no page of its own, and reopening from this row is a fresh window. */
          onSelectPage={(pageId) =>
            setDiagram((current) => (current ? { ...current, pageId } : current))
          }
        />
      )}

      {/* The design editor, on the page a row's pencil named: the same `HTMLPreviewOverlay` the
          conversation's `html-preview` block opens its editor with, so the editor is one
          implementation. It loads the file it is given and opens on the editor; the same header's
          pencil switches to the rendered page, which is the app's own look at it rather than the
          browser window's. */}
      {htmlFile && (
        <HTMLPreviewOverlay
          isOpen
          onClose={() => setHtmlFile(null)}
          items={[{ src: htmlFile, label: htmlFile.split(/[\\/]/).pop() }]}
          onLoadContent={(src) => window.electronAPI.readFile(src)}
          initialMode="edit"
          // Read once per render, the way the diagram overlay does: a theme flip while this is
          // open lands on the next render.
          theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        />
      )}

      {/* The document a row in the folder opens — the same overlay a link to a `.md` in a
          conversation opens, so a document is read and written by one component whichever way it
          was reached. Its own links are the app's to open, which is what the two callbacks are:
          without them a document's links would be text. */}
      {mdFile && (
        <MarkdownFileOverlay
          isOpen
          onClose={() => setMdFile(null)}
          filePath={mdFile}
          theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
        />
      )}
    </Info_Page>
  )
}
