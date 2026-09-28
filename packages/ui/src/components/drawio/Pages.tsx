/**
 * The pages of the diagram, as a row you pick one from — which page is showing, and the way to any
 * other.
 *
 * The pages are the document's own, read from the file, and this is only how they are shown: a page
 * added in draw.io is here the next time the block renders, and one removed is gone. Nothing is
 * written back, because a `.drawio` file has no *current* page — nothing in it says which page is
 * *the* page. Which one is on screen is the caller's state, and this reports a click rather than
 * holding anything itself.
 *
 * The block in a conversation and the window it opens both use this row, so the two agree on what a
 * page is called and which one is showing. A single page gets no row at all: there is nothing to
 * choose, and a row holding one name is furniture.
 */

import type { DrawioPage } from '@craft-agent/shared/drawio/types'
import { cn } from '../../lib/utils'

export interface DrawioPagesProps {
  pages: DrawioPage[]
  activeIndex: number
  onSelect: (index: number) => void
  className?: string
}

/** What a page is called here: its own name, or — for a page the document never named — its number. */
function nameOf(page: DrawioPage, index: number): string {
  return page.name || String(index + 1)
}

export function DrawioPages({ pages, activeIndex, onSelect, className }: DrawioPagesProps) {
  if (pages.length <= 1) return null

  return (
    <div className={cn('flex items-center gap-1 px-2 py-1 overflow-x-auto border-b bg-muted/20', className)}>
      {pages.map((page, index) => (
        <button
          key={`${page.id}:${index}`}
          type="button"
          // Which page is showing, said the way the platform says it: the current member of a set of
          // choices (`aria-current` on a button) — not a role that would promise a panel behind every
          // page's name, which is not what a page of a diagram is.
          aria-current={index === activeIndex}
          onClick={() => onSelect(index)}
          title={page.name || undefined}
          className={cn(
            'shrink-0 max-w-[180px] truncate px-2.5 h-[22px] rounded-[6px] text-[12px]',
            'transition-colors select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            index === activeIndex
              ? 'bg-background shadow-minimal text-foreground font-medium'
              : 'text-muted-foreground/70 hover:text-foreground',
          )}
        >
          {nameOf(page, index)}
        </button>
      ))}
    </div>
  )
}
