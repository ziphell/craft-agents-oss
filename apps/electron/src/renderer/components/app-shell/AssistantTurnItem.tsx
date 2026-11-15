/**
 * One assistant turn, as the transcript's list renders it.
 *
 * This exists for one reason: **identity**. `TurnCard` is memoized, and a
 * conversation streams tens of `text_delta`s per second, so every prop it
 * receives has to keep its identity when the turn's own data has not changed —
 * otherwise the memo never bails and every mounted turn re-renders on every
 * token. It was written inline in `ChatDisplay`'s list, where nine of those
 * props were arrow functions created per render (`onBranch`, the four
 * annotation handlers, `onAcceptPlan`, …): `React.memo` was dead on arrival.
 *
 * So the split is:
 *
 * - **shared handlers** (`onBranch`, annotations, plan acceptance, pop-out,
 *   overlay) are owned by `ChatDisplay` and must arrive here stable — the chat
 *   builds them once and reads the live session through a ref;
 * - **per-turn handlers** (`onOpenDetails`, `onOpenActivityDetails`,
 *   `onOpenMultiFileDiff`, expansion) are bound to *this* turn, and are
 *   therefore `useCallback`s on the turn's own identity. They change when this
 *   turn changes, which is exactly when re-rendering it is correct.
 *
 * The list still owns the wrapper: its `key`, its ref (turn lookups for the rail
 * and for search both read it) and its search-highlight ring.
 */

import * as React from 'react'
import {
  TurnCard,
  formatTurnAsMarkdown,
  classifyFile,
  type ActivityItem,
  type AssistantTurn,
  type OpenAnnotationRequest,
} from '@craft-agent/ui'
import type { AnnotationV1 } from '@craft-agent/core/types'
import type { Message } from '../../../shared/types'
import type { ChatOverlayState } from './chat-overlay-state'
import { collectFileChangesFromActivities, getFirstFileChangeIdForActivity } from '@/lib/file-changes'

/**
 * The file a Read activity read, when that file is an image.
 *
 * An image is handed to the model as an attachment, so the result the UI keeps is only a
 * line of text. The picture itself is the file on disk — which is also what the person
 * wants to look at when they open the activity.
 */
function readImagePath(activity: ActivityItem): string | undefined {
  if (activity.toolName?.toLowerCase() !== 'read') return undefined
  const input = activity.toolInput as Record<string, unknown> | undefined
  const path = typeof input?.file_path === 'string'
    ? input.file_path
    : typeof input?.path === 'string'
      ? input.path
      : undefined
  return path && classifyFile(path).type === 'image' ? path : undefined
}

/** Whether a Write activity targets a document we render, rather than code to diff. */
function isDocumentWrite(activity: ActivityItem): boolean {
  if (activity.toolName !== 'Write') return false
  const input = activity.toolInput as Record<string, unknown> | undefined
  const filePath = (input?.file_path as string) || ''
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'txt'
}

export interface AssistantTurnItemProps {
  turn: AssistantTurn
  /** Stable key for this turn's expansion state (`getAssistantTurnUiKey`). */
  uiKey: string
  sessionId: string
  sessionFolderPath?: string
  /** The conversation's working directory — the folder this turn's relative file links resolve against. */
  workingDirectory?: string
  isExpanded: boolean
  onToggleTurn: (key: string, expanded: boolean) => void
  expandedActivityGroups: Set<string>
  onExpandedActivityGroupsChange: (groups: Set<string>) => void
  isLastResponse: boolean
  compactMode: boolean
  sendMessageKey: 'enter' | 'cmd-enter'
  openAnnotationRequest?: OpenAnnotationRequest | null
  hasActiveFollowUpAnnotations: boolean
  supportsBranching: boolean
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  onReply: (message: Pick<Message, 'id' | 'role' | 'content'>) => void
  onSaveAndSendFollowUp: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  onBranch: (messageId: string, options?: { newPanel?: boolean }) => void
  onAddAnnotation: (messageId: string, annotation: AnnotationV1) => void
  onRemoveAnnotation: (messageId: string, annotationId: string) => void
  onUpdateAnnotation: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  onAcceptPlan: () => void
  onAcceptPlanWithCompact: () => void
  onPopOut: (text: string) => void
  onOpenOverlay: (state: ChatOverlayState) => void
}

export const AssistantTurnItem = React.memo(function AssistantTurnItem({
  turn,
  uiKey,
  sessionId,
  sessionFolderPath,
  workingDirectory,
  isExpanded,
  onToggleTurn,
  expandedActivityGroups,
  onExpandedActivityGroupsChange,
  isLastResponse,
  compactMode,
  sendMessageKey,
  openAnnotationRequest,
  hasActiveFollowUpAnnotations,
  supportsBranching,
  onOpenFile,
  onOpenUrl,
  onReply,
  onSaveAndSendFollowUp,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  onAcceptPlan,
  onAcceptPlanWithCompact,
  onPopOut,
  onOpenOverlay,
}: AssistantTurnItemProps) {
  // Bound to this turn: recreated when this turn's object changes, which is the
  // only time this card needs to re-render anyway.
  const handleExpandedChange = React.useCallback(
    (expanded: boolean) => onToggleTurn(uiKey, expanded),
    [onToggleTurn, uiKey],
  )

  const openDetails = React.useCallback(() => {
    onOpenOverlay({ type: 'markdown', content: formatTurnAsMarkdown(turn), title: 'Turn Details' })
  }, [onOpenOverlay, turn])

  const openActivityDetails = React.useCallback((activity: ActivityItem) => {
    // Thinking/commentary is model-written markdown. Hand the raw source to the
    // document overlay (rendered as formatted markdown, not a code view) instead
    // of the tool-output heuristics (JSON / code / terminal), which can present
    // only part of a long passage.
    if (activity.type === 'intermediate' || activity.type === 'thinking') {
      onOpenOverlay({ type: 'markdown', content: activity.content || '', title: 'Thinking' })
      return
    }

    // Read of an image → the image overlay, with the file's path in its header.
    // The result the model left behind is only a line of text; the picture is
    // the file on disk.
    const imagePath = readImagePath(activity)
    if (imagePath) {
      onOpenFile(imagePath)
      return
    }

    // Edit/Write tool → Multi-file diff overlay (ungrouped, focused on this
    // change). A Write to .md/.txt is a document, so it opens as one.
    if ((activity.toolName === 'Edit' || activity.toolName === 'Write') && !isDocumentWrite(activity)) {
      const changes = collectFileChangesFromActivities(turn.activities)
      if (changes.length > 0) {
        onOpenOverlay({
          type: 'multi-diff',
          changes,
          consolidated: false,
          focusedChangeId: getFirstFileChangeIdForActivity(activity.id, changes),
        })
      }
      return
    }

    // All other tools → open generic activity cards overlay (Input/Output)
    onOpenOverlay({ type: 'activity', activity })
  }, [onOpenFile, onOpenOverlay, turn])

  const openMultiFileDiff = React.useCallback(() => {
    const changes = collectFileChangesFromActivities(turn.activities)
    if (changes.length > 0) {
      onOpenOverlay({ type: 'multi-diff', changes, consolidated: true })
    }
  }, [onOpenOverlay, turn])

  const hasEditOrWriteActivities = React.useMemo(
    () => turn.activities.some(a => a.toolName === 'Edit' || a.toolName === 'Write'),
    [turn.activities],
  )

  return (
    <TurnCard
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      baseDir={workingDirectory}
      hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
      turnId={turn.turnId}
      activities={turn.activities}
      response={turn.response}
      intent={turn.intent}
      isStreaming={turn.isStreaming}
      isComplete={turn.isComplete}
      isExpanded={isExpanded}
      onExpandedChange={handleExpandedChange}
      expandedActivityGroups={expandedActivityGroups}
      onExpandedActivityGroupsChange={onExpandedActivityGroupsChange}
      todos={turn.todos}
      onOpenFile={onOpenFile}
      onOpenUrl={onOpenUrl}
      isLastResponse={isLastResponse}
      compactMode={compactMode}
      onReply={onReply}
      sendMessageKey={sendMessageKey}
      openAnnotationRequest={openAnnotationRequest}
      onBranch={supportsBranching ? onBranch : undefined}
      onAddAnnotation={onAddAnnotation}
      onRemoveAnnotation={onRemoveAnnotation}
      onUpdateAnnotation={onUpdateAnnotation}
      onSaveAndSendFollowUp={onSaveAndSendFollowUp}
      onAcceptPlan={onAcceptPlan}
      onAcceptPlanWithCompact={onAcceptPlanWithCompact}
      onPopOut={onPopOut}
      onOpenDetails={openDetails}
      onOpenActivityDetails={openActivityDetails}
      onOpenMultiFileDiff={openMultiFileDiff}
      hasEditOrWriteActivities={hasEditOrWriteActivities}
    />
  )
})
