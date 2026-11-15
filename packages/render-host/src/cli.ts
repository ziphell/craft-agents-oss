/**
 * `craft-headless-export` — the process the GenOffice command line spawns when a conversion needs
 * a renderer, on a host that has no editor window.
 *
 * The contract is not this file's invention: `genoffice` does every conversion it can on its own,
 * and for the rest it spawns "the app" as
 *
 *     <app> --headless-export <input> --to <format> --out <path> --json
 *
 * expecting a JSON envelope on stdout and the file to exist. On the desktop that app is Craft
 * Agents itself (`apps/electron/src/main/headless-export.ts`); here it is this script, launched by
 * `node`/`bun`, so a hub answers the same contract without an Electron.
 *
 * **This runs on `node`, not `bun`.** Measured on 1.3.14: `bun` imports `playwright-core` fine and
 * then hangs on `chromium.launch()` — no error, no browser, no output. The image therefore bundles
 * this file (`bun run build:cli`) and starts it with the `node` it already installs for the
 * WhatsApp worker. The port that gives that away is `spawn(..., { stdio: ['ignore','pipe','pipe'] })`
 * on the CLI's side: Playwright drives the browser over stdio, and bun's pipes are not the same.
 *
 * **`--probe` exists because "is a renderer installed" cannot be answered by looking.**
 * `genoffice capabilities` reports `app.available: true` when it merely found a binary — a bare
 * Electron answers `--headless-export` with a 180-second timeout, measured. A host that asks this
 * probe gets an answer only after a browser has actually started, so a promise made here is one
 * that can be kept.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { stopWorkbookHost } from '@craft-agent/office-host'
import { frameFileName } from '@craft-agent/shared/recording/sampler-script'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ChromiumRenderer } from './chromium.ts'
import { RenderError, type OfficeApp } from './types.ts'

interface ExportRequest {
  input: string
  to: string
  out: string
}

/** The envelope the CLI reads. `ok` also requires the output file to exist. */
function envelope(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ command: 'export', ...payload })}\n`
}

function fail(error: string, message: string, extra: Record<string, unknown> = {}): number {
  process.stdout.write(envelope({ status: 'error', error, message, ...extra }))
  return 1
}

function parseExport(argv: string[]): ExportRequest | null {
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

/**
 * `--drawio`: a `.drawio` document → a drawing, in whichever format was asked for.
 *
 * The same launcher answers this because it is the same browser and the same origin; there is no
 * reason for a second executable to exist for the other half of the renderer seam.
 */
async function runDrawio(argv: string[]): Promise<number> {
  const at = argv.indexOf('--drawio')
  const input = argv[at + 1]
  const format = flagValue(argv, '--format')
  const out = flagValue(argv, '--out')
  const allowed = ['svg', 'xmlsvg', 'png', 'html', 'xml'] as const
  type Format = (typeof allowed)[number]
  if (!input || !format || !out) {
    return fail('invalid_argument', 'drawio needs --drawio <file> --format <svg|xmlsvg|png|html|xml> --out <path>.')
  }
  if (!(allowed as readonly string[]).includes(format)) {
    return fail('invalid_argument', `--format takes ${allowed.join(' / ')}, not ${format}.`)
  }
  if (!existsSync(input)) return fail('missing_input', `No such file: ${input}`)

  const renderer = new ChromiumRenderer()
  try {
    const bytes = await renderer.renderDrawio({
      xml: await readFile(input, 'utf8'),
      format: format as Format,
      ...(flagValue(argv, '--page') ? { page: flagValue(argv, '--page')! } : {}),
      ...(Number(flagValue(argv, '--scale')) > 0 ? { scale: Number(flagValue(argv, '--scale')) } : {}),
      ...(isTheme(flagValue(argv, '--theme')) ? { theme: flagValue(argv, '--theme') as 'auto' | 'light' | 'dark' } : {}),
    })
    mkdirSync(dirname(resolve(out)), { recursive: true })
    await writeFile(resolve(out), bytes)
    process.stdout.write(
      `${JSON.stringify({ command: 'drawio', status: 'ok', summary: `drawio → ${format}`, output_path: resolve(out), bytes: bytes.length })}\n`,
    )
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof RenderError ? error.code.toLowerCase() : 'draw_failed', message, { input, format })
  } finally {
    await renderer.close()
  }
}

function flagValue(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

function isTheme(value: string | undefined): boolean {
  return value === 'auto' || value === 'light' || value === 'dark'
}

function extensionOf(file: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(file)
  return match ? match[1]!.toLowerCase() : ''
}

/** Which editor prints a document. The same four the office tool and the export window use. */
const APP_BY_EXTENSION: Record<string, OfficeApp> = {
  docx: 'docs',
  doc: 'docs',
  odt: 'docs',
  xlsx: 'sheets',
  xls: 'sheets',
  ods: 'sheets',
  pptx: 'slides',
  ppt: 'slides',
  odp: 'slides',
}

async function runProbe(): Promise<number> {
  const renderer = new ChromiumRenderer()
  try {
    const info = await renderer.probe()
    process.stdout.write(
      `${JSON.stringify({ command: 'probe', status: 'ok', detail: info }, null, 0)}\n`,
    )
    return 0
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    process.stdout.write(`${JSON.stringify({ command: 'probe', status: 'error', error: 'renderer_unavailable', message: reason })}\n`)
    return 1
  } finally {
    await renderer.close()
  }
}

async function runExport(request: ExportRequest): Promise<number> {
  const { input, to, out } = request
  if (!existsSync(input)) return fail('missing_input', `No such file: ${input}`)

  const from = extensionOf(input)
  mkdirSync(dirname(resolve(out)), { recursive: true })

  // A `.pdf` is already the answer. Copying is the whole conversion, and it is what the desktop
  // does too — a renderer asked to print a PDF would only re-encode it.
  if (to === 'pdf' && from === 'pdf') {
    copyFileSync(input, out)
    return done(from, to, out)
  }

  if (to === 'pdf' && (from === 'html' || from === 'htm')) {
    const renderer = new ChromiumRenderer()
    try {
      // `file:` rather than `setContent`, so relative stylesheets and images beside the page load
      // the way they do when a person opens it.
      const pdf = await renderer.print({ kind: 'url', url: pathToFileURL(resolve(input)).href })
      await writeBytes(out, pdf)
    } catch (error) {
      await renderer.close()
      return renderFailure(from, to, error)
    }
    await renderer.close()
    return done(from, to, out)
  }

  // A document is printed by its own editor: the file on disk is reopened as the top document on
  // this host's office origin, and the editor's own print becomes the PDF.
  const app = APP_BY_EXTENSION[from]
  if (to === 'pdf' && app) {
    const renderer = new ChromiumRenderer()
    try {
      const pdf = await renderer.printDocument({
        app,
        path: resolve(input),
        bytes: new Uint8Array(await readFile(input)),
        outPath: resolve(out),
      })
      // `printDocument` writes the file the editor asked for; a renderer that answered with bytes
      // instead still has to put them where the caller named.
      if (!existsSync(out)) await writeBytes(out, pdf)
    } catch (error) {
      return renderFailure(from, to, error)
    } finally {
      await renderer.close()
    }
    return done(from, to, out)
  }

  return fail('unsupported_target', `${from} → ${to} is not something this host can export.`, { input: resolve(input), to })
}

async function writeBytes(out: string, bytes: Uint8Array): Promise<void> {
  await writeFile(out, bytes)
}

function done(from: string, to: string, out: string): number {
  if (!existsSync(out)) return fail('no_output', 'The export wrote no file.')
  process.stdout.write(envelope({ status: 'ok', summary: `${from} → ${to}`, output_path: resolve(out) }))
  return 0
}

function renderFailure(from: string, to: string, error: unknown): number {
  const code = error instanceof RenderError ? error.code.toLowerCase() : 'export_failed'
  const message = error instanceof Error ? error.message : String(error)
  return fail(code, message, { input: from, to })
}

/**
 * `--capture-url`: an html file as a PNG — the page itself, its scripts run, photographed after
 * they have painted (see `ChromiumRenderer.captureUrl`).
 *
 * The page is drawn, not printed: no PDF, no pdfium. `--capture-page` needs an editor to open the
 * document; this needs nothing but the browser it is already in.
 */
async function runCaptureUrl(argv: string[]): Promise<number> {
  const at = argv.indexOf('--capture-url')
  const input = argv[at + 1]
  const out = flagValue(argv, '--out')
  if (!input || !out) return fail('invalid_argument', 'capture-url needs --capture-url <file> --out <dir>.')
  if (!existsSync(input)) return fail('missing_input', `No such file: ${input}`)

  const width = Number(flagValue(argv, '--width') ?? '1000')
  const height = Number(flagValue(argv, '--height') ?? '625')
  const renderer = new ChromiumRenderer()
  try {
    const png = await renderer.captureUrl({
      url: pathToFileURL(resolve(input)).href,
      width: Number.isFinite(width) && width > 0 ? width : 1000,
      height: Number.isFinite(height) && height > 0 ? height : 625,
    })
    mkdirSync(resolve(out), { recursive: true })
    const target = join(resolve(out), `${basename(input).replace(/\.[^.]+$/, '')}.png`)
    await writeFile(target, png)
    process.stdout.write(`${JSON.stringify({ command: 'capture-url', status: 'ok', output_path: target, bytes: png.length })}
`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof RenderError ? error.code.toLowerCase() : 'capture_failed', message, { input })
  } finally {
    await renderer.close()
  }
}

/**
 * `--capture-page`: one page of a document as a PNG, photographed in its own editor.
 *
 * The page is *not* printed and the PDF is not made: the editor draws the page, and the picture is
 * that page (see `ChromiumRenderer.captureDocumentPage`). It lives in this launcher rather than in
 * the hub process for the reason everything else here does — `playwright-core` imports under Bun
 * and then hangs on `chromium.launch()`.
 */
async function runCapturePage(argv: string[]): Promise<number> {
  const at = argv.indexOf('--capture-page')
  const input = argv[at + 1]
  const out = flagValue(argv, '--out')
  const page = Number(flagValue(argv, '--page') ?? '1')
  // A workbook's corner: the sheet to show, and the cell the picture starts at.
  const sheet = flagValue(argv, '--sheet')
  const range = flagValue(argv, '--range')
  if (!input || !out) {
    return fail('invalid_argument', 'capture-page needs --capture-page <file> --out <dir> [--page <n>].')
  }
  if (!existsSync(input)) return fail('missing_input', `No such file: ${input}`)

  const app = APP_BY_EXTENSION[extensionOf(input)]
  if (!app || app === 'pdf') {
    return fail('unsupported_target', `${extensionOf(input) || 'that'} has no editor to photograph.`)
  }

  const renderer = new ChromiumRenderer()
  try {
    const png = await renderer.captureDocumentPage({
      app,
      path: resolve(input),
      bytes: new Uint8Array(await readFile(input)),
      // The tool counts pages from 1; the page is addressed from 0 here.
      page: Math.max(0, Math.trunc(page) - 1),
      ...(sheet || range ? { target: { ...(sheet ? { sheet } : {}), ...(range ? { range } : {}) } } : {}),
    })
    mkdirSync(resolve(out), { recursive: true })
    const target = join(resolve(out), `${basename(input).replace(/\.[^.]+$/, '')}-${String(page).padStart(2, '0')}.png`)
    await writeFile(target, png)
    process.stdout.write(`${JSON.stringify({ command: 'capture-page', status: 'ok', output_path: target, bytes: png.length })}
`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof RenderError ? error.code.toLowerCase() : 'capture_failed', message, { input })
  } finally {
    // A workbook is read by a sidecar process, and a sidecar outlives the call that started it.
    // Without this the launcher never exits and the host that spawned it waits out its timeout.
    stopWorkbookHost()
    await renderer.close()
  }
}

/**
 * `--probe-video` / `--video-frames`: a recording's header, or its frames.
 *
 * The decoding is the same sampler script the desktop runs, executed here because this is the
 * process that owns a Chromium. Frames are written under `--out` as `frame-0001.jpg` and named in
 * the envelope; a probe writes nothing and answers the header alone.
 */
async function runVideo(argv: string[], probeOnly: boolean): Promise<number> {
  const flag = probeOnly ? '--probe-video' : '--video-frames'
  const at = argv.indexOf(flag)
  const input = argv[at + 1]
  if (!input || input.startsWith('--')) return fail('invalid_argument', `${flag} needs a recording path.`)
  if (!existsSync(input)) return fail('missing_input', `No such file: ${input}`)

  const out = probeOnly ? undefined : flagValue(argv, '--out')
  if (!probeOnly && !out) {
    return fail('invalid_argument', '--video-frames needs --out <dir> — frames travel as files.')
  }

  const renderer = new ChromiumRenderer()
  try {
    const sampled = await renderer.sampleVideo({
      path: resolve(input),
      mode: flagValue(argv, '--mode') === 'changes' ? 'changes' : 'timeline',
      everyMs: numberFlag(argv, '--every') ?? 1_000,
      maxFrames: numberFlag(argv, '--max') ?? 1_000,
      ...numberOption(argv, '--threshold', 'changeThreshold'),
      ...numberOption(argv, '--from', 'fromMs'),
      ...numberOption(argv, '--to', 'toMs'),
      ...numberOption(argv, '--max-edge', 'maxEdge'),
      ...(argv.includes('--first') ? { first: true } : {}),
      ...(argv.includes('--last') ? { last: true } : {}),
      ...(probeOnly ? { probeOnly: true } : {}),
    })

    const frames: Array<{ offset_ms: number; path: string }> = []
    if (out) {
      const dir = resolve(out)
      mkdirSync(dir, { recursive: true })
      for (const [index, frame] of sampled.frames.entries()) {
        const target = join(dir, frameFileName(index + 1))
        await writeFile(target, frame.bytes)
        frames.push({ offset_ms: frame.offsetMs, path: target })
      }
    }

    process.stdout.write(
      `${JSON.stringify({
        command: 'video',
        status: 'ok',
        duration_ms: sampled.durationMs,
        width: sampled.viewport?.width ?? null,
        height: sampled.viewport?.height ?? null,
        truncated: sampled.truncated,
        frames,
      })}\n`,
    )
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof RenderError ? error.code.toLowerCase() : 'video_failed', message, { input })
  } finally {
    await renderer.close()
  }
}

/**
 * `--audio-extract`: a recording's sound, as a 16 kHz mono WAV.
 *
 * Same decoder and same codec limits as the frames read; the difference is the answer — a file on
 * disk instead of pictures in the envelope.
 */
async function runAudioExtract(argv: string[]): Promise<number> {
  const at = argv.indexOf('--audio-extract')
  const input = argv[at + 1]
  if (!input || input.startsWith('--')) {
    return fail('invalid_argument', '--audio-extract needs a recording path.')
  }
  if (!existsSync(input)) return fail('missing_input', `No such file: ${input}`)

  const out = flagValue(argv, '--out')
  if (!out) return fail('invalid_argument', '--audio-extract needs --out <file.wav>.')

  const renderer = new ChromiumRenderer()
  try {
    const audio = await renderer.extractAudio({ path: resolve(input), outPath: resolve(out) })
    process.stdout.write(
      `${JSON.stringify({
        command: 'audio',
        status: 'ok',
        path: audio.path,
        duration_ms: audio.durationMs,
        sample_rate: audio.sampleRate,
        bytes: audio.byteLength,
      })}\n`,
    )
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail(error instanceof RenderError ? error.code.toLowerCase() : 'audio_failed', message, {
      input,
    })
  } finally {
    await renderer.close()
  }
}

function numberFlag(argv: string[], name: string): number | undefined {
  const raw = flagValue(argv, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function numberOption<T extends 'changeThreshold' | 'fromMs' | 'toMs' | 'maxEdge'>(
  argv: string[],
  flag: string,
  key: T,
): Partial<Record<T, number>> {
  const value = numberFlag(argv, flag)
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<T, number>>)
}

const HELP = `craft-headless-export — print something, on a host with no editor window

  --headless-export <input> --to <pdf> --out <path> [--json]   answer the GenOffice CLI's contract
  --drawio <file> --format <fmt> --out <path> [--page] [--scale] [--theme]   draw a diagram
  --capture-page <file> --out <dir> [--page <n>] [--sheet] [--range] [--json]
                                                               one page as a PNG, photographed
  --capture-url <file> --out <dir> [--width n] [--height n] [--json]
                                                               an html page as a PNG, scripting off
  --probe-video <file> [--json]                                a recording's length and picture size
  --video-frames <file> --out <dir> [--mode timeline|changes] [--every ms] [--max n]
                 [--threshold r] [--from ms] [--to ms] [--first] [--last] [--max-edge n]
                                                               frames as numbered JPEGs
  --audio-extract <file> --out <file.wav>                      a recording's sound, 16 kHz mono
  --probe [--json]                                             start a browser and report it
  --help

Environment:
  CRAFT_BROWSER_BIN      a chromium binary to drive (chromes-headless-shell, system chromium)
  CRAFT_BROWSER_CHANNEL  a Playwright channel instead (chrome, msedge) — a dev machine's own
  CRAFT_RENDER_CONCURRENCY  how many jobs may print at once (default 2)
`

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }
  if (argv.includes('--probe')) return runProbe()
  if (argv.includes('--drawio')) return runDrawio(argv)
  if (argv.includes('--capture-page')) return runCapturePage(argv)
  if (argv.includes('--capture-url')) return runCaptureUrl(argv)
  if (argv.includes('--probe-video')) return runVideo(argv, true)
  if (argv.includes('--video-frames')) return runVideo(argv, false)
  if (argv.includes('--audio-extract')) return runAudioExtract(argv)

  const request = parseExport(argv)
  if (!request) {
    return fail('invalid_argument', 'export needs --headless-export <input> --to <format> --out <path>')
  }
  return runExport(request)
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(envelope({ status: 'error', error: 'export_failed', message }))
    process.exitCode = 1
  })

