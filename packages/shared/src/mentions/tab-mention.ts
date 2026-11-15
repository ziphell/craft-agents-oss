/**
 * Tab mentions — a whole tab of the browser window, carried inside the composer's text.
 *
 * The sibling of `element-mention` (a page element rather than the whole page), and the same
 * encoding: the composer's value is a plain string (see `rich-text-input`), so a tab travels as
 * `[tab:<url>|<title>|<tabId>]` with every part percent-encoded — the payload must contain no
 * `]`, and a URL may.
 *
 * A tab is what the window's own `tabs` are (`BrowserTabSummary`, `tabAction`, `tab-show`):
 * the noun is the window's, and this is that noun as a reference. It exists because a tab is
 * a thing to talk about in its own right, not only a place an element was picked on: "look at
 * this page", "what is wrong with this screen". The address says where the reader is standing
 * and the title is what makes the chip readable; the **id** is what makes the reference
 * actionable, because `--tab <id>` and `tab-show <id>` name a tab by it and an address cannot
 * tell two tabs apart. It is last so that a marker written before it existed — two parts — still
 * reads.
 *
 * The marker is what the composer renders as a chip and what the message stores, exactly like
 * `[source:...]` and `[skill:...]`: the store keeps the marker so the chip can be redrawn from
 * it, the UI hides it behind a badge, and the agent rewrites it into a readable reference at
 * the model boundary (`resolveTabMentions`, called from base-agent alongside the other
 * resolvers). The live format lives here, in shared, because both sides read it.
 */

export interface TabRef {
  /** The tab's address — where the tab is, and what its chip reads as when it has no title. */
  url: string
  /** The tab's own title, shown as the chip's label. May be empty. */
  title: string
  /**
   * The tab's id — the name the browser tools take (`--tab <id>`, `tab-show <id>`).
   *
   * Optional because it is not always known: a marker written before this field existed has
   * none, and neither has a draft that outlived the tab. Every reader treats it that way.
   */
  tabId?: string
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

/** Build the marker a tab is inserted as. */
export function buildTabMention(ref: TabRef): string {
  const parts = [ref.url, ref.title, ref.tabId]
  while (parts.length > 2 && !parts[parts.length - 1]) parts.pop()

  return `[tab:${parts.map((part) => encodeURIComponent(part ?? '')).join('|')}]`
}

/**
 * Read a marker's payload back into a tab reference.
 *
 * Returns null for a payload that is not one of ours — a draft is user-editable text, so a
 * clipped or hand-typed marker has to render as plain text rather than as a chip that stands
 * for nothing.
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

  const [url, title, tabId] = decoded
  return {
    url: url ?? '',
    title: title ?? '',
    ...(tabId ? { tabId } : {}),
  }
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
 * Rewrite every marker into the reference the model reads.
 *
 * `[tab:https%3A%2F%2Fa.example%2F|Cart|12]` → `[Mentioned tab: Cart (tab 12, https://a.example/)]`
 *
 * The model-facing half of the reference: the composer keeps the marker (so the chip can be
 * redrawn), and the agent rewrites it here, the way it already does for sources and skills.
 * The id comes first in the parentheses when there is one, because it is the part a command can
 * be pointed with — the address is what it says it is. A malformed marker is left untouched so
 * nothing silently disappears from the user's message.
 */
export function resolveTabMentions(text: string): string {
  return text.replace(new RegExp(MARKER_RE.source, 'g'), (full, payload: string) => {
    const ref = parseTabMention(payload)
    if (!ref) return full
    const id = ref.tabId ? `tab ${ref.tabId}, ` : ''
    return `[Mentioned tab: ${tabLabel(ref)} (${id}${ref.url})]`
  })
}
