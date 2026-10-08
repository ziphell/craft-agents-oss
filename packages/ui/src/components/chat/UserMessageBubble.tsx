/**
 * UserMessageBubble - Shared user message component
 *
 * Displays user messages with right-aligned styling:
 * - Subtle background (5% foreground)
 * - Pill-shaped corners
 * - Max width 80%
 * - Markdown rendering for links and code
 * - Optional file attachments with thumbnails
 * - Content badges for @mentions (sources, skills)
 * - Pending/queued states (Electron only)
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clock } from 'lucide-react'
import type { StoredAttachment, ContentBadge } from '@craft-agent/core'
import { normalizePath } from '@craft-agent/core/utils'
import { cn } from '../../lib/utils'
import { Markdown } from '../markdown'
import { FileTypeIcon, getFileTypeLabel } from './attachment-helpers'
import { MentionIcon, mentionIconKindFor } from './mention-icons'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../tooltip'
import { useTranslation } from 'react-i18next'

// A reference badge's icon comes from the one set shared with the composer's chip and the @
// menu (see ./mention-icons). These two are not references, so they keep their own marks.
const CONTEXT_ICON_TEXT = '⚙'
const COMMAND_ICON_TEXT = '/'

/**
 * Check if a badge is an edit_request badge (identified by XML tag in rawText)
 */
function isEditRequestBadge(badge: ContentBadge): boolean {
  return badge.type === 'context' && !!badge.rawText?.includes('<edit_request>')
}

/**
 * EditRequestBadge - Standalone badge rendered above the user message bubble
 * Taller and with larger corner radius than inline badges for visual distinction
 */
function EditRequestBadge({ badge }: { badge: ContentBadge }) {
  const displayLabel = badge.collapsedLabel || badge.label
  return (
    <span className="inline-flex items-center h-[28px] px-2.5 rounded-[8px] bg-background shadow-minimal text-[13px] text-muted-foreground">
      {displayLabel}
    </span>
  )
}

/**
 * InlineBadge - Renders a single content badge inline with text
 * Styled to match the input field badges (bg-background with shadow)
 */
function InlineBadge({ badge }: { badge: ContentBadge }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      {badge.iconDataUrl ? (
        <img
          src={badge.iconDataUrl}
          alt=""
          className="h-[12px] w-[12px] rounded-[2px] shrink-0"
        />
      ) : (
        <MentionIcon
          kind={mentionIconKindFor(badge.type, badge.label)}
          className="h-[12px] w-[12px] shrink-0 text-muted-foreground"
        />
      )}
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )
}

/**
 * CommandBadge - Renders a slash command badge inline with text
 * Styled similarly to InlineBadge but indicates a SDK command (e.g., /compact)
 */
function CommandBadge({ badge }: { badge: ContentBadge }) {
  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      <span className="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[10px] font-medium">
        {COMMAND_ICON_TEXT}
      </span>
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )
}

/**
 * ContextBadge - Renders a context badge that collapses hidden content
 * Shows collapsed label and hides the raw content from display
 * Note: edit_request badges are handled separately by EditRequestBadge
 */
function ContextBadge({ badge }: { badge: ContentBadge }) {
  const { t } = useTranslation()
  const displayLabel = badge.collapsedLabel || badge.label

  return (
    <span
      className="inline-flex items-center gap-1 h-[22px] px-1.5 mr-1 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
      title={t('chat.contextBadge')}
    >
      <span className="h-[12px] w-[12px] rounded-[2px] bg-foreground/5 flex items-center justify-center text-foreground/50 shrink-0 text-[8px]">
        {CONTEXT_ICON_TEXT}
      </span>
      <span className="truncate max-w-[200px] text-muted-foreground">{displayLabel}</span>
    </span>
  )
}

/**
 * InlineFileBadge - File/folder badge for inline display within text.
 * Shows proper icon (folder, code file, or generic file) with Tooltip for full path.
 * Optionally clickable when onFileClick is provided.
 */
function InlineFileBadge({
  badge,
  onFileClick
}: {
  badge: ContentBadge
  onFileClick?: (path: string) => void
}) {
  // Strip .craft-agent workspace/session path prefix for cleaner tooltip display
  // e.g. "/Users/.../workspaces/{id}/sessions/{id}/plans/foo.md" → "plans/foo.md"
  const rawPath = badge.filePath || badge.label
  const tooltipPath = normalizePath(rawPath).replace(/^.*\.craft-agent\/workspaces\/[^/]+\/(sessions\/[^/]+\/)?/, '')
  const isClickable = !!badge.filePath && !!onFileClick

  const badgeContent = (
    <span
      role={isClickable ? 'button' : undefined}
      onClick={() => isClickable && onFileClick!(badge.filePath!)}
      className={cn(
        "inline-flex items-center gap-1 h-[22px] px-1.5 mx-0.5 rounded-[5px] bg-background shadow-minimal text-[12px] align-middle",
        isClickable && "hover:bg-foreground/5 transition-colors cursor-pointer"
      )}
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      <MentionIcon
        kind={mentionIconKindFor(badge.type, badge.label)}
        className="h-[12px] w-[12px] shrink-0 text-muted-foreground"
      />
      <span className="truncate max-w-[200px]">{badge.label}</span>
    </span>
  )

  // Wrap with Tooltip to show full path on hover
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badgeContent}
        </TooltipTrigger>
        <TooltipContent side="top">
          {tooltipPath}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Render content with badges inserted at their positions.
 * Text segments between badges are rendered as Markdown.
 *
 * Context badges (type='context') are special:
 * - They completely hide the marked content range
 * - They show a collapsed badge with the collapsedLabel
 * - Used for EditPopover metadata that shouldn't be visible to users
 *
 * File badges (type='file') render inline as clickable badges:
 * - Used for plan execution messages where file path appears inline with text
 */
function renderContentWithBadges(
  content: string,
  badges: ContentBadge[],
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void
): ReactNode {
  if (badges.length === 0) {
    return (
      <Markdown
        mode="minimal"
        onUrlClick={onUrlClick}
        onFileClick={onFileClick}
        className="text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap"
      >
        {content}
      </Markdown>
    )
  }

  // Sort badges by start position
  const sortedBadges = [...badges].sort((a, b) => a.start - b.start)

  const elements: ReactNode[] = []
  let lastEnd = 0

  sortedBadges.forEach((badge, i) => {
    // Add text before this badge
    if (badge.start > lastEnd) {
      const textBefore = content.slice(lastEnd, badge.start)
      if (textBefore.trim()) {
        elements.push(
          <Markdown
            key={`text-${i}`}
            mode="minimal"
            onUrlClick={onUrlClick}
            onFileClick={onFileClick}
            className="inline text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap [&_p]:inline"
          >
            {textBefore}
          </Markdown>
        )
      }
    }

    // Context badges hide content and show collapsed label
    // Command badges show SDK commands like /compact
    // File badges show clickable file references inline
    // Source/skill badges show inline with the original text
    // Note: edit_request badges are filtered out and rendered above the bubble separately
    if (badge.type === 'context') {
      elements.push(<ContextBadge key={`badge-${i}`} badge={badge} />)
    } else if (badge.type === 'command') {
      elements.push(<CommandBadge key={`badge-${i}`} badge={badge} />)
    } else if (badge.type === 'file' || badge.type === 'folder') {
      elements.push(<InlineFileBadge key={`badge-${i}`} badge={badge} onFileClick={onFileClick} />)
    } else {
      elements.push(<InlineBadge key={`badge-${i}`} badge={badge} />)
    }

    lastEnd = badge.end
  })

  // Add remaining text after last badge
  if (lastEnd < content.length) {
    const textAfter = content.slice(lastEnd)
    if (textAfter.trim()) {
      elements.push(
        <Markdown
          key="text-end"
          mode="minimal"
          onUrlClick={onUrlClick}
          onFileClick={onFileClick}
          className="inline text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap [&_p]:inline"
        >
          {textAfter}
        </Markdown>
      )
    }
  }

  // Use <p> to match Markdown's block-level line-height behavior
  return <p className="text-sm">{elements}</p>
}

export interface UserMessageBubbleProps {
  /** Message content (markdown supported) */
  content: string
  /** Additional className for the outer container */
  className?: string
  /** Callback when a URL is clicked */
  onUrlClick?: (url: string) => void
  /** Callback when a file path is clicked */
  onFileClick?: (path: string) => void
  /** Stored attachments (images, documents) */
  attachments?: StoredAttachment[]
  /** Content badges for inline display (sources, skills) */
  badges?: ContentBadge[]
  /** Whether the message is awaiting backend confirmation. User bubbles stay visually stable. */
  isPending?: boolean
  /** Whether the message is queued (badge shown) */
  isQueued?: boolean
  /** Compact mode - reduces padding for popover embedding */
  compactMode?: boolean
}

/** Minimum visible duration of the "Queued" chip. Both backends ack
 * mid-stream sends within ~50–150ms, which would otherwise make the chip
 * flash too briefly to register. Hold it long enough for the user to
 * actually read it. */
const QUEUED_MIN_VISIBLE_MS = 2500

export function UserMessageBubble({
  content,
  className,
  onUrlClick,
  onFileClick,
  attachments,
  badges,
  isQueued,
  compactMode,
}: UserMessageBubbleProps) {
  const { t } = useTranslation()
  const hasAttachments = attachments && attachments.length > 0

  // Show the queued chip while `isQueued` is true AND for at least
  // QUEUED_MIN_VISIBLE_MS after it first became true — even if the backend
  // acks in <150ms. Pure UI state; `isQueued` remains the persisted source
  // of truth.
  const [showQueued, setShowQueued] = useState(isQueued ?? false)
  const queuedShownAtRef = useRef<number | null>(isQueued ? Date.now() : null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }

    if (isQueued) {
      setShowQueued(true)
      if (queuedShownAtRef.current === null) {
        queuedShownAtRef.current = Date.now()
      }
      return
    }

    // isQueued flipped to false. Keep the chip up for the remainder of
    // the minimum visible window, then clear.
    if (queuedShownAtRef.current === null) return

    const elapsed = Date.now() - queuedShownAtRef.current
    const remaining = Math.max(0, QUEUED_MIN_VISIBLE_MS - elapsed)

    if (remaining === 0) {
      setShowQueued(false)
      queuedShownAtRef.current = null
      return
    }

    clearTimerRef.current = setTimeout(() => {
      setShowQueued(false)
      queuedShownAtRef.current = null
      clearTimerRef.current = null
    }, remaining)
  }, [isQueued])

  // Separate edit_request badges (rendered above bubble) from other badges (rendered inline)
  const editRequestBadges = badges?.filter(isEditRequestBadge) ?? []
  const inlineBadges = badges?.filter(b => !isEditRequestBadge(b)) ?? []
  const hasEditRequestBadges = editRequestBadges.length > 0
  const hasInlineBadges = inlineBadges.length > 0

  // Strip edit_request content from the displayed text
  // Each badge has start/end positions marking where to remove content
  let displayContent = content
  if (hasEditRequestBadges) {
    // Sort badges by start position descending so we can remove from end to start
    // (this preserves positions for earlier removals)
    const sortedBadges = [...editRequestBadges].sort((a, b) => b.start - a.start)
    for (const badge of sortedBadges) {
      displayContent = displayContent.slice(0, badge.start) + displayContent.slice(badge.end)
    }
    displayContent = displayContent.trim()
  }

  return (
    <div className={cn("flex flex-col items-end gap-3 w-full", className)}>
      {/* Attachment preview row - stored attachments with thumbnails */}
      {hasAttachments && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {attachments!.map((att, i) => {
            const isImage = att.type === 'image'
            const hasThumbnail = !!att.thumbnailBase64

            return (
              <div
                key={att.id || i}
                className="shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => att.storedPath && onFileClick?.(att.storedPath)}
                title={t('chat.clickToOpen', { name: att.name })}
              >
                {isImage ? (
                  /* IMAGE: Square thumbnail only */
                  <div className="h-14 w-14 rounded-[8px] overflow-hidden bg-background shadow-minimal">
                    {hasThumbnail ? (
                      <img
                        src={`data:image/png;base64,${att.thumbnailBase64}`}
                        alt={att.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center">
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                ) : (
                  /* DOCUMENT: Bubble with thumbnail/icon + 2-line text */
                  <div className="flex items-center gap-2.5 rounded-[8px] bg-user-message-bubble pl-1.5 pr-3 py-1.5">
                    <div className="h-11 w-8 rounded-[6px] overflow-hidden bg-background shadow-minimal flex items-center justify-center shrink-0">
                      {hasThumbnail ? (
                        <img
                          src={`data:image/png;base64,${att.thumbnailBase64}`}
                          alt={att.name}
                          className="h-full w-full object-cover object-top"
                        />
                      ) : (
                        <FileTypeIcon type={att.type} mimeType={att.mimeType} className="h-5 w-5" />
                      )}
                    </div>
                    <div className="flex flex-col min-w-0 max-w-[120px]">
                      <span className="text-xs font-medium line-clamp-2 break-all" title={att.name}>
                        {att.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {getFileTypeLabel(att.type, att.mimeType, att.name)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Badges row - edit request badges above text bubble */}
      {hasEditRequestBadges && (
        <div className="flex gap-2 justify-end max-w-[80%] flex-wrap">
          {editRequestBadges.map((badge, i) => (
            <EditRequestBadge key={`edit-badge-${i}`} badge={badge} />
          ))}
        </div>
      )}

      {/* Text content bubble. Queued messages render an inline header chip
          inside the bubble (Clock icon + 'Queued' italic) instead of a
          separate pill below — keeps the chat to one bubble per message
          while the chip and pulsing icon make the waiting state obvious
          (#616 follow-up). */}
      <div
        className={cn(
          "max-w-[80%] bg-user-message-bubble rounded-[16px] break-words min-w-0 select-text [&_p]:m-0",
          compactMode ? "px-4 py-2" : "px-5 py-3.5"
        )}
      >
        {showQueued && (
          <div
            className="flex items-center gap-1.5 text-foreground/55 mb-1.5"
            role="status"
            aria-live="polite"
          >
            <Clock className="h-3 w-3 animate-pulse" aria-hidden="true" />
            <span className="text-[11px] italic">{t('chat.queuedBadge')}</span>
          </div>
        )}
        {hasInlineBadges
          ? renderContentWithBadges(displayContent, inlineBadges, onUrlClick, onFileClick)
          : (
            <Markdown
              mode="minimal"
              onUrlClick={onUrlClick}
              onFileClick={onFileClick}
              className="text-sm [&_a]:underline [&_code]:bg-foreground/10 [&_p]:whitespace-pre-wrap"
            >
              {displayContent}
            </Markdown>
          )
        }
      </div>
    </div>
  )
}
