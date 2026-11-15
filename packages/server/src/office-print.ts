/**
 * The hub's printer, for the one place that asks for it by callback rather than by command.
 *
 * Two callers print a document here, and they arrive from opposite directions:
 *
 * - `convert_tool convert --to pdf` asks the **engine**, which spawns `<app> --headless-export …`
 *   and reads the answer. That path needs nothing from this file.
 * - The **deck editor's own "Export as PDF"** goes through `officeDeckCall('exportPdf')`, and that
 *   asks `officePrint()` — a function injected by the process that owns the hosts
 *   (`@craft-agent/office-host/runtime`). On the desktop it is the app's export pipeline; here it
 *   has to be something a hub can do.
 *
 * The obvious answer — construct the renderer in-process — is the wrong one, and it was measured:
 * **`playwright-core` imports fine under Bun and then hangs on `chromium.launch()`**, forever. So
 * the printer does not print; it spawns the launcher that can, and reads the same envelope the
 * engine reads. One implementation, two callers, and the hub's own runtime never touches a browser.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setOfficePrint, type OfficePrint } from '@craft-agent/office-host'

export interface CliPrintOptions {
  /** The executable to run. On the image this is `resources/render-host/craft-headless-export`. */
  command: string
  /** Arguments the command takes before `--headless-export` — how a test runs the bundle on node. */
  prefixArgs?: string[]
  /** How long a print may take. A deck with images on a loaded hub is the slow case. */
  timeoutMs?: number
}

/** The envelope `craft-headless-export` prints, as far as this file cares about it. */
interface ExportEnvelope {
  status?: string
  output_path?: string
  error?: string
  message?: string
}

/**
 * A printer that answers by running the launcher.
 *
 * Success is a file, not a string: the envelope says `ok`, and the caller still checks the path
 * exists — because "the export finished" and "there is a PDF" are two different claims, and only
 * the second one is what a person waiting on the button cares about.
 */
export function createCliPrint(options: CliPrintOptions): OfficePrint {
  const timeoutMs = options.timeoutMs ?? 120_000

  return (input, outPath) =>
    new Promise<string>((resolve, reject) => {
      const target = outPath ?? input.path.replace(/\.[^.]+$/, '.pdf')
      const child = spawn(
        options.command,
        [...(options.prefixArgs ?? []), '--headless-export', input.path, '--to', 'pdf', '--out', target, '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Printing ${input.path} took longer than ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`The printing host could not be started: ${error.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const envelope = parseEnvelope(stdout)
        if (envelope?.status === 'ok' && existsSync(target)) return resolve(target)
        const message =
          envelope?.message ??
          envelope?.error ??
          (stderr.trim() ? stderr.trim().split('\n').slice(-2).join(' ') : `the printing host exited with code ${code}`)
        reject(new Error(message))
      })
    })
}

/**
 * Install the printer, or take it away when this host has no launcher.
 *
 * Passing `null` is not a no-op: it clears a printer a previous configuration left behind, so a hub
 * that lost its renderer refuses "no renderer" instead of failing in the middle of a save.
 */
export function configureOfficePrint(launcher: string | null): void {
  setOfficePrint(launcher ? createCliPrint({ command: launcher }) : null)
}

/** The last JSON object a process printed — the launcher's envelope, or one of its lines. */
function parseEnvelope(text: string): ExportEnvelope | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as ExportEnvelope
    } catch {
      // A line that only looks like JSON is not the answer; keep looking upwards.
    }
  }
  return null
}
