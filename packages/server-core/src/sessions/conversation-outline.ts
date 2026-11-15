/**
 * The conversation's shape: one entry per question the person asked.
 *
 * The turn rail is a navigator, not a rendering — it answers "which question am I
 * reading, and how do I get back to that one". A client that holds only the
 * newest page cannot answer that from its own messages, and a rail that only
 * ticks the questions inside the loaded page is worse than no rail: it silently
 * claims the conversation started where the page starts.
 *
 * So the outline comes from the whole history. Only the text is sent, truncated —
 * enough for the hover preview, small enough to ask for freely.
 */

import type { Message } from '@craft-agent/core'

export interface ConversationQuestion {
  /** Id of the user message — the client turns this into its turn key. */
  id: string
  /** Opening text, for the rail's hover preview. Truncated. */
  text: string
}

/**
 * How much of each question travels.
 *
 * The preview shows one line (the client further trims it), so this only has to
 * be long enough for a question that starts with a paragraph of context.
 */
export const QUESTION_PREVIEW_LIMIT = 400

/** Text of a message's content, whether it is a string or text blocks. */
function contentText(message: Message): string {
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

export function listQuestions(messages: readonly Message[]): ConversationQuestion[] {
  const questions: ConversationQuestion[] = []

  for (const message of messages) {
    // Same rule as the transcript: hidden nudges and not-yet-sent queued
    // messages are not questions the person asked.
    if (message.role !== 'user' || message.hidden || message.isQueued) continue

    const text = contentText(message).trim()
    if (!text) continue

    questions.push({
      id: message.id,
      text: text.length > QUESTION_PREVIEW_LIMIT ? text.slice(0, QUESTION_PREVIEW_LIMIT) : text,
    })
  }

  return questions
}
