/**
 * PrototypesListPanel
 *
 * Workspace-scoped prototype list shown in the navigator slot when the
 * Prototypes sidebar item is active. Two levels, because a prototype is a
 * **flow** and its pages are the granularity you act on (plan §19.9):
 *
 * - **level 1** — a prototype: name, status dot, expand chevron and the `…` menu
 *   that holds the decisions about *which prototypes exist* (new page, duplicate,
 *   delete). Clicking the row opens the prototype's own page;
 * - **level 2** — its pages, in flow order: name, kind, entry mark and a status
 *   dot. Clicking a page opens **that page**; its menu holds the decisions about
 *   the flow itself (open, entry, rename, delete).
 *
 * Expansion is plain React state on purpose: it says where you are looking, not
 * a fact about the prototype, so it is not persisted (a list that reopened the
 * way you left it would look like a property of the data).
 *
 * A prototype with no pages is not an error: it says "no pages yet" and offers
 * the way to add the first one — the state every new prototype is in (plan
 * §13.2).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Copy, ExternalLink, FileCode, Flag, FlagOff, FlaskConical, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { Info_Badge } from '@/components/info'
import { useMenuComponents } from '@/components/ui/menu-context'
import type { PrototypePage, PrototypeStatus } from '@craft-agent/shared/prototypes'

export interface PrototypesListPanelProps {
  prototypes: PrototypeStatus[]
  /** Opens the prototype's own page (its details). */
  onPrototypeClick: (slug: string) => void
  /** Opens one page of a prototype — a live page on its address, a page of ours in the host's rendering. */
  onOpenPage?: (slug: string, page: PrototypePage) => void
  /** Opens the "New Prototype" dialog (panel-header button lives in AppShell for prototypes mode). */
  onAddPrototype?: () => void
  /** Adds a page to a prototype — the dialog asked for its kind and where it lives. */
  onAddPage?: (slug: string) => void
  /** Marks which page the address root opens, or clears it (`null` → the page index). */
  onSetEntryPage?: (slug: string, page: string | null) => void
  /** Renames a page — the row is the name the file and the address answer to. */
  onRenamePage?: (slug: string, page: string) => void
  /** Removes a page. The caller asks the user first — nothing here confirms. */
  onRemovePage?: (slug: string, page: PrototypePage) => void
  /** Copies the prototype into a new one; the caller decides what to do with the result. */
  onDuplicatePrototype?: (slug: string) => void
  /** Removes the prototype. The caller asks the user first — nothing here confirms. */
  onDeletePrototype?: (slug: string) => void
  selectedPrototypeSlug?: string | null
  className?: string
}

export function PrototypesListPanel({
  prototypes,
  onPrototypeClick,
  onOpenPage,
  onAddPrototype,
  onAddPage,
  onSetEntryPage,
  onRenamePage,
  onRemovePage,
  onDuplicatePrototype,
  onDeletePrototype,
  selectedPrototypeSlug,
  className,
}: PrototypesListPanelProps) {
  const { t } = useTranslation()
  /** Slugs whose pages are on screen. UI state: where you are looking, not a fact about the prototype. */
  const [expandedSlugs, setExpandedSlugs] = React.useState<Set<string>>(() => new Set())

  const toggleExpanded = React.useCallback((slug: string) => {
    setExpandedSlugs((previous) => {
      const next = new Set(previous)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }, [])

  if (prototypes.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<FlaskConical />}
          title={t('prototypesList.empty')}
          description={t('prototypesList.emptyDescription')}
        >
          {onAddPrototype && (
            <button
              type="button"
              onClick={onAddPrototype}
              className="inline-flex items-center gap-1 h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('prototypesList.newPrototype')}
            </button>
          )}
        </EntityListEmptyScreen>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <ScrollArea className="flex-1">
        <div className="pb-2" data-list-role="prototypes">
          <div className="pt-1">
            {prototypes.map((prototype, index) => (
              <PrototypeRow
                key={prototype.slug}
                prototype={prototype}
                isSelected={selectedPrototypeSlug === prototype.slug}
                isFirst={index === 0}
                isExpanded={expandedSlugs.has(prototype.slug)}
                onToggleExpanded={() => toggleExpanded(prototype.slug)}
                onClick={() => onPrototypeClick(prototype.slug)}
                onOpenPage={onOpenPage ? (page) => onOpenPage(prototype.slug, page) : undefined}
                onAddPage={onAddPage ? () => onAddPage(prototype.slug) : undefined}
                onSetEntryPage={
                  onSetEntryPage ? (page) => onSetEntryPage(prototype.slug, page) : undefined
                }
                onRenamePage={onRenamePage ? (page) => onRenamePage(prototype.slug, page) : undefined}
                onRemovePage={onRemovePage ? (page) => onRemovePage(prototype.slug, page) : undefined}
                onDuplicate={
                  onDuplicatePrototype ? () => onDuplicatePrototype(prototype.slug) : undefined
                }
                onDelete={
                  onDeletePrototype ? () => onDeletePrototype(prototype.slug) : undefined
                }
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

/**
 * The status dot a row carries.
 *
 * What the row says at a glance, in the order a person would act on it: something
 * is wrong with its pages (a row that cannot be read, a declared page whose
 * document is gone, a `patches/<page>/` that matches nothing), it has pages but
 * still owes something (a requirement nothing implements, an objection nobody
 * answered, a check that failed), it has no pages yet, or it is fine.
 *
 * The fourth state shares the amber of "no pages" and is told apart by the words
 * beside it: the two call for different actions. What counts as owing something is
 * `settleBlockers` — the gate's own list, so a row cannot look finished while the
 * details page says otherwise.
 */
function statusColor(hasPages: boolean, issues: number, blockers: number): string {
  if (issues > 0) return 'var(--destructive)'
  if (blockers > 0) return 'var(--info)'
  if (!hasPages) return 'var(--info)'
  return 'var(--success)'
}

function StatusDot({ color, title }: { color: string; title: string }) {
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      title={title}
      aria-hidden
    />
  )
}

interface PrototypeRowProps {
  prototype: PrototypeStatus
  isSelected: boolean
  isFirst: boolean
  isExpanded: boolean
  onToggleExpanded: () => void
  onClick: () => void
  onOpenPage?: (page: PrototypePage) => void
  onAddPage?: () => void
  onSetEntryPage?: (page: string | null) => void
  onRenamePage?: (page: string) => void
  onRemovePage?: (page: PrototypePage) => void
  onDuplicate?: () => void
  onDelete?: () => void
}

function PrototypeRow({
  prototype,
  isSelected,
  isFirst,
  isExpanded,
  onToggleExpanded,
  onClick,
  onOpenPage,
  onAddPage,
  onSetEntryPage,
  onRenamePage,
  onRemovePage,
  onDuplicate,
  onDelete,
}: PrototypeRowProps) {
  const { t } = useTranslation()
  const hasPages = prototype.pages.length > 0

  return (
    <EntityRow
      showSeparator={!isFirst}
      separatorClassName="pl-10 pr-4"
      isSelected={isSelected}
      onMouseDown={(e: React.MouseEvent) => {
        if (e.button === 0) onClick()
      }}
      icon={
        // The chevron sits in the icon slot so it reads as "this row holds
        // something", and it is the only part of the row that toggles: the row
        // itself still opens the prototype.
        <>
          <span
            role="button"
            tabIndex={0}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? t('prototypesList.collapse') : t('prototypesList.expand')}
            title={isExpanded ? t('prototypesList.collapse') : t('prototypesList.expand')}
            className="grid place-items-center rounded-[4px] text-muted-foreground/60 hover:bg-foreground/10 hover:text-foreground cursor-pointer"
            onMouseDown={(e) => {
              // Keeps the row's own mousedown (which opens the prototype) out.
              e.stopPropagation()
              e.preventDefault()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpanded()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggleExpanded()
              }
            }}
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
          </span>
          <FlaskConical className="h-3.5 w-3.5 text-foreground/60" />
        </>
      }
      title={prototype.slug}
      badges={
        <>
          <StatusDot
            color={statusColor(hasPages, prototype.pageIssues.length, prototype.settleBlockers.length)}
            title={
              prototype.pageIssues.length > 0
                ? t('prototypesList.hasIssues', { count: prototype.pageIssues.length })
                : prototype.settleBlockers.length > 0
                  ? t('prototypesList.notSettled', { count: prototype.settleBlockers.length })
                  : hasPages
                    ? t('prototypesList.pagesOk')
                    : t('prototypesList.noPages')
            }
          />
          <span className="shrink-0 text-xs text-foreground/60">
            {hasPages
              ? t('prototypesList.pageCount', { count: prototype.pages.length })
              : t('prototypesList.noPages')}
          </span>
          {prototype.pageIssues.length > 0 && (
            <span className="shrink-0 text-xs text-destructive">
              {t('prototypesList.hasIssues', { count: prototype.pageIssues.length })}
            </span>
          )}
          {prototype.pageIssues.length === 0 && prototype.settleBlockers.length > 0 && (
            <span className="shrink-0 text-xs text-info">
              {t('prototypesList.notSettled', { count: prototype.settleBlockers.length })}
            </span>
          )}
          <span className="shrink-0 text-xs text-foreground/60">
            {t('prototypesList.patchCount', { count: prototype.patches.total })}
          </span>
        </>
      }
      // One menu content, two surfaces: EntityRow renders it as the hover "…"
      // dropdown and as the right-click context menu, so the two can never drift.
      menuContent={
        onAddPage || onDuplicate || onDelete ? (
          <PrototypeRowMenu onAddPage={onAddPage} onDuplicate={onDuplicate} onDelete={onDelete} />
        ) : undefined
      }
    >
      {isExpanded && (
        <PageList
          prototype={prototype}
          onOpenPage={onOpenPage}
          onAddPage={onAddPage}
          onSetEntryPage={onSetEntryPage}
          onRenamePage={onRenamePage}
          onRemovePage={onRemovePage}
        />
      )}
    </EntityRow>
  )
}

function PrototypeRowMenu({
  onAddPage,
  onDuplicate,
  onDelete,
}: {
  onAddPage?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {onAddPage && (
        <MenuItem onClick={onAddPage}>
          <Plus className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.newPage')}</span>
        </MenuItem>
      )}
      {(onAddPage && (onDuplicate || onDelete)) && <Separator />}
      {onDuplicate && (
        <MenuItem onClick={onDuplicate}>
          <Copy className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.duplicate')}</span>
        </MenuItem>
      )}
      {onDuplicate && onDelete && <Separator />}
      {onDelete && (
        <MenuItem onClick={onDelete} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.delete')}</span>
        </MenuItem>
      )}
    </>
  )
}

interface PageListProps {
  prototype: PrototypeStatus
  onOpenPage?: (page: PrototypePage) => void
  onAddPage?: () => void
  onSetEntryPage?: (page: string | null) => void
  onRenamePage?: (page: string) => void
  onRemovePage?: (page: PrototypePage) => void
}

/**
 * The pages of one prototype, in the order the flow gives them.
 *
 * An empty flow is said, not implied, and it comes with the way to add the first
 * page — the same state a just-created prototype is in.
 */
function PageList({
  prototype,
  onOpenPage,
  onAddPage,
  onSetEntryPage,
  onRenamePage,
  onRemovePage,
}: PageListProps) {
  const { t } = useTranslation()

  if (prototype.pages.length === 0) {
    return (
      <div className="pb-2 pl-6 pr-2">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <span className="flex-1 text-xs text-muted-foreground">{t('prototypesList.noPages')}</span>
          {onAddPage && (
            <button
              type="button"
              onClick={onAddPage}
              className="shrink-0 text-xs font-medium text-accent hover:underline underline-offset-2"
            >
              {t('prototypesList.newPage')}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="pb-1 pl-6">
      {prototype.pages.map((page) => (
        <PageRow
          key={page.name}
          page={page}
          onOpen={onOpenPage ? () => onOpenPage(page) : undefined}
          onSetEntry={onSetEntryPage ? () => onSetEntryPage(page.name) : undefined}
          onClearEntry={onSetEntryPage ? () => onSetEntryPage(null) : undefined}
          onRename={onRenamePage ? () => onRenamePage(page.name) : undefined}
          onRemove={onRemovePage ? () => onRemovePage(page) : undefined}
        />
      ))}
    </div>
  )
}

interface PageRowProps {
  page: PrototypePage
  onOpen?: () => void
  onSetEntry?: () => void
  onClearEntry?: () => void
  onRename?: () => void
  onRemove?: () => void
}

function PageRow({ page, onOpen, onSetEntry, onClearEntry, onRename, onRemove }: PageRowProps) {
  const { t } = useTranslation()
  // A page that cannot be opened says why in the dot's title instead of offering
  // a menu item that would only fail: a page of ours whose document is gone, or
  // one with no address to show (nothing is serving prototypes).
  const openable = !!page.url
  const dotTitle = page.kind === 'overlay'
    ? page.url ?? t('prototypesList.pageNoAddress')
    : page.file
      ? page.file
      : t('prototypesList.pageDocumentGone')

  return (
    <EntityRow
      onMouseDown={(e: React.MouseEvent) => {
        if (e.button === 0) onOpen?.()
      }}
      // Indented one level: a page belongs to the row above it.
      className="pl-4"
      icon={
        page.kind === 'overlay'
          ? <Layers className="h-3.5 w-3.5 text-foreground/50" />
          : <FileCode className="h-3.5 w-3.5 text-foreground/50" />
      }
      title={page.name}
      badges={
        <>
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
        </>
      }
      trailing={
        <StatusDot
          color={openable ? 'var(--success)' : 'var(--info)'}
          title={dotTitle}
        />
      }
      menuContent={
        <PageRowMenu
          entry={page.entry}
          openable={openable}
          onOpen={onOpen}
          onSetEntry={onSetEntry}
          onClearEntry={onClearEntry}
          onRename={onRename}
          onRemove={onRemove}
        />
      }
    />
  )
}

function PageRowMenu({
  entry,
  openable,
  onOpen,
  onSetEntry,
  onClearEntry,
  onRename,
  onRemove,
}: {
  entry: boolean
  openable: boolean
  onOpen?: () => void
  onSetEntry?: () => void
  onClearEntry?: () => void
  onRename?: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {onOpen && (
        <MenuItem onClick={onOpen} disabled={!openable}>
          <ExternalLink className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.pageOpen')}</span>
        </MenuItem>
      )}
      {onSetEntry && !entry && (
        <MenuItem onClick={onSetEntry}>
          <Flag className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.pageSetEntry')}</span>
        </MenuItem>
      )}
      {onClearEntry && entry && (
        <MenuItem onClick={onClearEntry}>
          <FlagOff className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.pageClearEntry')}</span>
        </MenuItem>
      )}
      {(onRename || onRemove) && <Separator />}
      {onRename && (
        <MenuItem onClick={onRename}>
          <Pencil className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.pageRename')}</span>
        </MenuItem>
      )}
      {onRemove && (
        <MenuItem onClick={onRemove} variant="destructive">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.pageDelete')}</span>
        </MenuItem>
      )}
    </>
  )
}
