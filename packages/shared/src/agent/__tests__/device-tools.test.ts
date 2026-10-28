/**
 * `device_tool`'s contract: the device is an argument of the meta-tool, and the nested tool name
 * decides what is asked of it. These tests pin that shape — not the device's own policy, which is
 * enforced on the device and tested there.
 */
import { describe, it, expect } from 'bun:test';
import { executeDeviceMetaCommand, executeDeviceProxyCommand, executeDeviceToolCommand } from '../device-tools.ts';
import type { DeviceToolFns } from '../device-tool.ts';

function makeFns(overrides: Partial<DeviceToolFns> = {}): DeviceToolFns {
  return {
    list: async () => [{
      id: 'dev-1',
      name: 'office-mac',
      platform: 'darwin',
      version: '0.9.3',
      allowedRoots: ['/work'],
      online: true,
      deviceAllows: true,
      available: true,
      offered: { shell: true, files: true, browser: true, computer: true },
      capabilities: { shell: true, files: true, browser: true, computer: true },
    }],
    exec: async () => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      cwd: '/work',
    }),
    fs: async (_device, args) => ({ op: args.op, path: args.path, content: 'hello' }),
    getBrowserFns: async () => {
      throw new Error('not used')
    },
    getComputerFns: async () => {
      throw new Error('not used')
    },
    ...overrides,
  };
}

describe('device_tool', () => {
  it('lists devices without naming one', async () => {
    const result = await executeDeviceToolCommand({
      tool: 'devices',
      fns: makeFns(),
      sessionId: 's1',
    });
    expect(result.output).toContain('office-mac (dev-1)');
    expect(result.output).toContain('v0.9.3');
    expect(result.output).toContain('/work');
  });

  it('refuses a nested tool with no device', async () => {
    await expect(
      executeDeviceToolCommand({
        tool: 'bash',
        args: { command: 'ls' },
        fns: makeFns(),
        sessionId: 's1',
      }),
    ).rejects.toThrow('A device is required');
  });

  it('routes bash to the named device with its arguments', async () => {
    const calls: unknown[] = [];
    const result = await executeDeviceToolCommand({
      tool: 'bash',
      device: 'office-mac',
      args: { command: 'git status', cwd: '/work/repo', timeoutMs: 5000 },
      fns: makeFns({
        exec: async (device, args) => {
          calls.push({ device, args });
          return {
            stdout: 'clean',
            stderr: '',
            exitCode: 0,
            timedOut: false,
            durationMs: 5,
            cwd: args.cwd ?? '/work',
          };
        },
      }),
      sessionId: 's1',
    });
    expect(calls).toEqual([{ device: 'office-mac', args: { command: 'git status', cwd: '/work/repo', timeoutMs: 5000 } }]);
    expect(result.output).toContain('clean');
    expect(result.output).toContain('exit 0');
  });

  it('routes file operations through the fs surface', async () => {
    const result = await executeDeviceToolCommand({
      tool: 'read',
      device: 'dev-1',
      args: { path: '/work/a.txt', offset: 2, limit: 3 },
      fns: makeFns(),
      sessionId: 's1',
    });
    expect(result.output).toBe('hello');
  });

  it('keeps meta and proxy calls apart', async () => {
    const fns = makeFns()
    const meta = await executeDeviceMetaCommand(fns)
    expect(meta.output).toContain('office-mac')

    await expect(
      executeDeviceProxyCommand({ tool: 'devices', device: 'dev-1', fns, sessionId: 's1' }),
    ).rejects.toThrow('meta call')
  });

  it('passes the named device through unchanged — no implicit substitution', async () => {
    const seen: string[] = []
    await executeDeviceProxyCommand({
      tool: 'read',
      device: 'dev-exact-name',
      args: { path: '/work/a.txt' },
      fns: makeFns({
        fs: async (device, args) => {
          seen.push(device)
          return { op: args.op, path: args.path, content: '' }
        },
      }),
      sessionId: 's1',
    })
    expect(seen).toEqual(['dev-exact-name'])
  })
});
