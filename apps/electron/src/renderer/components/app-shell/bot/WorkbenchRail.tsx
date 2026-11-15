/**
 * The workbench: what the assistant started here, and what came back.
 *
 * It is a column of **cards**, not a list of rows: each one is a piece of work someone asked for,
 * so it gets the app's card language (the same border, radius and shadow as a board tile) and the
 * same hover-revealed corner action. Rows with a dot and a truncated title read as a log; a card
 * with a title, a time, a last line and its files reads as something you can decide about.
 *
 * Grouped by the only distinction that matters at a glance — still running, or finished — and each
 * group disappears when empty, so a quiet workbench is short rather than padded with headings.
 *
 * **Finished work is capped.** This column is a dial for "what is happening now", not an archive of
 * everything ever asked for: a list that grows with every request stops being read by the third day,
 * and the app already has the archive — a child is an ordinary session, it sits in the session list,
 * and archiving it takes it off the list *and* off this one. So the rail shows the newest
 * `FINISHED_LIMIT` and folds the rest into a single row that says how many, and where they are.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { Square } from 'lucide-react'
import type { BotTask, BotTaskResult } from '@craft-agent/shared/protocol'
import { cn } from '@/lib/utils'
import { shortTimeLocale } from '@/utils/session'

/** How many finished cards the rail holds before the rest fold into one row. */
export const FINISHED_LIMIT = 8

/**
 * How many cards the rail actually shows.
 *
 * Exported because the header's number and the list's length must be the same number — they are
 * read side by side, a few hundred pixels apart, and any disagreement looks like a bug even when
 * both are "right".
 */
export function visibleTaskCount(tasks: BotTask[]): number {
  const running = tasks.filter(task => task.state === 'running').length
  return running + Math.min(tasks.length - running, FINISHED_LIMIT)
}

export interface WorkbenchRailProps {
  tasks: BotTask[]
  results: Record<string, BotTaskResult>
  /** Open the conversation / task behind a card, in the workspace it belongs to. */
  onOpen: (task: BotTask) => void
  onStop: (task: BotTask) => void
  onOpenFile: (path: string) => void
  /** Where the work that has aged out of the rail lives: the session list. */
  onOpenArchive: () => void
}

export function WorkbenchRail({ tasks, results, onOpen, onStop, onOpenFile, onOpenArchive }: WorkbenchRailProps) {
  const { t } = useTranslation()
  // Running work is bounded by reality (a few runs, not a few hundred), so it is never capped.
  const running = tasks.filter(task => task.state === 'running')
  const finishedAll = tasks
    .filter(task => task.state !== 'running')
    .sort((a, b) => (b.lastMessageAt ?? b.startedAt) - (a.lastMessageAt ?? a.startedAt))
  const finished = finishedAll.slice(0, FINISHED_LIMIT)
  const older = finishedAll.length - finished.length

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {tasks.length === 0 ? (
          <p className="px-2 pt-4 text-[12px] leading-relaxed text-muted-foreground">
            {t('bot.noTasks', {
              defaultValue: 'Nothing yet. Work you ask for in this workspace shows up here.',
            })}
          </p>
        ) : (
          <>
            {running.length > 0 && (
              <Section label={t('bot.sectionRunning', { defaultValue: 'Running' })} count={running.length}>
                {running.map(task => (
                  <TaskCard
                    key={task.sessionId}
                    task={task}
                    result={results[task.sessionId]}
                    onOpen={onOpen}
                    onStop={onStop}
                    onOpenFile={onOpenFile}
                  />
                ))}
              </Section>
            )}
            {finished.length > 0 && (
              <Section label={t('bot.sectionDone', { defaultValue: 'Finished' })} count={finished.length}>
                {finished.map(task => (
                  <TaskCard
                    key={task.sessionId}
                    task={task}
                    result={results[task.sessionId]}
                    onOpen={onOpen}
                    onStop={onStop}
                    onOpenFile={onOpenFile}
                  />
                ))}
              </Section>
            )}
            {older > 0 && (
              <button
                type="button"
                onClick={onOpenArchive}
                className="mt-2 w-full rounded-md px-1.5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
              >
                {t('bot.olderTasks', {
                  defaultValue: '{{count}} older ones — in the session list',
                  count: older,
                })}
              </button>
            )}
          </>
        )}
    </div>
  )
}

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <section className="first:mt-1">
      <h3 className="flex items-center gap-1.5 px-1 pb-1.5 pt-3 text-[11px] font-medium text-foreground/45">
        {label}
        <span className="tabular-nums text-foreground/30">{count}</span>
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function TaskCard({
  task,
  result,
  onOpen,
  onStop,
  onOpenFile,
}: {
  task: BotTask
  result?: BotTaskResult
  onOpen: (task: BotTask) => void
  onStop: (task: BotTask) => void
  onOpenFile: (path: string) => void
}) {
  const { t } = useTranslation()
  const isRunning = task.state === 'running'
  const lastText = result?.lastText
  const artifacts = result?.artifacts ?? []
  const when = task.lastMessageAt
    ? formatDistanceToNowStrict(new Date(task.lastMessageAt), {
        locale: shortTimeLocale as Locale,
        roundingMethod: 'floor',
      })
    : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(task)
        }
      }}
      title={task.kind === 'task'
        ? t('bot.openTask', { defaultValue: 'Open the task' })
        : t('bot.open', { defaultValue: 'Open in its workspace' })}
      className={cn(
        'group relative cursor-pointer rounded-lg border border-border/50 bg-foreground/[0.02] px-2.5 py-2 shadow-minimal',
        'transition-colors hover:border-border/80 hover:bg-foreground/[0.035]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      <div className="min-w-0">
        {/* Only the title line steps aside for the corner action; the body keeps the full width,
            otherwise every running card wraps a word early for no reason. */}
        <div className={cn('flex items-center gap-1.5', isRunning && 'pr-6')}>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              isRunning ? 'bg-amber-500' : task.unread ? 'bg-amber-500/70' : 'bg-foreground/25',
            )}
            title={isRunning
              ? t('bot.stateRunning', { defaultValue: 'running' })
              : task.unread
                ? t('bot.stateUnread', { defaultValue: 'came back while you were away' })
                : undefined}
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight text-foreground">
            {task.name ?? task.sessionId}
          </span>
        </div>
        <div className="mt-[3px] flex items-center gap-1.5 pl-3 text-[10.5px] text-foreground/40">
          {task.kind === 'task' && task.progress && (
            <span className="tabular-nums">
              {t('bot.nodesProgress', {
                defaultValue: '{{done}}/{{total}} nodes',
                done: task.progress.done,
                total: task.progress.total,
              })}
            </span>
          )}
          {task.kind === 'task' && !task.progress && (
            <span>{t('bot.kindTask', { defaultValue: 'Task' })}</span>
          )}
          {when && <span className="tabular-nums">{when}</span>}
        </div>
      </div>

      {lastText && (
        <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-[11px] leading-[1.55] text-foreground/65">
          {lastText}
        </p>
      )}

      {artifacts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {artifacts.map(artifact => (
            <button
              key={artifact.path}
              type="button"
              onClick={event => {
                event.stopPropagation()
                onOpenFile(artifact.path)
              }}
              title={artifact.path}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-md border border-border/50 bg-foreground/[0.03] px-1.5 py-0.5 text-[10.5px] transition-colors hover:border-border',
                artifact.exists ? 'text-foreground/75 hover:text-foreground' : 'text-muted-foreground line-through',
              )}
            >
              <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground">{artifact.format}</span>
              <span className="min-w-0 truncate">{artifact.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Stopping a run is a different act from cancelling a turn, so it only exists on a card that
          is actually running — and only on hover, where it cannot be pressed by accident. */}
      {isRunning && (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            onStop(task)
          }}
          title={t('bot.cancel', { defaultValue: 'Stop' })}
          aria-label={t('bot.cancel', { defaultValue: 'Stop' })}
          className={cn(
            'absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md border border-border/60 bg-card',
            'text-foreground/50 opacity-0 shadow-minimal transition-opacity',
            'hover:bg-foreground/[0.05] hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
        >
          <Square className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
