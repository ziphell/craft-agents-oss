/**
 * Shared visual helpers for Designs surfaces (tiles + detail header):
 * the design-type badges and the freshness indicator derived from DesignConfig.
 */

import * as React from 'react'
import { AppWindow, Clapperboard, LayoutTemplate, Presentation, type LucideIcon } from 'lucide-react'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { shortTimeLocale } from '@/utils/session'
import type { DesignConfig, DesignKind } from '@craft-agent/shared/designs/types'

const DESIGN_KIND_ICONS: Record<DesignKind, LucideIcon> = {
  webpage: AppWindow,
  prototype: LayoutTemplate,
  deck: Presentation,
  motion: Clapperboard,
}

export function relativeTime(epochMs: number): string {
  return formatDistanceToNowStrict(new Date(epochMs), {
    locale: shortTimeLocale as Locale,
    roundingMethod: 'floor',
  })
}

/**
 * What this design is — the stored kind, which is also what the list filter and
 * the export menu bind to. One design is one kind (see @craft-agent/shared/
 * designs → kind.ts for why it is declared rather than inferred).
 */
export function DesignKindBadge({ kind, className }: { kind: DesignKind; className?: string }) {
  const { t } = useTranslation()
  const Icon = DESIGN_KIND_ICONS[kind]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border border-border/60 bg-foreground/[0.02] px-1.5 py-0.5 text-[10.5px] font-medium text-foreground/60',
        kind === 'webpage' && 'text-emerald-600 dark:text-emerald-400',
        kind === 'prototype' && 'text-sky-600 dark:text-sky-400',
        kind === 'deck' && 'text-orange-600 dark:text-orange-400',
        kind === 'motion' && 'text-violet-600 dark:text-violet-400',
        className,
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2} aria-hidden />
      {t(`designs.kind.${kind}`)}
    </span>
  )
}

/**
 * Freshness of a design's data/content:
 * - last refresh failed → red dot + "refresh failed"
 * - last refresh ok     → green dot + relative time
 * - never refreshed     → neutral dot + relative updatedAt
 */
export function DesignFreshness({ config, className }: { config: DesignConfig; className?: string }) {
  const { t } = useTranslation()
  const last = config.lastRefresh

  let dotClass = 'bg-foreground/30'
  let text: string
  if (last && !last.ok) {
    dotClass = 'bg-red-500'
    text = t('designs.refreshFailed')
  } else if (last) {
    dotClass = 'bg-emerald-500'
    text = relativeTime(last.at)
  } else {
    text = relativeTime(config.updatedAt)
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-[11px] text-foreground/50', className)}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  )
}
