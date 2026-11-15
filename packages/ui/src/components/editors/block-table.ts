/**
 * The block table: what the open document is made of, measured against the file it came from.
 *
 * It exists because of a measurement, not a guess. Running the real editor (official markdown engine) over a
 * small document showed that a block's serialization is **not** the file's bytes:
 *
 * ```
 * file: | a | b |              doc: | a   | b   |
 *       | --- | --- |                | --- | --- |
 *       | 1 | 2 |                    | 1   | 2   |
 * ```
 *
 * Tables get their columns padded. Frontmatter (`---\ntitle: …\n---`) does not survive at all — the parser reads
 * it as a thematic break followed by a heading, so one file block becomes two nodes. A diff that compares "what
 * the document serializes to" against "what the file says" therefore sees a table as **changed when nobody touched
 * it**, and every save reformats every table in the file.
 *
 * So the two directions use different yardsticks, and this module keeps both:
 *
 * - **Landing (file → document)** compares *file text against file text*. The layout of the source the document
 *   was loaded from is kept here; the incoming write is laid out the same way; blocks are compared as bytes. A
 *   table the agent did not touch is not a difference, because neither side went through the serializer.
 * - **Saving (document → file)** compares *the node against itself*: `baseline` is what this node serialized to
 *   when the table was built. Until the person actually edits a block, the node still serializes to exactly that,
 *   so the block is written from `source` — its original bytes, padding and all.
 *
 * The `null` baseline is the third case: a block that does not become exactly one node (frontmatter, or anything
 * the schema has no home for) is **not live**. It keeps its bytes until somebody edits it — the document carries it
 * as its own text, so an edit means the text on screen, and that is what gets written. The landing path is the one
 * place that still refuses to splice while the document and the table disagree about how many blocks there are.
 *
 * A save is keyed by blocks, but a block is not a straitjacket: Enter, a paste, Backspace joining two paragraphs —
 * a keystroke may change how many blocks there are, and `planSaveByDiff` answers that by replacing one *region* of
 * the file instead of one row of this table.
 */

import { insertBlocks, layoutMarkdown, planLanding, spliceBlocks, spliceRange, type Landing, type MarkdownChunk, type MarkdownLayout, type SavePlan } from './markdown-blocks'
import { says } from './block-parse'

/** What the editor can do with markdown; the only thing this module needs from it. */
export interface BlockBridge {
  /** Markdown in, document JSON out (one block in, at most one node out, in practice). */
  parse: (markdown: string) => { content?: unknown[] } | null
  /** Document JSON in, markdown out. */
  serialize: (json: unknown) => string
}

export interface BlockRow {
  /** Byte range in `BlockTable.source`. */
  from: number
  to: number
  /** The file's exact bytes for this block, including the whitespace inside it. */
  source: string
  /** `source` trimmed — what the landing diff compares. */
  text: string
  /**
   * What this block's node serialized to when the table was built, or `null` when the block is not exactly one
   * node. A block whose baseline is `null` is never re-serialized: it is not editable as a block, and it keeps its
   * bytes.
   */
  baseline: string | null
}

export interface BlockTable {
  /** The file text this table describes. */
  source: string
  layout: MarkdownLayout
  rows: BlockRow[]
}

/**
 * Build the table for `source`.
 *
 * Every block is parsed on its own, which is also the check that it is a block the document can hold: a fragment
 * that parses to zero or to several nodes is stored with a `null` baseline. Without a bridge (a legacy markdown
 * engine) the table still has its layout, but no block is live — the caller falls back to whole-document behaviour.
 */
export function buildBlockTable(source: string, bridge: BlockBridge | null): BlockTable {
  const layout = layoutMarkdown(source)
  const rows: BlockRow[] = []
  for (const chunk of layout.chunks) {
    if (chunk.kind !== 'block') continue
    let baseline: string | null = null
    if (bridge) {
      try {
        const content = bridge.parse(chunk.text)?.content ?? []
        if (content.length === 1) {
          const serialized = bridge.serialize({ type: 'doc', content }).trim()
          /*
           * **Live only if the words survived.** A block can parse into one node and still come back with less than it
           * said — `<div>红色的一段</div>` serializes to `""`, and `<kbd>Ctrl</kbd>` to `&nbsp;` while staying
           * non-empty. Such a block is not live: writing it back would replace the person's markup, and the text
           * inside it, with what the engine could say. Its bytes are kept instead, and it is carried as its own text
           * (`block-parse.ts`), which is what keeps the block count and the document equal.
           */
          baseline = says(serialized) === says(chunk.text) ? serialized : null
        }
      } catch {
        baseline = null
      }
    }
    rows.push({ from: chunk.from, to: chunk.to, source: chunk.text, text: chunk.text.trim(), baseline })
  }
  return { source, layout, rows }
}

/**
 * What an outside write becomes, measured in the file's own blocks — the side that never went through a serializer.
 */
export function planLandingFromTable(table: BlockTable, nextSource: string): Landing {
  return planLanding(table.rows.map((row) => row.text), nextSource)
}

/**
 * What a save writes.
 *
 * `current` is the document's side, one entry per row, already in **file space** (the caller undoes its engine's
 * escaping, e.g. `¤` → `$`): the block's node serialized now, or `null` when there is no node to ask. A row whose
 * text is unchanged since load is written from `source`, so a table keeps the file's own alignment instead of
 * gaining the serializer's padding the first time anything else in the document is saved.
 *
 * **One block may become several.** Enter, a paste with a blank line in it, a paragraph turned into a list: a
 * keystroke is not obliged to keep the block count, and an editor that refuses those is an editor that silently
 * declines to save what was just typed. The replacement goes into the block's own byte range, which may now hold
 * more blocks than the row it replaces — the table is rebuilt from the text afterwards (`retable` → `null` →
 * `buildBlockTable`), so nothing downstream keeps a stale row.
 *
 * The one thing still refused is text the parser throws on: writing it would produce a file nobody can read back.
 */
export function planSaveFromTable(
  table: BlockTable,
  current: ReadonlyArray<string | null>,
  reparse: (block: string) => string[],
): SavePlan {
  const changes = new Map<number, string>()
  const refused: SavePlan['refused'] = []

  table.rows.forEach((row, index) => {
    const now = current[index]
    if (now == null) return // no node to ask; assume untouched rather than guess
    const text = now.trim()

    if (row.baseline === null) {
      /*
       * Not live: the block is one the engine could not carry — it is on screen as its own text (a raw `<div>`, a
       * `<kbd>`), and the engine is not trusted to give its markup back unchanged. That says nothing about the
       * *person's* edit: if the text on screen is no longer the text the file holds, they typed in it, and what they
       * typed is what the block now says. Until this existed, typing in such a block was quietly dropped.
       */
      if (text !== row.source.trim()) changes.set(index, text)
      return
    }
    if (text === row.baseline) return // untouched since load — keep the file's bytes

    if (!text) {
      // An emptied block is a deleted block: the block itself goes, and its gap stays.
      changes.set(index, '')
      return
    }
    try {
      reparse(text)
    } catch (error) {
      refused.push({ block: index, reason: `did not parse: ${String(error)}` })
      return
    }
    changes.set(index, text)
  })

  return {
    text: spliceBlocks(table.layout, changes),
    written: [...changes.keys()].sort((a, b) => a - b),
    refused,
    changed: changes.size > 0,
  }
}

/**
 * The table again, for a body that was just written, when the blocks still line up one to one.
 *
 * `null` when they do not — a save that split a block (Enter, a paste of two paragraphs) changed how many there are,
 * so there is no row-by-row answer and the caller rebuilds from the text (`buildBlockTable`).
 *
 * `current` is the document side of the blocks that were written: their baseline becomes what they serialize to now,
 * so the *next* save sees them as untouched and leaves their bytes alone.
 */
/**
 * The table after a save that changed the block count: the rows outside the region keep what they had, the region's
 * new blocks come in with the text they were written as.
 *
 * `buildBlockTable` would answer the same thing by re-parsing every block of the file — measured at ~50ms for a
 * 128-block document, on top of the ~25ms the layout itself costs, and a structural save is something a person does
 * with the Enter key. The rows that were not in the region are untouched by definition (the save only rewrote those
 * bytes), so their baselines still describe them; only the offsets move.
 *
 * Falls back to `null` when the assembled rows do not line up with the new text, which the caller answers by
 * rebuilding.
 */
export function retableAfterRegion(
  table: BlockTable,
  nextSource: string,
  rowFrom: number,
  rowTo: number,
  newBlocks: readonly string[],
): BlockTable | null {
  const layout = layoutMarkdown(nextSource)
  const chunks = layout.chunks.filter((chunk) => chunk.kind === 'block')
  const rows: BlockRow[] = []
  /** One row per block of the new text, in order — whatever the offsets say, the rows must line up with the blocks. */
  const add = (baseline: string | null): boolean => {
    const chunk = chunks[rows.length]
    if (!chunk) return false
    rows.push({ from: chunk.from, to: chunk.to, source: chunk.text, text: chunk.text.trim(), baseline })
    return true
  }

  for (let index = 0; index < rowFrom; index += 1) {
    if (!add(table.rows[index]?.baseline ?? null)) return null
  }
  for (const block of newBlocks) {
    // The block was written from this text, so this text is what its node says: that is what a baseline is.
    if (!add(block.trim())) return null
  }
  for (let index = rowTo; index < table.rows.length; index += 1) {
    if (!add(table.rows[index]?.baseline ?? null)) return null
  }

  return rows.length === chunks.length ? { source: nextSource, layout, rows } : null
}

/**
 * The table again, for a body that was just written. — **without re-reading the file.**
 *
 * Measured: `layoutMarkdown` on a 128-block / 19 KB document costs ~29 ms, and this function ran on every keystroke,
 * to answer a question whose answer is arithmetic. A save replaces the bytes of the blocks it wrote and nothing else
 * (`spliceBlocks` is literally that), so the new offsets are the old ones shifted by the lengths the replaced blocks
 * gained or lost. The gaps between blocks do not move at all; they only start at different offsets.
 *
 * `written` is what makes it exact: the rows whose bytes were replaced, whose new text is what their nodes say now.
 * The rebuilt chunk list is then **checked against `nextSource`** character for character, and anything that does not
 * line up — a block that ends in whitespace, a replacement that is empty (which deletes a block), a table in the caller
 * that was not the one the text came from — falls back to a real layout. Cheap, and the fallback is the old code.
 */
export function retable(
  table: BlockTable,
  nextSource: string,
  current?: ReadonlyArray<string | null>,
  written?: readonly number[],
): BlockTable | null {
  if (written && written.length > 0) {
    const shifted = retableByShift(table, nextSource, current, written)
    if (shifted) return shifted
  }

  const layout = layoutMarkdown(nextSource)
  const blocks = layout.chunks.filter((chunk) => chunk.kind === 'block')
  if (blocks.length !== table.rows.length) return null
  return {
    source: nextSource,
    layout,
    rows: table.rows.map((row, index) => {
      const chunk = blocks[index]!
      const now = current?.[index]
      return {
        from: chunk.from,
        to: chunk.to,
        source: chunk.text,
        text: chunk.text.trim(),
        baseline: now != null ? now.trim() : row.baseline,
      }
    }),
  }
}

/**
 * The table again, from the previous one and the lengths that changed.
 *
 * `null` when the arithmetic cannot be confirmed against `nextSource`, which is the caller's signal to read the file
 * again. Nothing here parses markdown: one pass over the chunks, one `join` to check, one pass over the rows.
 */
function retableByShift(
  table: BlockTable,
  nextSource: string,
  current: ReadonlyArray<string | null> | undefined,
  written: readonly number[],
): BlockTable | null {
  const replaced = new Set(written)
  const chunks: MarkdownChunk[] = []
  const bounds: Array<{ from: number; to: number; source: string }> = []
  let cursor = 0
  let index = 0

  for (const chunk of table.layout.chunks) {
    if (chunk.kind === 'gap') {
      chunks.push({ kind: 'gap', from: cursor, to: cursor + chunk.text.length, text: chunk.text })
      cursor += chunk.text.length
      continue
    }
    const row = table.rows[index]
    if (!row) return null
    // A written row says what its node says now; every other row keeps the bytes the file already had.
    const text = replaced.has(index) ? (current?.[index] ?? '').trim() : row.source
    // An empty replacement deletes the block, which changes the count: that is the structural path's question.
    if (!text) return null
    // A block with surrounding whitespace would change where the *next* gap starts. Do not guess — re-read instead.
    if (text !== text.trim()) return null
    chunks.push({ kind: 'block', from: cursor, to: cursor + text.length, text })
    bounds.push({ from: cursor, to: cursor + text.length, source: text })
    cursor += text.length
    index += 1
  }

  if (index !== table.rows.length) return null
  // The check that makes the shortcut safe: the chunks have to add up to the text the caller was given.
  let joined = ''
  for (const chunk of chunks) joined += chunk.text
  if (joined !== nextSource) return null

  return {
    source: nextSource,
    layout: { source: nextSource, chunks },
    rows: table.rows.map((row, rowIndex) => {
      const bound = bounds[rowIndex]!
      const now = current?.[rowIndex]
      return {
        from: bound.from,
        to: bound.to,
        source: bound.source,
        text: bound.source.trim(),
        baseline: now != null ? now.trim() : row.baseline,
      }
    }),
  }
}

/** A top-level node of a document, as much of it as finding a position needs. */
export interface PositionedNode {
  nodeSize: number
}

/**
 * Which top-level blocks a set of edited ranges touches.
 *
 * This is what makes saving cheap: a keystroke reports the positions it touched, and only those blocks are
 * re-serialized to see whether they changed. Any change that spans a boundary counts both sides — a block that
 * gained a paragraph is still a change to the block it was in, and a bare position (a step that only sets the
 * selection) touches nothing.
 */
export function touchedBlocks(
  nodes: readonly PositionedNode[],
  ranges: ReadonlyArray<{ from: number; to: number }>,
): number[] {
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const node of nodes) {
    starts.push(offset)
    offset += node.nodeSize
    ends.push(offset)
  }

  const found = new Set<number>()
  for (const range of ranges) {
    const from = Math.min(range.from, range.to)
    const to = Math.max(range.from, range.to)
    for (let index = 0; index < nodes.length; index += 1) {
      const start = starts[index]!
      const end = ends[index]!
      if (from === to) {
        // An insertion sits between two positions; it belongs to the block that contains it.
        if (from >= start && from <= end) found.add(index)
        continue
      }
      // Overlap. A deletion that ends exactly where the next block starts belongs to the one it came from.
      if (from < end && to > start) found.add(index)
    }
  }
  return [...found].sort((a, b) => a - b)
}

/* ---------------------------------------------------------------------------------------------
 * The paragraph past the end.
 *
 * TipTap's `TrailingNode` (on by default in StarterKit) keeps one empty paragraph after a document that ends with
 * something you cannot type below — a table, a list, a code fence — so there is somewhere for the caret to go. That
 * node belongs to the editor and not to the file, and everything that counts blocks has to know it: with it in the
 * count, a file ending in a table looked like it had a block the file never had, so every outside write fell back to
 * a whole-document reload (`the document has 3 blocks where the file has 2`) and a person typing in that paragraph
 * had their text dropped on save.
 *
 * It is recognised by **shape**, not by counting: the last top-level node, a paragraph, saying nothing. Counting
 * would not do — a paragraph the person emptied and a merge that removed a block both change the count, and the two
 * need different answers.
 * ------------------------------------------------------------------------------------------- */

/** As much of a ProseMirror node as deciding this needs. */
export interface Documentish {
  childCount: number
  child(index: number): { type: { name: string }; content: { size: number } }
}

/**
 * The index of the editor's trailing paragraph, or -1 when the document is exactly its blocks.
 *
 * A paragraph that says something is not this: it is a block — a new one, if the file has not got it yet — and the
 * save path treats it as such.
 */
export function appendixIndex(doc: Documentish): number {
  if (doc.childCount === 0) return -1
  const last = doc.child(doc.childCount - 1)
  if (last.type.name !== 'paragraph') return -1
  return last.content.size === 0 ? doc.childCount - 1 : -1
}

/** A save that replaced a region of the file: the rows it stood for, and the blocks that replaced them. */
export interface RegionSavePlan extends SavePlan {
  region: { from: number; to: number; blocks: readonly string[] }
}

/**
 * What a save writes when the edit changed how many blocks there are.
 *
 * Enter, a paste with a blank line in it, Backspace at the start of a paragraph: a keystroke is not obliged to keep
 * the block count, and a block-index comparison has nothing to say about it — index 1 is now two paragraphs and
 * index 2 is a table. Measured before this existed: pressing Enter wrote the *first* half of the paragraph and
 * dropped the rest from the file (the node that held it was never asked about), and joining two paragraphs wrote
 * the merged text into the row of the first and left the second row's bytes in place, so the text appeared twice.
 *
 * So the alignment is done the way the landing path does it, from both ends: the blocks that still say what their
 * row said are a prefix, the ones at the end are a suffix, and everything between them is **one region** that is
 * replaced. Untouched blocks keep the file's own bytes, a table keeps its alignment, and the block that split keeps
 * both of its halves.
 *
 * `now` is the document's blocks, serialized in file space, in order.
 */
export function planSaveByDiff(
  table: BlockTable,
  now: readonly string[],
  reparse: (block: string) => string[],
): RegionSavePlan {
  const rows = table.rows
  const same = (node: string | undefined, row: BlockRow | undefined): boolean => {
    if (node === undefined || row === undefined) return false
    // `baseline` is what the row's own node serialized to when the table was built; a row that is not live has none,
    // and then its file text is the only thing it can be compared with.
    return node.trim() === (row.baseline ?? row.text).trim()
  }

  let prefix = 0
  while (prefix < rows.length && prefix < now.length && same(now[prefix], rows[prefix])) prefix += 1
  let suffix = 0
  while (
    suffix < rows.length - prefix &&
    suffix < now.length - prefix &&
    same(now[now.length - 1 - suffix], rows[rows.length - 1 - suffix])
  ) {
    suffix += 1
  }

  const rowFrom = prefix
  const rowTo = rows.length - suffix
  const blocks = now.slice(prefix, now.length - suffix)
  const text = blocks.join('\n\n')
  const region = { from: rowFrom, to: rowTo, blocks }

  if (rowFrom === rowTo && !text) {
    return { text: table.source, written: [], refused: [], changed: false, region }
  }
  try {
    reparse(text)
  } catch (error) {
    return {
      text: table.source,
      written: [],
      refused: [{ block: rowFrom, reason: `did not parse: ${String(error)}` }],
      changed: false,
      region,
    }
  }

  const next =
    rowFrom === rowTo
      ? insertBlocks(table.layout, rowFrom, text) // nothing was replaced: a block was added here
      : spliceRange(table.layout, rowFrom, rowTo, text)
  return {
    text: next,
    written: rowFrom === rowTo ? [rowFrom] : Array.from({ length: rowTo - rowFrom }, (_, offset) => rowFrom + offset),
    refused: [],
    changed: next !== table.source,
    region,
  }
}
