/**
 * Turning an edit in the document into the text of a file.
 *
 * The question a save answers is not "what does this document serialize to" — that answer is a whole re-write, and
 * it is why rich markdown editors reformat a file the moment you touch one word. The question is "**which blocks
 * changed**", and blocks that did not are written from the bytes the file already had. A table keeps its own column
 * alignment, a code fence keeps its indentation, a paragraph nobody touched keeps its line endings.
 *
 * Which blocks changed is answered cheaply, from the transaction: ProseMirror says which ranges the keystroke
 * touched, and only those blocks are re-serialized to see whether their text actually moved. A selection change
 * touches nothing and costs nothing.
 *
 * It is separated from the component that calls it so this can be tested against the real editor rather than
 * described: `__tests__/tiptap-roundtrip.test.ts` types into a document with a table in it and reads the file back.
 */

import type { Editor } from '@tiptap/core'
import {
  buildBlockTable,
  planSaveByDiff,
  planSaveFromTable,
  retable,
  retableAfterRegion,
  touchedBlocks,
  type BlockBridge,
  type BlockTable,
} from './block-table'
import type { SavePlan } from './markdown-blocks'

/** A transaction, as much of it as this needs: the ranges it edited. */
export interface EditedRanges {
  steps?: ReadonlyArray<unknown>
}

/** The editor's markdown bridge, or `null` when the engine has none (legacy `tiptap-markdown` exposes no parse). */
export function bridgeOf(editor: Editor): BlockBridge | null {
  const markdown = (editor as unknown as { markdown?: Record<string, unknown> }).markdown
  if (!markdown || typeof markdown.parse !== 'function' || typeof markdown.serialize !== 'function') return null
  return {
    parse: (source: string) => (markdown.parse as (md: string) => { content?: unknown[] } | null)(source) ?? null,
    serialize: (json: unknown) => (markdown.serialize as (json: unknown) => string)(json),
  }
}

/** One block's markdown as the document sees it, trimmed (`toFile` undoes the engine's own escaping). */
export function blockMarkdown(editor: Editor, bridge: BlockBridge, index: number, toFile: (md: string) => string): string | null {
  const node = editor.state.doc.child(index)
  if (!node) return null
  return toFile(bridge.serialize({ type: 'doc', content: [node.toJSON()] })).trim()
}

export interface SaveResult {
  /** The whole file: the envelope, then the body with only the changed blocks rewritten. */
  text: string
  /** The table to carry forward — baselines updated, offsets moved. */
  table: BlockTable
  /** What happened to each block, including any that were refused. */
  plan: SavePlan
  /** The blocks the transaction touched. */
  touched: number[]
  /**
   * Whether there is anything to write at all.
   *
   * Not the same as `touched.length > 0`: a person typing in the paragraph past the end changes no block of the file
   * and still writes a paragraph into it, and a transaction that only moved the caret changes nothing.
   */
  changed: boolean
}

/**
 * Save `editor` against `table`, for a transaction that touched `ranges`.
 *
 * `table` is the last-known block table; `envelope` supplies the frontmatter and line endings to put back.
 * Returns `null` when the engine has no bridge, which is the caller's signal to fall back to writing the whole
 * document (`getMarkdown`).
 */
export function saveBlocks(
  editor: Editor,
  table: BlockTable,
  transaction: EditedRanges | undefined,
  toFile: (md: string) => string,
): SaveResult | null {
  const bridge = bridgeOf(editor)
  if (!bridge) return null

  const doc = editor.state.doc
  /*
   * **An empty paragraph is a blank line, not a block.** The file has no words there, and the editor's copy of it is a
   * place to put the caret — the same fact `appendixIndex` states about the one at the end, which is really just the
   * most common one. Counting them made a document diverge from its file by one node the moment somebody pressed
   * Enter on a blank line, and from then on every keystroke took the structural path instead of asking about the block
   * it touched.
   */
  const nodes: Array<{ nodeSize: number }> = []
  /** Row index → the document node it is. `blockMarkdown` and the serializers work in document space. */
  const blockNodes: number[] = []
  doc.forEach((node, _offset, index) => {
    nodes.push({ nodeSize: node.nodeSize })
    if (node.type.name === 'paragraph' && node.content.size === 0) return
    blockNodes.push(index)
  })

  // A step is `{from, to}` for anything that touches text, and has neither when it only moved the selection.
  const ranges = (transaction?.steps ?? []).flatMap((step) => {
    const { from, to } = step as { from?: unknown; to?: unknown }
    return typeof from === 'number' && typeof to === 'number' ? [{ from, to }] : []
  })
  // Touched in document positions, asked about in blocks: a touched blank paragraph belongs to no row.
  const touched = touchedBlocks(nodes, ranges)
    .map((docIndex) => blockNodes.indexOf(docIndex))
    .filter((rowIndex) => rowIndex >= 0)
  const reparse = (block: string) => {
    const count = bridge.parse(block)?.content?.length ?? 0
    return Array.from({ length: count }, () => block)
  }

  /*
   * **The common case: the document still has one node per block of the file.** Then a keystroke is a question about
   * the blocks it touched, and only those are re-serialized — this is the path every character of ordinary typing
   * takes.
   */
  if (blockNodes.length === table.rows.length) {
    if (touched.length === 0) {
      return {
        text: table.source,
        table,
        plan: { text: table.source, written: [], refused: [], changed: false },
        touched,
        changed: false,
      }
    }
    const current: Array<string | null> = table.rows.map(() => null)
    for (const index of touched) current[index] = blockMarkdown(editor, bridge, blockNodes[index]!, toFile)
    const plan = planSaveFromTable(table, current, reparse)
    return {
      text: plan.text,
      // `plan.written` is what makes the shift exact: those rows' new bytes are what their nodes say now.
      table: retable(table, plan.text, current, plan.written) ?? buildBlockTable(plan.text, bridge),
      plan,
      touched,
      changed: plan.changed,
    }
  }

  /*
   * **The document has a different number of blocks than the file**: Enter, a paste of two paragraphs, Backspace
   * joining two. Block indices no longer line up, so the question becomes "which *region* changed", answered from
   * both ends (`planSaveByDiff`) — and the table is rebuilt from the text afterwards, because the rows it held
   * describe a file that no longer exists.
   */
  const now: string[] = []
  for (const index of blockNodes) {
    now.push(toFile(bridge.serialize({ type: 'doc', content: [doc.child(index).toJSON()] })).trim())
  }
  const plan = planSaveByDiff(table, now, reparse)
  /*
   * The rows outside the region were not rewritten, so their baselines still describe them; only the region's blocks
   * are new. `retableAfterRegion` assembles that, which is the ~25ms the layout costs — `buildBlockTable` would also
   * re-parse every block of the file, another ~25ms on a 128-block document, and this path runs on the Enter key.
   */
  const next =
    retableAfterRegion(table, plan.text, plan.region.from, plan.region.to, plan.region.blocks) ??
    buildBlockTable(plan.text, bridge)
  return {
    text: plan.text,
    table: next,
    plan,
    touched,
    changed: plan.changed,
  }
}
