/**
 * Craft Bot's entry in the compact (mobile) shell.
 *
 * On a desktop the assistant is a row in the sidebar. Compact mode hides the sidebar entirely
 * (`effectiveSidebarAndNavigatorHidden`), so that row — and `mod+j`, which needs a keyboard — were
 * the only two ways in, and neither exists on a phone-sized window. The assistant became
 * unreachable exactly where it is most useful ("start that thing from my phone").
 *
 * So it is a row at the top of the session list, where a mobile person starts: same glyph, the
 * running count when something is running, and one tap to the panel.
 *
 * This component owns its harness: it subscribes to the workbench store (which is cheap when no
 * artifacts are wanted) so AppShell does not have to poll for a badge it only draws here.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import { useBotWorkbench } from '@/atoms/bot-workbench'

export function BotMobileEntry() {
  const { t } = useTranslation()
  const { tasks } = useBotWorkbench()
  const running = tasks.filter(task => task.state === 'running').length

  return (
    <button
      type="button"
      onClick={() => navigate(routes.view.bot())}
      aria-label={t('bot.openAssistant', { defaultValue: 'Open Craft Bot' })}
      className={cn(
        'mx-2 mb-1 flex shrink-0 items-center gap-2 rounded-[10px] px-2.5 py-2 text-left',
        'transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.06]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
        {t('bot.name', { defaultValue: 'Craft Bot' })}
      </span>
      {running > 0 && (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-[1px] text-[10.5px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          {running}
        </span>
      )}
    </button>
  )
}
