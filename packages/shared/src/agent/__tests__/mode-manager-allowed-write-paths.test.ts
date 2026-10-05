import { describe, it, expect } from 'bun:test';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { matchesAllowedWritePath } from '../../agent/mode-manager.ts';

// The matcher is shared by Explore mode (shouldAllowToolInMode) and Ask mode
// (core/pre-tool-use.ts:shouldPromptInAskMode) since OSS #1065; both modes must
// agree on what "inside the allowlist" means.
//
// Paths are built from the filesystem root with `join`, so the expectations hold
// on Windows too: there an absolute path carries a drive prefix that the matcher
// keeps (it resolves both the path and the pattern through the same normalizer).
const ROOT = resolve('/');
const OUT = join(ROOT, 'tmp', 'out');
const SITE = join(ROOT, 'srv', 'site');

describe('matchesAllowedWritePath', () => {
  it('matches nested paths under a /** glob', () => {
    expect(matchesAllowedWritePath(join(OUT, 'a', 'b.txt'), [join(OUT, '**')])).toBe(true);
    expect(matchesAllowedWritePath(join(OUT, 'a.txt'), [join(OUT, '**')])).toBe(true);
  });

  it('does not match a sibling directory that shares the prefix', () => {
    expect(matchesAllowedWritePath(join(ROOT, 'tmp', 'output', 'a.txt'), [join(OUT, '**')])).toBe(false);
  });

  it('expands ~ in patterns', () => {
    expect(matchesAllowedWritePath(join(homedir(), '.craft-agent', 'x.json'), ['~/.craft-agent/**'])).toBe(true);
  });

  it('checks every pattern and ignores invalid ones', () => {
    expect(matchesAllowedWritePath(join(SITE, 'index.html'), [join(ROOT, 'tmp', '**'), join(SITE, '**')])).toBe(true);
    expect(matchesAllowedWritePath(join(SITE, 'index.html'), [join(ROOT, 'tmp', '**')])).toBe(false);
    expect(matchesAllowedWritePath(join(SITE, 'index.html'), [])).toBe(false);
  });
});
