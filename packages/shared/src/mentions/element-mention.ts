/**
 * Element mentions — a page element the browser panel picked, carried inside the composer's
 * text.
 *
 * The composer's value is a plain string (see `rich-text-input`), so anything that survives a
 * round-trip through it has to *be* text. An element therefore travels as
 * `[element:<selector>|<text>|<url>|<tabId>]` with every part percent-encoded: the payload has
 * to contain no `]`, and selectors do contain brackets (`[data-testid="x"]`). The last two parts
 * are optional and dropped when absent.
 *
 * The third part is where it was picked, and it is why the marker grew: the picker belongs to
 * the window and stays on while the user moves between its tabs, so the element alone does not
 * say which page it came from. It is left off entirely when a pick carries no origin (the
 * agent's own `browser_tool pick`), which is also why the two-part form is still read back.
 *
 * The fourth is **which** tab of the window that was — the id the browser tools take
 * (`--tab <id>`), appended after the address for the same reason in `tab-mention`: a page says
 * where, and only the id says which tab is to be acted on when two are showing it.
 *
 * The marker is what the composer renders as a chip and what the message stores, exactly like
 * `[source:...]` and `[skill:...]`: the store keeps the marker so the chip can be redrawn from
 * it, the UI hides it behind a badge, and the agent rewrites it into a readable reference at
 * the model boundary (`resolveElementMentions`, called from base-agent alongside the other
 * resolvers). The live format lives here, in shared, because both sides read it.
 */

export interface ElementRef {
  /** Stable selector for the element (`data-testid` > `id` > `:nth-of-type` path). */
  selector: string
  /** The element's own text, shown as the chip's label. May be empty. */
  text: string
  /** The address of the page it was picked on, when the pick carried it. */
  url?: string
  /**
   * The id of the tab it was picked on, when the pick carried it — the name the browser tools
   * take (`--tab <id>`). See `tab-mention` for why the address is not enough on its own.
   */
  tabId?: string
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
 * Absent parts are dropped rather than encoded as empty ones, so a pick that carries no origin
 * produces the shorter marker it did before this grew.
 */
export function buildElementMention(ref: ElementRef): string {
  const parts = [ref.selector, ref.text, ref.url, ref.tabId]
  while (parts.length > 2 && !parts[parts.length - 1]) parts.pop()

  return `[element:${parts.map((part) => encodeURIComponent(part ?? '')).join('|')}]`
}

/**
 * Read a marker's payload back into an element reference.
 *
 * Returns null for a payload that is not one of ours — a draft is user-editable text, so a
 * clipped or hand-typed marker has to render as plain text rather than as a chip that stands
 * for nothing.
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

  const [selector, text, url, tabId] = decoded
  return {
    selector: selector ?? '',
    text: text ?? '',
    ...(url ? { url } : {}),
    ...(tabId ? { tabId } : {}),
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
 * What the chip shows: the element's own words when it has any — `"Submit"` says more about
 * which button this is than the selector does — and the selector when it does not (icons,
 * empty containers).
 */
export function elementLabel(ref: ElementRef): string {
  return ref.text || ref.selector
}

/**
 * Rewrite every marker into the reference the model reads.
 *
 * `[element:%23submit|Submit|https%3A%2F%2Fshop.example%2Fcart|12]`
 *   → `[Mentioned element: Submit (#submit on https://shop.example/cart, tab 12)]`
 *
 * The model-facing half of the reference: the composer keeps the marker (so the chip can be
 * redrawn), and the agent rewrites it here, the way it already does for sources and skills.
 * The selector is always in the reference — it is what the agent needs to change the element —
 * and the page when the pick carried one, because the same element can be picked from two tabs;
 * the tab's id follows it when the pick carried that, because the same page can *be* two tabs.
 * A malformed marker is left untouched.
 */
export function resolveElementMentions(text: string): string {
  return text.replace(new RegExp(MARKER_RE.source, 'g'), (full, payload: string) => {
    const ref = parseElementMention(payload)
    if (!ref) return full
    const where = ref.url ? ` on ${ref.url}` : ''
    const tab = ref.tabId ? `, tab ${ref.tabId}` : ''
    return `[Mentioned element: ${elementLabel(ref)} (${ref.selector}${where}${tab})]`
  })
}
