/**
 * TurnRail.tsx
 *
 * A slim navigator for the questions asked in the conversation, pinned beside
 * the messages area. One tick per user turn: hovering previews that question,
 * clicking scrolls to it.
 *
 * The rail is additive — the conversation itself is unchanged (all turns stay
 * expanded and flat). It is the "which question am I reading / jump to it"
 * affordance for long sessions, not a container for content.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { stripMarkdown } from './TurnCard'
import type { Turn } from './turn-utils'

export interface TurnRailItem {
  /** Matches the conversation's turn key, so clicks land on the same element. */
  key: string
  /** One line shown in the hover preview. */
  preview: string
}

/** Per-tick vertical pitch bounds. Ticks compress to `MIN` before they overflow. */
const TICK_PITCH_MAX = 6
const TICK_PITCH_MIN = 2
/** Vertical breathing room so the tick column does not touch the message fade. */
const RAIL_PADDING = 24
/** Roughly the preview card's height, used to keep it inside the rail. */
const PREVIEW_ESTIMATED_HEIGHT = 96
const PREVIEW_MAX_CHARS = 140

function messageText(message: Message): string {
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
          ? (block as { text: string }).text
          : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function toPreview(text: string): string {
  const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…` : flat
}

/**
 * Build the rail's items from the grouped turns.
 *
 * Only the user's own turns become ticks. The rail answers "which question am I
 * reading, and how do I get back to it" — assistant and system turns do not add
 * to that, they are the reply to a question already on the rail.
 *
 * `getKey` is the caller's turn-key function — the rail must hand back exactly
 * the keys the conversation registered its DOM refs under, otherwise a click
 * has nothing to scroll to.
 */
export function buildTurnRailItems(turns: Turn[], getKey: (turn: Turn) => string): TurnRailItem[] {
  const items: TurnRailItem[] = []

  for (const turn of turns) {
    if (turn.type !== 'user') continue
    items.push({ key: getKey(turn), preview: toPreview(messageText(turn.message)) })
  }

  return items
}

/**
 * A question in the conversation, as the server reports it.
 *
 * The rail is built from these rather than from the mounted turns, because a
 * client holds only part of a long conversation: a rail that ticks just the
 * questions inside the loaded page claims the conversation began there.
 */
export interface TurnRailQuestion {
  id: string
  text: string
}

/**
 * Build rail items from a conversation's whole list of questions.
 *
 * `keyFor` must produce the same keys the conversation registers its turn
 * elements under (`user-<messageId>` by default), or a click has nothing to
 * scroll to.
 */
export function buildTurnRailItemsFromQuestions(
  questions: readonly TurnRailQuestion[],
  keyFor: (messageId: string) => string = messageId => `user-${messageId}`,
): TurnRailItem[] {
  return questions.map(question => ({ key: keyFor(question.id), preview: toPreview(question.text) }))
}

export interface TurnRailProps {
  items: TurnRailItem[]
  /** Key of the turn currently at the reading position. */
  activeKey?: string | null
  onSelect: (key: string) => void
  /**
   * Rendered in the same centred column, directly under the ticks.
   *
   * It is part of that column rather than a separate row at the foot of the
   * rail: a short session would otherwise leave it parked at the bottom of the
   * pane, far away from the ticks it belongs to.
   */
  trailing?: ReactNode
  className?: string
}

export function TurnRail({ items, activeKey, onSelect, trailing, className }: TurnRailProps) {
  const { t } = useTranslation()
  // Hold the node in state rather than reading a ref once: the rail renders
  // `null` until it has two ticks, so on the first pass there is nothing to
  // measure — and an unwatched rail keeps a height of 0 forever, which crushes
  // the tick column into the top of the rail and drops the oldest ticks.
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null)
  const [railHeight, setRailHeight] = useState(0)
  const [hovered, setHovered] = useState<{ key: string; top: number } | null>(null)
  // The trailing slot takes height away from the ticks, so its size has to be
  // measured — a 200-turn session compresses the ticks to fit whatever is left.
  const [trailingEl, setTrailingEl] = useState<HTMLDivElement | null>(null)
  const [trailingHeight, setTrailingHeight] = useState(0)

  useEffect(() => {
    if (!trailingEl) {
      setTrailingHeight(0)
      return
    }
    const observer = new ResizeObserver(() => setTrailingHeight(trailingEl.offsetHeight))
    observer.observe(trailingEl)
    setTrailingHeight(trailingEl.offsetHeight)
    return () => observer.disconnect()
  }, [trailingEl])

  // Track the rail's height so the tick pitch can adapt to however many turns
  // the session has (a 20-turn chat and a 200-turn chat must both fit).
  useEffect(() => {
    if (!railEl) return
    const observer = new ResizeObserver(() => setRailHeight(railEl.clientHeight))
    observer.observe(railEl)
    setRailHeight(railEl.clientHeight)
    return () => observer.disconnect()
  }, [railEl])

  const pitch = useMemo(() => {
    if (items.length === 0) return TICK_PITCH_MAX
    const available = Math.max(0, railHeight - RAIL_PADDING * 2 - trailingHeight)
    // No room measured yet: compress, never expand. Falling back to the maximum
    // pitch here makes `overflow` exceed the rail's padding and clip the oldest
    // ticks — the exact thing the pitch is supposed to prevent.
    if (available === 0) return TICK_PITCH_MIN
    return Math.min(TICK_PITCH_MAX, Math.max(TICK_PITCH_MIN, available / items.length))
  }, [items.length, railHeight, trailingHeight])

  // A very long session can still outgrow the column even at the minimum pitch.
  // Shift the column up rather than clipping it, so the turns being read (the
  // newest ones) stay on the rail and the oldest ones fall off the top.
  const overflow = useMemo(() => {
    const available = Math.max(0, railHeight - RAIL_PADDING * 2)
    return Math.max(0, items.length * pitch + trailingHeight - available)
  }, [items.length, pitch, railHeight, trailingHeight])

  if (items.length < 2) return null

  const hoveredItem = hovered ? items.find((item) => item.key === hovered.key) : undefined
  const maxPreviewTop = Math.max(0, railHeight - PREVIEW_ESTIMATED_HEIGHT)

  return (
    <div
      ref={setRailEl}
      className={cn('relative z-20 h-full w-7 shrink-0 select-none', className)}
      onMouseLeave={() => setHovered(null)}
    >
      <div
        className="flex h-full flex-col items-center overflow-hidden"
        style={{ paddingTop: RAIL_PADDING, paddingBottom: RAIL_PADDING }}
        role="navigation"
        aria-label={t('chat.turnsNav')}
      >
        <div
          className={cn('flex flex-col items-center', overflow === 0 && 'my-auto')}
          style={overflow > 0 ? { marginTop: -overflow } : undefined}
        >
          {items.map((item) => {
            const isActive = item.key === activeKey
            return (
              <button
                key={item.key}
                type="button"
                aria-label={item.preview || undefined}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelect(item.key)}
                onMouseEnter={(event) =>
                  setHovered({ key: item.key, top: (event.currentTarget as HTMLElement).offsetTop })
                }
                onFocus={(event) =>
                  setHovered({ key: item.key, top: (event.currentTarget as HTMLElement).offsetTop })
                }
                onBlur={() => setHovered(null)}
                style={{ height: pitch }}
                className="group/tick flex w-7 items-center justify-center focus:outline-none"
              >
                <span
                  className={cn(
                    'block rounded-full transition-all duration-100',
                    isActive
                      ? 'h-[3px] w-4 bg-foreground'
                      : 'h-[2px] w-1.5 bg-foreground/25 group-hover/tick:bg-foreground/70 group-focus-visible/tick:bg-foreground/70'
                  )}
                />
              </button>
            )
          })}
          {trailing !== undefined && (
            <div
              ref={setTrailingEl}
              // `pt-2` is part of this box on purpose: the measured height then
              // includes the gap, and the ticks above are never drawn against
              // the button's edge.
              className="flex shrink-0 items-center justify-center pt-2"
            >
              {trailing}
            </div>
          )}
        </div>
      </div>

      {hoveredItem && (
        <div
          className="pointer-events-none absolute right-full z-30 mr-2 w-[240px] rounded-[8px] border border-border bg-popover p-2 shadow-md"
          style={{ top: Math.max(0, Math.min(hovered?.top ?? 0, maxPreviewTop)) }}
        >
          <p className="line-clamp-4 text-[12px] leading-snug text-foreground/80">
            {hoveredItem.preview}
          </p>
        </div>
      )}
    </div>
  )
}
