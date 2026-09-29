import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import { buildDarwinSandboxProfile } from './filesystem-isolation.ts';

/**
 * The path as the profile states it.
 *
 * The builder `resolve`s the session directory, so the string depends on the platform
 * (`/tmp/x` becomes `C:\tmp\x` on Windows) — `sandbox-exec` only ever runs on macOS, but this
 * test runs wherever the suite does, so it has to derive the same path rather than spell a
 * POSIX one. Backslashes are then doubled, which is how the profile quotes a path.
 */
function quotedPathIn(sessionDir: string): string {
  return resolve(sessionDir).replace(/\\/g, '\\\\');
}

describe('buildDarwinSandboxProfile', () => {
  it('includes session subpath write allow', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session');
    expect(profile).toContain(`(allow file-write* (subpath "${quotedPathIn('/tmp/craft-session')}"))`);
    expect(profile).not.toContain('(deny network*)');
  });

  it('includes deny network when requested', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session', { includeNetworkDeny: true });
    expect(profile).toContain('(deny network*)');
  });
});
