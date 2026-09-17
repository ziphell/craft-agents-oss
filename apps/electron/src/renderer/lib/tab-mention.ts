/**
 * Tab mentions — a whole tab of the browser window, carried inside the composer's
 * text.
 *
 * The sibling of `element-mention`, and the same mechanism: the composer's value is
 * a plain string (see `rich-text-input`), so a tab travels as
 * `[tab:<url>|<title>|<prototype>|<prototypePage>]` with every part percent-encoded —
 * the payload must contain no `]`, and a URL may.
 *
 * A tab is what the window's own `tabs` are (`BrowserTabSummary`, `tabAction`,
 * `tab-show`): the noun is the window's, and this is that noun as a reference.
 *
 * It exists because a tab is a thing to talk about in its own right, not only a place
 * an element was picked on: "look at this page", "what is wrong with this screen". The
 * two trailing parts are the tab's identity as a **prototype's page**, and they are
 * left off entirely for a tab that is nobody's prototype — reading the shorter marker
 * back leaves nothing empty behind.
 *
 * The marker is what the composer renders as a chip and what the draft stores. It
 * never reaches the model — `expandTabMentions` rewrites it into a readable reference
 * at send time, the way `expandElementMentions` does for elements.
 */

export interface TabRef {
  /** The tab's address — the one thing that identifies it. */
  url: string
  /** The tab's own title, shown as the chip's label. May be empty. */
  title: string
  /** The prototype this tab belongs to, when it is one's. */
  prototypeSlug?: string
  /** Which page of that prototype, when its page table knew. */
  prototypePage?: string
}

export interface TabMention {
  ref: TabRef
  /** The marker's payload, encoded — what consumers that cannot take an object (mentions.ts) key on. */
  payload: string
  /** The whole `[tab:...]` marker, as it appears in the text. */
  fullMatch: string
  startIndex: number
}

const MARKER_RE = /\[tab:([^\]]+)\]/g

/**
 * Build the marker a tab is inserted as.
 *
 * Absent parts are dropped rather than encoded as empty ones, so a tab that is
 * nobody's prototype produces the shorter marker.
 */
export function buildTabMention(ref: TabRef): string {
  const parts = [ref.url, ref.title, ref.prototypeSlug, ref.prototypePage]
  while (parts.length > 2 && !parts[parts.length - 1]) parts.pop()

  return `[tab:${parts.map((part) => encodeURIComponent(part ?? '')).join('|')}]`
}

/**
 * Read a marker's payload back into a tab reference.
 *
 * Returns null for a payload that is not one of ours — a draft is user-editable
 * text, so a clipped or hand-typed marker has to render as plain text rather than
 * as a chip that stands for nothing.
 */
export function parseTabMention(payload: string): TabRef | null {
  const parts = payload.split('|')
  if (parts.length < 2) return null

  let decoded: string[]
  try {
    decoded = parts.map((part) => decodeURIComponent(part))
  } catch {
    return null
  }

  const [url, title, prototypeSlug, prototypePage] = decoded
  return {
    url: url ?? '',
    title: title ?? '',
    ...(prototypeSlug ? { prototypeSlug } : {}),
    ...(prototypePage ? { prototypePage } : {}),
  }
}

/**
 * The tab as a prototype page, in one phrase: `demo / cart`, or empty for a tab
 * nobody owns.
 *
 * Not prose and not translated — a prototype slug and a page name read the same in
 * every language.
 */
export function tabOriginText(ref: TabRef): string {
  if (!ref.prototypeSlug) return ''
  return `${ref.prototypeSlug}${ref.prototypePage ? ` / ${ref.prototypePage}` : ''}`
}

/**
 * What the chip shows: the tab's title, and its address when the title says nothing
 * (`about:blank`, a tab that has not finished loading).
 */
export function tabLabel(ref: TabRef): string {
  return ref.title.trim() || ref.url
}

/** All tab markers in a text, in order, with positions for splicing. */
export function findTabMentions(text: string): TabMention[] {
  const mentions: TabMention[] = []
  const pattern = new RegExp(MARKER_RE.source, 'g')

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const payload = match[1]!
    const ref = parseTabMention(payload)
    if (!ref) continue
    mentions.push({ ref, payload, fullMatch: match[0], startIndex: match.index })
  }

  return mentions
}

/**
 * Replace every marker with the reference the model should read.
 *
 * `format` supplies the wording (the caller owns i18n); malformed markers are left
 * untouched so nothing silently disappears from the user's message.
 */
export function expandTabMentions(
  text: string,
  format: (ref: TabRef) => string
): string {
  const mentions = findTabMentions(text)
  if (mentions.length === 0) return text

  let expanded = ''
  let lastIndex = 0
  for (const mention of mentions) {
    expanded += text.slice(lastIndex, mention.startIndex) + format(mention.ref)
    lastIndex = mention.startIndex + mention.fullMatch.length
  }

  return expanded + text.slice(lastIndex)
}
