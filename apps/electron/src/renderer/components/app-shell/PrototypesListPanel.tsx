/**
 * PrototypesListPanel
 *
 * Workspace-scoped prototype list shown in the navigator slot when the
 * Prototypes sidebar item is active. Mirrors the lightweight skeleton of
 * ProjectsListPanel — no multi-select / drag-drop in v1, and no delete UI
 * (the workbench has no prototype-delete RPC).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { Info_Badge } from '@/components/info'
import type { PrototypeStatus } from '@craft-agent/shared/prototypes'

export interface PrototypesListPanelProps {
  prototypes: PrototypeStatus[]
  onPrototypeClick: (slug: string) => void
  /** Opens the "New Prototype" dialog (panel-header button lives in AppShell for prototypes mode). */
  onAddPrototype?: () => void
  selectedPrototypeSlug?: string | null
  className?: string
}

export function PrototypesListPanel({
  prototypes,
  onPrototypeClick,
  onAddPrototype,
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
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

interface PrototypeRowProps {
  prototype: PrototypeStatus
  isSelected: boolean
  isFirst: boolean
  onClick: () => void
}

function PrototypeRow({ prototype, isSelected, isFirst, onClick }: PrototypeRowProps) {
  const { t } = useTranslation()

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
          <Info_Badge color={prototype.baseHtmlPresent ? 'success' : 'warning'}>
            {prototype.baseHtmlPresent
              ? t('prototypesList.baseHtml')
              : t('prototypesList.baseHtmlMissing')}
          </Info_Badge>
          <span className="shrink-0 text-xs text-foreground/60">
            {t('prototypesList.patchCount', { count: prototype.patches.total })}
          </span>
        </>
      }
    />
  )
}
