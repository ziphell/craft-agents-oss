/**
 * PrototypesListPanel
 *
 * Workspace-scoped prototype list: the navigator slot's content while the
 * Prototypes item is active.
 *
 * **One level, on purpose** (plan §19.9, revised). This list answers exactly one
 * question — which prototype am I working on — because scope is the whole of what
 * a prototype is to the rest of the app: a handover unit (config, patches,
 * services and dist all live under it) that its conversations bind to. Its pages
 * are **not** a second level here:
 *
 * - A page is an address or a document. The place a page is looked at is the
 *   workspace's browser window, and the window's own tabs and address bar
 *   (`/<page>`, plan §12.6 / §16.3) are where switching between pages happens —
 *   they are also the only navigator that can show the page itself, with its
 *   patches applied. A list here could not.
 * - A page's facts and actions have a home: its prototype's details page, where
 *   the flow, the entry, the changes each page carries and whether its selectors
 *   still match are read together. Showing them in two places is how the two
 *   drift apart (the second level and the details page had grown two copies of
 *   "set as entry", "rename", "remove").
 *
 * So a row is a scope, not a folder: click it and you are looking at that
 * prototype; the dot says whether anything is wrong with it, the count says how
 * big the flow is, and the menu holds the decisions about *which prototypes
 * exist* (duplicate, duplicate with the changes folded in, delete). Adding a page
 * belongs to the flow you are looking at, so it lives in the details page's page
 * index.
 */

import { useTranslation } from 'react-i18next'
import { Copy, FlaskConical, Layers, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { useMenuComponents } from '@/components/ui/menu-context'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

export interface PrototypesListPanelProps {
  prototypes: PrototypeStatus[]
  /** Opens the prototype's own page — its details, which is where its pages are. */
  onPrototypeClick: (slug: string) => void
  /** Opens the "New Prototype" dialog (the panel-header button lives in AppShell). */
  onAddPrototype?: () => void
  /** Copies the prototype into a new one; the caller decides what to do with the result. */
  onDuplicatePrototype?: (slug: string, foldChanges?: boolean) => void
  /** Removes the prototype. The caller asks the user first — nothing here confirms. */
  onDeletePrototype?: (slug: string) => void
  selectedPrototypeSlug?: string | null
  className?: string
}

export function PrototypesListPanel({
  prototypes,
  onPrototypeClick,
  onAddPrototype,
  onDuplicatePrototype,
  onDeletePrototype,
  selectedPrototypeSlug,
  className,
}: PrototypesListPanelProps) {
  const { t } = useTranslation()

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
                onClick={() => onPrototypeClick(prototype.slug)}
                onDuplicate={
                  onDuplicatePrototype
                    ? (foldChanges) => onDuplicatePrototype(prototype.slug, foldChanges)
                    : undefined
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
 * The fourth state shares the amber of "no pages" and is told apart by its tooltip:
 * the two call for different actions. What counts as owing something is
 * `settleBlockers` — the gate's own list, so a row cannot look finished while the
 * details page says otherwise. The details page is where that list is read out in
 * full; here the dot and the page count are the whole row, because a scope picker
 * that also tried to report would be a second, worse report.
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
  onClick: () => void
  /** Copy this prototype; `true` folds the copy's changes on the way out (plan §21.3). */
  onDuplicate?: (foldChanges: boolean) => void
  onDelete?: () => void
}

function PrototypeRow({
  prototype,
  isSelected,
  isFirst,
  onClick,
  onDuplicate,
  onDelete,
}: PrototypeRowProps) {
  const { t } = useTranslation()
  const hasPages = prototype.pages.length > 0
  const issues = prototype.pageIssues.length
  const blockers = prototype.settleBlockers.length

  return (
    <EntityRow
      showSeparator={!isFirst}
      separatorClassName="pl-10 pr-4"
      isSelected={isSelected}
      onMouseDown={(e: React.MouseEvent) => {
        if (e.button === 0) onClick()
      }}
      icon={<FlaskConical className="h-3.5 w-3.5 text-foreground/60" />}
      title={prototype.slug}
      badges={
        <>
          <StatusDot
            color={statusColor(hasPages, issues, blockers)}
            title={
              issues > 0
                ? t('prototypesList.hasIssues', { count: issues })
                : blockers > 0
                  ? t('prototypesList.notSettled', { count: blockers })
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
        </>
      }
      // One menu content, two surfaces: EntityRow renders it as the hover "…"
      // dropdown and as the right-click context menu, so the two can never drift.
      menuContent={
        onDuplicate || onDelete ? (
          <PrototypeRowMenu onDuplicate={onDuplicate} onDelete={onDelete} />
        ) : undefined
      }
    />
  )
}

function PrototypeRowMenu({
  onDuplicate,
  onDelete,
}: {
  onDuplicate?: (foldChanges: boolean) => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
      {onDuplicate && (
        <MenuItem onClick={() => onDuplicate(false)}>
          <Copy className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.duplicate')}</span>
        </MenuItem>
      )}
      {/* The same copy, with its change layer collapsed on the way out: the copy starts
          as one document rather than a chain of patches, and this prototype is left
          alone. It lives here because a fold is only ever worth doing to a copy —
          nothing else in the app does it (plan §21.3). */}
      {onDuplicate && (
        <MenuItem onClick={() => onDuplicate(true)}>
          <Layers className="h-3.5 w-3.5" />
          <span className="flex-1">{t('prototypesList.duplicateFolded')}</span>
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
