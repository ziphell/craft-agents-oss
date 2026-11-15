/**
 * Where a query occurs in a conversation.
 *
 * Search has to reach text the reader cannot see — that is the whole point of
 * it — so it runs here, over the complete history the server holds, and not over
 * whatever page a client happens to have loaded.
 *
 * There is exactly **one** definition of "searchable", and it is this one: every
 * client asks the server, so a count shown next to the search field means the
 * same thing in a fully loaded conversation and in one that has only its newest
 * page.
 *
 * What counts as searchable is what the transcript actually puts on screen:
 *
 * - user messages (hidden nudges and not-yet-sent queued messages excluded —
 *   they are not rendered);
 * - assistant messages that ended a turn (an intermediate or still-pending
 *   message is commentary inside the tool timeline, not a readable answer);
 * - system notices (error / info / warning).
 *
 * Tool output and plan bodies are not included: they are shown in cards, not as
 * prose, and counting them would inflate the count with text the reader never
 * sees as text.
 */

import type { Message } from '@craft-agent/core'

export interface MessageSearchHit {
  /** Id of the message the occurrences live in. */
  id: string
  /** Its role, so a client can resolve which turn to open without holding it. */
  role: Message['role']
  /** How many non-overlapping occurrences of the query it contains. */
  count: number
  /** Position in the conversation (oldest = 0), for ordering and diagnostics. */
  index: number
}

export interface MessageSearchResult {
  /** Total occurrences across the conversation. */
  total: number
  /** Per-message occurrences, in conversation order. */
  hits: MessageSearchHit[]
  /**
   * The hit list was cut at the cap: `total` is still exact, `hits` is not the
   * whole map of them. Clients say "1000+" rather than pretending to know.
   */
  limited: boolean
}

/**
 * How many hits (messages, not occurrences) one answer carries.
 *
 * A one-letter query matches nearly every message in a long conversation; the
 * cap keeps the payload and the client's flat match list bounded. Tuning this is
 * cheap — it is one object per matching message, not per occurrence.
 */
export const MESSAGE_SEARCH_HIT_LIMIT = 1500

/** The text a message contributes to search, or '' when it contributes none. */
export function searchableText(message: Message): string {
  if (message.hidden) return ''
  if (message.role === 'user' && message.isQueued) return ''

  switch (message.role) {
    case 'user': {
      const content = message.content as unknown
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter((block: { type?: string }) => block.type === 'text')
          .map((block: { text?: string }) => block.text ?? '')
          .join('\n')
      }
      return ''
    }
    case 'assistant':
      if (message.isIntermediate || message.isPending) return ''
      return message.content ?? ''
    case 'error':
    case 'info':
    case 'warning':
      return message.content ?? ''
    default:
      return ''
  }
}

/** Non-overlapping occurrences of `query`, case-insensitively. */
export function countOccurrences(text: string, query: string): number {
  if (!query) return 0
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let count = 0
  let position = 0
  while ((position = haystack.indexOf(needle, position)) !== -1) {
    count++
    position += needle.length
  }
  return count
}

export function searchMessages(
  messages: readonly Message[],
  query: string,
  hitLimit: number = MESSAGE_SEARCH_HIT_LIMIT,
): MessageSearchResult {
  const trimmed = query.trim()
  if (!trimmed) return { total: 0, hits: [], limited: false }

  const hits: MessageSearchHit[] = []
  let total = 0
  let limited = false

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    const text = searchableText(message)
    if (!text) continue

    const count = countOccurrences(text, trimmed)
    if (count === 0) continue

    total += count
    if (hits.length < hitLimit) {
      hits.push({ id: message.id, role: message.role, count, index })
    } else {
      limited = true
    }
  }

  return { total, hits, limited }
}
