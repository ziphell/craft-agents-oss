/**
 * Column alignment for markdown tables — `|:--|:-:|--:|`.
 *
 * That delimiter row is not decoration: GFM defines the colons as the table's column alignment, and the information
 * survives every stage of parsing (marked's table token carries `align`, mdast's table node carries `align`, the
 * renderer's `<th>`/`<td>` carry `align`). It was being dropped at exactly two places — this editor's table node had
 * nowhere to put it, and the serializer wrote `---` for every column — so a table lost its alignment the moment
 * somebody typed in it. (Untouched blocks kept it, because those are written from the file's own bytes.)
 *
 * Two pieces, and both are the reading face's behaviour written down for a document model:
 *
 * - **`align` on `tableCell`/`tableHeader`** — the smallest thing a table can hold alignment in, and the mechanism
 *   `prosemirror-tables` provides for exactly this (`tableNodes({ cellAttributes })`). It also makes the alignment
 *   survive HTML (copy/paste inside the editor), which is why it parses from `style.text-align` as well as the legacy
 *   `align` attribute.
 * - **`Table.parseMarkdown` / `Table.renderMarkdown`** — cells are built by the table, not by themselves, so the
 *   alignment has to be read there (`token.align[index]`, falling back to the cell token's own `align`) and written
 *   back there (the delimiter row, one colon per side).
 *
 * ## Upgrading TipTap will make most of this file redundant
 *
 * Read from the shipped `dist` of 3.32.2 (latest at the time of writing; `genoffice` vendors 3.31) — upstream now does
 * **all four** things this file was written for:
 *
 * | what | upstream | ours (on 3.20) |
 * |---|---|---|
 * | column alignment | `tableCell.align`, `parseMarkdown` reads `token.align`, delimiter row gets `:---`/`---:`/`:---:` | here |
 * | `<br>` in a cell | `@tiptap/markdown` 3.32 parses inline HTML through the schema's `parseDOM` (`parseHTMLToken`), so `<br>` is a `hardBreak`; unrecognised tags become literal text instead of vanishing | `inlineWithBreaks` |
 * | a `\|` in a cell | `escapePipesInCellText` | `escapeCellPipes` |
 * | a cell with several blocks | joined, then every newline becomes `<br>` | same |
 * | the table's own extent | a `markdownTokenizer` that stops at a blank line | `marked`'s own tokenizer |
 *
 * **So: when this project upgrades TipTap to ≥ 3.21, delete most of this file** and go back to
 * `import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'`. Three things to check then,
 * because our block layer was measured against 3.20's serializer: (a) that the delimiter row still falls inside
 * `says()` (it will — colons are punctuation, and `says` compares words), (b) that a table's serialization is still
 * padding-only, so an untouched table is still detected as untouched (`__tests__/tiptap-roundtrip.test.ts`, "pads a
 * table…"), and (c) that an empty block inside a cell is still written `&nbsp;` upstream — we write an empty line
 * instead (`<br><br>`), which is what **Outline** does and what the person reading it expects; keep that one rule even
 * after the rest goes. The upgrade also replaces the table tokenizer, so re-run the whole roundtrip suite rather than
 * trusting this note.
 */

import type { JSONContent } from '@tiptap/core'
import type { MarkdownToken } from '@tiptap/core'
import { Table, TableCell, TableHeader } from '@tiptap/extension-table'

export type TableAlign = 'left' | 'center' | 'right'

/** Only the three values GFM defines; anything else is "no alignment", not an error. */
export function normalizeTableAlign(value: unknown): TableAlign | null {
  return value === 'left' || value === 'right' || value === 'center' ? value : null
}

/** The alignment an element already carries — inline style first, then the legacy attribute. */
function alignOf(element: HTMLElement): TableAlign | null {
  const style = (element.style?.textAlign ?? '').trim().toLowerCase()
  const attribute = (element.getAttribute('align') ?? '').trim().toLowerCase()
  return normalizeTableAlign(style || attribute)
}

const alignAttribute = {
  default: null,
  parseHTML: (element: HTMLElement) => alignOf(element),
  renderHTML: (attributes: { align?: TableAlign | null }) =>
    attributes.align ? { style: `text-align: ${attributes.align}` } : {},
}

export const AlignedTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute }
  },
})

export const AlignedTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), align: alignAttribute }
  },
})

/* ---------------------------------------------------------------------------------------------
 * markdown ↔ document, over the table's own cells
 * ------------------------------------------------------------------------------------------- */

export const AlignedTable = Table.extend({
  parseMarkdown(token, helpers) {
    const columnAligns = Array.isArray((token as { align?: unknown }).align) ? ((token as { align?: unknown[] }).align ?? []) : []
    const attrsFor = (index: number, cell: { align?: unknown }) => {
      const align = normalizeTableAlign(columnAligns[index] ?? cell?.align)
      return align ? { align } : {}
    }

    const rows: JSONContent[] = []
    const header = (token as { header?: Array<{ tokens?: MarkdownToken[]; align?: unknown }> }).header
    if (header) {
      rows.push(
        helpers.createNode(
          'tableRow',
          undefined,
          header.map((cell, index) =>
            helpers.createNode(
              'tableHeader',
              attrsFor(index, cell),
              [{ type: 'paragraph', content: inlineWithBreaks(helpers, cell.tokens ?? []) }] as never,
            ),
          ),
        ) as JSONContent,
      )
    }
    const body = (token as { rows?: Array<Array<{ tokens?: MarkdownToken[]; align?: unknown }>> }).rows
    if (body) {
      for (const row of body) {
        rows.push(
          helpers.createNode(
            'tableRow',
            undefined,
            row.map((cell, index) =>
              helpers.createNode(
                'tableCell',
                attrsFor(index, cell),
                [{ type: 'paragraph', content: inlineWithBreaks(helpers, cell.tokens ?? []) }] as never,
              ),
            ),
          ) as JSONContent,
        )
      }
    }
    return helpers.createNode('table', undefined, rows) as JSONContent
  },

  renderMarkdown(node, helpers) {
    return renderTable(node as { content?: JSONContent[] }, helpers)
  },
})

/** Collapse a cell's whitespace, keeping the `<br>`s that stand for its line breaks. */
function collapseWhitespace(value: string): string {
  return (value ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '<br>')
    .trim()
}

/**
 * A cell's inline tokens, with `<br>` as a real line break.
 *
 * A cell is one line of markdown, so the only way it can hold a line break is the HTML for one — which is what GFM
 * and every table written by a human does. The engine hands that over as a generic `html` token and its inline parser
 * turns it into an empty paragraph *inside* the cell's paragraph, which then writes back as `&nbsp;`: the break
 * silently became a non-breaking space, and because the words survived nothing looked wrong until the next save. (The
 * same shape of loss as `<kbd>`, and the reason the block layer compares words rather than markup.)
 */
function inlineWithBreaks(
  helpers: { parseInline(tokens: MarkdownToken[]): JSONContent[] },
  tokens: readonly MarkdownToken[],
): JSONContent[] {
  const inline: JSONContent[] = []
  let run: MarkdownToken[] = []
  const flush = () => {
    if (run.length > 0) {
      inline.push(...helpers.parseInline(run))
      run = []
    }
  }
  for (const token of tokens) {
    const raw = String((token as { raw?: unknown; text?: unknown }).raw ?? (token as { text?: unknown }).text ?? '')
    if ((token as { type?: string }).type === 'html' && /^<br\s*\/?>$/i.test(raw.trim())) {
      flush()
      inline.push({ type: 'hardBreak' })
      continue
    }
    run.push(token)
  }
  flush()
  return inline
}

/** One cell's markdown on one line: every break in it becomes `<br>`, which is how a table cell holds a break. */
function toCellLine(markdown: string): string {
  return markdown
    .replace(/\\\n/g, '<br>') // a hard break the engine wrote with a backslash
    .replace(/[ \t]*\n/g, '<br>') // a hard break the engine wrote with two spaces, and any other newline
}

/**
 * A `|` inside a cell ends the column, so it has to be escaped — `a \| b` is a cell containing a pipe.
 *
 * Everything already escaped (`\|`, `\\`) is left alone: escaping it twice would put a literal backslash into
 * somebody's file. Every table renderer that keeps cell text does this (TipTap 3.32's `escapePipesInCellText`,
 * genoffice while rendering a table, Outline's `esc()` under `inTable`); without it, typing a pipe into a cell produced
 * a row with one column too many.
 */
function escapeCellPipes(text: string): string {
  return text.replace(/\\.|\|/g, (match) => (match === '|' ? '\\|' : match))
}

/**
 * The table as markdown: padded columns (as before), and a delimiter row that says how each column is aligned.
 *
 * Lifted from `@tiptap/extension-table` 3.20's own renderer — same padding, same empty first line, same `\u001f`
 * between a cell's block children — with the colons added. Changing the rest as well would have re-serialized every
 * table in every file for a feature that touches one line of them.
 */
function renderTable(
  node: { content?: JSONContent[] },
  helpers: { renderChildren(children: JSONContent[] | JSONContent): string },
): string {
  if (!node?.content || node.content.length === 0) return ''

  const rows: Array<Array<{ text: string; isHeader: boolean; align: TableAlign | null }>> = []
  for (const row of node.content) {
    const cells: Array<{ text: string; isHeader: boolean; align: TableAlign | null }> = []
    for (const cell of row.content ?? []) {
      const blocks = Array.isArray(cell.content) ? cell.content : []
      /*
       * A cell is one line of markdown, so every break in it has to be written `<br>` — the one a person typed, and
       * the boundary between two blocks that ended up in the same cell. The stock renderer joined those with a `\u001f`
       * control character (a byte that means nothing in markdown, and is not even printable) and let a hard break's own
       * newline split the row in two.
       */
      const raw = blocks
        .map((child) => {
          const piece = toCellLine(helpers.renderChildren(child))
          // An empty block is an **empty line** in the cell, not the `&nbsp;` the engine writes for an empty paragraph:
          // two breaks in a row are what a person reads as a blank line, and a non-breaking space is not nothing.
          return piece.replace(/&nbsp;/g, '').trim() === '' ? '' : piece
        })
        .join('<br>')
      cells.push({
        text: escapeCellPipes(collapseWhitespace(raw)),
        isHeader: cell.type === 'tableHeader',
        align: normalizeTableAlign((cell.attrs as { align?: unknown } | undefined)?.align),
      })
    }
    rows.push(cells)
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (columnCount === 0) return ''

  const columnAligns: Array<TableAlign | null> = new Array(columnCount).fill(null)
  for (const row of rows) {
    row.forEach((cell, index) => {
      if (!columnAligns[index] && cell.align) columnAligns[index] = cell.align
    })
  }

  const widths = new Array(columnCount).fill(0)
  for (const row of rows) {
    for (let index = 0; index < columnCount; index += 1) {
      widths[index] = Math.max(widths[index], (row[index]?.text ?? '').length, 3)
    }
  }

  const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length))
  const headerRow = rows[0] ?? []
  const hasHeader = headerRow.some((cell) => cell.isHeader)
  const headerTexts = new Array(columnCount).fill('').map((_, index) => (hasHeader ? (headerRow[index]?.text ?? '') : ''))

  let out = '\n'
  out += `| ${headerTexts.map((text, index) => pad(text, widths[index]!)).join(' | ')} |\n`
  out += `| ${widths
    .map((width, index) => {
      const dashes = '-'.repeat(Math.max(3, width))
      const align = columnAligns[index]
      if (align === 'left') return `:${dashes}`
      if (align === 'right') return `${dashes}:`
      if (align === 'center') return `:${dashes}:`
      return dashes
    })
    .join(' | ')} |\n`
  const body = hasHeader ? rows.slice(1) : rows
  for (const row of body) {
    out += `| ${new Array(columnCount)
      .fill('')
      .map((_, index) => pad(row[index]?.text ?? '', widths[index]!))
      .join(' | ')} |\n`
  }
  return out
}

/** The `style` a cell needs for its alignment — `undefined` when the column does not say. */
export function tableCellAlignStyle(align: unknown): { textAlign: TableAlign } | undefined {
  const normalized = normalizeTableAlign(align)
  return normalized ? { textAlign: normalized } : undefined
}

/**
 * The alignment a table cell carries on the element the renderer hands over (`<th align="left">`).
 *
 * `remark-gfm` reads it off the delimiter row and `remark-rehype` puts it on every cell; the reading face's `th`/`td`
 * components used to take only `children`, which is why a document's alignment was invisible while being read.
 */
export function tableCellAlignOf(node: unknown): string | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties
  const align = properties?.align
  return typeof align === 'string' ? align : null
}
