import { describe, expect, it } from 'bun:test';
import { buildSearchQuery } from '../imap.ts';
import { detectProvider, resolveEndpoints } from '../presets.ts';

describe('detectProvider', () => {
  it('maps known consumer domains', () => {
    expect(detectProvider('someone@qq.com')).toBe('qq');
    expect(detectProvider('someone@126.com')).toBe('163');
    expect(detectProvider('someone@outlook.com')).toBe('outlook');
  });

  it('returns undefined for unknown domains', () => {
    expect(detectProvider('someone@example.org')).toBeUndefined();
    expect(detectProvider('not-an-address')).toBeUndefined();
  });
});

describe('resolveEndpoints', () => {
  it('uses the provider preset', () => {
    const resolved = resolveEndpoints({ address: 'a@qq.com' });
    expect(resolved).toEqual({
      imap: { host: 'imap.qq.com', port: 993, secure: true },
      smtp: { host: 'smtp.qq.com', port: 587, secure: false },
    });
  });

  it('infers the port from an explicit TLS choice', () => {
    const resolved = resolveEndpoints({
      address: 'a@example.org',
      imap: { host: 'mail.example.org', secure: false },
      smtp: { host: 'mail.example.org', secure: false },
    });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.imap.port).toBe(143);
    expect(resolved.smtp.port).toBe(587);
  });

  it('keeps a custom port even when the user only changes TLS', () => {
    const resolved = resolveEndpoints({ address: 'a@qq.com', smtp: { secure: true, port: 2465 } });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.smtp).toEqual({ host: 'smtp.qq.com', port: 2465, secure: true });
  });

  it('refuses to guess servers for an unknown provider', () => {
    const resolved = resolveEndpoints({ address: 'a@example.org' });
    expect('error' in resolved).toBe(true);
  });

  it('defaults a custom server to the TLS ports', () => {
    const resolved = resolveEndpoints({
      address: 'a@example.org',
      imap: { host: 'mail.example.org' },
      smtp: { host: 'mail.example.org' },
    });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.imap).toEqual({ host: 'mail.example.org', port: 993, secure: true });
    expect(resolved.smtp).toEqual({ host: 'mail.example.org', port: 465, secure: true });
  });

  it('takes the TLS mode from the port when only a port is given', () => {
    const starttls = resolveEndpoints({
      address: 'a@example.org',
      imap: { host: 'mail.example.org', port: 143 },
      smtp: { host: 'mail.example.org', port: 587 },
    });
    if ('error' in starttls) throw new Error(starttls.error);
    expect(starttls.imap.secure).toBe(false);
    expect(starttls.smtp.secure).toBe(false);

    const tls = resolveEndpoints({
      address: 'a@example.org',
      imap: { host: 'mail.example.org', port: 993 },
      smtp: { host: 'mail.example.org', port: 465 },
    });
    if ('error' in tls) throw new Error(tls.error);
    expect(tls.imap.secure).toBe(true);
    expect(tls.smtp.secure).toBe(true);
  });

  it('treats port 25 as plaintext submission', () => {
    const resolved = resolveEndpoints({
      address: 'a@example.org',
      imap: { host: 'mail.example.org' },
      smtp: { host: 'mail.example.org', port: 25 },
    });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.smtp).toEqual({ host: 'mail.example.org', port: 25, secure: false });
  });

  it('lets an explicit TLS choice win over the port', () => {
    const resolved = resolveEndpoints({
      address: 'a@example.org',
      imap: { host: 'mail.example.org', port: 143, secure: true },
      smtp: { host: 'mail.example.org' },
    });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.imap.secure).toBe(true);
  });

  it('follows a port override on a preset', () => {
    const resolved = resolveEndpoints({ address: 'a@qq.com', smtp: { port: 465 } });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.smtp).toEqual({ host: 'smtp.qq.com', port: 465, secure: true });
  });
});

describe('buildSearchQuery', () => {
  it('defaults to ALL when nothing is specified', () => {
    expect(buildSearchQuery({})).toEqual({ all: true });
  });

  it('maps unread to seen:false and keeps date bounds', () => {
    const since = new Date('2026-01-01T00:00:00Z');
    expect(buildSearchQuery({ unseen: true, since })).toEqual({ seen: false, since });
  });
});
