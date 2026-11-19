/**
 * ToolbarStatusSlot
 *
 * Overlay slot for the input toolbar bottom row. It currently hosts the
 * escape-to-interrupt hint, shown while a turn is running.
 *
 * Positioned absolute inset-0 over the toolbar's relative container.
 * Uses AnimatePresence for smooth fade transitions between states.
 */

import * as React from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'

interface ToolbarStatusSlotProps {
  /** Whether the escape interrupt overlay should be visible */
  showEscapeOverlay: boolean
}

export function ToolbarStatusSlot({
  showEscapeOverlay,
}: ToolbarStatusSlotProps) {
  return (
    <AnimatePresence>
      {showEscapeOverlay && (
        <motion.div
          key="escape"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={cn(
            "absolute inset-0 z-10",
            "rounded-b-[12px]",
            "shadow-tinted",
            "flex items-center justify-center",
            "pointer-events-auto",
          )}
          style={{
            '--shadow-color': 'var(--info-rgb)',
            backgroundColor: 'color-mix(in srgb, var(--info) 10%, var(--background))',
            color: 'color-mix(in oklab, var(--info) 30%, var(--foreground))',
          } as React.CSSProperties}
        >
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Trans
              i18nKey="toolbar.escapeToInterrupt"
              components={{ kbd: <Kbd className="text-inherit bg-current/10" /> }}
            />
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
