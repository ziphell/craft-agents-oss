/**
 * Running one of the bundled command-line tools from a session.
 *
 * The tools are Bun bundles in `resources/cli-tools/dist`; a caller runs one in a child process
 * rather than importing it, because decoding audio is CPU-bound and synchronous and would stop the
 * conversation that asked. The lookup order matches the server's own runner: an explicit
 * `CRAFT_CLI_TOOLS`, then the app's bundled assets, then the dev layouts.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getBundledAssetsDir } from '../utils/paths.ts'
import { cliRuntime } from '../utils/cli-tool.ts'

export interface CliRun {
  ok: boolean
  stdout: string
  stderr: string
  /** A sentence for the caller when the tool could not be run at all. */
  message?: string
}

/** Where the tool bundles live, or null when this install has none. */
export function cliToolsDir(): string | null {
  const configured = process.env.CRAFT_CLI_TOOLS?.trim()
  if (configured) return configured
  const root = process.env.CRAFT_BUNDLED_ASSETS_ROOT?.trim()
  if (root) {
    const beside = join(root, 'resources', 'cli-tools', 'dist')
    if (existsSync(beside)) return beside
  }
  return getBundledAssetsDir('cli-tools/dist') ?? null
}

/**
 * The runtime that runs a bundle — the same answer the agent's other tools get.
 *
 * Deliberately not a second copy: this used to be a duplicate of `utils/cli-tool.ts`'s resolver,
 * which is how the two drifted (one passed `run`, the other did not).
 */

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Run a bundle to completion. Never throws: a missing build, a crash and a timeout are answers a
 * door can render, and each says which one it was.
 */
export function runBundledCliTool(
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
      message: `${name} 的构建不存在：运行 bun run build:cli-tools 后重试。`,
    })
  }

  return new Promise((resolve) => {
    const runtime = cliRuntime()
    const child = spawn(runtime.command, [...runtime.argsPrefix, file, ...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({
        ok: false,
        stdout,
        stderr,
        message: `${name} 运行超过 ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60000)} 分钟，已停止。`,
      })
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, message: `${name} 无法启动：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, ...(code === 0 ? {} : { message: `${name} 退出码 ${code}` }) })
    })
  })
}
