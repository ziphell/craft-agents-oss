/**
 * TweaksListPanel
 *
 * Workspace-scoped tweak list: the navigator slot's content while the Tweaks
 * item is active. One row per tweak — what it is called, and whether it has
 * code. A tweak's own page is the content column beside it, and the pages a
 * tweak runs on are listed there rather than here: a row that grew a chip per
 * match read as a wall of them, and rows stopped being comparable.
 *
 * The description is not here either: it is the note an agent wrote about the
 * code, and it belongs on the page that shows the code. A row's job is telling
 * tweaks apart.
 *
 * On/off is not a chip here. Every tweak carries a switch on its own page, and a
 * chip on every row said "on" for most of them — the same reason a running
 * automation is not chipped: the exception is the news. A tweak that is off is
 * dimmed, which is how the automations list already says it.
 *
 * There is deliberately no "New tweak" here: a tweak is written by an agent (it
 * is code for a page this app does not own), and a form that produced an empty
 * tweak would only be a folder with nothing in it. The empty state says that
 * instead of offering a button that cannot work.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { EntityRow } from '@/components/ui/entity-row'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import type { TweakSummary } from '@craft-agent/shared/tweaks'

export interface TweaksListPanelProps {
  tweaks: TweakSummary[]
  /** Opens the tweak's own page. */
  onTweakClick: (slug: string) => void
  /** Starts a conversation with an agent to write a tweak. */
  onAskAgent: () => void
  selectedTweakSlug?: string | null
  className?: string
}

export function TweaksListPanel({
  tweaks,
  onTweakClick,
  onAskAgent,
  selectedTweakSlug,
  className,
}: TweaksListPanelProps) {
  const { t } = useTranslation()

  // Most recently edited first: a tweak being worked on is the one being looked for.
  const ordered = React.useMemo(
    () => [...tweaks].sort((a, b) => b.updatedAt - a.updatedAt),
    [tweaks],
  )

  if (tweaks.length === 0) {
    return (
      <div className={cn('flex flex-col flex-1 min-h-0', className)}>
        <EntityListEmptyScreen
          icon={<Wand2 />}
          title={t('tweaks.emptyTitle')}
          description={t('tweaks.emptyDescription')}
        >
          <button
            type="button"
            onClick={onAskAgent}
            className="inline-flex h-7 items-center gap-1.5 rounded-[8px] bg-background px-3 text-xs font-medium shadow-minimal transition-colors hover:bg-foreground/[0.03]"
          >
            <Sparkles className="h-3.5 w-3.5" /> {t('tweaks.askAgent')}
          </button>
        </EntityListEmptyScreen>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      <ScrollArea className="flex-1">
        <div className="pb-2" data-list-role="tweaks">
          <div className="pt-1">
            {ordered.map((tweak, index) => (
              <EntityRow
                key={tweak.slug}
                className={cn(!tweak.enabled && 'opacity-50')}
                showSeparator={index > 0}
                isSelected={selectedTweakSlug === tweak.slug}
                onMouseDown={(e: React.MouseEvent) => {
                  if (e.button === 0) onTweakClick(tweak.slug)
                }}
                icon={<Wand2 className="h-3.5 w-3.5 text-foreground/60" />}
                title={tweak.name}
                badges={
                  /* Only the exception earns a chip: having code is what a working tweak
                     always is, so a chip saying so would sit on every row and mean
                     nothing. Having none is the state worth flagging. */
                  !tweak.hasCode ? <TweakChip>{t('tweaks.noCode')}</TweakChip> : undefined
                }
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

/** The one chip a row can carry: no code, which is the state worth flagging. */
function TweakChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10.5px] font-medium text-destructive">
      {children}
    </span>
  )
}
