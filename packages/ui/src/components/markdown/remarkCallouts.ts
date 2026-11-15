/**
 * `> [!NOTE]` — a blockquote that says what it is.
 *
 * Not a markdown construct: CommonMark has no callouts, and neither the GFM spec nor `remark-gfm`
 * knows this one. It is GitHub's *alerts* (and Obsidian's callouts, which are the same syntax), and
 * that is exactly why it is the one worth supporting — a reader that has never heard of it sees an
 * ordinary blockquote with one loud line in it (`[!NOTE]`), where the container spellings
 * (`:::note`, `!!! note`) would leave punctuation with nothing behind it. A file written for this
 * app stays readable everywhere, and stays *the file*.
 *
 * What this does is small: mark the blockquote with the type it names, and take the marker out of
 * the first paragraph so it is not read aloud as text. Everything about how a callout *looks* is the
 * renderer's business (`Markdown`'s `blockquote`), because the editor draws the same source with its
 * own decorations rather than through this plugin.
 *
 * The marker is also where the type is *written*, so the same expression is understood on both sides of the app:
 * here for the reader, and by the block editor (`TiptapMarkdownEditor`) for the document being edited.
 * `parseCalloutMarker` is exported for that reason, so a document cannot be a callout in one face and not the other.
 */

import { visit } from 'unist-util-visit'
import type { Plugin } from 'unified'
import type { Root } from 'mdast'

/** The types GitHub knows, plus the ones Obsidian adds that read as themselves. */
const KNOWN = new Set([
  'note',
  'tip',
  'important',
  'warning',
  'caution',
  'info',
  'success',
  'failure',
  'danger',
  'bug',
  'question',
  'example',
  'quote',
  'todo',
])

const MARKER = /^\[!([a-zA-Z][\w-]*)\]([+-]?)[ \t]?/

export interface CalloutMarker {
  /** The type, lower-cased. Unknown types are kept: they are still a callout, just a plain one. */
  type: string
  /**
   * The type exactly as the line writes it — `NOTE`, `Note`, `note`.
   *
   * `type` is what the app draws with (one key into `CALLOUT_NAMES`), and it cannot be what is written back: the
   * editor serializes the callout, and `says()` compares the words that survive, so a marker lower-cased on the way
   * out reads as a lost word and the whole block falls to the literal path. Measured: `> [!NOTE] 大写提示` came back
   * as `> [!note] 大写提示` and was shown — in the editor and in anything that draws the document — as its own source.
   * Keeping the spelling is what lets the file be written in the case it was written in.
   */
  spelling: string
  /** Whether the type is one the app draws with a name and a colour of its own. */
  known: boolean
  /** The fold character GitHub and Obsidian write after the marker (`[!note]-`). */
  fold: string
  /** How many characters of the line the marker takes. */
  length: number
}

/**
 * The marker a callout's first line starts with, if it has one.
 *
 * Case-insensitive, because people write `[!Note]`; an unknown type is still a marker — a document
 * from a tool this app has never met should look like a callout, not like a stray sentence.
 */
export function parseCalloutMarker(text: string): CalloutMarker | null {
  const match = MARKER.exec(text)
  if (!match) return null
  const spelling = match[1] ?? ''
  const type = spelling.toLowerCase()
  if (!type) return null
  return { type, spelling, known: KNOWN.has(type), fold: match[2] ?? '', length: match[0].length }
}

const remarkCallouts: Plugin<[], Root> = () => (tree) => {
  visit(tree, 'blockquote', (node) => {
    const first = node.children[0]
    if (!first || first.type !== 'paragraph') return

    const head = first.children[0]
    if (!head || head.type !== 'text') return

    const marker = parseCalloutMarker(head.value)
    if (!marker) return

    node.data = node.data ?? {}
    node.data.hProperties = {
      ...(node.data.hProperties as Record<string, unknown> | undefined),
      'data-callout': marker.type,
      ...(marker.known ? {} : { 'data-callout-unknown': 'true' }),
      ...(marker.fold ? { 'data-callout-fold': marker.fold } : {}),
    }

    head.value = head.value.slice(marker.length)

    // A marker alone on its line leaves nothing behind — the type is the heading now.
    if (!head.value && first.children.length === 1) node.children.shift()
  })
}

export default remarkCallouts
