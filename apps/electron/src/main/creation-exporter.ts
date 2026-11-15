/**
 * Export a work — the file a person hands on.
 *
 * Three engines, chosen by what the source is, and none of them new:
 *
 * | source | target | how |
 * | --- | --- | --- |
 * | md / html | docx | the office engine's own `convert` (html2docx) |
 * | md / html | pdf | md → html by the same engine, then the app prints the page |
 * | docx | md | the Word editor's headless serializer (a window, no app instance) |
 * | docx / xlsx / pptx / pdf | pdf | the editor's own print stylesheet |
 *
 * Two decisions worth stating:
 *
 * - **PDF is printed here, not by the command line.** The CLI's `--to pdf` needs a *packaged* app to
 *   point at (`GENOFFICE_APP_BIN`); printing in this process works in a development run too, which is
 *   where most of this is tested.
 * - **md is converted through html, not through a second markdown parser.** The engine already owns
 *   that conversion, and a second one here would be a second dialect — the same rule the poster
 *   pipeline follows.
 *
 * A failure is an answer, not an exception: the caller shows the sentence.
 */

import { BrowserWindow } from 'electron'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extensionOf, type CreationExportTarget } from '@craft-agent/shared/office/creation-export'
import { inlineLocalAssets } from '@craft-agent/shared/office/single-file-html'
import { executeOfficeToolCommand } from '@craft-agent/shared/agent/office-commands'
import { exportThroughEditor, writeOfficePdf, type OfficeExportApp } from './office-export'

export interface CreationExportInput {
  workspaceRootPath: string
  /** Absolute path of the work. */
  path: string
  target: CreationExportTarget
  /** Absolute destination, chosen by the person. */
  outPath: string
}

/** The office editor that opens a document, or null for a format no editor has. */
function officeAppFor(extension: string): OfficeExportApp | null {
  if (extension === 'docx' || extension === 'doc' || extension === 'odt') return 'docs'
  if (extension === 'xlsx' || extension === 'xls' || extension === 'xlsm' || extension === 'ods') return 'sheets'
  if (extension === 'pptx' || extension === 'ppt' || extension === 'odp') return 'slides'
  if (extension === 'pdf') return 'pdf'
  return null
}

/**
 * A page printed to PDF by a window nobody sees.
 *
 * `printBackground` is on because a report without its fills is a different document. The page is
 * loaded from its own file, so relative assets resolve exactly as they do when it is opened.
 */
async function printToPdf(sourcePath: string, outPath: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await win.loadURL(pathToFileURL(sourcePath).href)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true,
    })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(outPath, pdf)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * One page, every local asset inlined, written where the person asked.
 *
 * The source is read, rewritten in memory and written to `outPath` — the file being exported keeps
 * its ordinary references, so the agent's own edits to it stay readable. A reference that cannot be
 * resolved is left pointing at what it pointed at, and the caller is told how many.
 */
async function writeSingleFile(input: CreationExportInput): Promise<string> {
  const source = await readFile(input.path, 'utf8')
  const root = dirname(input.path)
  const result = inlineLocalAssets(source, (reference) => {
    try {
      const clean = reference.split(/[?#]/)[0] ?? reference
      if (!clean) return null
      const resolved = resolve(root, clean)
      if (!existsSync(resolved)) return null
      return { mime: mimeFor(resolved), bytes: new Uint8Array(readFileSync(resolved)) }
    } catch {
      return null
    }
  })
  await writeFile(input.outPath, result.html, 'utf8')
  if (result.skipped > 0) {
    throw new Error(
      `${result.skipped} reference(s) could not be embedded, so ${basename(input.outPath)} is not ` +
        'self-contained. It was written and still names them.',
    )
  }
  return input.outPath
}

/** Enough of a media type for a browser to draw the bytes it is given. */
function mimeFor(path: string): string {
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    ico: 'image/x-icon',
    css: 'text/css',
    js: 'text/javascript',
    woff: 'font/woff',
    woff2: 'font/woff2',
  }
  return table[(path.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream'
}

/** Run the office engine's own conversion and answer whether it wrote the file. */
async function convertThroughEngine(
  input: CreationExportInput,
  to: 'docx' | 'html',
  outPath: string,
): Promise<void> {
  const command = ['convert', `"${input.path}"`, '--to', to, '--out', `"${outPath}"`, '--force']
  await executeOfficeToolCommand({ command, workspaceRootPath: input.workspaceRootPath })
  if (!existsSync(outPath)) {
    throw new Error(`The document engine did not write ${outPath}.`)
  }
}

/**
 * Export one work, and answer the path written.
 *
 * The caller has already chosen the destination, so this never asks a question — it either writes
 * that file or says why it could not.
 */
export async function exportCreation(input: CreationExportInput): Promise<string> {
  const source = extensionOf(input.path)
  const officeApp = officeAppFor(source)

  if (input.target === 'pdf') {
    if (officeApp) {
      const bytes = new Uint8Array(await readFile(input.path))
      await writeOfficePdf({ app: officeApp, path: input.path, bytes }, input.outPath)
      return input.outPath
    }
    if (source === 'html' || source === 'htm') {
      await printToPdf(input.path, input.outPath)
      return input.outPath
    }
    if (source === 'md' || source === 'markdown' || source === 'mdx') {
      // The engine writes the page; this process prints it. The intermediate is a temp file, since
      // the conversion's only consumer is the print call right after it.
      const page = join(input.outPath.replace(/[\\/][^\\/]+$/, ''), `.craft-export-${process.pid}.html`)
      try {
        await convertThroughEngine(input, 'html', page)
        await printToPdf(page, input.outPath)
      } finally {
        if (existsSync(page)) unlinkSync(page)
      }
      return input.outPath
    }
    throw new Error(`This host cannot print ${source || 'that format'} to PDF.`)
  }

  if (input.target === 'html') return writeSingleFile(input)

  if (input.target === 'docx') {
    if (source === 'md' || source === 'markdown' || source === 'mdx' || source === 'html' || source === 'htm') {
      await convertThroughEngine(input, 'docx', input.outPath)
      return input.outPath
    }
    throw new Error(`Only a markdown or HTML document becomes a Word file.`)
  }

  // Remaining target: md, which only a Word document produces.
  if (officeApp === 'docs') {
    const bytes = new Uint8Array(await readFile(input.path))
    return exportThroughEditor({ app: 'docs', path: input.path, bytes, format: 'md', outPath: input.outPath })
  }
  throw new Error(`Only a Word document becomes markdown.`)
}
