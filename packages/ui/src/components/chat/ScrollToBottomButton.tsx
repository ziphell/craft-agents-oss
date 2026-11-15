/**
 * ScrollToBottomButton.tsx
 *
 * The "back to the newest message" affordance for a conversation the reader has
 * scrolled away from. It only answers while there is something below to return
 * to — at the bottom there is nothing to go back to.
 *
 * The button keeps its box when it fades out. That matters in the turn-rail
 * column: the ticks are laid out above it, so a box that appeared and vanished
 * would rock the whole column up and down every time the reader reached the
 * bottom.
 *
 * Two placements, one component:
 * - `rail` sits under the ticks, where the reader already looks for navigation.
 *   It is mouse-sized: the rail is a desktop-only affordance.
 * - `floating` overlays the messages area for compact/mobile layouts, where the
 *   rail is not rendered and the button has to be thumb-reached.
 */

import { motion } from 'motion/react'
import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

export interface ScrollToBottomButtonProps {
  /** True while newer content is out of view. */
  visible: boolean
  onClick: () => void
  variant?: 'rail' | 'floating'
  className?: string
}

export function ScrollToBottomButton({
  visible,
  onClick,
  variant = 'rail',
  className,
}: ScrollToBottomButtonProps) {
  const { t } = useTranslation()
  const isRail = variant === 'rail'

  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={t('chat.scrollToBottom')}
      title={t('chat.scrollToBottom')}
      // Hidden but present: out of the tab order and out of the way, while the
      // space it occupies stays reserved for the layout above it.
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      initial={false}
      animate={{
        opacity: visible ? 1 : 0,
        y: visible ? 0 : isRail ? 4 : 8,
        scale: visible ? 1 : 0.92,
      }}
      transition={{ duration: 0.14, ease: 'easeOut' }}
      className={cn(
        'flex items-center justify-center rounded-full',
        'border border-border/60 bg-background/85 text-foreground/60 backdrop-blur-sm',
        'shadow-sm transition-colors',
        'hover:border-border hover:bg-background hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isRail ? 'size-6' : 'size-9',
        !visible && 'pointer-events-none',
        className,
      )}
    >
      <ArrowDown className={isRail ? 'size-3' : 'size-4'} strokeWidth={2.25} aria-hidden="true" />
    </motion.button>
  )
}
