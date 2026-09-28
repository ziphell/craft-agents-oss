/**
 * TurnRail.tsx
 *
 * A slim navigator for the conversation's turns, pinned beside the messages area.
 * One tick per turn: hovering previews that turn, clicking scrolls to it.
 *
 * The rail is additive — the conversation itself is unchanged (all turns stay
 * expanded and flat). It is the "where am I / jump there" affordance for long
 * sessions, not a container for content.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, CircleAlert, Info, User } from 'lucide-react'
import type { Message } from '@craft-agent/core'
import { cn } from '../../lib/utils'
import { getPreviewText, stripMarkdown } from './TurnCard'
import { getTurnIntent, hasErrorActivities, type Turn } from './turn-utils'

/** Which side of the conversation a turn came from. Drives the tick's length. */
export type TurnRailRole = 'user' | 'assistant' | 'system'

export interface TurnRailItem {
  /** Matches the conversation's turn key, so clicks land on the same element. */
  key: string
  role: TurnRailRole
  /** One line shown in the hover preview. */
  preview: string
  /** Tool/step count for assistant turns. */
  steps?: number
  /** True when a step in this turn failed. */
  hasError?: boolean
}

/** Per-tick vertical pitch bounds. Ticks compress to `MIN` before they overflow. */
const TICK_PITCH_MAX = 6
const TICK_PITCH_MIN = 2
/** Vertical breathing room so the tick column does not touch the message fade. */
const RAIL_PADDING = 24
/** Roughly the preview card's height, used to keep it inside the rail. */
const PREVIEW_ESTIMATED_HEIGHT = 96
const PREVIEW_MAX_CHARS = 140

const ROLE_ICON: Record<TurnRailRole, typeof User> = {
  user: User,
  assistant: Bot,
  system: Info,
}

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
 * `getKey` is the caller's turn-key function — the rail must hand back exactly
 * the keys the conversation registered its DOM refs under, otherwise a click
 * has nothing to scroll to.
 */
export function buildTurnRailItems(turns: Turn[], getKey: (turn: Turn) => string): TurnRailItem[] {
  const items: TurnRailItem[] = []

  for (const turn of turns) {
    // Credential/OAuth prompts are transient gates, not conversation turns worth navigating.
    if (turn.type === 'auth-request') continue

    const key = getKey(turn)

    if (turn.type === 'assistant') {
      const preview =
        toPreview(turn.response?.text ?? '')
        || getTurnIntent(turn)
        || getPreviewText(turn.activities, turn.intent, turn.isStreaming, !!turn.response, turn.isComplete)
      items.push({
        key,
        role: 'assistant',
        preview,
        steps: turn.activities.length || undefined,
        hasError: hasErrorActivities(turn),
      })
      continue
    }

    items.push({
      key,
      role: turn.type === 'user' ? 'user' : 'system',
      preview: toPreview(messageText(turn.message)),
    })
  }

  return items
}

export interface TurnRailProps {
  items: TurnRailItem[]
  /** Key of the turn currently at the reading position. */
  activeKey?: string | null
  onSelect: (key: string) => void
  className?: string
}

export function TurnRail({ items, activeKey, onSelect, className }: TurnRailProps) {
  const { t } = useTranslation()
  const railRef = useRef<HTMLDivElement>(null)
  const [railHeight, setRailHeight] = useState(0)
  const [hovered, setHovered] = useState<{ key: string; top: number } | null>(null)

  // Track the rail's height so the tick pitch can adapt to however many turns
  // the session has (a 20-turn chat and a 200-turn chat must both fit).
  useEffect(() => {
    const el = railRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setRailHeight(el.clientHeight))
    observer.observe(el)
    setRailHeight(el.clientHeight)
    return () => observer.disconnect()
  }, [])

  const pitch = useMemo(() => {
    if (items.length === 0) return TICK_PITCH_MAX
    const available = Math.max(0, railHeight - RAIL_PADDING * 2)
    if (available === 0) return TICK_PITCH_MAX
    return Math.min(TICK_PITCH_MAX, Math.max(TICK_PITCH_MIN, available / items.length))
  }, [items.length, railHeight])

  // A very long session can still outgrow the column even at the minimum pitch.
  // Shift the column up rather than clipping it, so the turns being read (the
  // newest ones) stay on the rail and the oldest ones fall off the top.
  const overflow = useMemo(() => {
    const available = Math.max(0, railHeight - RAIL_PADDING * 2)
    return Math.max(0, items.length * pitch - available)
  }, [items.length, pitch, railHeight])

  if (items.length < 2) return null

  const hoveredItem = hovered ? items.find((item) => item.key === hovered.key) : undefined
  const HoveredIcon = hoveredItem ? ROLE_ICON[hoveredItem.role] : null
  const maxPreviewTop = Math.max(0, railHeight - PREVIEW_ESTIMATED_HEIGHT)

  return (
    <div
      ref={railRef}
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
                    item.role === 'assistant' ? 'w-2.5' : 'w-1.5',
                    isActive
                      ? 'h-[3px] w-4 bg-foreground'
                      : 'h-[2px] bg-foreground/25 group-hover/tick:bg-foreground/70 group-focus-visible/tick:bg-foreground/70',
                    !isActive && item.hasError && 'bg-destructive/60'
                  )}
                />
              </button>
            )
          })}
        </div>
      </div>

      {hoveredItem && (
        <div
          className="pointer-events-none absolute right-full z-30 mr-2 w-[240px] rounded-[8px] border border-border bg-popover p-2 shadow-md"
          style={{ top: Math.max(0, Math.min(hovered?.top ?? 0, maxPreviewTop)) }}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {HoveredIcon && <HoveredIcon className="h-3 w-3 shrink-0" />}
            {hoveredItem.steps !== undefined && (
              <span className="tabular-nums">{hoveredItem.steps}</span>
            )}
            {hoveredItem.hasError && <CircleAlert className="h-3 w-3 shrink-0 text-destructive" />}
          </div>
          <p className="mt-1 line-clamp-4 text-[12px] leading-snug text-foreground/80">
            {hoveredItem.preview}
          </p>
        </div>
      )}
    </div>
  )
}
