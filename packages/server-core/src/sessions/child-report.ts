/**
 * What the assistant is told when work it started comes back.
 *
 * The rail already shows the task and its artifacts; nobody reads a rail. The point of this text
 * is to make the assistant **say the result in the conversation**, which is the difference between
 * "three cards over there" and "Alpha finished, here is what it found".
 *
 * Kept here as a pure function so the wording — the part that decides whether the model narrates
 * or parrots — can be read and tested without a session manager.
 */

/** How much of a task's final answer is quoted back. */
const EXCERPT_LIMIT = 900;

export interface ChildReportEntry {
  /** The task's name, as the person sees it on the card. */
  name: string;
  /** The workspace it ran in (the assistant's own, now that it works in one workspace). */
  workspaceName: string;
  /** Its conversation, so the assistant can point at it or read more. */
  sessionId: string;
  /** `completed`, `failed`, `cancelled`, … as the session's own turn ended. */
  status: string;
  /** The last thing that session said. */
  lastText?: string;
}

function trim(text: string): string {
  const clean = text.trim();
  return clean.length > EXCERPT_LIMIT ? `${clean.slice(0, EXCERPT_LIMIT)}…` : clean;
}

export function formatChildReport(
  entries: ChildReportEntry[],
  options: { instructions?: boolean } = {},
): string {
  const lines: string[] = [
    entries.length === 1
      ? '[child-task-finished] A task you started has ended.'
      : `[child-task-finished] ${entries.length} tasks you started have ended.`,
    '',
  ];

  for (const entry of entries) {
    lines.push(`- "${entry.name}" in ${entry.workspaceName} — ${entry.status} (session ${entry.sessionId})`);
    if (entry.lastText?.trim()) {
      lines.push(`  Its last message: ${trim(entry.lastText)}`);
    } else {
      lines.push('  It ended without a final message.');
    }
  }

  if (options.instructions !== false) {
    lines.push(
      '',
      'Tell the person what came back, in one or two sentences each: what was asked, what came out,',
      'and anything that needs a decision. Do not repeat the quotes in full, do not re-dispatch the',
      'work, and do not start new tasks from this message.',
    )
  };

  return lines.join('\n');
}
