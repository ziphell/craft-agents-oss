/**
 * `--headless-export`: the contract the GenOffice command line uses when a conversion needs a
 * renderer.
 *
 * The CLI does every conversion it can on its own, and for the rest it spawns "the app" as:
 *
 *     <app> --headless-export <input> --to <format> --out <path> --json
 *
 * expecting a JSON envelope on stdout and the file to exist (`packages/cli/src/formats/app-export.ts`).
 * GenOffice answers that with its own Electron. **So does this app** — it is Electron too, and the
 * browser the conversion wants is already here. Pointing `GENOFFICE_APP_BIN` at this binary means
 * `genoffice convert` finishes every direction it knows, without a GenOffice install and without a
 * second Chromium.
 *
 * Two directions are ours to answer:
 *
 * - **html/md → docx**: `html2docx`'s own `ElectronBrowserDriver` (bundled as `office-engine/html2docx.cjs`).
 * - **anything → pdf**: the same hidden-window print the editor's Export uses (`office-export.ts`).
 *
 * One is not: **docx → html** is the Word editor's standalone-HTML serializer, which lives in that
 * editor — not a rendering job, so nothing here can stand in for it. It answers with the refusal
 * rather than a file that is not what was asked for.
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBundledAssetsDir } from '@craft-agent/shared/utils/paths'
import { createElectronRenderer, exportThroughEditor } from './office-export'

export interface HeadlessExportRequest {
  input: string
  to: string
  out: string
}

/** Parse the four arguments this mode takes; null when they are not all there. */
export function parseHeadlessExport(argv: string[]): HeadlessExportRequest | null {
  const at = argv.indexOf('--headless-export')
  if (at < 0) return null
  const input = argv[at + 1]
  const toAt = argv.indexOf('--to')
  const outAt = argv.indexOf('--out')
  const to = toAt >= 0 ? argv[toAt + 1] : undefined
  const out = outAt >= 0 ? argv[outAt + 1] : undefined
  if (!input || !to || !out) return null
  return { input, to, out }
}

/** The envelope the CLI reads. `ok` also requires the output file to exist. */
function envelope(payload: Record<string, unknown>): string {
  return JSON.stringify({ command: 'export', ...payload }) + '\n'
}

/** `html|md → docx`, through the converter and this app's own browser. */
async function htmlToDocx(input: string, out: string): Promise<void> {
  const root = getBundledAssetsDir('office-engine')
  if (!root) throw new Error('The office engine is not installed (run: bun scripts/build-office-engine.ts)')

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { convertHtmlToDocx, ElectronBrowserDriver } = require(join(root, 'html2docx.cjs')) as {
    convertHtmlToDocx: (input: { url: string }, driver: unknown, options?: Record<string, unknown>) => Promise<{ docx: Uint8Array }>
    ElectronBrowserDriver: {
      create(viewport: { width: number; height: number; deviceScaleFactor: number }): Promise<{ close(): Promise<void> }>
    }
  }

  // `deviceScaleFactor` is not optional: without it `Emulation.setDeviceMetricsOverride` refuses
  // the call and the driver never finishes creating (measured).
  const driver = await ElectronBrowserDriver.create({ width: 1024, height: 1400, deviceScaleFactor: 1 })
  try {
    const { docx } = await convertHtmlToDocx({ url: pathToFileURL(input).href }, driver, { naturalTableWidth: true })
    await writeFile(out, docx)
  } finally {
    await driver.close().catch(() => undefined)
  }
}

/** `* → pdf`, through the same print path the editor's Export uses. */
async function toPdf(input: string, out: string): Promise<void> {
  const ext = input.split('.').pop()?.toLowerCase() ?? ''
  const app = ext === 'docx' || ext === 'doc' || ext === 'odt'
    ? 'docs'
    : ext === 'xlsx' || ext === 'xls' || ext === 'csv' || ext === 'ods'
      ? 'sheets'
      : ext === 'pptx' || ext === 'ppt' || ext === 'odp'
        ? 'slides'
        : ext === 'pdf'
          ? 'pdf'
          : null
  if (!app) throw new Error(`This host cannot print ${ext || 'that'} to pdf.`)
  // The bytes come from disk: a conversion is about a file, not about a document on screen.
  const bytes = new Uint8Array(await (await import('node:fs/promises')).readFile(input))
  // Through the seam rather than through this app's own `writeOfficePdf`: the two are the same
  // pipeline today, and naming the shared interface here is what keeps the desktop and a hub from
  // answering the same question in different words.
  const renderer = createElectronRenderer()
  try {
    const pdf = await renderer.printDocument({ app, path: input, bytes, outPath: out })
    if (!existsSync(out)) await (await import('node:fs/promises')).writeFile(out, pdf)
  } finally {
    await renderer.close()
  }
}

/**
 * Run one export and answer the process's exit code.
 *
 * The envelope is printed whether the export worked or not — the CLI reads a failure's `error`
 * from it, and a silent exit is the one thing that leaves the caller guessing.
 */
export async function runHeadlessExport(argv: string[]): Promise<number> {
  const request = parseHeadlessExport(argv)
  if (!request) {
    process.stdout.write(envelope({ status: 'error', error: 'invalid_argument', message: 'export needs --headless-export <input> --to <format> --out <path>' }))
    return 1
  }
  const { input, to, out } = request

  try {
    if (!existsSync(input)) throw new Error(`No such file: ${input}`)

    const from = input.split('.').pop()?.toLowerCase() ?? ''
    if (to === 'docx' && (from === 'html' || from === 'htm' || from === 'md' || from === 'markdown')) {
      await htmlToDocx(input, out)
    } else if (to === 'pdf') {
      await toPdf(input, out)
    } else if ((to === 'html' || to === 'md') && (from === 'docx' || from === 'doc' || from === 'odt')) {
      // The Word editor serializes these itself — the same headless mode its own app drives.
      const bytes = new Uint8Array(await (await import('node:fs/promises')).readFile(input))
      await exportThroughEditor({ app: 'docs', path: input, bytes, format: to, outPath: out })
    } else {
      throw new Error(`${from} → ${to} is not something this host can export.`)
    }

    if (!existsSync(out)) throw new Error('The export wrote no file.')
    process.stdout.write(envelope({ status: 'ok', summary: `${from} → ${to}`, output_path: out }))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(envelope({ status: 'error', error: 'export_failed', message }))
    return 1
  }
}
