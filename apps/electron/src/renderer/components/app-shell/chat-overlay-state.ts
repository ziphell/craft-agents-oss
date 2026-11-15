/**
 * What the chat's document overlays are showing.
 *
 * These lived inside `ChatDisplay.tsx` until a turn's card needed to open one
 * (`AssistantTurnItem`): the turn owns the handlers that build these states —
 * details from its own activities, a diff from its own edits — and the chat
 * owns the overlay that renders them. So the shape lives here, in a module
 * neither owns, and both import it.
 */

import type { ActivityItem, FileChange } from '@craft-agent/ui'

/** State for multi-diff overlay (Edit/Write activities) */
export interface MultiDiffOverlayState {
  type: 'multi-diff'
  changes: FileChange[]
  consolidated: boolean
  focusedChangeId?: string
}

/** State for markdown overlay (pop-out, turn details, generic activities) */
export interface MarkdownOverlayState {
  type: 'markdown'
  content: string
  title: string
  /** When true, show raw markdown source in code viewer instead of rendered preview */
  forceCodeView?: boolean
}

/** Union of all overlay states, or null for no overlay */
export type ChatOverlayState =
  | { type: 'activity'; activity: ActivityItem }
  | MultiDiffOverlayState
  | MarkdownOverlayState
  | null
