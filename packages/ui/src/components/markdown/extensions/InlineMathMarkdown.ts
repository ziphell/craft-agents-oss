/**
 * Inline math as these documents write it: `$…$`, and `$$…$$` on one line.
 *
 * Two problems with the stock tokenizer, both measured on the path this editor actually uses (the document is built
 * block by block, so the whole-file `preprocessMarkdownForOfficial` — which is only applied on the one fallback path —
 * never sees these blocks):
 *
 * | written | stock tokenizer | after this |
 * | --- | --- | --- |
 * | `行内 $a^2$ 结束` | inline math | inline math |
 * | `行内 $$a^2$$ 结束` | **plain text** — the tokenizer requires a single `$` | inline math |
 * | `价格 $100 与 $200` | **inline math with `latex: "100 与 "`** — a price band rendered as a formula | text |
 *
 * The `$$…$$` form is the one the app's own documentation tells people to write (`preprocessMarkdownForOfficial`
 * converts it for the fallback path), so on the block path it silently stayed literal: "inline math is not rendered".
 *
 * Money is refused rather than escaped. The older approach rewrote `$100` into `¤100` before parsing and back on the
 * way out — which puts a currency sign the person never typed on screen. A candidate that begins with a digit and
 * contains none of the characters formulas are made of is a price, not a formula; `$2x + 3$` still parses because of
 * the `+`.
 *
 * The block form is untouched: `$$…$$` on a line of its own is `BlockMath`'s, at block level.
 */

import { BlockMath, InlineMath } from '@tiptap/extension-mathematics'

/** Characters that only appear when somebody means a formula (`$2x + 3$`, `$a_{1}$`, `$\frac12$`). */
const FORMULA_CHARACTER = /[\\^_{}+\-=*/<>|]/

/** `1,234`, `100`, `2M` — a number somebody put a dollar sign in front of. */
function looksLikeMoney(latex: string): boolean {
  return /^\d/.test(latex) && !FORMULA_CHARACTER.test(latex)
}

/**
 * Display math, but **only where it starts a line**.
 *
 * The stock block tokenizer's `start` returns the index of any `$$` in the source, and marked ends the current block
 * there — so a paragraph containing `行内 $$a^2$$ 结束` was cut into three: a paragraph, a display formula, a paragraph.
 * The line break is what makes it display math; inside a sentence it is inline math, and only the inline tokenizer can
 * see it.
 */
export const BlockMathMarkdown = BlockMath.extend({
  markdownTokenizer: {
    name: 'blockMath',
    level: 'block',
    start: (src: string) => {
      const match = /(?:^|\n)\$\$/m.exec(src)
      // `-1` keeps marked from treating a `$$` mid-line as the start of a new block.
      return match ? match.index + (match[0].length - 2) : -1
    },
    tokenize(src: string) {
      const match = /^\$\$([^$]+)\$\$/.exec(src)
      if (!match) return undefined
      return { type: 'blockMath', raw: match[0], latex: (match[1] ?? '').trim() }
    },
  },
})

export const InlineMathMarkdown = InlineMath.extend({
  markdownTokenizer: {
    name: 'inlineMath',
    level: 'inline',
    start: (src: string) => src.indexOf('$'),
    tokenize(src: string) {
      // `$$…$$` first: on one line it is inline math, and the single-dollar rule would leave the second `$` behind.
      const double = /^\$\$([^$]+)\$\$/.exec(src)
      if (double) {
        return { type: 'inlineMath', raw: double[0], latex: (double[1] ?? '').trim() }
      }
      const single = /^\$([^$]+)\$(?!\$)/.exec(src)
      if (!single) return undefined
      const latex = (single[1] ?? '').trim()
      if (looksLikeMoney(latex)) return undefined
      return { type: 'inlineMath', raw: single[0], latex }
    },
  },
})
