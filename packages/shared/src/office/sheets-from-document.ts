/**
 * Tables out of a document, as a workbook.
 *
 * **This is transcoding, not recovery.** A markdown table and an HTML `<table>` have real structure,
 * so nothing here guesses: the ambiguity is not "where is the table" but "which tables, and what
 * are they called". The rules are stated below and enforced by tests, because a converter whose
 * rules are folklore produces workbooks nobody trusts.
 *
 * What it deliberately does **not** do, and why that is not laziness:
 *
 * - **No formulas.** A markdown cell is text; `=SUM(A2:A3)` in a document is a *string*, and turning
 *   it into a live formula would be inventing arithmetic the author never asked for. (The agent
 *   writes formulas through `create --from` / `apply --ops`, where it means them.)
 * - **No type guessing beyond the unambiguous.** `-12` and `3.5` become numbers; `1,200`, `12%` and
 *   `2026-10-30` stay text. Guessing a locale turns a column of money into a column of wrong
 *   numbers, which is worse than a column of text.
 * - **No merging.** A merged cell in the source is *filled* (see below) rather than reproduced:
 *   `merge_cells` is a layout fact about a range, and once the grid is flattened there is no range
 *   to merge. An author who wants merges asks for them with an op.
 *
 * The heuristics that matter, all of them "as much as possible" rather than "as strictly as legal":
 *
 * | source construct | what happens |
 * | --- | --- |
 * | `<td colspan=3>` | the value fills all three columns |
 * | `<td rowspan=4>` | the value fills the same column in the next three rows |
 * | nested `<table>` | the outer table is taken; the inner one is counted in a note |
 * | `<caption>` | the sheet name, ahead of any heading |
 * | a heading | the sheet name: the nearest one *above* the table |
 * | no heading, no caption | `Sheet1`, `Sheet2`, … |
 * | a markdown table | header row + body, with `\|` unescaped and inline markers stripped |
 * | a table inside a code fence | **not** a table — that is an example of one |
 */

import { parseHTML } from 'linkedom'
import type { CellValue, ExtractedTable, WorkbookSpec } from './types'

/** Excel's own limit, and the reason a name gets truncated rather than rejected. */
const SHEET_NAME_MAX = 31

/** Characters a worksheet name may not contain; Excel refuses the file rather than the name. */
const ILLEGAL_SHEET_CHARS = /[[\]:*?/\\]/g

/** A number we are certain about: no separators, no currency, no percent. */
function asNumber(text: string): number | null {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** Cell text → a value. Everything ambiguous stays text, on purpose (see the header). */
export function cellValue(raw: string): CellValue {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return null
  const number = asNumber(text)
  return number === null ? text : number
}

/**
 * Strip the inline markers that mean "formatting" in a document and would be noise in a cell.
 *
 * Deliberately shallow: emphasis, code spans and links are the ones a person reads *through*; a
 * footnote marker or an image keeps its text, because dropping content is worse than keeping markup.
 */
export function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
}

/** A worksheet name that Excel will accept, and that two tables cannot share. */
export function sheetName(candidate: string | null, fallbackIndex: number, taken: Set<string>): string {
  const base = (candidate ?? '')
    .replace(ILLEGAL_SHEET_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SHEET_NAME_MAX)
    .trim()
  let name = base || `Sheet${fallbackIndex}`
  let suffix = 2
  while (taken.has(name.toLowerCase())) {
    const tag = ` (${suffix++})`
    name = `${(base || `Sheet${fallbackIndex}`).slice(0, SHEET_NAME_MAX - tag.length)}${tag}`
  }
  taken.add(name.toLowerCase())
  return name
}

/** Drop rows that are entirely empty, and columns that are entirely empty after that. */
function trimGrid(rows: CellValue[][]): CellValue[][] {
  const kept = rows.filter((row) => row.some((cell) => cell !== null && cell !== ''))
  if (!kept.length) return []
  const width = Math.max(...kept.map((row) => row.length))
  const keepColumn: boolean[] = []
  for (let column = 0; column < width; column++) {
    keepColumn[column] = kept.some((row) => {
      const cell = row[column]
      return cell !== undefined && cell !== null && cell !== ''
    })
  }
  return kept.map((row) => {
    const next: CellValue[] = []
    for (let column = 0; column < width; column++) if (keepColumn[column]) next.push(row[column] ?? null)
    return next
  })
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** Split one table row into cells, honouring `\|` and ignoring the outer pipes. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!
    if (char === '\\' && trimmed[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** Is this the `| --- | :--: |` row that separates a header from its body? */
function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s/g, '')))
}

/**
 * Every markdown table in a document, in order, named by the heading above it.
 *
 * A fence is skipped rather than parsed: a table inside ``` is an *example of a table*, which is
 * exactly what a document about markdown contains — exporting that would be exporting the manual.
 */
export function tablesFromMarkdown(source: string): ExtractedTable[] {
  const lines = source.split(/\r?\n/)
  const taken = new Set<string>()
  const tables: ExtractedTable[] = []
  let heading: string | null = null
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const atx = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (atx) {
      heading = plainInline(atx[2]!.trim()).slice(0, SHEET_NAME_MAX) || null
      continue
    }
    // setext heading: a line of text underlined by === or ---
    if (i + 1 < lines.length && line.trim() && /^\s{0,3}(=+|-{3,})\s*$/.test(lines[i + 1]!) && !line.includes('|')) {
      heading = plainInline(line.trim()).slice(0, SHEET_NAME_MAX) || null
      i++
      continue
    }

    const isRow = line.includes('|')
    const next = lines[i + 1]
    if (!isRow || !next || !isDelimiterRow(next)) continue

    const header = splitTableRow(line).map((cell) => plainInline(cell))
    const rows: CellValue[][] = [header.map(cellValue)]
    i += 2
    while (i < lines.length && lines[i]!.includes('|') && !isDelimiterRow(lines[i]!)) {
      rows.push(splitTableRow(lines[i]!).map((cell) => cellValue(plainInline(cell))))
      i++
    }
    i--

    const grid = trimGrid(rows)
    if (!grid.length) continue
    // A GFM table always has a header row — the delimiter line is what makes it a table at all.
    tables.push({ sheetName: sheetName(heading, tables.length + 1, taken), rows: grid, headerRow: true })
  }

  return tables
}

// ── HTML ────────────────────────────────────────────────────────────────────

/**
 * The slice of a DOM node this file uses.
 *
 * `packages/shared` compiles without the DOM lib (it runs in Node and on a hub), so `Element` here
 * is a structural type rather than the browser's: linkedom's nodes satisfy it, and nothing in this
 * module can accidentally depend on a DOM API that only exists in a renderer.
 */
interface MinimalElement {
  tagName: string
  children: ArrayLike<MinimalElement>
  parentElement: MinimalElement | null
  textContent?: string | null
  getAttribute(name: string): string | null
  querySelector(selector: string): MinimalElement | null
  querySelectorAll(selector: string): ArrayLike<MinimalElement>
  closest(selector: string): MinimalElement | null
}

/** The visible text of a node, with source whitespace collapsed. */
function nodeText(node: { textContent?: string | null }): string {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * A table's rows as a rectangular grid, with `colspan` and `rowspan` **filled in**.
 *
 * Filling rather than leaving holes is the whole point of "as much as possible": a reader of the
 * workbook wants the value that applied to those cells, and `null` reads as "unknown". This is
 * also why an exported workbook has no merges — the geometry is already gone by the time the grid
 * exists (see the header).
 */
export function gridFromTable(table: MinimalElement): CellValue[][] {
  const rows = Array.from(table.querySelectorAll('tr'))
  const grid: CellValue[][] = []
  /** Columns still covered by a rowspan from an earlier row: column index → value. */
  const carried = new Map<number, { value: CellValue; remaining: number }>()

  for (const row of rows) {
    const cells = Array.from(row.children).filter(
      (child) => child.tagName === 'TD' || child.tagName === 'TH',
    )
    const line: CellValue[] = []
    let column = 0

    const flushCarried = () => {
      while (carried.has(column)) {
        const span = carried.get(column)!
        line[column] = span.value
        span.remaining -= 1
        if (span.remaining <= 0) carried.delete(column)
        column += 1
      }
    }

    for (const cell of cells) {
      flushCarried()
      const value = cellValue(nodeText(cell))
      const colspan = Math.max(1, Number(cell.getAttribute('colspan') ?? '1') || 1)
      const rowspan = Math.max(1, Number(cell.getAttribute('rowspan') ?? '1') || 1)
      for (let offset = 0; offset < colspan; offset++) {
        line[column] = value
        if (rowspan > 1) carried.set(column, { value, remaining: rowspan - 1 })
        column += 1
      }
    }
    flushCarried()
    grid.push(line)
  }

  return trimGrid(grid)
}

/**
 * Every top-level table in an HTML document, named by `<caption>` and then by the heading above it.
 *
 * A nested table is not exported: it belongs to the cell that contains it, and a workbook has no
 * cell that can hold one. The count is reported so the caller can say what was left behind rather
 * than pretend the document had fewer tables.
 */
export function tablesFromHtml(html: string): ExtractedTable[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`) as unknown as {
    document: MinimalElement
  }
  const taken = new Set<string>()
  const tables: ExtractedTable[] = []
  let skippedNested = 0

  // Document order, so "the heading above it" is the last heading seen.
  let heading: string | null = null
  const walker = document.querySelectorAll('h1,h2,h3,h4,h5,h6,table')
  for (const node of Array.from(walker)) {
    const tag = node.tagName.toLowerCase()
    if (tag !== 'table') {
      heading = nodeText(node).slice(0, SHEET_NAME_MAX) || null
      continue
    }
    if (node.parentElement?.closest('table')) {
      skippedNested += 1
      continue
    }
    const grid = gridFromTable(node as unknown as MinimalElement)
    if (!grid.length) continue
    const caption = node.querySelector('caption')
    const name = caption ? nodeText(caption) : heading
    // Only when the document said so: a `<th>` in the first row is the author's claim, and the
    // freeze/filter that follows from it is only right when they made it.
    const firstRow = node.querySelector('tr')
    const headerRow = Boolean(
      firstRow && Array.from(firstRow.children).some((cell) => cell.tagName === 'TH'),
    )
    tables.push({ sheetName: sheetName(name, tables.length + 1, taken), rows: grid, headerRow })
  }

  if (skippedNested > 0) {
    for (const table of tables) table.note = `${skippedNested} nested table(s) were not exported`
    if (!tables.length) {
      tables.push({ sheetName: 'Sheet1', rows: [], note: `${skippedNested} nested table(s) were not exported` })
    }
  }

  return tables
}

/**
 * The workbook a document describes, or null when it describes none.
 *
 * Null is the answer for "no tables", not an empty workbook: a file with nothing in it is not a
 * conversion, it is a mistake being handed to a person.
 */
export function workbookFromDocument(source: string, kind: 'md' | 'html'): WorkbookSpec | null {
  const tables = kind === 'md' ? tablesFromMarkdown(source) : tablesFromHtml(source)
  const sheets = tables.filter((table) => table.rows.length > 0)
  if (!sheets.length) return null
  return {
    sheets: sheets.map((table) => ({
      name: table.sheetName,
      rows: table.rows,
      ...(table.headerRow ? { headerRow: true } : {}),
    })),
  }
}
