/**
 * The workbench: a column pinned to the **right of the assistant's conversation**.
 *
 * Three placements were wrong before this one. Inside the assistant's panel, a second panel
 * squeezed the chat to a sliver while this column held its width (panels share the row). At the
 * window's right edge, work the assistant started ended up on the far side of whatever panel was
 * opened afterwards — the answer sitting apart from the question. The rule that holds is
 * adjacency: **immediately right of the conversation that started the work**, with anything opened
 * later flowing further right. It does not take part in the row's proportion maths, so its width is
 * its own and a new panel never eats into it.
 *
 * In compact (mobile) mode the same component is a full-screen sheet — the layout a column could
 * never give us.
 *
 * It is dismissible, and here a `×` **is** right: this is a tool panel, not a destination — the
 * same reason the assistant's own header has none.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PanelHeaderCenterButton } from '@/components/ui/PanelHeaderCenterButton'
import { botWorkbenchOpenAtom, setArtifactsWanted, useBotWorkbench } from '@/atoms/bot-workbench'
import { useAppShellContext } from '@/context/AppShellContext'
import { navigate, routes } from '@/lib/navigate'
import type { BotTask } from '@craft-agent/shared/protocol'
import { WorkbenchRail, visibleTaskCount } from './WorkbenchRail'

export function BotWorkbenchDock({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { onOpenFile } = useAppShellContext()
  const setOpen = useSetAtom(botWorkbenchOpenAtom)
  const { tasks, results, error } = useBotWorkbench()

  const openTask = React.useCallback((task: BotTask) => {
    navigate(routes.view.allSessions(task.sessionId), { newPanel: true })
  }, [])

  const stopTask = React.useCallback(async (task: BotTask) => {
    try {
      await window.electronAPI.cancelBotTask(task.sessionId, task.slug, task.runId)
    } catch {
      // The next poll will show what actually happened.
    }
  }, [])

  const shown = visibleTaskCount(tasks)

  // Files are only worth reading while there is somewhere to show them.
  React.useEffect(() => {
    setArtifactsWanted(true)
    return () => setArtifactsWanted(false)
  }, [])

  // `Esc` closes the nearest thing, and while this are open it is the nearest.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setOpen])

  return (
    <aside
      // Width as a class, not an inline style: the sheet variant overrides it with `w-full`, and an
      // inline `width` silently beat that class (which is how it became a 320px stripe down the
      // middle of a phone). `min-w-0` lets it give way before the row overflows.
      className={cn(
        'flex h-full w-[320px] min-w-0 shrink-0 flex-col overflow-clip bg-background shadow-middle',
        // An inner column: rounded on all four sides, like the panel beside it.
        'rounded-[10px]',
        className,
      )}
      aria-label={t('bot.workbenchTitle', { defaultValue: 'Workbench' })}
    >
      <header className="flex h-[42px] shrink-0 items-center gap-2 pl-3 pr-2">
        <span className="text-[13px] font-medium text-foreground">
          {t('bot.workbenchTitle', { defaultValue: 'Workbench' })}
        </span>
        {/* Counts **cards on screen**; the folded row inside accounts for the rest. */}
        {shown > 0 && <span className="text-[11px] tabular-nums text-foreground/35">{shown}</span>}
        <div className="flex-1" />
        <PanelHeaderCenterButton
          icon={<X className="h-4 w-4" />}
          tooltip={t('bot.closeWorkbench', { defaultValue: 'Close the workbench' })}
          onClick={() => setOpen(false)}
        />
      </header>

      {error && (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-destructive">{error}</p>
      )}

      <WorkbenchRail
        tasks={tasks}
        results={results}
        onOpen={openTask}
        onStop={task => void stopTask(task)}
        onOpenFile={onOpenFile}
        onOpenArchive={() => navigate(routes.view.allSessions())}
      />
    </aside>
  )
}
