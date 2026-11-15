/**
 * Tests for `office_tool`'s commands.
 *
 * What is checked here is the **reading** of a command — which engine verb it becomes, which file
 * it points at, which flags survive, and which are refused — not the engine. `planOfficeCommand`
 * is pure for exactly this reason: the same command line can be asserted without a GenOffice build
 * on the machine, which no CI box has.
 *
 * Two classes of mistake these tests exist for, both seen in the tool before:
 *
 * - a command mapped to the wrong verb (`read` used to run `info`, which answers block *counts*, so
 *   the block indexes `apply` addresses were unavailable);
 * - a flag silently dropped (`convert … --sheet Data` exported the active sheet instead).
 */

import { executeOfficeToolCommand } from '../office-commands'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  deckMissingPages,
  deckOutlineTitles,
  deckPageFile,
  parsePdfOcrCommand,
  planOfficeCommand,
  type DeckRequest,
  type OfficePlan,
} from '../office-commands'
import { pageNeedsOcr } from '../office-pdf-commands'

const workspace = resolve('/work/session')

/** A path as the tool hands it to the engine: resolved against the session. */
const at = (name: string): string => resolve(workspace, name)

/** The argv of a command that should run, with the `--flag` pairs joined for readability. */
function argvOf(command: string | string[]): string[] {
  const plan = planOfficeCommand(command, workspace)
  if (plan.kind !== 'run') throw new Error(`expected a run, got ${plan.kind === 'say' ? plan.output : 'a deck request'}`)
  return plan.invocation.argv
}

function refusalOf(command: string | string[]): string {
  const plan: OfficePlan = planOfficeCommand(command, workspace)
  if (plan.kind !== 'say') throw new Error(`expected a refusal, got ${plan.kind === 'run' ? plan.invocation.argv.join(' ') : 'a deck request'}`)
  return plan.output
}

describe('read — one verb per domain', () => {
  it('reads a document with the reader that answers block indexes', () => {
    expect(argvOf('read brief.docx --json')).toEqual(['docs', 'read', at('brief.docx'), '--json'])
  })

  it('reads a workbook with the reader that answers cells and sheet features', () => {
    expect(argvOf('read book.xlsx --sheet Data --stats')).toEqual([
      'sheet',
      'read',
      at('book.xlsx'),
      '--sheet',
      'Data',
      '--stats',
    ])
  })

  it('reads a deck with the reader that answers slide and element ids', () => {
    expect(argvOf('read deck.pptx --slide 0 --layouts')).toEqual(['slides', 'read', at('deck.pptx'), '--slide', '0', '--layouts'])
  })

  it('reads a PDF text layer through the pdf verb', () => {
    expect(argvOf('read report.pdf --page 2')).toEqual(['pdf', 'read', at('report.pdf'), '--page', '2'])
  })

  it('answers a plain-text file with info', () => {
    expect(argvOf('read notes.md')).toEqual(['info', at('notes.md')])
  })

  it('refuses a file no reader owns, and says what would have worked', () => {
    const message = refusalOf('read photo.png')
    expect(message).toContain('is not a document this tool reads')
    expect(message).toContain('sheet (xlsx')
  })

  it('refuses a flag its reader does not have — a sheet option on a document', () => {
    expect(refusalOf('read brief.docx --sheet Data')).toContain('read does not take --sheet')
  })
})

describe('apply — the domain comes from the file', () => {
  it('applies to a document', () => {
    expect(argvOf('apply brief.docx --ops ops.json --dry-run')).toEqual([
      'docs',
      'apply',
      at('brief.docx'),
      '--ops',
      at('ops.json'),
      '--dry-run',
    ])
  })

  it('applies to a workbook, including a format the old default sent to docs', () => {
    for (const file of ['book.xlsx', 'book.ods', 'book.xlsb']) {
      expect(argvOf(`apply ${file} --ops ops.json`)[0]).toBe('sheet')
    }
  })

  it('applies to a deck', () => {
    expect(argvOf('apply deck.pptx --ops ops.json')[0]).toBe('slides')
  })

  it('tracks the edit as revisions, which is the whole point on someone else’s file', () => {
    expect(argvOf('apply brief.docx --ops ops.json --track --author 审阅人')).toEqual([
      'docs',
      'apply',
      at('brief.docx'),
      '--ops',
      at('ops.json'),
      '--track',
      '--author',
      '审阅人',
    ])
  })

  it('refuses a file that is not a document instead of sending it to docs', () => {
    expect(refusalOf('apply notes.txt --ops ops.json')).toContain('apply needs a document')
  })

  it('names the guide for the domain when ops are missing', () => {
    expect(refusalOf('apply book.xlsx')).toContain('office_tool guide sheets')
    expect(refusalOf('apply brief.docx')).toContain('office_tool guide docs')
  })
})

describe('convert — the engine’s own options survive', () => {
  it('passes the worksheet to export and the password for an encrypted source', () => {
    expect(argvOf('convert book.xlsx --to csv --sheet 汇总 --out out.csv --force')).toEqual([
      'convert',
      at('book.xlsx'),
      '--to',
      'csv',
      '--sheet',
      '汇总',
      '--out',
      at('out.csv'),
      '--force',
    ])
  })

  it('refuses a target outside the engine’s vocabulary', () => {
    expect(refusalOf('convert report.docx --to tiff')).toContain('--to takes')
  })

  it('leaves a route the engine lacks to the engine, which answers with the whole route table', () => {
    // md → xlsx has no route; the refusal that names every route that does exist is the engine's.
    expect(argvOf('convert notes.md --to xlsx')).toEqual(['convert', at('notes.md'), '--to', 'xlsx'])
  })
})

describe('merge — values, not a path', () => {
  it('resolves a values file, which is the form that survives any shell-like reading', () => {
    expect(argvOf('merge tpl.docx --data values.json --out filled.docx --strict')).toEqual([
      'merge',
      at('tpl.docx'),
      '--data',
      at('values.json'),
      '--out',
      at('filled.docx'),
      '--strict',
    ])
  })

  it('keeps inline JSON inline when the command arrives as an array of arguments', () => {
    expect(argvOf(['merge', 'tpl.docx', '--data', '{"party":"山西焦煤"}', '--out', 'filled.docx'])).toEqual([
      'merge',
      at('tpl.docx'),
      '--data',
      '{"party":"山西焦煤"}',
      '--out',
      at('filled.docx'),
    ])
  })

  it('leaves stdin to the engine', () => {
    expect(argvOf('merge tpl.docx --data - --out filled.docx')).toContain('-')
  })

  it('explains the quote-eating rather than passing mangled JSON on', () => {
    // A string command is read like a shell line: the quotes inside the object are delimiters.
    const message = refusalOf('merge tpl.docx --data {"party":"山西焦煤"} --out filled.docx')
    expect(message).toContain('tokenized like a shell line')
    expect(message).toContain('--data values.json')
  })

  it('needs somewhere to write', () => {
    expect(refusalOf('merge tpl.docx --data {}')).toContain('--out')
  })
})

describe('compare — a redline of two documents', () => {
  it('runs docs compare with both files and the output', () => {
    expect(argvOf('compare before.docx after.docx --out redline.docx --granularity char')).toEqual([
      'docs',
      'compare',
      at('before.docx'),
      at('after.docx'),
      '--out',
      at('redline.docx'),
      '--granularity',
      'char',
    ])
  })

  it('needs both documents', () => {
    expect(refusalOf('compare before.docx --out redline.docx')).toContain('two .docx files')
  })
})

describe('pdf — the text layer without an app', () => {
  it('reads a page range', () => {
    expect(argvOf('pdf report.pdf --range 1-5 --full')).toEqual(['pdf', 'read', at('report.pdf'), '--range', '1-5', '--full'])
  })

  it('refuses a file that is not a PDF', () => {
    expect(refusalOf('pdf report.docx')).toContain('is not a .pdf')
  })
})

describe('pdf ocr — one page, on request', () => {
  const requestOf = (command: string) => {
    const parsed = parsePdfOcrCommand(command, workspace)
    if (!parsed || 'error' in parsed) throw new Error('expected a page request')
    return parsed
  }
  const errorOf = (command: string) => {
    const parsed = parsePdfOcrCommand(command, workspace)
    if (!parsed || !('error' in parsed)) throw new Error('expected a refusal')
    return parsed.error
  }

  it('reads the page the caller named, with the page-sized default', () => {
    expect(requestOf('pdf ocr scan.pdf --page 3')).toEqual({
      file: at('scan.pdf'),
      page: 3,
      maxSide: 1600,
      json: false,
      force: false,
    })
  })

  it('takes --json, --max-side and --out', () => {
    expect(requestOf('pdf ocr scan.pdf --page 3 --max-side 2048 --json --out page-3.md')).toEqual({
      file: at('scan.pdf'),
      page: 3,
      maxSide: 2048,
      json: true,
      force: false,
      out: at('page-3.md'),
    })
  })

  it('takes --force, for a page whose own text layer is not the answer', () => {
    expect(requestOf('pdf ocr report.pdf --page 2 --force').force).toBe(true)
    expect(errorOf('pdf ocr report.pdf --page 2 --force=1')).toContain('takes no value')
  })

  it('needs a page: a whole-book pass is not what this command is for', () => {
    expect(errorOf('pdf ocr scan.pdf')).toContain('--page')
  })

  it('refuses a file that is not a PDF, or more than one', () => {
    expect(errorOf('pdf ocr scan.docx --page 1')).toContain('is not a .pdf')
    expect(errorOf('pdf ocr a.pdf b.pdf --page 1')).toContain('one file at a time')
  })

  it('refuses a flag it does not have, and an output it cannot write', () => {
    expect(errorOf('pdf ocr scan.pdf --page 1 --range 1-3')).toContain('does not take --range')
    expect(errorOf('pdf ocr scan.pdf --page 1 --out page-1.pptx')).toContain('.txt, .md or .json')
  })

  it('leaves every other pdf command alone', () => {
    expect(parsePdfOcrCommand('pdf read scan.pdf', workspace)).toBeNull()
    expect(parsePdfOcrCommand('render scan.pdf --page 1', workspace)).toBeNull()
  })
})

describe('pdf ocr — which pages are read from their pixels', () => {
  const stats = (chars: number, imageCoverage: number) => ({
    chars,
    imageCoverage,
    text: '',
    width: 595,
    height: 842,
  })

  it('reads a scan: no text layer at all', () => {
    expect(pageNeedsOcr(stats(0, 0))).toBe(true)
    expect(pageNeedsOcr(stats(12, 0.98))).toBe(true)
  })

  it('reads a scan with a letterhead: real text, but one picture across the page', () => {
    expect(pageNeedsOcr(stats(120, 0.85))).toBe(true)
  })

  it('reads a letterhead that is not quite a page of text, rather than miss a body behind it', () => {
    expect(pageNeedsOcr(stats(60, 0.4))).toBe(true)
  })

  it('leaves a page of prose to its own text layer', () => {
    expect(pageNeedsOcr(stats(900, 0))).toBe(false)
    expect(pageNeedsOcr(stats(100, 0.4))).toBe(false)
  })
})

describe('create — each type has the source it can read', () => {
  it('makes a document from Markdown', () => {
    expect(argvOf('create brief.md --out brief.docx')).toEqual([
      'create',
      '--type',
      'docx',
      '--from',
      at('brief.md'),
      '--out',
      at('brief.docx'),
    ])
  })

  it('makes a workbook from CSV or JSON, and says so when handed Markdown', () => {
    expect(argvOf('create rows.csv --out book.xlsx --type xlsx --header')).toEqual([
      'create',
      '--type',
      'xlsx',
      '--from',
      at('rows.csv'),
      '--header',
      '--out',
      at('book.xlsx'),
    ])
    expect(refusalOf('create table.md --out book.xlsx --type xlsx')).toContain('reads a .csv or a .json')
  })

  it('makes a deck from ops, and refuses prose with the guide it needs', () => {
    expect(argvOf('create --type pptx --ops slides.json --out deck.pptx')).toEqual([
      'create',
      '--type',
      'pptx',
      '--ops',
      at('slides.json'),
      '--out',
      at('deck.pptx'),
    ])
    const prose = refusalOf('create outline.md --out deck.pptx --type pptx')
    expect(prose).toContain('--ops <ops.json>')
    expect(prose).toContain('guide slides spec')
  })

  it('refuses a source file on a deck instead of ignoring it, and keeps --render with it', () => {
    const message = refusalOf('create --type pptx --ops s.json --out deck.pptx outline.md')
    expect(message).toContain('takes --ops or --spec, not a source file')

    expect(argvOf('create --type pptx --ops s.json --out deck.pptx --render previews')).toEqual([
      'create',
      '--type',
      'pptx',
      '--ops',
      at('s.json'),
      '--render',
      at('previews'),
      '--out',
      at('deck.pptx'),
    ])
  })
})

describe('render — the picture of a page', () => {
  it('looks at one page and leaves no folder behind by default', () => {
    const plan = planOfficeCommand('render brief.docx', workspace)
    if (plan.kind !== 'run') throw new Error(`expected a run, got ${plan.kind}`)
    // "Show me" is not "fill a folder": one page, drawn into a scratch directory…
    expect(plan.invocation.argv).toContain('--page')
    expect(plan.invocation.argv[plan.invocation.argv.indexOf('--page') + 1]).toBe('1')
    expect(plan.ephemeral).toBe(true)
    // …and never beside the document, which is what it used to do.
    expect(plan.invocation.argv.join(' ')).not.toContain(at('brief-pages'))
  })

  it('draws only the page that was asked for', () => {
    const plan = planOfficeCommand('render brief.pdf --page 3', workspace)
    if (plan.kind !== 'run') throw new Error(`expected a run, got ${plan.kind}`)
    expect(plan.invocation.argv.filter((arg) => arg === '--page')).toHaveLength(1)
    expect(plan.ephemeral).toBe(true)
  })

  it('writes files, and lists them, when a directory is named', () => {
    const plan = planOfficeCommand('render brief.pdf --out shots', workspace)
    if (plan.kind !== 'run') throw new Error(`expected a run, got ${plan.kind}`)
    expect(plan.list).toBe(at('shots'))
    expect(plan.ephemeral).toBeUndefined()
  })

  it('takes a directory, a page, a scale and a contact sheet', () => {
    const plan = planOfficeCommand('render report.pdf --out shots --page 1 --scale 2 --grid', workspace)
    if (plan.kind !== 'run') throw new Error(`expected a run, got ${plan.kind}`)
    expect(plan.invocation.argv).toEqual([
      'render',
      at('report.pdf'),
      '--out',
      at('shots'),
      '--page',
      '1',
      '--scale',
      '2',
      '--grid',
    ])
    expect(plan.list).toBe(at('shots'))
  })

  it('crops a deck to element ids', () => {
    expect(argvOf('render deck.pptx --el e_1,e_2 --pad 24')[0]).toBe('render')
    expect(argvOf('render deck.pptx --el e_1,e_2 --pad 24')).toContain('--el')
  })

  it('prints a document and a deck, and rasterises a pdf in place', () => {
    const doc = planOfficeCommand('render brief.docx', workspace)
    const deck = planOfficeCommand('render talk.pptx --page 3', workspace)
    const all = planOfficeCommand('render talk.pptx --out out/pages', workspace)
    const pdf = planOfficeCommand('render report.pdf', workspace)
    if (doc.kind !== 'run' || deck.kind !== 'run' || all.kind !== 'run' || pdf.kind !== 'run') {
      throw new Error('expected runs')
    }
    // A page of a document is a *page*: printed by the app and rasterised. Its editor is an editing
    // surface — measured today as the toolbar, a black stage, or the page, depending on the frame —
    // and a printed page is page-shaped where a photograph of the window is not.
    expect(doc.capture).toBeUndefined()
    expect(doc.needsApp).toContain('page images of a .docx')
    expect(deck.capture).toBeUndefined()
    expect(deck.needsApp).toContain('page images of a .pptx')
    // The same route for every page, so the count no longer changes how it is made.
    expect(all.capture).toBeUndefined()
    expect(all.needsApp).toContain('page images of a .pptx')
    // A pdf is already pages, and pdfium draws them in-process — no renderer, no print.
    expect(pdf.capture).toBeUndefined()
    expect(pdf.needsApp).toBeUndefined()
  })

  it('has no render for a workbook, which has no pages to look at', async () => {
    // The door does not answer it, and says why rather than sending the question to Word's tool or
    // spending a renderer on a print job.
    const answer = await executeOfficeToolCommand({
      command: 'render sheet.xlsx',
      workspaceRootPath: workspace,
      tool: 'xlsx_tool',
    })
    expect(answer.output).toContain('not a workbook command')
    expect(answer.output).toContain('no pages until it is printed')
    expect(answer.output).not.toContain('docx_tool')
  })

  it('shot draws the grid, scrolled to the corner it was given', () => {
    const plain = planOfficeCommand('shot sales.xlsx', workspace)
    const aimed = planOfficeCommand('shot sales.xlsx --sheet 明细 --range B40', workspace)
    if (plain.kind !== 'run' || aimed.kind !== 'run') throw new Error('expected runs')
    // A picture into a scratch directory, read and removed: the reply carries the image.
    expect(plain.capture).toEqual({ path: join(workspace, 'sales.xlsx'), page: 0 })
    expect(plain.captureOnly).toBe(true)
    expect(plain.ephemeral).toBe(true)
    expect(aimed.capture?.target).toEqual({ sheet: '明细', range: 'B40' })
  })

  it('keeps shot to the workbook door, and to its own flags', async () => {
    // `shot` belongs to the workbook door, and a document is not a workbook.
    const wrongDoor = await executeOfficeToolCommand({
      command: 'shot brief.docx',
      workspaceRootPath: workspace,
      tool: 'docx_tool',
    })
    expect(wrongDoor.output).toContain('shot')
    expect(refusalOf('shot sales.xlsx --page 2')).toContain('shot does not take --page')
  })

  it('marks printing to PDF as needing the app, and other targets as not', () => {
    const pdf = planOfficeCommand('convert report.docx --to pdf', workspace)
    const md = planOfficeCommand('convert report.docx --to md', workspace)
    if (pdf.kind !== 'run' || md.kind !== 'run') throw new Error('expected runs')
    expect(pdf.needsApp).toBe('PDF output')
    expect(md.needsApp).toBeUndefined()
  })

  it('refuses a flag the engine’s renderer does not have', () => {
    expect(refusalOf('render brief.docx --sheet Data')).toContain('render does not take --sheet')
  })
})

describe('check — findings, not a rewrite', () => {
  it('checks a document and a workbook with their own checker', () => {
    expect(argvOf('check brief.docx')).toEqual(['docs', 'check', at('brief.docx')])
    expect(argvOf('check book.xlsx --json')).toEqual(['sheet', 'check', at('book.xlsx'), '--json'])
  })

  it('checks a deck by its layout, which is the engine’s audit', () => {
    expect(argvOf('check deck.pptx --slide 1')).toEqual(['slides', 'audit', at('deck.pptx'), '--slide', '1'])
  })

  it('refuses a file with nothing to check', () => {
    expect(refusalOf('check photo.png')).toContain('check covers a document')
  })
})

describe('guide — the engine’s own word for the domain', () => {
  it('maps the singular to the group the CLI knows', () => {
    expect(argvOf('guide sheet')).toEqual(['guide', 'sheets'])
    expect(argvOf('guide docs')).toEqual(['guide', 'docs'])
  })

  it('passes a second group through, whether written as two tokens or one', () => {
    expect(argvOf('guide slides spec')).toEqual(['guide', 'slides', 'spec'])
    expect(argvOf('guide "slides spec"')).toEqual(['guide', 'slides', 'spec'])
  })

  it('defaults to the document op reference', () => {
    expect(argvOf('guide')).toEqual(['guide', 'docs'])
  })
})

describe('pdf — pages and marks run in-process', () => {
  /** The command this verbs-to-pdf plans, or the sentence that refused it. */
  function pdfOf(command: string | string[]): string[] {
    const plan = planOfficeCommand(command, workspace)
    if (plan.kind !== 'pdf') throw new Error(`expected a pdf verb, got ${plan.kind}`)
    return plan.argv
  }

  it('routes every page-and-mark verb to the local implementation', () => {
    for (const verb of ['info', 'split', 'reorder', 'duplicate', 'crop', 'nup', 'merge', 'rotate', 'watermark', 'header-footer', 'from-image', 'fill-form']) {
      expect(pdfOf(`pdf ${verb} file.pdf`)[0]).toBe(verb)
    }
  })

  it('keeps `pdf <file>` on the engine’s own text reader', () => {
    expect(argvOf('pdf report.pdf --page 2')).toEqual(['pdf', 'read', at('report.pdf'), '--page', '2'])
  })

  it('prints the pdf help rather than calling a file named "help"', () => {
    expect(refusalOf('pdf help')).toContain('pdf info <file>')
  })

  it('still refuses a non-PDF passed where a file is expected', () => {
    expect(refusalOf('pdf report.docx')).toContain('is not a .pdf')
  })
})

describe('the staged deck flow', () => {
  /** The deck request a command plans, or the sentence that refused it. */
  function deckOf(command: string | string[]): DeckRequest {
    const plan = planOfficeCommand(command, workspace)
    if (plan.kind !== 'deck') throw new Error(`expected a deck request, got ${plan.kind}`)
    return plan.request
  }

  it('starts from the two files the agent wrote, and takes either spelling', () => {
    const request = deckOf('deck_start decks/q3 --style style.md --outline outline.json')
    expect(request).toEqual({
      command: 'deck_start',
      dir: at('decks/q3'),
      style: at('style.md'),
      outline: at('outline.json'),
    })
    expect(deckOf('deck-start decks/q3 --style style.md --outline outline.json').command).toBe('deck_start')
  })

  it('needs both files to start — a deck without an outline has no pages to write', () => {
    expect(refusalOf('deck_start decks/q3 --style style.md')).toContain('--outline <outline.json>')
    expect(refusalOf('deck_start --style s.md --outline o.json')).toContain('needs a deck folder')
  })

  it('takes a page by outline index, for a new page or a rebuilt slide', () => {
    expect(deckOf('deck_page decks/q3 --index 2 --page page.json')).toEqual({
      command: 'deck_page',
      dir: at('decks/q3'),
      index: 2,
      page: at('page.json'),
    })
    expect(deckOf('deck_replace decks/q3 --index 0 --page p.json --pptx other.pptx').pptx).toBe(at('other.pptx'))
    expect(refusalOf('deck_page decks/q3 --page p.json')).toContain('--index <n>')
    expect(refusalOf('deck_replace decks/q3 --index 1')).toContain('--page <page.json>')
  })

  it('builds into the folder unless told where', () => {
    expect(deckOf('deck_build decks/q3')).toEqual({ command: 'deck_build', dir: at('decks/q3') })
    expect(deckOf('deck_build decks/q3 --out deck.pptx').out).toBe(at('deck.pptx'))
  })

  it('names a page file the way the builder reads it: pages/01.json', () => {
    expect(deckPageFile('/deck', 0)).toBe(join('/deck', 'pages', '01.json'))
    expect(deckPageFile('/deck', 9)).toBe(join('/deck', 'pages', '10.json'))
  })

  it('reads the outline as the list of pages, and finds the ones still missing', () => {
    expect(deckOutlineTitles({ pages: [{ title: 'A' }, { title: 'B' }, {}] })).toEqual(['A', 'B', ''])
    expect(deckOutlineTitles({})).toEqual([])

    const dir = mkdtempSync(join(tmpdir(), 'craft-deck-'))
    try {
      expect(deckMissingPages(dir, 3)).toEqual([0, 1, 2])
      mkdirSync(join(dir, 'pages'), { recursive: true })
      writeFileSync(join(dir, 'pages', '01.json'), '{}')
      writeFileSync(join(dir, 'pages', '02.json'), '{}')
      expect(deckMissingPages(dir, 3)).toEqual([2])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the door', () => {
  it('refuses a command it does not have, with help rather than an engine spawn', () => {
    expect(refusalOf('open brief.docx')).toContain('No such command: open')
    expect(refusalOf('open brief.docx')).toContain('office_tool — documents as files')
  })
})
