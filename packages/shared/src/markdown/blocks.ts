/**
 * A markdown file as **blocks and the bytes between them**.
 *
 * This is the half of the rich editor that decides what a save is allowed to touch. mdast already knows where a
 * top-level block starts and ends (`position.start.offset` / `end.offset`, in characters, not lines), and
 * everything that is *not* a block — the blank lines, the newline style, whatever sits between two blocks — is
 * kept as its own chunk. A save then rewrites the blocks that changed and leaves every other byte exactly as it
 * was, which is the promise a document model cannot make for a file it did not author: a construct the editor
 * has no node for survives as long as nobody types inside it.
 *
 * Deliberately no ProseMirror here. The editor is one consumer; the offsets are the truth both sides agree on.
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'

/** One piece of the file: a top-level block, or the bytes between two of them. */
export type MarkdownChunk =
  | { kind: 'block'; from: number; to: number; text: string }
  | { kind: 'gap'; from: number; to: number; text: string }

export interface MarkdownLayout {
  /** The text this layout was made from. Offsets mean nothing against any other text. */
  source: string
  /** In file order; `block` and `gap` alternate, starting and ending with a gap (either may be empty). */
  chunks: MarkdownChunk[]
  /** Set when the file could not be parsed: the caller must fall back to treating it as one text. */
  problem?: string
}

const parser = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm)

export function layoutMarkdown(source: string): MarkdownLayout {
  let tree: { children?: Array<{ position?: { start?: { offset?: number }; end?: { offset?: number } } }> }
  try {
    tree = parser.parse(source) as typeof tree
  } catch (error) {
    return { source, chunks: [{ kind: 'gap', from: 0, to: source.length, text: source }], problem: String(error) }
  }

  const spans: Array<{ from: number; to: number }> = []
  for (const node of tree.children ?? []) {
    const from = node.position?.start?.offset
    const to = node.position?.end?.offset
    // A block with no position is one we cannot splice safely; the whole file is then left to the caller.
    if (typeof from !== 'number' || typeof to !== 'number' || to <= from) {
      return { source, chunks: [{ kind: 'gap', from: 0, to: source.length, text: source }], problem: 'block without a position' }
    }
    spans.push({ from, to })
  }

  const chunks: MarkdownChunk[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.from > cursor) chunks.push({ kind: 'gap', from: cursor, to: span.from, text: source.slice(cursor, span.from) })
    chunks.push({ kind: 'block', ...span, text: source.slice(span.from, span.to) })
    cursor = span.to
  }
  if (cursor < source.length) chunks.push({ kind: 'gap', from: cursor, to: source.length, text: source.slice(cursor) })
  if (chunks.length === 0) chunks.push({ kind: 'gap', from: 0, to: 0, text: '' })

  return { source, chunks }
}

/** The blocks, in order, as text. The gaps are not here: they belong to the file, not to the document. */
export function blockTexts(layout: MarkdownLayout): string[] {
  return layout.chunks.filter((chunk): chunk is Extract<MarkdownChunk, { kind: 'block' }> => chunk.kind === 'block').map((chunk) => chunk.text.trim())
}

/**
 * How many blocks at each end two documents still agree on.
 *
 * The same idea as GenOffice's draft landing (`keep`): whatever the editor and the file agree on at the start
 * and at the end is not touched, and only the stretch between them is replaced. Keeping the **suffix** too is
 * what makes an edit in the middle of a document cost one block instead of half of it.
 */
export function commonAffixes(before: readonly string[], after: readonly string[]): { prefix: number; suffix: number } {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++
  }
  return { prefix, suffix }
}

/**
 * The file with some blocks replaced — and **only** those blocks.
 *
 * `replacements` is keyed by block index in `layout`. Nothing else is re-serialised: a newline style, a blank
 * line, a block nobody touched keeps its bytes, which is the whole reason this is not "serialise the document
 * and write it".
 */
export function spliceBlocks(layout: MarkdownLayout, replacements: ReadonlyMap<number, string>): string {
  if (replacements.size === 0) return layout.source
  let out = ''
  let block = 0
  for (const chunk of layout.chunks) {
    if (chunk.kind === 'gap') {
      out += chunk.text
      continue
    }
    const next = replacements.get(block++)
    out += next === undefined ? chunk.text : next
  }
  return out
}

/**
 * Replace one contiguous run of blocks with new text.
 *
 * The landing path of an outside write: everything before and after the run is untouched, so the only bytes that
 * move are the ones the file itself changed.
 */
export function spliceRange(layout: MarkdownLayout, fromBlock: number, toBlock: number, text: string): string {
  const count = toBlock - fromBlock
  if (count <= 0) return layout.source
  let seen = -1
  let start = -1
  let end = -1
  for (const chunk of layout.chunks) {
    if (chunk.kind !== 'block') continue
    seen++
    if (seen === fromBlock) start = chunk.from
    if (seen === toBlock - 1) {
      end = chunk.to
      break
    }
  }
  // A run collapses into one block: the blank lines *inside* the run go with it, the ones around it stay.
  if (start < 0 || end < 0) return layout.source
  return layout.source.slice(0, start) + text + layout.source.slice(end)
}

/**
 * Insert `text` as new block(s) **before** block `atBlock` — or after the last one, when `atBlock` is the count.
 *
 * Enter in the middle of a document adds a block without replacing any: the block above keeps its bytes, the block
 * below keeps its bytes, and the new text goes between them with the blank line markdown needs.
 */
export function insertBlocks(layout: MarkdownLayout, atBlock: number, text: string): string {
  if (!text) return layout.source
  const blocks = layout.chunks.filter((chunk) => chunk.kind === 'block')
  if (atBlock >= blocks.length) {
    // At the end: one blank line between, and whatever newline the file ended with is kept where it was.
    const body = layout.source.replace(/\n+$/, '')
    return `${body}${body ? '\n\n' : ''}${text}${layout.source.endsWith('\n') ? '\n' : ''}`
  }
  if (atBlock < 0) return layout.source
  const at = blocks[atBlock]!.from
  return `${layout.source.slice(0, at)}${text}\n\n${layout.source.slice(at)}`
}

/**
 * What an outside write becomes, in the document that is already open.
 *
 * The answer is a *span*: keep `prefix` blocks at the start and `suffix` at the end, and let the stretch between
 * them be replaced by `blocks`. That is the whole of "the agent changed one paragraph" — the caret, the selection
 * and everything above and below it are untouched because they are not in the replaced span at all.
 *
 * Nothing here decides *how* to apply it (ProseMirror transaction, undo step, highlight); it only says what the
 * difference is, in the same block vocabulary the save path uses, so both directions agree on what a block is.
 */
export interface Landing {
  /** Blocks the open document and the file still agree on, from the start. */
  prefix: number
  /** …and from the end. Never overlaps `prefix`. */
  suffix: number
  /** The blocks that take the place of the span between them; empty when the file only removed blocks. */
  blocks: string[]
  /** The file as parsed, for a caller that needs the new offsets. */
  layout: MarkdownLayout
  /** Nothing to do: the document and the file say the same thing. */
  idle: boolean
  /** The file could not be parsed; the caller must fall back to a whole-document reload. */
  unusable: boolean
}

export function planLanding(currentBlocks: readonly string[], nextSource: string): Landing {
  const layout = layoutMarkdown(nextSource)
  const next = blockTexts(layout)
  const { prefix, suffix } = commonAffixes(currentBlocks, next)
  const middle = next.slice(prefix, next.length - suffix)
  return {
    prefix,
    suffix,
    blocks: middle,
    layout,
    idle: middle.length === 0 && prefix + suffix === currentBlocks.length && prefix + suffix === next.length,
    unusable: layout.problem !== undefined,
  }
}

/**
 * Where the span sits **in the document**, from the block sizes of its top-level nodes.
 *
 * `prefix` and `suffix` are blocks; ProseMirror wants offsets, and one off-by-one here rewrites the wrong
 * paragraph without anyone noticing. It takes sizes rather than a `Node` so it can be tested without an editor:
 * `[node.nodeSize, …]` in document order is the whole input.
 */
export function landingTarget(sizes: readonly number[], prefix: number, suffix: number): { from: number; to: number } | null {
  if (prefix < 0 || suffix < 0 || prefix + suffix > sizes.length) return null
  const from = sizes.slice(0, prefix).reduce((total, size) => total + size, 0)
  const to = sizes.reduce((total, size) => total + size, 0) - sizes.slice(sizes.length - suffix).reduce((total, size) => total + size, 0)
  return to < from ? null : { from, to }
}

/**
 * What a save writes: the file, with the blocks that changed swapped in — and nothing else.
 *
 * That is the narrow promise this editor makes — "the blocks you did not touch are byte-identical" — and the reason a
 * construct nobody wrote a node for cannot be quietly rewritten by a save. What it does *not* promise is that a block
 * keeps its count: Enter, a paste, a paragraph turned into a list all change it, and refusing those would mean
 * declining to save what was just typed (`planSaveFromTable` in the editor is where that is decided).
 *
 * `written` and `refused` are reported per block so a caller can say what happened instead of silently dropping it.
 */
export interface SavePlan {
  /** The text to write. Equals `layout.source` when nothing was accepted. */
  text: string
  /** The blocks that were used. */
  written: number[]
  /** The blocks whose replacement was refused, with the reason, so a caller can say so instead of silently dropping. */
  refused: Array<{ block: number; reason: string }>
  /** True when at least one block was written. */
  changed: boolean
}
