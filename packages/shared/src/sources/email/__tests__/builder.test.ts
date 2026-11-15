import { describe, expect, it } from 'bun:test';
import { SourceServerBuilder } from '../../server-builder.ts';
import type { LoadedSource } from '../../types.ts';

function makeSource(email: Partial<NonNullable<LoadedSource['config']['email']>>): LoadedSource {
  return {
    config: {
      id: 'mail_test',
      name: 'Test mailbox',
      slug: 'mail',
      enabled: true,
      provider: '163',
      type: 'email',
      email: { address: 'me@163.com', ...email },
    },
    guide: null,
    folderPath: '/tmp/sources/mail',
    workspaceRootPath: '/tmp',
    workspaceId: 'ws',
  };
}

describe('SourceServerBuilder.buildEmailServer', () => {
  const builder = new SourceServerBuilder();

  it('needs a credential before building the server', () => {
    expect(builder.buildEmailServer(makeSource({}), null)).toBeNull();
    expect(builder.buildEmailServer(makeSource({}), { user: 'me@163.com', pass: '' })).toBeNull();
  });

  it('builds an in-process server for a known provider', () => {
    const server = builder.buildEmailServer(makeSource({}), { user: 'me@163.com', pass: 'code' });
    expect(server).not.toBeNull();
    expect((server as { type?: string }).type).toBe('sdk');
  });

  it('refuses to guess servers for an unknown provider', () => {
    expect(() =>
      builder.buildEmailServer(makeSource({ address: 'me@example.org', provider: undefined }), {
        user: 'me@example.org',
        pass: 'code',
      })
    ).toThrow(/Unknown email provider/);
  });

  it('accepts explicit hosts for an unknown provider', () => {
    const server = builder.buildEmailServer(
      makeSource({
        address: 'me@example.org',
        imap: { host: 'imap.example.org' },
        smtp: { host: 'smtp.example.org' },
      }),
      { user: 'me@example.org', pass: 'code' }
    );
    expect(server).not.toBeNull();
  });
});
