import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveScriptRuntime } from './resolve-script-runtime.ts';

describe('resolveScriptRuntime', () => {
  it('prefers CRAFT_UV for python3', () => {
    const prev = process.env.CRAFT_UV;
    process.env.CRAFT_UV = '/tmp/custom-uv';

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-uv');
      expect(resolved.argsPrefix).toEqual(['run', '--python', '3.12']);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.CRAFT_UV;
      else process.env.CRAFT_UV = prev;
    }
  });

  it('prefers bundled uv when env is missing', () => {
    const prevUv = process.env.CRAFT_UV;
    delete process.env.CRAFT_UV;

    const base = mkdtempSync(join(tmpdir(), 'runtime-resolver-'));
    const uvPath = join(base, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
    mkdirSync(join(base, 'resources', 'bin', `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(uvPath, '');

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: true, resourcesBasePath: base });
      expect(resolved.command).toBe(uvPath);
      expect(resolved.source).toBe('bundled');
    } finally {
      if (prevUv === undefined) delete process.env.CRAFT_UV;
      else process.env.CRAFT_UV = prevUv;
    }
  });

  it('blocks PATH fallback in packaged mode', () => {
    const prevUv = process.env.CRAFT_UV;
    const prevBase = process.env.CRAFT_RESOURCES_BASE;
    const prevRoot = process.env.CRAFT_APP_ROOT;
    delete process.env.CRAFT_UV;
    delete process.env.CRAFT_RESOURCES_BASE;
    delete process.env.CRAFT_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('python3', { isPackaged: true })).toThrow(
        'packaged app'
      );
    } finally {
      if (prevUv === undefined) delete process.env.CRAFT_UV;
      else process.env.CRAFT_UV = prevUv;
      if (prevBase === undefined) delete process.env.CRAFT_RESOURCES_BASE;
      else process.env.CRAFT_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.CRAFT_APP_ROOT;
      else process.env.CRAFT_APP_ROOT = prevRoot;
    }
  });

  it('rejects bare CRAFT_NODE command in packaged mode', () => {
    const prev = process.env.CRAFT_NODE;
    process.env.CRAFT_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node', { isPackaged: true })).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prev === undefined) delete process.env.CRAFT_NODE;
      else process.env.CRAFT_NODE = prev;
    }
  });

  it('rejects bun in packaged mode when no Bun is available', () => {
    const prevBun = process.env.CRAFT_BUN;
    const prevBase = process.env.CRAFT_RESOURCES_BASE;
    const prevRoot = process.env.CRAFT_APP_ROOT;
    delete process.env.CRAFT_BUN;
    delete process.env.CRAFT_RESOURCES_BASE;
    delete process.env.CRAFT_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('bun', { isPackaged: true })).toThrow(
        'Bun runtime unavailable'
      );
    } finally {
      if (prevBun === undefined) delete process.env.CRAFT_BUN;
      else process.env.CRAFT_BUN = prevBun;
      if (prevBase === undefined) delete process.env.CRAFT_RESOURCES_BASE;
      else process.env.CRAFT_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.CRAFT_APP_ROOT;
      else process.env.CRAFT_APP_ROOT = prevRoot;
    }
  });

  it('falls back to Bun for node when no Node is available', () => {
    const prevNode = process.env.CRAFT_NODE;
    const prevBun = process.env.CRAFT_BUN;
    const prevBase = process.env.CRAFT_RESOURCES_BASE;
    const prevRoot = process.env.CRAFT_APP_ROOT;
    delete process.env.CRAFT_NODE;
    process.env.CRAFT_BUN = process.execPath;
    delete process.env.CRAFT_RESOURCES_BASE;
    delete process.env.CRAFT_APP_ROOT;

    try {
      const resolved = resolveScriptRuntime('node', { isPackaged: true });
      expect(resolved.command).toBe(process.execPath);
      expect(resolved.argsPrefix).toEqual([]);
      expect(resolved.source).toBe('env');
    } finally {
      if (prevNode === undefined) delete process.env.CRAFT_NODE;
      else process.env.CRAFT_NODE = prevNode;
      if (prevBun === undefined) delete process.env.CRAFT_BUN;
      else process.env.CRAFT_BUN = prevBun;
      if (prevBase === undefined) delete process.env.CRAFT_RESOURCES_BASE;
      else process.env.CRAFT_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.CRAFT_APP_ROOT;
      else process.env.CRAFT_APP_ROOT = prevRoot;
    }
  });

  it('rejects node in packaged mode when neither Node nor Bun is available', () => {
    const prevNode = process.env.CRAFT_NODE;
    const prevBun = process.env.CRAFT_BUN;
    const prevBase = process.env.CRAFT_RESOURCES_BASE;
    const prevRoot = process.env.CRAFT_APP_ROOT;
    delete process.env.CRAFT_NODE;
    delete process.env.CRAFT_BUN;
    delete process.env.CRAFT_RESOURCES_BASE;
    delete process.env.CRAFT_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('node', { isPackaged: true })).toThrow(
        'No JavaScript runtime'
      );
    } finally {
      if (prevNode === undefined) delete process.env.CRAFT_NODE;
      else process.env.CRAFT_NODE = prevNode;
      if (prevBun === undefined) delete process.env.CRAFT_BUN;
      else process.env.CRAFT_BUN = prevBun;
      if (prevBase === undefined) delete process.env.CRAFT_RESOURCES_BASE;
      else process.env.CRAFT_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.CRAFT_APP_ROOT;
      else process.env.CRAFT_APP_ROOT = prevRoot;
    }
  });

  it('prefers CRAFT_BUN for bun in dev', () => {
    const prev = process.env.CRAFT_BUN;
    process.env.CRAFT_BUN = '/tmp/custom-bun';

    try {
      const resolved = resolveScriptRuntime('bun', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-bun');
      expect(resolved.argsPrefix).toEqual([]);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.CRAFT_BUN;
      else process.env.CRAFT_BUN = prev;
    }
  });
});
