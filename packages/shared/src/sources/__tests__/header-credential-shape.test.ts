import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { SourceCredentialManager } from '../credential-manager.ts';
import { buildHeaders } from '../api-tools.ts';
import { SourceServerBuilder } from '../server-builder.ts';
import type { LoadedSource, FolderSourceConfig } from '../types.ts';

// Regression for OSS #1067: a header-auth source whose credential was stored by
// the multi-header prompt (`{"x-goog-api-key":"…"}`) reached the wire as the
// serialized object because getApiCredential only parsed JSON when the config
// itself listed headerNames.

const KEY = 'AIzaSy' + 'k'.repeat(33);

function source(api: Partial<NonNullable<FolderSourceConfig['api']>>): LoadedSource {
  return {
    config: {
      id: 'gemini',
      slug: 'gemini',
      name: 'Gemini',
      enabled: true,
      provider: 'google-ai',
      type: 'api',
      isAuthenticated: true,
      api: { baseUrl: 'https://generativelanguage.googleapis.com/', authType: 'header', ...api },
    } as FolderSourceConfig,
    guide: null,
    folderPath: '/tmp/ws/sources/gemini',
    workspaceRootPath: '/tmp/ws',
    workspaceId: 'ws',
  };
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function withStored(manager: SourceCredentialManager, value: string) {
  const spy = spyOn(manager, 'load').mockResolvedValue({ value });
  spies.push(spy);
}

describe('getApiCredential for single-header sources', () => {
  const manager = new SourceCredentialManager();
  const builder = new SourceServerBuilder();

  test('JSON-wrapped credential for the configured headerName becomes the bare key on the wire', async () => {
    const src = source({ headerName: 'x-goog-api-key' });
    withStored(manager, JSON.stringify({ 'x-goog-api-key': KEY }));

    const credential = await manager.getApiCredential(src);
    expect(credential).toBe(KEY);

    const headers = buildHeaders(builder.buildApiConfig(src).auth, credential!);
    expect(headers['x-goog-api-key']).toBe(KEY);
  });

  test('JSON credential under another header name is sent under that name', async () => {
    const src = source({ headerName: 'X-API-Key' });
    withStored(manager, JSON.stringify({ 'x-goog-api-key': KEY }));

    const credential = await manager.getApiCredential(src);
    const headers = buildHeaders(builder.buildApiConfig(src).auth, credential!);
    expect(headers['x-goog-api-key']).toBe(KEY);
    expect(headers['X-API-Key']).toBeUndefined();
  });

  test('plain key is unchanged', async () => {
    const src = source({ headerName: 'x-goog-api-key' });
    withStored(manager, KEY);
    expect(await manager.getApiCredential(src)).toBe(KEY);
  });

  test('bearer credentials that look like JSON are never unwrapped', async () => {
    const src = source({ authType: 'bearer' });
    const odd = JSON.stringify({ a: 'b' });
    withStored(manager, odd);
    expect(await manager.getApiCredential(src)).toBe(odd);
  });

  test('buildHeaders unwraps a serialized header map handed to it directly', () => {
    const headers = buildHeaders({ type: 'header', headerName: 'x-goog-api-key' }, JSON.stringify({ 'x-goog-api-key': KEY }));
    expect(headers['x-goog-api-key']).toBe(KEY);
  });
});
