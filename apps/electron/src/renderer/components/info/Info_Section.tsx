/**
 * Info_Section
 *
 * Section container with title, optional description, and content card.
 * Matches SettingsSection styling pattern.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface Info_SectionProps {
  /** Section title */
  title: string
  /** Optional description below title */
  description?: string
  /** Optional right-aligned header actions */
  actions?: React.ReactNode
  /** Anchor for a link that jumps here (the gate points at the section it names). */
  id?: string
  /**
   * Render the content without its card.
   *
   * For a section whose content is one line of "nothing here yet": the card is
   * what a section costs, and a screen with five empty cards reads as five things
   * to do. The title and its hint stay, so the reader still knows the section is
   * there and what it would hold.
   */
  bare?: boolean
  /** Section content */
  children: React.ReactNode
  className?: string
}

export function Info_Section({
  title,
  description,
  actions,
  id,
  bare = false,
  children,
  className,
}: Info_SectionProps) {
  return (
    <section id={id} className={cn('space-y-3 pt-2', className)}>
      <div className="flex items-start justify-between pl-1">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold">
            {title}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </div>
      {bare ? (
        children
      ) : (
        <div className="bg-background shadow-minimal rounded-[8px] overflow-hidden">
          {children}
        </div>
      )}
    </section>
  )
}
