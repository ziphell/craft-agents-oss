/**
 * ConversationSuffix - the tiny "2/4" that follows a session's title.
 *
 * A session folder keeps one conversation live and archives the earlier ones.
 * This is only a marker that there is more than one; it does nothing of its own.
 * It sits inside the title button, so a click opens the title menu, where the
 * conversation list — each stretch shown with its first message — is the way to
 * switch. Deliberately tiny: having several conversations is a fact about the
 * session, not a control that deserves header space.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionConversation } from '@craft-agent/shared/protocol'

export interface ConversationSuffixProps {
  sessionId: string
  /** The stretch the session is currently showing (from the session atom). */
  conversationId?: string
}

export function ConversationSuffix({ sessionId, conversationId }: ConversationSuffixProps) {
  const { t } = useTranslation()
  const [conversations, setConversations] = React.useState<SessionConversation[]>([])

  // Refetch when the live stretch changes (a `/replace` or a switch), since the
  // marker's numerator follows it.
  React.useEffect(() => {
    let cancelled = false
    window.electronAPI
      .listConversations(sessionId)
      .then(list => { if (!cancelled) setConversations(list) })
      .catch(() => { /* optional furniture: a failed read just hides it */ })
    return () => { cancelled = true }
  }, [sessionId, conversationId])

  if (conversations.length < 2) return null

  const ordered = [...conversations].sort((a, b) => a.startedAt - b.startedAt)
  const liveIndex = ordered.findIndex(conversation => conversation.isLive)

  return (
    <span
      className="shrink-0 text-[10px] font-normal leading-none tabular-nums text-muted-foreground/70"
      title={t('chat.conversations')}
    >
      {liveIndex + 1}/{ordered.length}
    </span>
  )
}
