/**
 * Shared visual helpers for Websites surfaces (tiles + detail header):
 * the freshness indicator derived from WebsiteConfig.
 */

import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { shortTimeLocale } from '@/utils/session'
import type { WebsiteConfig } from '@craft-agent/shared/websites/types'

export function relativeTime(epochMs: number): string {
  return formatDistanceToNowStrict(new Date(epochMs), {
    locale: shortTimeLocale as Locale,
    roundingMethod: 'floor',
  })
}

/**
 * Freshness of a website's data/content:
 * - last refresh failed → red dot + "refresh failed"
 * - last refresh ok     → green dot + relative time
 * - never refreshed     → neutral dot + relative updatedAt
 */
export function WebsiteFreshness({ config, className }: { config: WebsiteConfig; className?: string }) {
  const { t } = useTranslation()
  const last = config.lastRefresh

  let dotClass = 'bg-foreground/30'
  let text: string
  if (last && !last.ok) {
    dotClass = 'bg-red-500'
    text = t('websites.refreshFailed')
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
