/**
 * A blockquote that says what it is — `> [!NOTE]`, as a document node.
 *
 * The reading face has read these since `remarkCallouts` (`[!type]` at the start of the first line, GitHub alerts and
 * Obsidian's callouts are the same syntax). The editing face is a blockquote with no idea of that convention, so a
 * document used to mean two different things depending on which face was open: a coloured, named callout when read,
 * and a quote whose first line was the literal text `[!NOTE]` when edited. That is the kind of disagreement this
 * editor exists to avoid, and `parseCalloutMarker` was exported from the remark plugin for exactly this node to use.
 *
 * Three parts, and each is where the file is:
 *
 * - **parse** — the marker is taken out of the first paragraph and becomes `attrs.callout` (lower-cased, the key the
 *   label and the stylesheet read) plus `attrs.calloutMarker` (the file's own spelling, `NOTE`), and the fold
 *   character, `[!note]-`, which stays part of what the file says. A marker that is the whole line leaves no empty
 *   paragraph behind, so the document has the same shape in both faces.
 * - **render** — the marker is put back on its own line, in the case the file wrote it. A block the person never
 *   touched is written from the file's own bytes anyway (`block-table.ts`); this is what an edited one says.
 * - **draw** — `data-callout` and `data-callout-label` on the `<blockquote>`, and the stylesheet turns those into the
 *   same box, colour and name the renderer draws. The label is an attribute rather than a `<div>` on purpose: an
 *   element would have to live inside a content hole, and then every callout would carry a node the file has no
 *   equivalent of.
 */

import Blockquote from '@tiptap/extension-blockquote'
import type { JSONContent } from '@tiptap/core'
import { calloutName } from '../callouts'
import { parseCalloutMarker } from '../remarkCallouts'

/** The attrs this node reads, as the markdown parser hands them over. */
interface CalloutAttrs {
  callout?: string | null
  /** The type as the file spelled it (`NOTE`), which is how it is written back. `callout` is the lower-cased key. */
  calloutMarker?: string | null
  calloutFold?: string | null
}

interface JsonNode {
  type: string
  attrs?: Record<string, unknown> | null
  content?: JsonNode[]
  text?: string
}

/**
 * Take the marker off the first paragraph of a parsed blockquote.
 *
 * Works on the parsed *json* rather than on marked's tokens: the token tree is the parser's private business (inline
 * tokens carry the marker in three places at once — `text`, `raw`, and the first child), while the document JSON has
 * exactly one place it can be.
 */
function stripMarker(node: JsonNode): JsonNode | null {
  const first = node.content?.[0]
  if (!first || first.type !== 'paragraph' || !first.content?.length) return null
  const head = first.content[0]
  if (!head || head.type !== 'text' || typeof head.text !== 'string') return null

  const marker = parseCalloutMarker(head.text)
  if (!marker) return null

  /*
   * The marker often shares a paragraph with the text below it — `> [!note]\n> 甲段。` is *one* paragraph with a soft
   * break, which is how GitHub alerts and Obsidian callouts are written. Taking the marker off therefore leaves the
   * break at the front, and that break was never text: it only separated the name from the body.
   */
  const rest = head.text.slice(marker.length).replace(/^\n/, '')
  const content = [...first.content]
  if (rest) content[0] = { ...head, text: rest }
  else content.shift()

  const children = content.length
    ? [{ ...first, content }, ...(node.content ?? []).slice(1)]
    : (node.content ?? []).slice(1)

  return {
    ...node,
    attrs: {
      ...(node.attrs ?? {}),
      callout: marker.type,
      /*
       * The file's own spelling, kept beside the lower-cased type rather than instead of it: `callout` is what the
       * stylesheet, the label and the reading face all key on, and it has to stay one spelling. Without this second
       * attribute the marker came back lower-cased and `says()` read that as a lost word — so a `> [!NOTE]` block was
       * shown as its own source in the editor.
       */
      calloutMarker: marker.spelling,
      calloutFold: marker.fold || null,
    },
    content: children,
  }
}

export const CalloutBlockquote = Blockquote.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** The type the marker named, lower-cased; `null` for an ordinary quote. */
      callout: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-callout'),
        renderHTML: (attributes: CalloutAttrs) => {
          if (!attributes.callout) return {}
          return {
            'data-callout': attributes.callout,
            'data-callout-label': calloutName(attributes.callout),
          }
        },
      },
      /** The `+`/`-` GitHub and Obsidian write after the marker (`> [!note]-`). Kept because the file has it. */
      calloutFold: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
      /**
       * The type in the file's own case (`NOTE`), which is what {@link renderMarkdown} writes back.
       *
       * Carried through the DOM as well (`data-callout-marker`), so copying a callout inside the editor and pasting it
       * back does not quietly lower-case it — ProseMirror round-trips a node through `renderHTML` → `parseHTML`.
       */
      calloutMarker: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-callout-marker'),
        renderHTML: (attributes: CalloutAttrs) =>
          attributes.calloutMarker ? { 'data-callout-marker': attributes.calloutMarker } : {},
      },
    }
  },

  parseMarkdown(token, helpers) {
    const node = helpers.createNode('blockquote', undefined, helpers.parseChildren(token.tokens ?? [])) as JsonNode
    return (stripMarker(node) ?? node) as unknown as JSONContent
  },

  renderMarkdown(node, helpers) {
    const attrs = (node.attrs ?? {}) as CalloutAttrs
    const children = (node.content ?? []) as JsonNode[]
    /*
     * The same spelling the stock blockquote writes — one `> ` per line, a bare `>` for a blank one, `>\n` between
     * blocks — with the marker as a line of its own above it when this is a callout. Written out rather than taken
     * from `Blockquote.config` so that the two can never drift on the part that decides a file's bytes.
     */
    const body = children
      .map((child) =>
        helpers
          .renderChildren([child])
          .split('\n')
          .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
          .join('\n'),
      )
      .join('\n>\n')
    if (!attrs.callout) return body
    const fold = attrs.calloutFold ?? ''
    // The file's spelling when there is one; a callout whose type only ever came from a label falls back to the key.
    const marker = attrs.calloutMarker ?? attrs.callout
    return body ? `> [!${marker}]${fold}\n${body}` : `> [!${marker}]${fold}`
  },
})
