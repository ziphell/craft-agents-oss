/**
 * Element mentions — a page element the browser panel picked, carried inside the
 * composer's text.
 *
 * The composer's value is a plain string (see `rich-text-input`), so anything that
 * survives a round-trip through it has to *be* text. An element therefore travels as
 * `[element:<selector>|<text>|<url>|<folder>]` with every part percent-encoded: the
 * payload has to contain no `]`, and selectors do contain brackets
 * (`[data-testid="x"]`). The last two are optional and dropped when absent.
 *
 * The third part is where it was picked, and it is why the marker grew: the picker
 * belongs to the window and stays on while the user moves between its tabs, so the
 * element alone does not say which page it came from. It is left off entirely when a
 * pick carries no origin (the agent's own `browser_tool pick`), which is also why the
 * two-part form is still read back.
 *
 * The fourth is the folder, when the page was one this app serves: a website's pages are
 * files in the workspace, so a pick on one is a statement about files as much as about a
 * page. Also optional, and also read back from markers that never had it.
 *
 * The marker is what the composer renders as a chip and what the draft stores. It
 * never reaches the model — `expandElementMentions` rewrites it into a readable
 * reference at send time, so the message reads like the mention markers the agent
 * already knows (`[Mentioned file: ...]`) without a second resolver on its side.
 */

export interface ElementRef {
  /** Stable selector for the element (`data-testid` > `id` > `:nth-of-type` path). */
  selector: string
  /** The element's own text, shown as the chip's label. May be empty. */
  text: string
  /** The address of the page it was picked on, when the pick carried it. */
  url?: string
  /**
   * The folder the page is served from, when it is a website of this app's
   * (`websites/<slug>/`). What the agent has to edit, rather than guess at.
   */
  dir?: string
}

export interface ElementMention {
  ref: ElementRef
  /** The marker's payload, encoded — what consumers that cannot take an object (mentions.ts) key on. */
  payload: string
  /** The whole `[element:...]` marker, as it appears in the text. */
  fullMatch: string
  startIndex: number
}

const MARKER_RE = /\[element:([^\]]+)\]/g

/**
 * Build the marker a picked element is inserted as.
 *
 * Absent parts are dropped rather than encoded as empty ones, so a pick that
 * carries no origin produces the shorter marker it did before this grew.
 */
export function buildElementMention(ref: ElementRef): string {
  const parts = [ref.selector, ref.text, ref.url, ref.dir]
  while (parts.length > 2 && !parts[parts.length - 1]) parts.pop()

  return `[element:${parts.map((part) => encodeURIComponent(part ?? '')).join('|')}]`
}

/**
 * Read a marker's payload back into an element reference.
 *
 * Returns null for a payload that is not one of ours — a draft is user-editable
 * text, so a clipped or hand-typed marker has to render as plain text rather than
 * as a chip that stands for nothing.
 */
export function parseElementMention(payload: string): ElementRef | null {
  const parts = payload.split('|')
  if (parts.length < 2) return null

  let decoded: string[]
  try {
    decoded = parts.map((part) => decodeURIComponent(part))
  } catch {
    return null
  }

  const [selector, text, url, dir] = decoded
  return {
    selector: selector ?? '',
    text: text ?? '',
    ...(url ? { url } : {}),
    ...(dir ? { dir } : {}),
  }
}

/** All element markers in a text, in order, with positions for splicing. */
export function findElementMentions(text: string): ElementMention[] {
  const mentions: ElementMention[] = []
  const pattern = new RegExp(MARKER_RE.source, 'g')

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const payload = match[1]!
    const ref = parseElementMention(payload)
    if (!ref) continue
    mentions.push({ ref, payload, fullMatch: match[0], startIndex: match.index })
  }

  return mentions
}

/**
 * What the chip shows: the element's own words when it has any — `"Submit"` says
 * more about which button this is than the selector does — and the selector when
 * it does not (icons, empty containers).
 */
export function elementLabel(ref: ElementRef): string {
  return ref.text || ref.selector
}

/**
 * Replace every marker with the reference the model should read.
 *
 * `format` supplies the wording (the caller owns i18n); malformed markers are left
 * untouched so nothing silently disappears from the user's message.
 */
export function expandElementMentions(
  text: string,
  format: (ref: ElementRef) => string
): string {
  const mentions = findElementMentions(text)
  if (mentions.length === 0) return text

  let expanded = ''
  let lastIndex = 0
  for (const mention of mentions) {
    expanded += text.slice(lastIndex, mention.startIndex) + format(mention.ref)
    lastIndex = mention.startIndex + mention.fullMatch.length
  }

  return expanded + text.slice(lastIndex)
}
