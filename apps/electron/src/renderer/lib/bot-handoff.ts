/**
 * Handing something to Craft Bot.
 *
 * Craft Bot is a conversation, and a conversation starts *somewhere*: the thing you just read,
 * the file you just made. This module turns "somewhere" into the text its composer opens with —
 * the third of the assistant's four doors, and the only one that is about **leaving** what you
 * are looking at rather than going to the assistant first.
 *
 * Three rules shape the text, and each one is a decision rather than a style:
 *
 * 1. **It is context, not a request.** Handing something over dispatches nothing: the person
 *    presses Enter. So the brief says what and where, and never says what to do — a brief that
 *    opens with an instruction would be sent as a command the moment someone presses Enter.
 * 2. **It names its origin.** `session <id>` is how the assistant can go back and read the
 *    source, and how the person can tell where a stranger's summary came from. A summary with
 *    no id is a claim the model cannot check and the person cannot trace.
 * 3. **It is short.** Six hundred characters of the source at most. The assistant can read the
 *    rest itself; filling the composer with a transcript pushes the one sentence the person has
 *    to write off the bottom of the box.
 */

/** How much of the source conversation's last reply is quoted, characters. */
const EXCERPT_LIMIT = 600

export interface ConversationHandoff {
  kind: 'conversation'
  /** The conversation's title, as the person sees it. */
  title: string
  /** Where it lives, so two workspaces with the same title are still distinguishable. */
  workspaceName: string
  /** The conversation itself — the id is the point, not decoration. */
  sessionId: string
  /** Its last assistant reply, already flattened by the caller or not; this module trims it. */
  lastText?: string | null
}

export interface FileHandoff {
  kind: 'file'
  /** Absolute path: the assistant can open it, and the person can recognise it. */
  path: string
  title: string
  /** `docx`, `md`, … — the card's badge. Omitted when unknown. */
  format?: string
  /** The conversation that wrote it, when the creations index knows. */
  sessionId?: string
  sessionName?: string | null
}

export type HandoffSource = ConversationHandoff | FileHandoff

/** One paragraph out of a message, so a multi-line reply does not break the quote block. */
function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > EXCERPT_LIMIT ? `${clean.slice(0, EXCERPT_LIMIT)}…` : clean
}

/**
 * The text the Bot's composer opens with.
 *
 * Ends with a blank line on purpose: the caret lands after it, so whatever the person types
 * reads as *their* instruction following the context, and never has to be inserted above it.
 */
export function buildHandoffBrief(source: HandoffSource): string {
  const lines: string[] = []

  if (source.kind === 'conversation') {
    lines.push(
      '[handoff] The person sent you this from a conversation in their workspace.',
      `- conversation: ${source.title}`,
    )
    if (source.workspaceName.trim()) lines.push(`- workspace: ${source.workspaceName}`)
    lines.push(`- session: ${source.sessionId}`)
    const last = source.lastText?.trim()
    if (last) {
      lines.push('', 'Its last reply:', `> ${excerpt(last)}`)
    }
  } else {
    const format = source.format ? ` (${source.format})` : ''
    lines.push(
      '[handoff] The person sent you this from a file in their workspace.',
      `- file: ${source.path}`,
      `- title: ${source.title}${format}`,
    )
    if (source.sessionId) {
      const who = source.sessionName?.trim() ? `"${source.sessionName.trim()}" ` : ''
      lines.push(`- written by: conversation ${who}(session ${source.sessionId})`)
    }
  }

  return `${lines.join('\n')}\n\n`
}
