import { describe, it, expect } from 'bun:test';
import { resolveToolName } from '../tool-names.ts';

describe('tool names', () => {
  it('recognizes both wrappers, bare and namespaced', () => {
    expect(resolveToolName('browser_tool')).toBe('browser');
    expect(resolveToolName('prototype_tool')).toBe('prototype');

    // The namespace is not enumerated on purpose: `mcp__workspace__…` and `session__…` are
    // the same tool, and a fourth namespace must not need this file changed.
    expect(resolveToolName('mcp__session__browser_tool')).toBe('browser');
    expect(resolveToolName('mcp__workspace__browser_tool')).toBe('browser');
    expect(resolveToolName('session__browser_tool')).toBe('browser');
    expect(resolveToolName('mcp__session__prototype_tool')).toBe('prototype');
  });

  it('answers browser for the names the browser commands shipped under', () => {
    expect(resolveToolName('browser_open')).toBe('browser');
    expect(resolveToolName('browser_snapshot')).toBe('browser');
    expect(resolveToolName('browser_click_at')).toBe('browser');
    expect(resolveToolName('mcp__session__browser_click_at')).toBe('browser');
  });

  it('returns null for everything else', () => {
    expect(resolveToolName('Read')).toBeNull();
    expect(resolveToolName('Write')).toBeNull();
    expect(resolveToolName('mcp__session__source_test')).toBeNull();
    expect(resolveToolName('')).toBeNull();
    expect(resolveToolName('   ')).toBeNull();
  });

  // A name that merely ends in the wrapper's name behind a single underscore is not the wrapper:
  // `(?:^|__)` is what keeps a tool called `some_browser_tool` out.
  it('does not answer for a name that only looks like one', () => {
    expect(resolveToolName('my_browser_tool')).toBeNull();
    expect(resolveToolName('browser_tool_extra')).toBeNull();
  });
});
