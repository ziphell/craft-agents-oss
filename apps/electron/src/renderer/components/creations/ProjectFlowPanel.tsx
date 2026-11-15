/**
 * A project's flow — everything it made, in the order it made it.
 *
 * This is the project's own reading surface for work that was generated rather than written: one
 * row per generation, newest first, with what it was built from and what came after it. Nothing is
 * registered here: a row exists because a note sits beside a file (`@craft-agent/shared/provenance`),
 * so deleting the file deletes the row, and a folder read outside this app still says the same thing.
 *
 * The lineage is read, not stored. `from` is a record's `references`; `to` is every record that
 * names this file — both answers come from the same notes, so they cannot disagree.
 *
 * This is **generation history**, not the asset library. A row is what was made; the library is the
 * curated `assets/` folder, and a row joins it only when somebody presses "add to library".
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, ExternalLink, FileText, Link2, Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import {
  joinProjectPath,
  generationOf,
  newestFirst,
  relatedOf,
  searchGenerations,
  sourcesOf,
  usedBy,
} from '@craft-agent/shared/provenance'
import type { GenerationRecord } from '@craft-agent/shared/provenance'
import { useAppShellContext } from '@/context/AppShellContext'
import { Input } from '@/components/ui/input'
import { navigate, routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const VIDEO = /\.(mp4|webm|mov|m4v|mkv)$/i

const nameOf = (file: string): string => file.split('/').pop() ?? file

/** Read once per session and keep it: a timeline scrolls, and a picture does not change under it. */
const previews = new Map<string, string>()

function MediaThumb({ path, className }: { path: string; className?: string }) {
  const [, force] = React.useState(0)
  const cached = previews.get(path)

  React.useEffect(() => {
    if (cached || !IMAGE.test(path)) return
    let live = true
    void window.electronAPI
      .readFilePreviewDataUrl(path, 512)
      .then((dataUrl) => {
        previews.set(path, dataUrl)
        if (live) force((count) => count + 1)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [path, cached])

  if (IMAGE.test(path)) {
    return cached ? (
      <img src={cached} alt="" className={cn('h-full w-full object-cover', className)} />
    ) : (
      <div className={cn('h-full w-full bg-muted/40', className)} />
    )
  }
  if (VIDEO.test(path)) {
    return <video src={path} muted preload="metadata" className={cn('h-full w-full object-cover', className)} />
  }
  return (
    <div className={cn('flex h-full w-full items-center justify-center text-muted-foreground', className)}>
      <FileText className="h-4 w-4" />
    </div>
  )
}

function when(at: number): string {
  if (!at) return ''
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at))
}

export function ProjectFlowPanel({
  workspaceId,
  projectSlug,
}: {
  workspaceId: string | undefined
  projectSlug: string
}) {
  const { t } = useTranslation()
  const { onOpenFile } = useAppShellContext()
  const [state, setState] = React.useState<{ dir: string; records: GenerationRecord[] }>({
    dir: '',
    records: [],
  })
  const [loading, setLoading] = React.useState(true)
  const [selected, setSelected] = React.useState<string | null>(null)
  /** What is typed in the search box. It narrows the list; it never changes the lineage. */
  const [query, setQuery] = React.useState('')

  const load = React.useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const reply = await window.electronAPI.getProjectProvenance(workspaceId, projectSlug)
      setState({ dir: reply?.dir ?? '', records: Array.isArray(reply?.records) ? reply.records : [] })
    } catch (error) {
      console.error('[ProjectFlowPanel] Failed to read provenance:', error)
      setState({ dir: '', records: [] })
    } finally {
      setLoading(false)
    }
  }, [workspaceId, projectSlug])

  React.useEffect(() => {
    void load()
  }, [load])

  const ordered = React.useMemo(() => newestFirst(state.records), [state.records])
  const visible = React.useMemo(() => searchGenerations(ordered, query), [ordered, query])
  const open = React.useCallback(
    (file: string) => onOpenFile(joinProjectPath(state.dir, file)),
    [onOpenFile, state.dir],
  )
  // The explicit bridge from history to library: copy the generated file into `assets/`. The
  // original stays, so this row — and everything built from it — keeps its place in history.
  const addToLibrary = React.useCallback(
    async (file: string) => {
      if (!workspaceId) return
      try {
        const asset = await window.electronAPI.uploadProjectAsset(workspaceId, projectSlug, {
          filename: nameOf(file),
          sourcePath: joinProjectPath(state.dir, file),
          // Same volume by construction (both are inside the project): link instead of duplicating
          // a clip. `uploadProjectAsset` falls back to a copy where the filesystem cannot link.
          link: true,
        })
        toast.success(t('projectFlow.addedToLibrary', { name: asset.filename }))
      } catch (error) {
        console.error('[ProjectFlowPanel] Failed to add the file to the library:', error)
        toast.error(t('projectFlow.addFailed'))
      }
    },
    [workspaceId, projectSlug, state.dir, t],
  )

  if (loading) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">{t('projectFlow.loading')}</div>
  }

  if (ordered.length === 0) {
    return <div className="px-4 py-6 text-sm text-muted-foreground">{t('projectFlow.empty')}</div>
  }

  // The selection is looked up in every record, not the filtered ones: a search narrows what is
  // listed, never what is connected. The counts on each row and the lineage beside it are therefore
  // the same numbers whether or not a query is typed.
  const current = selected ? generationOf(ordered, selected) : null
  const detail = current ?? visible[0] ?? null

  return (
    <div className="flex flex-col">
      <div className="relative border-b border-border/50 px-4 py-2">
        <Search className="pointer-events-none absolute left-6 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('projectFlow.search')}
          className="pl-8"
        />
      </div>

      <div className="flex flex-col lg:flex-row">
        {visible.length === 0 ? (
          <div className="min-w-0 flex-1 px-4 py-6 text-sm text-muted-foreground">
            {t('projectFlow.noMatch')}
          </div>
        ) : (
          <ul className="min-w-0 flex-1 divide-y divide-border/50">
            {visible.map((record) => {
              const sources = sourcesOf(ordered, record.file)
              const dependents = usedBy(ordered, record.file)
              return (
                <li key={record.file}>
                  <button
                    type="button"
                    onClick={() => setSelected(record.file)}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                      detail?.file === record.file ? 'bg-accent/40' : 'hover:bg-accent/20',
                    )}
                  >
                    <span className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/20">
                      <MediaThumb path={joinProjectPath(state.dir, record.file)} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {when(record.at)}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {[record.channel, record.model].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-sm">
                        {record.prompt || t('projectFlow.noPrompt')}
                      </span>
                      <span className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                        {sources.length > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={t('projectFlow.from')}>
                            <ArrowLeft className="h-3 w-3" />
                            {sources.length}
                          </span>
                        )}
                        {dependents.length > 0 && (
                          <span className="inline-flex items-center gap-0.5" title={t('projectFlow.to')}>
                            <ArrowRight className="h-3 w-3" />
                            {dependents.length}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {detail ? (
          <aside className="shrink-0 border-t border-border/50 lg:w-[340px] lg:border-l lg:border-t-0">
            <FlowDetail
              record={detail}
              records={ordered}
              dir={state.dir}
              onSelect={setSelected}
              onOpen={open}
              onAddToLibrary={(file) => void addToLibrary(file)}
            />
          </aside>
        ) : null}
      </div>
    </div>
  )
}

/** One generation, in full: the picture, the words, and both ends of its lineage. */
function FlowDetail({
  record,
  records,
  dir,
  onSelect,
  onOpen,
  onAddToLibrary,
}: {
  record: GenerationRecord
  records: GenerationRecord[]
  dir: string
  onSelect: (file: string) => void
  onOpen: (file: string) => void
  onAddToLibrary: (file: string) => void
}) {
  const { t } = useTranslation()
  // Several hops out, both ways: the nearest thing a person wants is the direct neighbour, and the
  // row's indent says how far it is. `relatedOf` stops on a cycle, so a re-drawn output is safe.
  const lineage = relatedOf(records, record.file)

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="overflow-hidden rounded-md border border-border/60 bg-muted/20">
        <div className="aspect-square w-full">
          <MediaThumb path={joinProjectPath(dir, record.file)} />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={record.file}>
          {nameOf(record.file)}
        </span>
        {!record.file.startsWith('assets/') ? (
          <button
            type="button"
            onClick={() => onAddToLibrary(record.file)}
            title={t('projectFlow.addToLibrary')}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onOpen(record.file)}
          title={t('projectFlow.open')}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="whitespace-pre-wrap break-words text-sm">
        {record.prompt || <span className="text-muted-foreground">{t('projectFlow.noPrompt')}</span>}
      </p>

      {record.channel || record.model ? (
        <div className="text-[11px] text-muted-foreground">
          {[record.channel, record.model].filter(Boolean).join(' · ')}
        </div>
      ) : null}

      {record.session ? (
        <button
          type="button"
          onClick={() => navigate(routes.view.allSessions(record.session ?? ''))}
          className="inline-flex items-center gap-1 self-start text-[11px] text-foreground/60 hover:text-foreground"
        >
          <Link2 className="h-3 w-3" />
          {t('projectFlow.session')}
        </button>
      ) : null}

      <FlowLineage
        dir={dir}
        title={t('projectFlow.from')}
        empty={t('projectFlow.fromEmpty')}
        items={lineage.upstream.map((node) => ({
          file: node.file,
          caption: node.record?.prompt || nameOf(node.file),
          at: node.record?.at ?? 0,
          depth: node.depth,
          selectable: Boolean(node.record),
        }))}
        onSelect={onSelect}
      />

      <FlowLineage
        dir={dir}
        title={t('projectFlow.to')}
        empty={t('projectFlow.toEmpty')}
        items={lineage.downstream.map((node) => ({
          file: node.file,
          caption: node.record?.prompt || nameOf(node.file),
          at: node.record?.at ?? 0,
          depth: node.depth,
          selectable: Boolean(node.record),
        }))}
        onSelect={onSelect}
      />
    </div>
  )
}

/** One end of the lineage: the files themselves, named by what was asked of them. */
function FlowLineage({
  dir,
  title,
  empty,
  items,
  onSelect,
}: {
  dir: string
  title: string
  empty: string
  items: Array<{ file: string; caption: string; at: number; depth: number; selectable: boolean }>
  onSelect: (file: string) => void
}) {
  return (
    <div className="border-t border-border/50 pt-2">
      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <div className="text-[11px] text-muted-foreground/70">{empty}</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.file}>
              <button
                type="button"
                onClick={() => onSelect(item.file)}
                disabled={!item.selectable}
                className={cn(
                  'flex w-full items-center gap-2 rounded pr-1 py-1 text-left',
                  item.selectable ? 'hover:bg-accent/30' : 'cursor-default',
                )}
                // Distance from the file being read: the same marker a source file would indent
                // under the line that uses it. Padding rather than a margin, so the row still fits
                // the panel it sits in.
                style={{ paddingLeft: 4 + (item.depth - 1) * 10 }}
                title={item.file}
              >
                <span className="h-7 w-7 shrink-0 overflow-hidden rounded border border-border/60 bg-muted/20">
                  <MediaThumb path={joinProjectPath(dir, item.file)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] leading-tight">{item.caption}</span>
                  {item.at ? (
                    <span className="block text-[10px] tabular-nums text-muted-foreground">
                      {when(item.at)}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
