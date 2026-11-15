/**
 * An Office attachment, as markdown, for the model to read.
 *
 * Something in this process has to turn a `.docx` into text — the model cannot read the zip. That
 * used to be `markitdown-js`, which brought nineteen parsers (pdf-parse, ffmpeg, tesseract, Azure
 * Document Intelligence, exiftool, Outlook `.msg`) for six extensions that ever reach it here, and
 * one of those six never takes this path at all: `attachment.type === 'pdf'` goes to the API as
 * bytes, so the 10.8 MB `pdf-parse` fork at the top of that tree could not run even once. Measured
 * on the built main process, the tree was 14.5 MB of a 46 MB bundle.
 *
 * What is actually asked for is narrower, so this file does exactly it, with readers that read:
 *
 * - `.docx` — mammoth (WordprocessingML → HTML) and turndown (HTML → markdown, tables included)
 * - `.xlsx` / `.xls` — SheetJS, one markdown table per sheet
 * - `.pptx` — node-pptx-parser, one section per slide
 * - `.doc` / `.ppt` — the pre-2007 binaries: a sentence naming the modern format, because no reader
 *   here takes them (the old converter's did not either — mammoth and SheetJS read OOXML, so those
 *   two extensions were already a failure, just an obscure one)
 *
 * Reading only. Nothing here writes a document back; the writing lives in the editors' hosts.
 */

import { extname } from 'node:path'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import * as XLSX from 'xlsx'
import PptxParser from 'node-pptx-parser'

/** Collapse the blank-line runs every one of these conversions leaves behind. */
function tidy(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // mammoth wraps list text in <p>, so turndown answers "-   item". Only a marker at the start of
    // a line is touched — a nested list's marker is indented, and that indent is meaningful.
    .replace(/^([-*+]) {2,}/gm, '$1 ')
    .trim()
}

/** One cell's text: whitespace flattened, and a literal `|` escaped so it cannot end the column. */
function escapeCell(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/**
 * Rows → a markdown table. The first row is the header.
 *
 * Markdown has no table without a header, and both of the sources here give plain body rows
 * (mammoth writes `<td>` everywhere; a workbook has no `<th>` at all), so the first row is promoted
 * rather than invented. Fully empty rows are dropped — a trailing blank row in a sheet otherwise
 * becomes a row of pipes.
 */
export function rowsToMarkdownTable(rows: readonly (readonly string[])[]): string {
  const body = rows.filter((row) => row.some((cell) => cell !== ''))
  if (body.length === 0) return ''
  const width = Math.max(...body.map((row) => row.length))
  const pad = (row: readonly string[]) => [...row, ...Array<string>(width - row.length).fill('')]
  const line = (row: readonly string[]) => `| ${pad(row).join(' | ')} |`
  const [head, ...rest] = body
  return [line(head), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...rest.map(line)].join('\n')
}

/**
 * Enough of a DOM node to walk a table, without pulling `lib.dom` into a server package.
 *
 * turndown hands the rule the node it was built from (a domino element at runtime); these three
 * interfaces are the only surface the rule touches — a selector and a `textContent`.
 */
interface TableCellNode {
  textContent: string | null
}
interface TableRowNode {
  querySelectorAll(selector: string): ArrayLike<TableCellNode>
}
interface TableNode {
  querySelectorAll(selector: string): ArrayLike<TableRowNode>
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

/**
 * turndown keeps a `<table>` as raw HTML unless a rule claims it, and the tables mammoth emits are
 * plain `<tr><td>` — so the first row is the header by construction, as it is for a sheet.
 */
turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const table = node as unknown as TableNode
    const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('th,td')).map((cell) => escapeCell(cell.textContent ?? '')),
    )
    const rendered = rowsToMarkdownTable(rows)
    return rendered ? `\n\n${rendered}\n\n` : ''
  },
})

async function docxToMarkdown(path: string): Promise<string> {
  const { value: html, messages } = await mammoth.convertToHtml({ path })
  // mammoth answers with warnings for what it skipped (an unsupported style, an image it cannot
  // place) and still produces the rest — those are not worth failing for. An empty result is.
  if (!html.trim()) {
    const reason = messages.find((message) => message.type === 'error')?.message ?? 'no readable text'
    throw new Error(reason)
  }
  return turndown.turndown(html)
}

function spreadsheetToMarkdown(path: string): string {
  // `readFile` rather than `read`: SheetJS streams it off disk instead of holding a second copy
  // of the bytes, and an attachment may be up to the 20 MB the caller allows.
  const workbook = XLSX.readFile(path, { cellDates: true })
  const named = workbook.SheetNames.length > 1
  const parts: string[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false, // formatted text: a date reads as 2026-10-31, not as 46300
      defval: '',
      blankrows: false,
    }) as unknown[][]
    const table = rowsToMarkdownTable(
      rows.map((row) => row.map((cell) => escapeCell(cell == null ? '' : String(cell)))),
    )
    if (!table) continue
    parts.push(named ? `## ${name}\n\n${table}` : table)
  }
  return parts.join('\n\n')
}

async function deckToMarkdown(path: string): Promise<string> {
  const slides = await new PptxParser(path).extractText()
  return slides
    .map((slide, index) => {
      const body = slide.text.map((line) => line.trim()).filter(Boolean).join('\n\n')
      return body ? `## Slide ${index + 1}\n\n${body}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Convert one attachment to markdown.
 *
 * Throws with a sentence a person can act on — the caller turns it into the message shown for an
 * attachment it cannot read, so "save it as .docx" is the whole error.
 */
export async function officeToMarkdown(path: string): Promise<string> {
  const ext = extname(path).toLowerCase()
  let markdown: string
  switch (ext) {
    case '.docx':
      markdown = await docxToMarkdown(path)
      break
    case '.xlsx':
    case '.xls':
      markdown = spreadsheetToMarkdown(path)
      break
    case '.pptx':
      markdown = await deckToMarkdown(path)
      break
    case '.doc':
    case '.ppt':
      throw new Error(
        `${ext} is the pre-2007 binary format; save it as ${ext === '.doc' ? '.docx' : '.pptx'} to attach it`,
      )
    default:
      throw new Error(`No reader is installed for ${ext || 'this file'}`)
  }
  const tidyMarkdown = tidy(markdown)
  if (!tidyMarkdown) throw new Error('the document has no readable text')
  return tidyMarkdown
}
