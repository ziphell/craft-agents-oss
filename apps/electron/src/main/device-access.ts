/**
 * Device access — shell and file operations this machine offers to a hub.
 *
 * The hub names a device and a path; this side decides whether that path is its business. A call
 * is rooted in the directory this install keeps for that hub's workspace
 * (`<hub root base>/<hub device id>/<workspace id>`) and in the folders the person added to that
 * saved server — and nothing outside those is reachable.
 *
 * Advertised as `client:device:exec` / `client:device:fs` on the app-level links to saved
 * servers (`hub-connection.ts`); windows no longer answer these.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, promises as fsp } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { hubWorkspaceRoot, getComputerUseEnabled } from '@craft-agent/shared/config'
import type { DeviceExecRequest, DeviceExecResponse, DeviceFsRequest, DeviceFsResponse, DeviceHubContext, BrowserCapabilityRequest } from '@craft-agent/server-core/transport'
import { CLIENT_BROWSER_INVOKE, CLIENT_COMPUTER_INVOKE, CLIENT_DEVICE_EXEC, CLIENT_DEVICE_FS } from '@craft-agent/server-core/transport'
import type { LinkGrants } from './hub-connection'
import { dispatchComputerCapability, type ComputerCapabilityRequest, type ComputerPaneFns } from '@craft-agent/shared/agent'
import type { WsRpcClient } from '../transport/client'
import type { DeviceFsEntry, DeviceFsMatch } from '@craft-agent/shared/agent/device-tool'

const MAX_EXEC_OUTPUT_BYTES = 512 * 1024
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 5 * 1024 * 1024
const MAX_LIST_ENTRIES = 2000
const MAX_SEARCH_FILES = 5000
const MAX_SEARCH_RESULTS = 1000

/**
 * The directories a request may touch.
 *
 * Two sources:
 * - the directory this install keeps for that (hub, workspace) pair — created on first use. It is
 *   the tool's own scratch space, not a mapping to any hub workspace;
 * - folders the person added to that saved server (`allowedRoots`).
 *
 * A local workspace is **not** authorized by being a workspace: the dialog merely offers it as a
 * one-click path. Authorization is the saved list on the connection, and nothing else is reachable.
 * A request without the hub context is refused rather than answered with this machine's own
 * workspaces: a hub must never reach files that belong to this install by naming nothing.
 */
function rootsForRequest(req: DeviceHubContext, allowedRoots: readonly string[]): string[] {
  const hubDeviceId = req.hubDeviceId?.trim()
  const workspaceId = req.workspaceId?.trim()
  if (!hubDeviceId || !workspaceId) {
    throw new Error('This device only serves files inside a hub workspace: the hub and workspace are required.')
  }
  const root = hubWorkspaceRoot(hubDeviceId, workspaceId)
  try {
    mkdirSync(root, { recursive: true })
  } catch (error) {
    throw new Error(`Could not create this device's workspace directory: ${error instanceof Error ? error.message : String(error)}`)
  }

  return uniqueRoots([root, ...allowedRoots])
}

/** Resolve, drop blanks/relatives, and dedupe (case-insensitively on Windows) without reordering. */
function uniqueRoots(candidates: string[]): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const value = candidate.trim()
    if (!value || !isAbsolute(value)) continue
    const absolute = resolve(value)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(absolute)
  }
  return roots
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Resolve `p` and refuse anything outside the roots this request may touch. */
function resolveAllowedPath(p: string | undefined, roots: string[]): string {
  if (!p || !p.trim()) throw new Error('A path is required')
  if (roots.length === 0) {
    throw new Error('This device has no workspace directories available for remote access.')
  }
  const absolute = isAbsolute(p) ? resolve(p) : resolve(roots[0]!, p)
  const inside = roots.some((root) => {
    const rel = relative(root, absolute)
    return samePath(root, absolute) || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!inside) {
    throw new Error(`Path is outside this device's workspace directories: ${p}`)
  }
  return absolute
}

function capOutput(value: string, remaining: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes <= remaining) return { text: value, truncated: false }
  return { text: Buffer.from(value, 'utf8').subarray(0, Math.max(0, remaining)).toString('utf8'), truncated: true }
}

export async function runExec(req: DeviceExecRequest, allowedRoots: readonly string[]): Promise<DeviceExecResponse> {
  if (!req.command?.trim()) throw new Error('A command is required')
  const roots = rootsForRequest(req, allowedRoots)
  if (roots.length === 0) {
    throw new Error('This device has no workspace directories available for remote access.')
  }
  const cwd = req.cwd ? resolveAllowedPath(req.cwd, roots) : roots[0]!
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 60_000, 1_000), 300_000)
  const startedAt = Date.now()

  return await new Promise<DeviceExecResponse>((resolvePromise, reject) => {
    const child = spawn(req.command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false

    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        cwd,
        truncated,
      })
    }

    const killTree = () => {
      if (child.pid == null) return
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = capOutput(stdout + chunk.toString('utf8'), MAX_EXEC_OUTPUT_BYTES)
      stdout = next.text
      if (next.truncated) truncated = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = capOutput(stderr + chunk.toString('utf8'), MAX_EXEC_OUTPUT_BYTES)
      stderr = next.text
      if (next.truncated) truncated = true
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => finish(code))
  })
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

async function walkFiles(root: string, visit: (file: string) => Promise<boolean>): Promise<void> {
  const queue: string[] = [root]
  let seen = 0
  while (queue.length > 0) {
    const dir = queue.shift()!
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(absolute)
      } else if (entry.isFile()) {
        seen++
        if (seen > MAX_SEARCH_FILES) return
        if (!(await visit(absolute))) return
      }
    }
  }
}

export async function runFs(req: DeviceFsRequest, allowedRoots: readonly string[]): Promise<DeviceFsResponse> {
  const roots = rootsForRequest(req, allowedRoots)
  const absolute = req.path ? resolveAllowedPath(req.path, roots) : undefined

  switch (req.op) {
    case 'read': {
      if (!absolute) throw new Error('A path is required')
      const stat = await fsp.stat(absolute)
      if (!stat.isFile()) throw new Error('Not a file')
      if (stat.size > MAX_READ_BYTES) throw new Error(`File is larger than ${MAX_READ_BYTES} bytes`)
      const raw = await fsp.readFile(absolute, 'utf8')
      if (req.offset == null && req.limit == null) {
        return { op: 'read', path: absolute, content: raw }
      }
      const lines = raw.split('\n')
      const start = Math.max((req.offset ?? 1) - 1, 0)
      const end = Math.min(start + (req.limit ?? lines.length), lines.length)
      return { op: 'read', path: absolute, content: lines.slice(start, end).join('\n') }
    }
    case 'write': {
      if (!absolute) throw new Error('A path is required')
      const content = req.content ?? ''
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        throw new Error(`Content is larger than ${MAX_WRITE_BYTES} bytes`)
      }
      await fsp.mkdir(dirname(absolute), { recursive: true })
      await fsp.writeFile(absolute, content, 'utf8')
      return { op: 'write', path: absolute, bytesWritten: Buffer.byteLength(content, 'utf8') }
    }
    case 'edit': {
      if (!absolute) throw new Error('A path is required')
      if (!req.oldString) throw new Error('oldString is required')
      const before = await fsp.readFile(absolute, 'utf8')
      const parts = before.split(req.oldString)
      if (parts.length === 1) throw new Error('oldString was not found')
      if (parts.length > 2 && !req.replaceAll) {
        throw new Error('oldString occurs more than once; set replaceAll to replace every occurrence')
      }
      const after = parts.join(req.newString ?? '')
      await fsp.writeFile(absolute, after, 'utf8')
      return { op: 'edit', path: absolute, replacements: parts.length - 1 }
    }
    case 'list': {
      if (!absolute) throw new Error('A path is required')
      const entries = await fsp.readdir(absolute, { withFileTypes: true })
      const result: DeviceFsEntry[] = []
      for (const entry of entries) {
        const entryPath = resolve(absolute, entry.name)
        const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
        let size: number | undefined
        if (type === 'file') {
          try { size = (await fsp.stat(entryPath)).size } catch { /* raced */ }
        }
        result.push({ name: entry.name, path: entryPath, type, size })
        if (result.length >= MAX_LIST_ENTRIES) break
      }
      return { op: 'list', path: absolute, entries: result, truncated: result.length >= MAX_LIST_ENTRIES }
    }
    case 'stat': {
      if (!absolute) throw new Error('A path is required')
      const stat = await fsp.stat(absolute)
      return {
        op: 'stat',
        path: absolute,
        stat: {
          type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
      }
    }
    case 'glob': {
      if (!absolute) throw new Error('A path is required')
      if (!req.pattern) throw new Error('pattern is required')
      const regex = globToRegExp(req.pattern.replace(/\\/g, '/'))
      const files: string[] = []
      await walkFiles(absolute, async (file) => {
        const rel = relative(absolute, file).replace(/\\/g, '/')
        if (regex.test(rel)) files.push(file)
        return files.length < 2000
      })
      return { op: 'glob', path: absolute, files, truncated: files.length >= 2000 }
    }
    case 'grep': {
      if (!absolute) throw new Error('A path is required')
      if (!req.pattern) throw new Error('pattern is required')
      let regex: RegExp
      try {
        regex = new RegExp(req.pattern, req.ignoreCase ? 'i' : '')
      } catch (error) {
        throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
      }
      const filePattern = req.glob ? globToRegExp(req.glob.replace(/\\/g, '/')) : null
      const maxResults = Math.min(req.maxResults ?? 200, MAX_SEARCH_RESULTS)
      const matches: DeviceFsMatch[] = []
      await walkFiles(absolute, async (file) => {
        const rel = relative(absolute, file).replace(/\\/g, '/')
        if (filePattern && !filePattern.test(rel)) return true
        let stat
        try { stat = await fsp.stat(file) } catch { return true }
        if (stat.size > MAX_READ_BYTES) return true
        let content: string
        try { content = await fsp.readFile(file, 'utf8') } catch { return true }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i]!)) continue
          matches.push({ path: file, line: i + 1, text: lines[i]!.slice(0, 500) })
          if (matches.length >= maxResults) return false
        }
        return true
      })
      return { op: 'grep', path: absolute, matches, truncated: matches.length >= maxResults }
    }
    default:
      throw new Error(`Unsupported file operation: ${(req as { op?: string }).op}`)
  }
}

/**
 * Teach one connection to answer as this machine: shell, files, browser.
 *
 * Used by the app-level link to a saved hub (`hub-connection.ts`), so another machine reaches this
 * one without depending on a window. The browser is read per call: it is created after these.
 *
 * `connectionId` is the saved server this link belongs to. Browser windows are filed under it, so
 * two servers that happen to use the same workspace id never share one (`browserWorkspaceKey`).
 * `allowedRoots` is that saved server's folder list, captured when the link was built: the link is
 * rebuilt whenever the list changes, so a request never re-reads the config.
 */
export function attachDeviceCapabilities(
  client: WsRpcClient,
  browserPaneManager: () => { dispatchCapability(req: BrowserCapabilityRequest, connectionId?: string | null): Promise<unknown> } | null,
  computerUseManager: () => { fnsForSession(sessionId: string): Promise<ComputerPaneFns> } | null,
  connectionId: string,
  allowedRoots: readonly string[],
  grants: LinkGrants,
): void {
  // Each door checks its own grant. The capability list already keeps an ungranted door out of the
  // handshake; this is the second half — a server that kept an older list still gets refused.
  client.handleCapability(CLIENT_DEVICE_EXEC, async (req: DeviceExecRequest): Promise<DeviceExecResponse> => {
    if (!grants.shell) throw new Error('This server is not allowed to run commands on this machine.')
    if (!req || req.v !== 1) throw new Error('Unsupported device exec request')
    return await runExec(req, allowedRoots)
  })
  client.handleCapability(CLIENT_DEVICE_FS, async (req: DeviceFsRequest): Promise<DeviceFsResponse> => {
    if (!grants.files) throw new Error('This server is not allowed to read or write files on this machine.')
    if (!req || req.v !== 1) throw new Error('Unsupported device fs request')
    return await runFs(req, allowedRoots)
  })
  client.handleCapability(CLIENT_BROWSER_INVOKE, async (req: BrowserCapabilityRequest): Promise<unknown> => {
    if (!grants.browser) throw new Error("This server is not allowed to use this machine's browser.")
    const manager = browserPaneManager()
    if (!manager) throw new Error('This app has no browser to drive')
    return await manager.dispatchCapability(req, connectionId)
  })
  // This machine's desktop, for a hub that asked for it. The session id is the **connection**, so a
  // remote hub holds the same 90 s lease a local conversation does — and two hubs cannot both drive
  // this pointer, which is the whole point of the lease.
  client.handleCapability(CLIENT_COMPUTER_INVOKE, async (req: ComputerCapabilityRequest): Promise<unknown> => {
    if (!grants.computer) throw new Error("This server is not allowed to drive this machine's desktop.")
    if (!req || req.v !== 1) throw new Error('Unsupported computer request')
    // Capabilities are fixed at handshake, so a link opened while the switch was on can outlive it.
    // Re-reading the switch here is what makes turning it off effective immediately, rather than
    // at the next reconnect.
    // This request came from a **server**, so both levels are checked: the machine-level switch
    // (driver + OS grants), and the per-connection grant in `grants.computer` below.
    if (!getComputerUseEnabled()) throw new Error('Desktop control is turned off in Settings.')
    const manager = computerUseManager()
    if (!manager) throw new Error('This app has no desktop to drive')
    const fns = await manager.fnsForSession(`remote:${connectionId}`)
    return await dispatchComputerCapability(fns, req.method, req.args ?? [])
  })
}
