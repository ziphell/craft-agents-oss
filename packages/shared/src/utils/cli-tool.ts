/**
 * Running one of the bundled command-line tools from a host process.
 *
 * The tools are Bun bundles in `resources/cli-tools/dist`; only their native packages sit beside
 * them. A caller that wants one runs it in a child process rather than importing it: the work these
 * tools do (decoding audio, reading OCR, re-encoding a phone photo) is CPU-bound and synchronous,
 * and doing it in a conversation's process would stop every other conversation for as long as it
 * took.
 *
 * This lives in `shared` because two layers need it: the server (attachments, panels) and the
 * agent itself (`call_llm` normalising a picture before it is sent to a model).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getBundledAssetsDir } from './paths'

/** Where the tool bundles live: the environment's answer first, then the app's own resources. */
export function cliToolsDir(): string | null {
  const configured = process.env.CRAFT_CLI_TOOLS?.trim()
  if (configured) return configured
  return getBundledAssetsDir('cli-tools/dist') ?? null
}

/**
 * The runtime that runs a bundle, and the arguments it needs before the file.
 *
 * A desktop build sets `CRAFT_BUN` to the Bun it ships; a headless server *is* Bun, so its own
 * executable is the answer. Anything else falls back to `bun` on PATH, which is what a developer
 * machine has. `argsPrefix` exists because Bun takes `run <file>` while a plain JS runner does not.
 */
export interface CliRuntime {
  command: string
  argsPrefix: string[]
}

export function cliRuntime(): CliRuntime {
  const configured = process.env.CRAFT_BUN?.trim()
  if (configured) return { command: configured, argsPrefix: ['run'] }

  const self = basename(process.execPath).toLowerCase()
  if (self.startsWith('bun')) return { command: process.execPath, argsPrefix: ['run'] }

  return { command: 'bun', argsPrefix: ['run'] }
}

/**
 * The program that runs a bundle, without its arguments.
 *
 * Kept for callers that only need the path; prefer {@link cliRuntime}, which also carries the
 * `run` prefix Bun needs.
 */
export function bunBinary(): string {
  return cliRuntime().command
}

export interface CliRun {
  ok: boolean
  stdout: string
  stderr: string
  /** A sentence for the caller when the tool could not be run at all. */
  message?: string
}

/**
 * Run a bundle to completion.
 *
 * Never throws: a missing build, a crash and a timeout are all answers a settings page or a canvas
 * can render, and each says which one it was.
 */
export function runCliTool(
  name: string,
  args: readonly string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<CliRun> {
  const dir = cliToolsDir()
  const file = dir ? join(dir, `${name}.mjs`) : null
  if (!file || !existsSync(file)) {
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: '',
      message: `${name} is not built in this installation. Run \`bun run build:cli-tools\` and restart.`,
    })
  }

  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000
  return new Promise((resolve) => {
    const child = spawn(bunBinary(), ['run', file, ...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: CliRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        stdout,
        stderr,
        message: `${name} took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`,
      })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ ok: false, stdout, stderr, message: `${name} could not start: ${error.message}` })
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout, stderr })
        return
      }
      const reason = stderr.trim().split(/\r?\n/).filter(Boolean).pop()
      finish({
        ok: false,
        stdout,
        stderr,
        message: reason || `${name} exited with code ${code ?? 'unknown'}.`,
      })
    })
  })
}
