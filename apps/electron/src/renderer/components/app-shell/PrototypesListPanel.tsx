/**
 * PrototypesListPanel
 *
 * Workspace-scoped prototype list: the navigator slot's content while the
 * Prototypes item is active.
 *
 * **One level, on purpose**. This list answers exactly one
 * question — which prototype am I working on — because scope is the whole of what
 * a prototype is to the rest of the app: a folder holding a `PRD.md` and the work
 * beside it, that its conversations bind to. What is *inside* it is
 * not a second level here: the files are read on the prototype's own page, and the
 * pages a person works on are the workspace's browser window's tabs.
 *
 * So a row is a scope, not a folder: click it and you are looking at that
 * prototype; the dot says whether it is ready to hand over, and the menu holds the
 * decisions about *which prototypes exist* (duplicate, delete).
 */

import { useTranslation } from 'react-i18next'
import { Copy, FlaskConical, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { useMenuComponents } from '@/components/ui/menu-context'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

export interface PrototypesListPanelProps {
  prototypes: PrototypeStatus[]
  /** Opens the prototype's own page — its details, which is where its files are read. */
  onPrototypeClick: (slug: string) => void
  /** Opens the "New Prototype" dialog (the panel-header button lives in AppShell). */
  onAddPrototype?: () => void
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
 * A row carries a dot only when it has something to say: the PRD or the research has
 * something wrong with it, or something is still outstanding. **Nothing is not a colour** —
 * a prototype with no requirements at all has nothing outstanding either, and the row used to
 * answer that with a green "ready to hand over": a claim about work that does not exist yet.
 *
 * What counts as outstanding is `settleBlockers` — the gate's own list, so a row cannot look
 * finished while the details page says otherwise. The details page is where both lists are read
 * out in full; here the dot is the whole row, because a scope picker that also tried to report
 * would be a second, worse report.
 */
function statusColor(issues: number, blockers: number): string | null {
  if (issues > 0) return 'var(--destructive)'
  if (blockers > 0) return 'var(--info)'
  return null
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
  /** Copy this prototype. */
  onDuplicate?: () => void
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
  const issues = prototype.briefIssues.length
  const blockers = prototype.settleBlockers.length
  const color = statusColor(issues, blockers)

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
        color ? (
          <StatusDot
            color={color}
            title={
              issues > 0
                ? t('prototypeInfo.briefIssues')
                : t('prototypesList.notSettled', { count: blockers })
            }
          />
        ) : undefined
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
  onDuplicate?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const { MenuItem, Separator } = useMenuComponents()

  return (
    <>
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
