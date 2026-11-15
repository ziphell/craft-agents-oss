/**
 * Building a document out of a file's blocks, one block at a time.
 *
 * The engine cannot be trusted with the whole file. Measured, on the official markdown parser: a block of raw HTML
 * becomes a paragraph that serializes to `""` — the markup *and the text inside it* are gone. `<kbd>Ctrl</kbd>` comes
 * back as `&nbsp;`. A block that has no node of its own is therefore not a block the engine can carry, and handing it
 * the whole document means those blocks are invisible in the editor and one edit away from being deleted.
 *
 * So the question is asked **per block**, and answered one of two ways:
 *
 * - the engine reads it as exactly one node, and that node serializes back to something — use it, it is editable as
 *   what it is;
 * - anything else — keep the block's own bytes as **the text of a paragraph**. Measured: that survives the round trip
 *   exactly (`<div style="color:red">红色的一段</div>` comes back character for character), it is visible, it can be
 *   typed in, and it keeps the one-block-one-node promise every splice in this editor rests on.
 *
 * This is Outline's posture (`html: false` in its markdown-it setup — raw HTML is text, not HTML) reached from the
 * other side: we do not disable the parser rule, we simply do not ask the parser about blocks it would eat.
 */

import type { BlockBridge } from './block-table'

export interface BuiltBlock {
  /** The document JSON for this block: one node, always. */
  json: unknown
  /**
   * True when the block is carried as its own text because the engine had no way to represent it.
   *
   * The difference matters to a caller that wants to say so in the interface — "this is markup, edit it as markup" —
   * not to the save path, which treats both the same way: what is serialized is what the block says.
   */
  literal: boolean
}

/**
 * What a block *says*: the words in it, and nothing else.
 *
 * The question a block has to answer before the engine is trusted with it is "did anything get lost", and the answer
 * cannot be a comparison of markup: a markdown serializer legitimately rewrites markup while saying the same thing.
 * Measured on the official engine — a table's delimiter row is padded to the column widths (`| --- | ----- |`) and its
 * `:--` alignment colons dropped, `* 甲` becomes `- 甲`, `_斜_` becomes `*斜*`, `1)` becomes `1.`, and a setext
 * `标题 / ====` becomes `# 标题`. None of that loses a word, and comparing characters flagged every one of them, which
 * put those blocks on the literal path — a real markdown table, bullet list or heading rendered in the editor as its
 * own raw source. (That is why a document's tables looked like markdown.)
 *
 * So markup punctuation is not part of what a block says: tags and entities are taken out, then everything that is not
 * a letter or a digit. What is left is what the person reads, and what must survive the round trip — `<kbd>Ctrl</kbd>`
 * really does lose "Ctrl" (it comes back as `&nbsp;`), and that is exactly what this still refuses.
 */
export function says(block: string): string {
  return block
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** A paragraph holding `text` as its only content. */
function literalParagraph(text: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

/**
 * One file block as one document node.
 *
 * `bridge` is the engine's own parse/serialize. When it is absent (a legacy markdown engine) every block is literal,
 * which is the honest answer: nothing can be said about what the document would look like.
 */
export function blockToNode(bridge: BlockBridge | null, block: string): BuiltBlock {
  if (!bridge) return { json: literalParagraph(block.trim()), literal: true }

  try {
    const content = bridge.parse(block)?.content ?? []
    if (content.length === 1) {
      const serialized = bridge.serialize({ type: 'doc', content }).trim()
      /*
       * Trusted only when the words survive. Padding a table's columns, dropping `:--` colons or normalizing `*` to `-`
       * changes the markup and is fine — the block's own bytes are kept on save anyway, and `says` is blind to it. Losing
       * a word is not fine, and the engine does lose them: `<kbd>Ctrl</kbd>` comes back as `&nbsp;`, and a `<div>` block
       * comes back empty.
       */
      if (says(serialized) === says(block)) return { json: content[0], literal: false }
    }
  } catch {
    // A throw is the same answer as an empty serialization: the engine could not carry this block.
  }
  return { json: literalParagraph(block.trim()), literal: true }
}

export interface BuildDocumentOptions {
  /**
   * What a block the engine cannot carry becomes.
   *
   * `'paragraph'` (the default) is the editor's answer: the block's own text, visible and typable, so a splice never
   * loses it. `'literalBlock'` is the *reader's*: a node of its own that draws the block with the reading face, for a
   * document nobody can type in. The difference is measured — `按 <kbd>Ctrl</kbd> 保存` is source text in the first
   * and a `<kbd>` in the second, which is what the reader has always drawn.
   */
  literalAs?: 'paragraph' | 'literalBlock'
}

/** A whole file's blocks as document JSON, in file order. */
export function blocksToDocument(
  bridge: BlockBridge | null,
  blocks: readonly string[],
  options: BuildDocumentOptions = {},
): { type: 'doc'; content: unknown[] } {
  const literalAs = options.literalAs ?? 'paragraph'
  return {
    type: 'doc',
    content: blocks.map((block) => {
      const built = blockToNode(bridge, block)
      if (built.literal && literalAs === 'literalBlock') {
        return { type: 'literalBlock', attrs: { text: block.trim() } }
      }
      return built.json
    }),
  }
}
