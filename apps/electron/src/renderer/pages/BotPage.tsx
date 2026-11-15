import * as React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAtom } from 'jotai'
import { PanelRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import ChatPage from '@/pages/ChatPage'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { botWorkbenchOpenAtom, useBotWorkbench } from '@/atoms/bot-workbench'
import { visibleTaskCount } from '@/components/app-shell/bot/WorkbenchRail'
import { BotHeaderMenu } from '@/components/app-shell/bot/BotHeaderMenu'

/**
 * Craft Bot — the assistant's conversation. The workbench is **not here**.
 *
 * It used to be a column inside this page, which worked until a second panel opened: panels share
 * the width, so the chat was squeezed to a sliver while the column held its 300px. It now lives in
 * `BotWorkbenchDock`, a window-level dock outside the panel row — so a panel opening never moves
 * it, its width survives navigation, and in compact mode it is a full-screen sheet.
 *
 * What is left here is a conversation, a running count, and the switch.
 *
 * The interaction is specified in `docs/craft-bot-interaction.md`.
 */
export function BotPage() {
  const { t } = useTranslation()
  const shell = useAppShellContext()
  const [workbenchOpen, setWorkbenchOpen] = useAtom(botWorkbenchOpenAtom)
  const { bot, tasks, error } = useBotWorkbench()

  // **No close button on the panel.** The assistant is a destination — the sidebar row and `mod+j`
  // are how you come and go — not a document you dismiss; the 作品 panel is built the same way and
  // carries no `×` either. The close affordance arrives through the shell context (the panel slot
  // injects it), so the one honest way to take it off for this page only is to take it out of the
  // context here, rather than teaching every header downstream about the assistant.
  const assistantShell = useMemo(() => ({ ...shell, rightSidebarButton: null }), [shell])

  const running = useMemo(() => tasks.filter(task => task.state === 'running').length, [tasks])
  const shownCount = useMemo(() => visibleTaskCount(tasks), [tasks])

  if (error && !bot) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="max-w-md text-center text-sm text-muted-foreground">{error}</p>
      </div>
    )
  }

  if (!bot) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('bot.loading', { defaultValue: 'Starting Craft Bot…' })}</div>
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <AppShellProvider value={assistantShell}>
          {/* `key`: a new conversation must not inherit the old one's scroll position, drafts or
              pending reply. Remounting is the honest reset. */}
          <ChatPage
            key={bot.sessionId}
            sessionId={bot.sessionId}
            assistantHeader={{
              menu: <BotHeaderMenu sessionId={bot.sessionId} />,
              badge: (running > 0 || bot.permissionMode === 'safe') ? (
                <span className="ml-1 flex items-center gap-1.5">
                  {running > 0 && (
                    <span className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-[1px] text-[10.5px] font-medium tabular-nums text-amber-700 dark:text-amber-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                      {t('bot.runningCount', { defaultValue: '{{count}} running', count: running })}
                    </span>
                  )}
                  {/* The one state that silently breaks "start work" instead of failing loudly. */}
                  {bot.permissionMode === 'safe' && (
                    <span
                      className="rounded-full bg-amber-500/15 px-1.5 py-[1px] text-[10.5px] text-amber-700 dark:text-amber-300"
                      title={t('bot.exploreHint', {
                        defaultValue: 'This workspace is in Explore mode: it can read and answer, but it cannot start work or write files.',
                      })}
                    >
                      {t('mode.explore', { defaultValue: 'Explore' })}
                    </span>
                  )}
                </span>
              ) : undefined,
              actions: (
                <PanelHeaderCenterButton
                  icon={(
                    <span className="flex items-center gap-1">
                      <PanelRight className="h-4 w-4" />
                      {shownCount > 0 && (
                        <span className={cn('text-[10.5px] tabular-nums', running > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground')}>
                          {shownCount}
                        </span>
                      )}
                    </span>
                  )}
                  tooltip={workbenchOpen
                    ? t('bot.closeWorkbench', { defaultValue: 'Close the workbench' })
                    : t('bot.workbench', { defaultValue: 'Open the workbench: what it started, and what came back' })}
                  aria-label={t('bot.workbench', { defaultValue: 'Open the workbench: what it started, and what came back' })}
                  aria-expanded={workbenchOpen}
                  onClick={() => setWorkbenchOpen(open => !open)}
                  className={cn(workbenchOpen && 'bg-foreground/[0.06] opacity-100')}
                />
              ),
            }}
          />
        </AppShellProvider>
      </div>
    </div>
  )
}

export default BotPage
