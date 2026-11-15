/**
 * Chat component exports for @craft-agent/ui
 */

// Turn utilities (pure functions, no React)
export * from './turn-utils'
export * from './follow-up-helpers'

// Components
export { TurnCard, ResponseCard, SIZE_CONFIG, ActivityStatusIcon, type TurnCardProps, type ResponseCardProps, type ActivityItem, type ActivityStatus, type ResponseContent, type TodoItem, type OpenAnnotationRequest } from './TurnCard'
export { TurnRail, buildTurnRailItems, buildTurnRailItemsFromQuestions, type TurnRailProps, type TurnRailItem, type TurnRailQuestion } from './TurnRail'
export { ScrollToBottomButton, type ScrollToBottomButtonProps } from './ScrollToBottomButton'
export { AT_BOTTOM_THRESHOLD, distanceFromBottom, isScrolledToBottom, type ScrollMetrics } from './scroll-position'
export { InlineExecution, mapToolEventToActivity, type InlineExecutionProps, type InlineExecutionStatus, type InlineActivityItem } from './InlineExecution'
export { TurnCardActionsMenu, type TurnCardActionsMenuProps } from './TurnCardActionsMenu'
export { SessionViewer, type SessionViewerProps, type SessionViewerMode } from './SessionViewer'
export { UserMessageBubble, type UserMessageBubbleProps } from './UserMessageBubble'
export { SystemMessage, type SystemMessageProps, type SystemMessageType } from './SystemMessage'

// Attachment helpers
export { FileTypeIcon, getFileTypeLabel, type FileTypeIconProps } from './attachment-helpers'

// The one icon a mention chip shows, per kind (composer chip, message badge, @ menu)
export {
  MentionIcon,
  mentionIconSvg,
  mentionIconComponent,
  mentionIconKindFor,
  fileMentionIconKind,
  type MentionIconKind,
} from './mention-icons'

// Accept plan dropdown (for plan cards)
export { AcceptPlanDropdown } from './AcceptPlanDropdown'
