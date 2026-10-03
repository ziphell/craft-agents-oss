/**
 * useAskAgent — "hand this to the conversation", in one implementation.
 *
 * A report names some things that can only be settled **in a conversation**: an objection
 * somebody raised has to be answered, a link that points at nothing has to be fixed. For those,
 * a jump button is a door into an empty room — which is why the details pages say what is
 * outstanding and offer this instead. Both surfaces ask the same question, so the rule lives
 * here rather than in either one.
 *
 * Which conversation, in order:
 *
 * 1. **the focused one**, when it is already on this work — "the one you are in" is the least
 *    surprising target, and it keeps the two surfaces in sight of each other;
 * 2. otherwise **any** conversation on it — the work is long-lived and one conversation per
 *    project is the normal case;
 * 3. otherwise **a new one**, on it.
 *
 * The draft is the user's text: the line is **appended** (never replaced), and nothing is sent
 * on its own. The caller passes the line it wants handed over — for a notice that is
 * `notice.text`, the sentence the agent prints, so the conversation receives the same wording
 * the status output uses (`notices.ts`).
 */

import { useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { useActiveWorkspace, useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { focusedSessionIdAtom } from '@/atoms/panel-stack'
import { appendRestoredInput } from '@/lib/input-text'
import { navigate, routes } from '@/lib/navigate'
import {
  dispatchFocusInputEvent,
  dispatchRestoreInput,
} from '@/components/app-shell/input/focus-input-events'

/**
 * The work a conversation can be on.
 *
 * A **project** is the binding this app has (`projectId` on the session header).
 */
export interface AskAgentTarget {
  /** The project this work is in — a conversation counts when its `projectId` matches. */
  projectId?: string
  /** What a conversation created here is called, when there is none to reuse. */
  name?: string
}

export function useAskAgent(target: AskAgentTarget): (line: string) => Promise<void> {
  const workspace = useActiveWorkspace()
  const { onCreateSession, onInputChange, getDraft } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)
  const workspaceId = workspace?.id

  // Destructured so the callback's identity follows the values rather than the object literal
  // every caller passes: a target is written inline at the callsite, and a fresh object each
  // render would rebuild the callback each render with it.
  const { projectId, name } = target

  return useCallback(
    async (line: string) => {
      if (!workspaceId || !projectId) return

      const isOnThisWork = (sessionId: string) => {
        const meta = sessionMetaMap.get(sessionId) as
          | { projectId?: string }
          | undefined
        if (!meta) return false
        return meta.projectId === projectId
      }

      const focused = focusedSessionId && isOnThisWork(focusedSessionId) ? focusedSessionId : null
      let sessionId =
        focused ?? [...sessionMetaMap.values()].find((meta) => isOnThisWork(meta.id))?.id ?? null

      if (!sessionId) {
        const session = await onCreateSession(workspaceId, {
          projectId,
          name: name ?? projectId,
        })
        sessionId = session?.id ?? null
      }
      if (!sessionId) return

      // Into the composer the way every other "here is some text for you" goes there: the
      // draft **and** the event — the draft is what a composer reads on mount, the event
      // is what reaches one that is already open — then focus and go. Appended
      // (`appendRestoredInput`), so nothing the person already wrote is dropped, and
      // nothing is sent on its own.
      const next = appendRestoredInput(getDraft(sessionId), line)
      onInputChange(sessionId, next)
      dispatchRestoreInput(sessionId, next)
      dispatchFocusInputEvent({ sessionId })
      navigate(routes.view.allSessions(sessionId))
    },
    [
      workspaceId,
      projectId,
      name,
      sessionMetaMap,
      focusedSessionId,
      onCreateSession,
      getDraft,
      onInputChange,
    ],
  )
}
