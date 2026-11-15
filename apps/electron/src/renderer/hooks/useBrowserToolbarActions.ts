/**
 * useBrowserToolbarActions
 *
 * Handles the actions a browser panel's own toolbar forwards to the main window.
 *
 * The panel is a separate render process with no workspace or conversation context,
 * so it reports what the user did (`BrowserToolbarAction`) and this hook — which
 * knows the conversation the user is looking at — decides what it means.
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { PickedElement, PickedElementOrigin } from '@craft-agent/shared/protocol'

/**
 * An element handed to a conversation rather than to anything else.
 *
 * No workspace and no project: picking an element to talk about needs a
 * conversation and nothing else, so a plain tab someone opened in a window works
 * exactly like any other page.
 */
export interface AddElementRequest {
  element: PickedElement
  instanceId: string
  /** The page it was picked on — see `PickedElementOrigin`. */
  origin: PickedElementOrigin
  /**
   * Where it goes: the conversation the user is looking at, or `null` when there
   * is none — a window of its own, or nothing selected in the sidebar — in which
   * case the caller opens one rather than dropping the pick.
   */
  sessionId: string | null
}

export interface UseBrowserToolbarActionsOptions {
  /** The conversation the user is looking at, if any — where a pick goes. */
  activeSessionId?: string | null
  /** Called when the user used the bar under the selection. */
  onAddElementToConversation: (request: AddElementRequest) => void
}

export function useBrowserToolbarActions({
  activeSessionId,
  onAddElementToConversation,
}: UseBrowserToolbarActionsOptions): void {
  const { t } = useTranslation()

  useEffect(() => {
    const off = window.electronAPI.browserPane.onToolbarAction((action) => {
      if (action.kind === 'pick-failed') {
        toast.error(t('browserEdit.pickFailed'), { description: action.message })
        return
      }

      if (action.kind !== 'add-to-conversation') return

      // Where it goes is the conversation the user is looking at, not whoever
      // happens to be driving the window: the window is shared, so the hold on
      // it says what the agent last did, not where a person's pick belongs. With
      // nothing selected, `null` asks the caller to open a conversation — the
      // pick is never dropped for want of one.
      onAddElementToConversation({
        element: action.element,
        instanceId: action.instanceId,
        origin: action.origin,
        sessionId: activeSessionId ?? null,
      })
    })

    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeSessionId, onAddElementToConversation, t])
}
