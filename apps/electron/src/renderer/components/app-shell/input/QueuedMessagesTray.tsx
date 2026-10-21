import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, Clock, Paperclip, PencilLine, Trash2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Message } from '../../../../shared/types'

interface QueuedMessagesTrayProps {
  /** User messages waiting for the running turn to finish, in send order. */
  messages: Message[]
  /** Whether the turn these messages are waiting on is still running. */
  isProcessing: boolean
  /** Take the message out of the queue and put its text in the composer. */
  onEdit: (message: Message) => void
  /** Drop the message without touching the composer. */
  onRemove: (message: Message) => void
  /** Stop the running turn and send this message next. */
  onSendNow: (message: Message) => void
  /** Move a message to a new position (0-based, after removal). */
  onReorder: (messageId: string, toIndex: number) => void
  /** The dragged message was consumed by the agent before the drop landed. */
  onReorderExpired: () => void
  className?: string
}

/** One-line preview: queued text can be long, the editor has the full content. */
function previewOf(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

export function QueuedMessagesTray({
  messages,
  isProcessing,
  onEdit,
  onRemove,
  onSendNow,
  onReorder,
  onReorderExpired,
  className,
}: QueuedMessagesTrayProps) {
  const { t } = useTranslation()
  // Identity, not index: the queue is live, and the first entry can be replayed
  // while the pointer is still down. Indices shift under a drag; ids do not.
  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  // Insertion position: 0..messages.length, i.e. "before row N".
  const [dropIndex, setDropIndex] = React.useState<number | null>(null)
  // Collapsed shows just the header line. Local to this session's tray; the
  // component unmounts when the queue empties, so the next queue starts open.
  const [collapsed, setCollapsed] = React.useState(false)
  const canReorder = messages.length > 1

  // The source row can disappear mid-drag (the agent replayed it). Drop the
  // drag state so a later unrelated drag (e.g. files) is not mistaken for ours.
  React.useEffect(() => {
    if (draggingId && !messages.some(m => m.id === draggingId)) {
      setDraggingId(null)
      setDropIndex(null)
    }
  }, [messages, draggingId])

  if (messages.length === 0) return null

  return (
    <div className={cn(
      'mb-2 rounded-[10px] bg-background shadow-minimal px-2.5',
      collapsed ? 'py-1.5' : 'py-2',
      className,
    )}>
      <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" aria-hidden="true" />
        <span className="font-medium">{t('chat.queuedBadge')}</span>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">{messages.length}</span>
        {isProcessing && !collapsed && (
          <span className="ml-auto italic text-muted-foreground/70">{t('chat.queuedHint')}</span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(value => !value)}
          className={cn(
            'shrink-0 rounded-sm p-0.5 transition-colors hover:bg-foreground/10 hover:text-foreground cursor-pointer',
            isProcessing && !collapsed ? '' : 'ml-auto',
          )}
          title={collapsed ? t('chat.queuedExpand') : t('chat.queuedCollapse')}
          aria-label={collapsed ? t('chat.queuedExpand') : t('chat.queuedCollapse')}
          aria-expanded={!collapsed}
        >
          {collapsed
            ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            : <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
      {!collapsed && (
        <div className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {messages.map((message, index) => {
          const attachmentCount = message.attachments?.length ?? 0
          const showLineBefore = dropIndex === index
          const showLineAfter = index === messages.length - 1 && dropIndex === messages.length
          return (
            <div
              key={message.id}
              data-queued-row
              className={cn(
                'relative flex items-center gap-2 rounded-[6px] px-1.5 py-1 hover:bg-foreground/5',
                draggingId === message.id && 'opacity-40',
              )}
              onDragOver={e => {
                // Only our own row drags carry text/plain; file drags must fall
                // through to the composer.
                if (draggingId === null || !e.dataTransfer.types.includes('text/plain')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientY > rect.top + rect.height / 2
                setDropIndex(index + (after ? 1 : 0))
              }}
              onDrop={e => {
                e.preventDefault()
                if (draggingId === null) return

                // The agent can replay the dragged entry mid-drag; there is
                // nothing left to move then.
                if (!messages.some(m => m.id === draggingId)) {
                  setDraggingId(null)
                  setDropIndex(null)
                  onReorderExpired()
                  return
                }

                const rect = e.currentTarget.getBoundingClientRect()
                const after = e.clientY > rect.top + rect.height / 2
                // Resolve the target by identity against the list WITHOUT the
                // dragged entry: `toIndex` is applied after removal, and other
                // rows may have shifted while the pointer was down.
                const withoutSource = messages.filter(m => m.id !== draggingId)
                const targetRow = withoutSource.findIndex(m => m.id === message.id)
                if (targetRow === -1) {
                  // Dropped on itself.
                  setDraggingId(null)
                  setDropIndex(null)
                  return
                }

                onReorder(draggingId, targetRow + (after ? 1 : 0))
                setDraggingId(null)
                setDropIndex(null)
              }}
            >
              {showLineBefore && (
                <div className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full bg-foreground/40" />
              )}
              {showLineAfter && (
                <div className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-foreground/40" />
              )}
              <span
                draggable={canReorder}
                onDragStart={e => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', message.id)
                  const row = e.currentTarget.parentElement
                  if (row) e.dataTransfer.setDragImage(row, 8, 8)
                  setDraggingId(message.id)
                  setDropIndex(index)
                }}
                onDragEnd={() => {
                  setDraggingId(null)
                  setDropIndex(null)
                }}
                className={cn(
                  'w-4 shrink-0 select-none text-right text-[11px] tabular-nums text-muted-foreground/60',
                  canReorder && 'cursor-grab active:cursor-grabbing',
                )}
                title={canReorder ? t('chat.queuedReorder') : undefined}
                aria-label={canReorder ? t('chat.queuedReorder') : undefined}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]" title={previewOf(message.content)}>
                {previewOf(message.content)}
              </span>
              {attachmentCount > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
                  <Paperclip className="h-3 w-3" aria-hidden="true" />
                  {attachmentCount}
                </span>
              )}
              {isProcessing && (
                <button
                  type="button"
                  onClick={() => onSendNow(message)}
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground cursor-pointer"
                  title={t('chat.queuedSendNow')}
                  aria-label={t('chat.queuedSendNow')}
                >
                  <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onEdit(message)}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground cursor-pointer"
                title={t('chat.queuedEdit')}
                aria-label={t('chat.queuedEdit')}
              >
                <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(message)}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground cursor-pointer"
                title={t('chat.queuedRemove')}
                aria-label={t('chat.queuedRemove')}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )
        })}
        </div>
      )}
    </div>
  )
}
