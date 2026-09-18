/**
 * usePrototypeAskAgent — "hand this to the conversation", in one implementation.
 *
 * A prototype's gate names some things that can only be settled **in a conversation**:
 * an objection somebody raised has to be answered, a verification round has to be run.
 * For those, a jump button is a door into an empty room — which is why the details page
 * stopped showing a section for each of them and offers this instead (plan §19.10,
 * revised). The prototype panel will offer the same thing (plan §23.4), and both must
 * answer the same question the same way, so the rule lives here rather than in either
 * surface.
 *
 * Which conversation, in order:
 *
 * 1. **the focused one**, when it is already bound to this prototype — "the one you are
 *    in" is the least surprising target, and it keeps the two surfaces in sight of each
 *    other;
 * 2. otherwise **any** conversation bound to it — a prototype is long-lived and one
 *    conversation per prototype is the normal case;
 * 3. otherwise **a new one**, bound to the prototype.
 *
 * The draft is the user's text: the line is **appended** (never replaced), and nothing is
 * sent on its own. The caller passes the line it wants handed over — for a gate notice
 * that is `notice.text`, the sentence the agent prints, so the conversation receives the
 * same wording the status output uses (`notices.ts`).
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

export function usePrototypeAskAgent(prototypeSlug: string): (line: string) => Promise<void> {
  const workspace = useActiveWorkspace()
  const { onCreateSession, onInputChange, getDraft } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)
  const workspaceId = workspace?.id

  return useCallback(
    async (line: string) => {
      if (!workspaceId) return

      const isBound = (sessionId: string) =>
        (sessionMetaMap.get(sessionId) as { prototypeSlug?: string } | undefined)?.prototypeSlug ===
        prototypeSlug

      const focused = focusedSessionId && isBound(focusedSessionId) ? focusedSessionId : null
      let sessionId =
        focused ??
        [...sessionMetaMap.values()].find(
          (meta) => (meta as { prototypeSlug?: string }).prototypeSlug === prototypeSlug,
        )?.id ??
        null

      if (!sessionId) {
        const session = await onCreateSession(workspaceId, { prototypeSlug, name: prototypeSlug })
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
      prototypeSlug,
      sessionMetaMap,
      focusedSessionId,
      onCreateSession,
      getDraft,
      onInputChange,
    ],
  )
}
