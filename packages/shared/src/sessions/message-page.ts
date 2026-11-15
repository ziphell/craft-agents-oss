/**
 * A page of a conversation's messages, counted from the newest end.
 *
 * Long conversations are not transferred whole. The server keeps the complete
 * history (branching, compaction, token accounting and retries all need it);
 * what is paged is the **payload to a client**, which is where the cost is —
 * seven megabytes of JSON across the IPC boundary for the heaviest session on
 * this machine, and a renderer that then holds all of it.
 *
 * Pages are addressed from the newest message backwards: the first page is the
 * tail, and every following page ends just before the oldest message the caller
 * already holds. That is the direction a conversation reads in — it opens on the
 * newest turn and grows upwards as the reader scrolls.
 */

/**
 * How many messages one page carries.
 *
 * Chosen so a tool-heavy assistant turn (dozens of messages) still yields
 * several turns per page: the transcript renders twenty turns at a time, and
 * one page should cover about that many in the ordinary case.
 */
export const SESSION_MESSAGE_PAGE_SIZE = 200

export interface MessagePageOptions {
  /** Page size. Defaults to {@link SESSION_MESSAGE_PAGE_SIZE}. */
  limit?: number
  /** Return the messages *older than* the one with this id. Omit for the tail. */
  before?: string
  /**
   * Extend the page back until it holds at least this many questions.
   *
   * A tool-heavy turn can be longer than a whole page — an assistant working
   * through a long task posts dozens of messages between the question and its
   * answer. Cutting the page at a fixed message count then lands the reader in
   * the middle of that turn: the question they asked is not on screen, the turn
   * has no beginning, and everything that measures from it (the elapsed timer,
   * the "which turn am I in" rail) has nothing to measure from.
   *
   * So a page that is meant to *open* a conversation asks for a few questions to
   * be included, no matter how many messages that costs.
   */
  minQuestions?: number
  /**
   * Extend the page back until this message is included.
   *
   * This is how a client reaches a *specific* result — a search hit from the
   * middle of a history it never loaded — without leaving a hole: the page still
   * ends where the caller's window begins, it just starts earlier. Ignored when
   * the message is at or after `before` (it is already in the caller's range).
   */
  include?: string
}

export interface MessagePage<T> {
  messages: T[]
  /** Older messages exist that this page does not carry. */
  truncated: boolean
}

/** The fields a page needs to recognise a question, all optional. */
interface QuestionLike {
  role?: string
  hidden?: boolean
  isQueued?: boolean
}

/** Whether a message is something the person asked (as opposed to tool traffic). */
function isQuestion(message: QuestionLike | undefined): boolean {
  if (!message) return false
  return message.role === 'user' && !message.hidden && !message.isQueued
}

function countQuestions(messages: readonly QuestionLike[], from: number, to: number): number {
  let count = 0
  for (let index = from; index < to; index++) {
    if (isQuestion(messages[index])) count++
  }
  return count
}

/**
 * Cut one page out of `messages` (oldest → newest).
 *
 * A `before` id that no longer exists (deleted, compacted away) falls back to
 * the tail rather than returning nothing: the caller deduplicates by id, so a
 * repeated page costs one redundant response, while an empty one would read as
 * the end of the conversation.
 */
export function takeMessagePage<T extends { id: string } & QuestionLike>(
  messages: readonly T[],
  options: MessagePageOptions = {},
): MessagePage<T> {
  const limit = Math.max(1, Math.floor(options.limit ?? SESSION_MESSAGE_PAGE_SIZE))

  let end = messages.length
  if (options.before) {
    const index = messages.findIndex(message => message.id === options.before)
    if (index >= 0) end = index
  }

  let start = Math.max(0, end - limit)
  if (options.minQuestions && options.minQuestions > 0) {
    let seen = countQuestions(messages, start, end)
    while (start > 0 && seen < options.minQuestions) {
      start--
      if (isQuestion(messages[start])) seen++
    }
  }
  if (options.include) {
    const includeIndex = messages.findIndex(message => message.id === options.include)
    if (includeIndex >= 0 && includeIndex < end) start = Math.min(start, includeIndex)
  }

  return {
    messages: messages.slice(start, end),
    truncated: start > 0,
  }
}
