/**
 * The hub's page capture: a document's page, photographed by the launcher.
 *
 * The same reason `office-print.ts` spawns rather than imports: `playwright-core` imports under Bun
 * and then hangs on `chromium.launch()`, so the browser lives in a child process. `--capture-page`
 * is that child's verb, and what comes back is the picture — no PDF, no rasteriser, no print.
 *
 * The seam it fills is `setOfficePageCapture` in `@craft-agent/office-host`: `docx_tool render`
 * asks "draw me page 3", and answers with a file path, exactly like the app's own capture does.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  setOfficePageCapture,
  setOfficeWebShot,
  type PageCapture,
  type PageCaptureInput,
  type WebShot,
  type WebShotInput,
} from '@craft-agent/office-host'

export interface CliCaptureOptions {
  /** The launcher. On the image this is `resources/render-host/craft-headless-export`. */
  command: string
  /** Arguments the command takes before its verb — how a test runs the bundle on node. */
  prefixArgs?: string[]
  timeoutMs?: number
}

/** The envelope `craft-headless-export` prints, as far as this file cares about it. */
interface CaptureEnvelope {
  status?: string
  output_path?: string
  error?: string
  message?: string
}

export function createCliCapture(options: CliCaptureOptions): PageCapture {
  const timeoutMs = options.timeoutMs ?? 120_000

  return (input: PageCaptureInput) =>
    new Promise<string[]>((resolve, reject) => {
      const child = spawn(
        options.command,
        [
          ...(options.prefixArgs ?? []),
          '--capture-page',
          input.path,
          '--out',
          input.outDir,
          '--page',
          String(input.page + 1),
          ...(input.target?.sheet ? ['--sheet', input.target.sheet] : []),
          ...(input.target?.range ? ['--range', input.target.range] : []),
          '--json',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Drawing page ${input.page + 1} of ${input.path} took longer than ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`The capture host could not be started: ${error.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const envelope = parseEnvelope(stdout)
        // Success is a file, not a word: "the capture finished" and "there is a picture" are two
        // different claims, and the second is the one the caller can act on.
        if (envelope?.status === 'ok' && envelope.output_path && existsSync(envelope.output_path)) {
          return resolve([envelope.output_path])
        }
        const message =
          envelope?.message ??
          envelope?.error ??
          (stderr.trim() ? stderr.trim().split('\n').slice(-2).join(' ') : `the capture host exited with code ${code}`)
        reject(new Error(message))
      })
    })
}

/** Install the capture, or take it away when this host has no launcher. */
export function configureOfficePageCapture(launcher: string | null): void {
  setOfficePageCapture(launcher ? createCliCapture({ command: launcher }) : null)
}

/** The last JSON object a process printed — the launcher's envelope, or one of its lines. */
function parseEnvelope(text: string): CaptureEnvelope | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as CaptureEnvelope
    } catch {
      // A line that only looks like JSON is not the answer; keep looking upwards.
    }
  }
  return null
}

/**
 * The hub's page shot: an html file drawn by the launcher, scripting off.
 *
 * Same spawn as everything else here, for the same reason — the browser lives in a child process
 * because `playwright-core` hangs under Bun. `--capture-url` is that child's verb; the PNG comes
 * back as a file the tool layer reads into the reply.
 */
export function createCliWebShot(options: CliCaptureOptions): WebShot {
  const timeoutMs = options.timeoutMs ?? 120_000

  return (input: WebShotInput) =>
    new Promise<string[]>((resolve, reject) => {
      const child = spawn(
        options.command,
        [
          ...(options.prefixArgs ?? []),
          '--capture-url',
          input.path,
          '--out',
          input.outDir,
          '--width',
          String(input.width),
          '--height',
          String(input.height),
          '--json',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Drawing ${input.path} took longer than ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`The capture host could not be started: ${error.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const envelope = parseEnvelope(stdout)
        if (envelope?.status === 'ok' && envelope.output_path && existsSync(envelope.output_path)) {
          return resolve([envelope.output_path])
        }
        const message =
          envelope?.message ??
          envelope?.error ??
          (stderr.trim() ? stderr.trim().split(String.fromCharCode(10)).slice(-2).join(' ') : `the capture host exited with code ${code}`)
        reject(new Error(message))
      })
    })
}

/** Install the page shot, or take it away when this host has no launcher. */
export function configureOfficeWebShot(launcher: string | null): void {
  setOfficeWebShot(launcher ? createCliWebShot({ command: launcher }) : null)
}
