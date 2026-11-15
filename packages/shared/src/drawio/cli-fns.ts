/**
 * `drawio_tool`'s rendering, answered by a process instead of by a window.
 *
 * The tool used to reach only the browser pane: on the desktop that is the app's own drawio in a
 * hidden window, and on a hub it was a bridge to somebody's laptop — so a diagram could not be
 * drawn while nobody was signed in. It can now: the same vendored drawio, driven by a headless
 * Chromium in `packages/render-host`, and reached over a process contract like the rest of this
 * seam.
 *
 * Two calls, and only one of them needs the browser:
 *
 * - **listing pages** is parsing, not drawing. `drawioPages` already reads the document, so this
 *   answers without starting anything — a `pages` command should not cost a browser launch.
 * - **exporting** is a drawing, so it spawns `craft-headless-export --drawio …` and reads the file
 *   it wrote. Bytes travel as a file, not as base64 on stdout.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserPaneFns, DrawioFormat } from '../agent/browser-pane.ts'
import { drawioPages } from './types.ts'

/** What the engine can file a document as — `drawio_tool`'s own list, named once in the pane types. */
export type DrawioEngineFormat = DrawioFormat

const EXTENSIONS: Record<DrawioEngineFormat, string> = {
  svg: 'svg',
  xmlsvg: 'drawio.svg',
  png: 'png',
  html: 'html',
  xml: 'drawio',
}

const MIME_TYPES: Record<DrawioEngineFormat, string> = {
  svg: 'image/svg+xml',
  xmlsvg: 'image/svg+xml',
  png: 'image/png',
  html: 'text/html',
  xml: 'application/xml',
}

export interface DrawioExportRequest {
  path: string
  format: DrawioEngineFormat
  /** Where an `export` wants the file. Omitted by `render`, which only wants the bytes. */
  out?: string
  page?: string
  scale?: number
  theme?: 'auto' | 'light' | 'dark'
}

export interface RenderedDrawioBytes {
  bytes: Uint8Array
  mimeType: string
  extension: string
}

/**
 * The two calls `drawio_tool` makes of its host.
 *
 * Taken from the pane's own interface rather than written out again: a host that answers these two
 * *is* a host for this tool, and restating the shape here is how the two would drift.
 */
export type DrawioRenderFns = Pick<BrowserPaneFns, 'exportDrawio' | 'listDrawioPages'>

export interface DrawioCliFnsOptions {
  /** The launcher. On the image: `resources/render-host/craft-headless-export`. */
  command: string
  /** Arguments before `--drawio`, so a test can run the bundle on node instead. */
  prefixArgs?: string[]
  timeoutMs?: number
}

export function createDrawioCliFns(options: DrawioCliFnsOptions): DrawioRenderFns {
  const timeoutMs = options.timeoutMs ?? 120_000

  return {
    async listDrawioPages(input) {
      // A document that cannot be read is the caller's error to report, not an empty list: the
      // tool says "no pages" only when the file really has none.
      const text = await readFile(input.path, 'utf8')
      return drawioPages(text)
    },

    async exportDrawio(input) {
      const scratch = input.out ? null : await mkdtemp(join(tmpdir(), 'craft-drawio-'))
      const target = input.out ?? join(scratch!, `diagram.${EXTENSIONS[input.format]}`)
      try {
        await run(options, [
          '--drawio',
          input.path,
          '--format',
          input.format,
          '--out',
          target,
          ...(input.page ? ['--page', input.page] : []),
          ...(input.scale !== undefined ? ['--scale', String(input.scale)] : []),
          ...(input.theme ? ['--theme', input.theme] : []),
          '--json',
        ], timeoutMs)
        if (!existsSync(target)) throw new Error('The diagram engine wrote no file.')
        return {
          bytes: new Uint8Array(await readFile(target)),
          mimeType: MIME_TYPES[input.format],
          extension: EXTENSIONS[input.format],
          // A pane reports where it wrote; a diagram shown rather than kept has no path.
          path: input.out ?? null,
        }
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

/** The envelope `craft-headless-export` prints for a drawing. */
interface DrawioEnvelope {
  status?: string
  output_path?: string
  error?: string
  message?: string
}

function run(options: DrawioCliFnsOptions, args: string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, [...(options.prefixArgs ?? []), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Drawing this diagram took longer than ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`The diagram engine could not be started: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const envelope = parseEnvelope(stdout)
      if (envelope?.status === 'ok') return resolve()
      reject(
        new Error(
          envelope?.message ??
            envelope?.error ??
            (stderr.trim() ? stderr.trim().split('\n').slice(-2).join(' ') : `the diagram engine exited with code ${code}`),
        ),
      )
    })
  })
}

function parseEnvelope(text: string): DrawioEnvelope | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as DrawioEnvelope
    } catch {
      // A line that only looks like JSON is not the answer.
    }
  }
  return null
}
