/**
 * `device_tool` — the meta-tool's commands.
 *
 * One call names a **device** and the **nested tool** to run there, so the device is an argument
 * of the tool rather than a flag repeated on every operation. The nested vocabulary is the one an
 * agent already knows from its own shell/file/browser tools (`bash`, `read`, `write`, `edit`,
 * `list`, `stat`, `glob`, `grep`, `browser`), which is what keeps a remote machine from
 * needing a second dialect.
 *
 * Nothing here decides whether a path or a command is allowed: the device does, against its own
 * workspace roots. This file formats what came back.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { TOOL_DESCRIPTIONS, DeviceToolSchema } from '@craft-agent/session-tools-core';
import type { BrowserCommandImage } from './command-cli.ts';
import { executeBrowserToolCommand, BROWSER_RELEASE_HINT } from './browser-commands.ts';
import { executeComputerToolCommand, COMPUTER_RELEASE_HINT } from './computer-commands.ts';
import type {
  DeviceFsArgs,
  DeviceFsResult,
  DeviceToolFns,
  DeviceToolInfo,
} from './device-tool.ts';

export type DeviceToolName =
  | 'devices'
  | 'bash'
  | 'read'
  | 'write'
  | 'edit'
  | 'list'
  | 'stat'
  | 'glob'
  | 'grep'
  | 'browser'
  /** The device's own desktop, served by the remote bridge on the far side. */
  | 'computer';

const FS_TOOLS = new Set<DeviceToolName>(['read', 'write', 'edit', 'list', 'stat', 'glob', 'grep']);

export interface DeviceToolCommandArgs {
  tool: DeviceToolName;
  device?: string;
  args?: Record<string, unknown>;
  fns: DeviceToolFns;
  sessionId: string;
  /** Where a relative `--file` path in a nested browser command counts from. */
  workspaceRootPath?: string;
}

export interface DeviceToolCommandResult {
  output: string;
  image?: BrowserCommandImage;
  images?: BrowserCommandImage[];
}

// ============================================================================
// Argument helpers
// ============================================================================

function requireDevice(device: string | undefined): string {
  const trimmed = device?.trim();
  if (!trimmed) {
    throw new Error('A device is required. Run this tool with {"tool":"devices"} to list them.');
  }
  return trimmed;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value == null) throw new Error(`"${key}" is required for this tool.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

// ============================================================================
// Output formatting
// ============================================================================

function formatDevices(devices: DeviceToolInfo[]): string {
  if (devices.length === 0) {
    return 'No devices are available. A device must be connected, allow this server on its side, and be enabled here (Settings → Server → Devices).'
  }
  const lines = [`${devices.length} device${devices.length === 1 ? '' : 's'}:`];
  for (const device of devices) {
    const allowed = (Object.keys(device.capabilities) as Array<keyof DeviceToolInfo['capabilities']>)
      .filter((key) => device.capabilities[key])
    const label = device.alias ? `${device.alias} (${device.name})` : device.name
    lines.push(
      `- ${label} (${device.id})` +
      ` · ${device.platform ?? 'unknown platform'}` +
      (device.version ? ` · v${device.version}` : '') +
      ` · ${allowed.length > 0 ? allowed.join(', ') : 'no access'}`,
    )
    for (const root of device.allowedRoots) lines.push(`  root: ${root}`)
    if (device.defaultRoot) lines.push(`  default: ${device.defaultRoot}`)
  }
  return lines.join('\n')
}

function formatFsResult(result: DeviceFsResult): string {
  switch (result.op) {
    case 'read':
      return result.content ?? ''
    case 'write':
      return `Wrote ${result.bytesWritten ?? 0} bytes to ${result.path}`
    case 'edit':
      return `Replaced ${result.replacements ?? 0} occurrence(s) in ${result.path}`
    case 'list': {
      const entries = result.entries ?? []
      if (entries.length === 0) return `${result.path} is empty.`
      const lines = entries.map((entry) =>
        entry.type === 'file'
          ? `${entry.type}\t${entry.size ?? '?'}B\t${entry.path}`
          : `${entry.type}\t${entry.path}`)
      if (result.truncated) lines.push('… (list truncated)')
      return lines.join('\n')
    }
    case 'stat':
      return result.stat
        ? `${result.stat.type}\t${result.stat.size}B\t${new Date(result.stat.mtimeMs).toISOString()}\t${result.path}`
        : `No stat available for ${result.path}`
    case 'glob': {
      const files = result.files ?? []
      if (files.length === 0) return 'No files matched.'
      return [...files, ...(result.truncated ? ['… (results truncated)'] : [])].join('\n')
    }
    case 'grep': {
      const matches = result.matches ?? []
      if (matches.length === 0) return 'No matches.'
      const lines = matches.map((match) => `${match.path}:${match.line}: ${match.text}`)
      if (result.truncated) lines.push('… (results truncated)')
      return lines.join('\n')
    }
    default:
      return JSON.stringify(result)
  }
}

function formatExecResult(result: Awaited<ReturnType<DeviceToolFns['exec']>>): string {
  const lines: string[] = []
  if (result.stdout.trim()) lines.push(result.stdout.trimEnd())
  if (result.stderr.trim()) lines.push(`[stderr]\n${result.stderr.trimEnd()}`)
  if (result.truncated) lines.push('[output truncated]')
  const status = result.timedOut
    ? `timed out after ${result.durationMs}ms`
    : `exit ${result.exitCode ?? 'unknown'}`
  lines.push(`[${status} · ${result.durationMs}ms · cwd ${result.cwd}]`)
  return lines.join('\n')
}

// ============================================================================
// Execution — two kinds of call, deliberately kept apart
// ============================================================================

/**
 * **Meta** — what devices exist and what they allow. Names no device: it is a question about the
 * set, not an operation on one.
 */
export async function executeDeviceMetaCommand(fns: DeviceToolFns): Promise<DeviceToolCommandResult> {
  return { output: formatDevices(await fns.list()) }
}

/**
 * **Proxy** — run one tool **on the device that was named**, and nowhere else.
 *
 * The device is required and is passed through verbatim to the device layer, which resolves it to
 * exactly one connection. There is no fallback: not to the server's own machine, not to the client
 * that sent the last message, not to "whichever device is connected". A name that is missing,
 * unknown, ambiguous, or lacks the capability is an error — the point of naming a machine is that
 * the answer cannot quietly come from another one.
 */
export async function executeDeviceProxyCommand(
  opts: DeviceToolCommandArgs,
): Promise<DeviceToolCommandResult> {
  const args = opts.args ?? {}
  const device = requireDevice(opts.device)

  if (opts.tool === 'devices') {
    throw new Error('"devices" is a meta call: omit the device and do not name a proxy tool.')
  }

  if (opts.tool === 'bash') {
    const result = await opts.fns.exec(device, {
      command: requireString(args, 'command'),
      cwd: optionalString(args, 'cwd'),
      timeoutMs: optionalNumber(args, 'timeoutMs'),
    })
    return { output: formatExecResult(result) }
  }

  if (FS_TOOLS.has(opts.tool)) {
    if (opts.tool === 'write' && typeof args.content !== 'string') {
      throw new Error('"content" is required for write (an empty string is a valid one).')
    }
    if (opts.tool === 'edit') {
      requireString(args, 'oldString')
      if (typeof args.newString !== 'string') throw new Error('"newString" is required for edit.')
    }
    const fsArgs: DeviceFsArgs = {
      op: opts.tool as DeviceFsArgs['op'],
      path: optionalString(args, 'path'),
      content: optionalString(args, 'content'),
      oldString: optionalString(args, 'oldString'),
      newString: optionalString(args, 'newString'),
      replaceAll: optionalBoolean(args, 'replaceAll'),
      pattern: optionalString(args, 'pattern'),
      glob: optionalString(args, 'glob'),
      ignoreCase: optionalBoolean(args, 'ignoreCase'),
      maxResults: optionalNumber(args, 'maxResults'),
      offset: optionalNumber(args, 'offset'),
      limit: optionalNumber(args, 'limit'),
    }
    return { output: formatFsResult(await opts.fns.fs(device, fsArgs)) }
  }

  if (opts.tool === 'browser') {
    const command = args.command
    if (typeof command !== 'string' && !Array.isArray(command)) {
      throw new Error('"command" is required for the browser tool (a browser_tool command string or array).')
    }
    const fns = await opts.fns.getBrowserFns(device)
    const result = await executeBrowserToolCommand({
      command: command as string | string[],
      fns,
      sessionId: opts.sessionId,
      workspaceRootPath: opts.workspaceRootPath,
    })
    return {
      output: result.appendReleaseHint ? result.output + BROWSER_RELEASE_HINT : result.output,
      ...(result.image ? { image: result.image } : {}),
      ...(result.images ? { images: result.images } : {}),
    }
  }

  if (opts.tool === 'computer') {
    const command = args.command
    if (typeof command !== 'string' && !Array.isArray(command)) {
      throw new Error('"command" is required for the computer tool on a device (e.g. "status").')
    }
    const fns = await opts.fns.getComputerFns(device)
    const result = await executeComputerToolCommand({ command: command as string | string[], fns })
    return {
      output: result.appendReleaseHint ? result.output + COMPUTER_RELEASE_HINT : result.output,
      ...(result.image ? { image: result.image } : {}),
      ...(result.images ? { images: result.images } : {}),
    }
  }

  throw new Error(`Unsupported device tool: ${opts.tool}`)
}

/**
 * The one entry point the adapters use: meta when `tool` is `devices`, proxy otherwise.
 *
 * Kept as a dispatcher rather than one branch inside the proxy path so the two never share the
 * "which device" question — a meta call has no device to get wrong.
 */
export async function executeDeviceToolCommand(
  opts: DeviceToolCommandArgs,
): Promise<DeviceToolCommandResult> {
  if (opts.tool === 'devices') return await executeDeviceMetaCommand(opts.fns)
  return await executeDeviceProxyCommand(opts)
}


// ============================================================================
// Claude adapter
// ============================================================================

export interface DeviceToolOptions {
  sessionId: string;
  workspaceRootPath?: string;
  /** Read at execution time — the device list changes as clients connect and leave. */
  getDeviceFns: () => DeviceToolFns | undefined;
}

type ToolResult = {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  isError?: boolean;
};

export function createDeviceTools(options: DeviceToolOptions) {
  return [
    tool(
      'device_tool',
      TOOL_DESCRIPTIONS.device_tool,
      // The same zod-v3/v4 variance bridge `registryTool` uses in session-scoped-tools.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      DeviceToolSchema.shape as any,
      async (input) => {
        const args = input as { tool: DeviceToolName; device?: string; args?: Record<string, unknown> }
        try {
          const fns = options.getDeviceFns();
          if (!fns) {
            return {
              content: [{ type: 'text' as const, text: 'Devices are not available. This tool requires the desktop app connected to a hub.' }],
              isError: true,
            };
          }
          const result = await executeDeviceToolCommand({
            tool: args.tool as DeviceToolName,
            device: args.device,
            args: args.args,
            fns,
            sessionId: options.sessionId,
            workspaceRootPath: options.workspaceRootPath,
          })

          const content: ToolResult['content'] = [{ type: 'text', text: result.output }]
          if (result.image) {
            content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
          }
          for (const image of result.images ?? []) {
            content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
          }
          return { content }
        } catch (error) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          }
        }
      },
    ),
  ];
}
