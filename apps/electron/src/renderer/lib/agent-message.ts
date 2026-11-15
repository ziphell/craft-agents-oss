/**
 * Who said this, and what the person should see of it.
 *
 * A message in a conversation has three possible producers (see `Message.origin`), and only one of
 * them is the person at the keyboard. The renderer needs that answer in two places that used to
 * disagree with each other, because the only field available was `hidden` — which answers "do I
 * draw this", not "who wrote it":
 *
 * - the **draft tray** above the composer. It is the person's own unsent text. Another
 *   conversation's message sitting there offers to be edited into their words, and sending it
 *   would make them the author of something they never wrote;
 * - the **bubble**. An agent's message is a real turn and belongs in the transcript — attributed,
 *   and without the machine envelope it travels with.
 *
 * The envelope stays in `content` because that is what the model must read (it is how a
 * conversation knows who is asking, and where to reply). What a person sees is the message, not
 * the addressing.
 */

import type { Message } from '../../shared/types'

/** The three producers, resolved with `user` as the default (older rows predate the field). */
export function originOf(message: Pick<Message, 'origin'>): 'user' | 'agent' | 'system' {
  return message.origin ?? 'user'
}

/** True when another conversation wrote this — not the person, and not the app. */
export function isFromAgent(message: Pick<Message, 'origin'>): boolean {
  return originOf(message) === 'agent'
}

/**
 * Who to credit in the bubble, or `null` when nobody needs crediting.
 *
 * The name is what the sender is called on the board; the id is the fallback for a conversation
 * that has not been named yet, because an unnamed sender is still someone.
 */
export function agentAttribution(
  message: Pick<Message, 'origin' | 'fromSessionId' | 'fromSessionName'>,
): string | null {
  if (!isFromAgent(message)) return null
  return message.fromSessionName?.trim() || message.fromSessionId?.trim() || null
}

/**
 * The envelope `send_agent_message` prepends, as it is written today:
 *
 * ```
 * [Message from session "<id>" (<name>)]
 * Use send_agent_message with sessionId "<id>" to reply.
 *
 * ---
 *
 * <the message>
 * ```
 *
 * Matched loosely — the point is to drop addressing from what a person reads, and a message that
 * does not carry an envelope is simply returned unchanged.
 */
const ENVELOPE_RE =
  /^\s*\[Message from session [^\]]*\]\s*\n(?:[^\n]*\n)*?\s*---\s*\n[ \t]*\n?/

/**
 * What a person sees of an agent's message: everything after the envelope.
 *
 * Only applied to attributed messages — a message the person typed that happens to start with a
 * bracket is theirs to keep exactly as written.
 */
export function withoutAgentEnvelope(
  content: string,
  message: Pick<Message, 'origin' | 'fromSessionId' | 'fromSessionName'>,
): string {
  if (!isFromAgent(message)) return content
  return content.replace(ENVELOPE_RE, '').trimStart()
}

/** What the draft tray holds: the person's messages, and another conversation's, kept apart. */
export interface QueuedSplit {
  /** The person's own queued text — editable, removable, sendable now. */
  mine: Message[]
  /** Messages from other conversations, waiting for the current turn to end. Not editable. */
  fromAgents: Message[]
}

/**
 * Split a session's queued messages by who wrote them.
 *
 * Hidden ones are excluded from both sides: they are the app's own nudges ("your background task
 * finished", "the work you handed out came back"), which reach the model and never render — showing
 * one would put a wall of prompt text and an edit affordance in front of someone who never wrote it.
 */
export function splitQueued(messages: readonly Message[]): QueuedSplit {
  const mine: Message[] = []
  const fromAgents: Message[] = []
  for (const m of messages) {
    if (m.role !== 'user' || !m.isQueued || m.hidden) continue
    if (isFromAgent(m)) fromAgents.push(m)
    else mine.push(m)
  }
  return { mine, fromAgents }
}
