/**
 * What the assistant's title opens.
 *
 * Removing the session menu was right — "move to project", "board column", "share", "archive"
 * are a conversation's verbs, and none of them are true of an assistant. But one of them **is**:
 * binding an IM bot, so the person can write to this assistant from their phone and have it start
 * work here. That is the one item, and it is the reason this menu exists at all.
 *
 * Rendered into `PanelHeader`'s dropdown, so it must stay a fragment of menu items; the menu
 * primitives come from the surrounding `StyledDropdownMenuContent`.
 */

import * as React from 'react'
import { MessagingSessionMenuItem } from '@/components/messaging/MessagingSessionMenuItem'

export function BotHeaderMenu({ sessionId }: { sessionId: string }) {
  return <MessagingSessionMenuItem sessionId={sessionId} />
}
