import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import { flattenLabels, type LabelConfig } from '@craft-agent/shared/labels'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import type { SessionStatus } from '@/config/session-status-config'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'
import { QueuedMessagesTray } from './QueuedMessagesTray'
import type { Message } from '../../../../shared/types'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  sessionLabels?: string[]
  labels?: LabelConfig[]
  onLabelsChange?: (labels: string[]) => void
  sessionStatuses?: SessionStatus[]
  currentSessionStatus?: string
  onSessionStatusChange?: (stateId: string) => void
  className?: string
  /** The person's messages waiting behind the running turn. */
  queuedMessages?: Message[]
  /** Messages other conversations sent while this turn was running — not the person's text. */
  queuedFromAgents?: Message[]
  /** The message the person is answering, if they picked one. */
  replyTo?: { messageId: string; role: string; excerpt: string } | null
  onClearReply?: () => void
  onDiscardQueuedFromAgent?: (message: Message) => void
  onEditQueued?: (message: Message) => void
  onRemoveQueued?: (message: Message) => void
  onSendQueuedNow?: (message: Message) => void
  onReorderQueued?: (messageId: string, toIndex: number) => void
  onReorderQueuedExpired?: () => void
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  sessionLabels = [],
  labels = [],
  onLabelsChange,
  sessionStatuses = [],
  currentSessionStatus = 'todo',
  onSessionStatusChange,
  className,
  queuedMessages,
  queuedFromAgents,
  onDiscardQueuedFromAgent,
  onEditQueued,
  onRemoveQueued,
  onSendQueuedNow,
  onReorderQueued,
  onReorderQueuedExpired,
  replyTo,
  onClearReply,
  inputProps,
}: ChatInputZoneProps) {
  const { t } = useTranslation()
  const [autoOpenLabelId, setAutoOpenLabelId] = React.useState<string | null>(null)
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  const handleLabelAdd = React.useCallback((labelId: string) => {
    const current = sessionLabels || []
    if (current.includes(labelId)) return

    onLabelsChange?.([...current, labelId])

    const config = flattenLabels(labels || []).find(label => label.id === labelId)
    if (config?.valueType) {
      setAutoOpenLabelId(labelId)
    }
  }, [labels, onLabelsChange, sessionLabels])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-2 pb-3' : 'px-3 @xs/panel:px-4 pb-4',
      className,
    )}>
      {/* What this message answers, above the input. The strip is the whole state: no reply
          selected, no strip — a permanent empty "replying to…" row would be furniture. */}
      {replyTo && (
        <div className="mb-1.5 flex items-start gap-2 rounded-md border border-border bg-foreground/[0.03] px-2 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-muted-foreground">
              {replyTo.role === 'user'
                ? t('chat.replyingToYourself', { defaultValue: 'Replying to your message' })
                : t('chat.replyingToAssistant', { defaultValue: 'Replying to an earlier answer' })}
            </div>
            <div className="truncate text-[11px] text-foreground/70">{replyTo.excerpt}</div>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            title={t('chat.cancelReply', { defaultValue: 'Cancel reply' })}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {((queuedMessages && queuedMessages.length > 0) || (queuedFromAgents && queuedFromAgents.length > 0)) && onEditQueued && onRemoveQueued && onSendQueuedNow && onReorderQueued && onReorderQueuedExpired && (
        <QueuedMessagesTray
          messages={queuedMessages ?? []}
          fromAgents={queuedFromAgents}
          onDiscardFromAgent={onDiscardQueuedFromAgent}
          isProcessing={!!inputProps.isProcessing}
          onEdit={onEditQueued}
          onRemove={onRemoveQueued}
          onSendNow={onSendQueuedNow}
          onReorder={onReorderQueued}
          onReorderExpired={onReorderQueuedExpired}
        />
      )}

      {shouldShowOptionBadges && (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          tasks={tasks}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          onKillTask={onKillTask}
          onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
          sessionLabels={sessionLabels}
          labels={labels}
          onLabelsChange={onLabelsChange}
          onRemoveLabel={(labelId) => {
            const next = (sessionLabels || []).filter(entry => entry !== labelId && !entry.startsWith(`${labelId}::`))
            onLabelsChange?.(next)
          }}
          autoOpenLabelId={autoOpenLabelId}
          onAutoOpenConsumed={() => setAutoOpenLabelId(null)}
          sessionStatuses={sessionStatuses}
          currentSessionStatus={currentSessionStatus}
          onSessionStatusChange={onSessionStatusChange}
        />
      )}

      <InputErrorBoundary
        sessionId={sessionId}
        resetKey={inputResetKey}
        onClearDraft={handleClearDraft}
      >
        <InputContainer
          {...inputProps}
          compactMode={compactMode}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          labels={labels}
          sessionLabels={sessionLabels}
          onLabelAdd={handleLabelAdd}
          sessionFolderPath={sessionFolderPath}
          sessionId={sessionId}
          currentSessionStatus={currentSessionStatus}
        />
      </InputErrorBoundary>
    </div>
  )
}
