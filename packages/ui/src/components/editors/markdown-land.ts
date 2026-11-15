/**
 * Landing a file's new text in a document that is already open.
 *
 * The rule this exists for: an outside writer (the agent's `Write`/`Edit`, another window, a git checkout) must
 * become **one step of this editor's history, over the blocks that actually changed** — not a `setContent` that
 * throws the caret, the selection and the undo stack away, and not "ignore it while I am focused", which is what
 * the editor did before and why an agent's edit and a person's typing could never coexist.
 *
 * It is layered so each part can be questioned on its own:
 *
 * - `markdown-blocks.ts` (no editor at all): where blocks start and end in the file, what the difference is, and
 *   where that difference sits in ProseMirror. Tested without a document.
 * - this file: the three editor-shaped steps — read the document's blocks, parse the new ones, dispatch.
 *
 * Everything that can fail is answered rather than thrown: a caller that gets `{ applied: false }` reloads the
 * document the old way (which costs the person their caret, and is still better than a wrong splice).
 */

import type { Editor } from '@tiptap/core'
import { blockTexts, landingTarget, layoutMarkdown, planLanding, type Landing } from './markdown-blocks'
import { blockToNode, says } from './block-parse'
import { appendixIndex, type BlockBridge } from './block-table'

/**
 * The markdown bridge an editor exposes (`editor.markdown`): parse a fragment into document JSON, and serialize
 * one back. Feature-detected rather than assumed — the legacy and official markdown extensions spell this
 * differently, and a host that has neither simply gets the fallback.
 */
interface MarkdownBridge {
  parse?: (markdown: string) => { content?: unknown[] } | null
  serialize?: (json: unknown) => string
}

function bridgeOf(editor: Editor): MarkdownBridge | null {
  const candidate = (editor as unknown as { markdown?: MarkdownBridge }).markdown
  if (!candidate || typeof candidate.parse !== 'function' || typeof candidate.serialize !== 'function') return null
  return candidate
}

/**
 * The document's top-level blocks, serialized one at a time.
 *
 * Only a fallback: a block's serialization is not the file's bytes (tables gain column padding), so this is a
 * yardstick for "has this node changed", never for "does this match the file". Callers that know which source the
 * document came from pass it as `current` and the comparison happens in file space.
 */
export function documentBlocks(editor: Editor): string[] | null {
  const bridge = bridgeOf(editor)
  if (!bridge?.serialize) return null
  const blocks: string[] = []
  editor.state.doc.forEach((node) => {
    blocks.push(bridge.serialize!({ type: 'doc', content: [node.toJSON()] }).trim())
  })
  return blocks
}

export interface LandResult {
  /** The transaction was dispatched (or there was nothing to do). */
  applied: boolean
  /** Why not, in words a log or a caller can use. */
  reason?: string
  /** What was decided, for a caller that wants to report or highlight it. */
  landing?: Landing
}

/**
 * Land `nextSource` in `editor`.
 *
 * `current` is the source the open document was loaded from. Give it whenever it is known: the difference is then
 * measured between two versions of the *file*, so a table that nobody touched is not a difference just because the
 * serializer would pad it. Without it the comparison falls back to the document's own serialization, which is a
 * weaker yardstick — the transaction is still correct, it may simply cover more blocks than it needs to.
 *
 * `keepHistory` is the difference between "an edit that happened" and "a draft arriving": a stream of writes
 * (an agent composing a section) lands outside the history until it settles, then lands again inside it, so the
 * person gets one undo step per finished edit rather than one per tick.
 */
export function landMarkdown(
  editor: Editor,
  nextSource: string,
  options: { keepHistory?: boolean; current?: string } = {},
): LandResult {
  if (editor.isDestroyed) return { applied: false, reason: 'the editor is gone' }
  const current =
    options.current !== undefined
      ? blockTexts(layoutMarkdown(options.current))
      : documentBlocks(editor)
  if (current === null) return { applied: false, reason: 'this editor has no markdown bridge' }

  const landing = planLanding(current, nextSource)
  if (landing.unusable) return { applied: false, reason: 'the new text did not parse', landing }
  if (landing.idle) return { applied: true, landing }

  const bridge = bridgeOf(editor)!
  let nodes
  try {
    // Parsed block by block, not as a document: the span only needs the blocks that replace the old ones, and a
    // single bad block then costs that block (the whole landing falls back) instead of the file.
    const blocks = bridge as BlockBridge
    nodes = landing.blocks.map((block) => editor.schema.nodeFromJSON(blockToNode(blocks, block).json))
  } catch (error) {
    return { applied: false, reason: `a block did not parse: ${String(error)}`, landing }
  }

  /*
   * The paragraph the editor keeps past the end (`appendixIndex`) is not a block of the file, so it is not one of the
   * spans a landing addresses — and it must not be counted, or the splice would take it for the block it replaced and
   * delete whatever the person had typed there. With it excluded, `sizes` is the file's blocks again.
   */
  const appendix = appendixIndex(editor.state.doc)
  const sizes: number[] = []
  editor.state.doc.forEach((node, _offset, index) => {
    if (index !== appendix) sizes.push(node.nodeSize)
  })
  /*
   * The whole scheme rests on one file block being one top-level node. When they disagree (frontmatter, which the
   * parser splits in two) a splice at block offsets would land in the wrong place, so the caller reloads instead.
   *
   * **Except at the end, where the editor is allowed to have written past the file.** A paragraph typed below a
   * trailing table, or the one `TrailingNode` keeps there, sits after the file's last block and cannot move the
   * span — so the file's blocks are the first `current.length` of them, and the extra ones stay where they are. The
   * blocks at both edges of the span are checked against the file first: if the person inserted something in the
   * middle, those no longer say what they said, and reloading is the honest answer.
   */
  let blocks = sizes
  if (sizes.length !== current.length) {
    const extra = sizes.length - current.length
    if (extra <= 0 || !edgesSay(editor, bridge, current, landing)) {
      return {
        applied: false,
        reason: `the document has ${sizes.length} blocks where the file has ${current.length}`,
        landing,
      }
    }
    blocks = sizes.slice(0, current.length)
  }
  const target = landingTarget(blocks, landing.prefix, landing.suffix)
  if (!target) return { applied: false, reason: 'the span does not exist any more', landing }

  try {
    const tr = editor.state.tr.replaceWith(target.from, target.to, nodes.length > 0 ? nodes : [])
    tr.setMeta('agentEdit', { blocks: landing.blocks.length, prefix: landing.prefix })
    if (options.keepHistory === false) tr.setMeta('addToHistory', false)
    // One step per settled edit: consecutive landings inside the same window merge instead of stacking.
    tr.setMeta('closeHistory', true)
    editor.view.dispatch(tr)
    return { applied: true, landing }
  } catch (error) {
    return { applied: false, reason: `the transaction was refused: ${String(error)}`, landing }
  }
}

/**
 * Do the blocks on either side of the span still say what the file says they say?
 *
 * Two serializations, and only when the counts disagree — the case where the splice's offsets are being trusted in a
 * document that is not exactly the file. A block the person edited breaks this, which is the point: their typing may
 * have moved a block that the span is computed from. The instrument is the one the block layer uses everywhere else
 * (`says`), so a table's padding is not a difference.
 */
function edgesSay(
  editor: Editor,
  bridge: MarkdownBridge,
  current: readonly string[],
  landing: Landing,
): boolean {
  if (!bridge.serialize) return false
  const before = landing.prefix - 1
  const after = current.length - landing.suffix
  for (const index of [before, after]) {
    if (index < 0 || index >= current.length) continue
    const node = editor.state.doc.child(index)
    if (!node) return false
    const now = bridge.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
    if (says(now) !== says(current[index]!)) return false
  }
  return true
}
