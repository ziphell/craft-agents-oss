/**
 * What each callout type is called on screen.
 *
 * `> [!NOTE]` already carries its type in the file; this is the human name for it, and it is here rather than in the
 * renderer because **both faces draw the same callout**. The reading face (`Markdown`) has always had names for the
 * known types; the editing face is a document whose callout is an attribute, and the label it shows is read from
 * `data-callout-label` — which is written from this table. One table, so a `> [!warning]` cannot be "Warning" in one
 * face and "WARNING" (or nothing) in the other.
 *
 * An unknown type keeps its own spelling, upper-cased by the stylesheet: a document written for a tool this app has
 * never met should still look like the callout it says it is.
 */

export const CALLOUT_NAMES: Readonly<Record<string, string>> = {
  note: 'Note',
  info: 'Info',
  tip: 'Tip',
  success: 'Success',
  important: 'Important',
  question: 'Question',
  example: 'Example',
  warning: 'Warning',
  caution: 'Caution',
  danger: 'Danger',
  failure: 'Failure',
  bug: 'Bug',
  todo: 'Todo',
  quote: 'Quote',
}

/** The name to draw for `type` — the known one, or the type as written. */
export function calloutName(type: string): string {
  return CALLOUT_NAMES[type] ?? type
}
