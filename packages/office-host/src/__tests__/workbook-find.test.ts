import { describe, it, expect } from 'bun:test'
import { wildcardMatcher } from '../workbook'

/**
 * Find's matching rules, which are the only part of `findWorkbookCells` that is not a sidecar call.
 *
 * Excel's wildcards are not regular expressions: `*` is any run, `?` is one character, and `~` is how
 * a person searches for a literal one. Getting that wrong turns "find 2025-*" into a search for the
 * word "2025-" plus a regex quantifier.
 */
describe('find wildcards', () => {
  it('treats * as any run and ? as one character', () => {
    expect(wildcardMatcher('2025-*', false, false)('2025-Q1')).toBe(true)
    // Unanchored, `?` only has to match *somewhere* — Excel's Find is a contains unless the whole
    // cell is required, which is the next case.
    expect(wildcardMatcher('2025-?', false, false)('2025-Q1')).toBe(true)
    expect(wildcardMatcher('2025-?', false, true)('2025-Q1')).toBe(false)
    expect(wildcardMatcher('2025-??', false, true)('2025-Q1')).toBe(true)
  })

  it('anchors when the whole cell must match', () => {
    expect(wildcardMatcher('2025', false, true)('2025')).toBe(true)
    expect(wildcardMatcher('2025', false, true)('2025-Q1')).toBe(false)
    // …and an asterisk still spans the rest
    expect(wildcardMatcher('2025*', false, true)('2025-Q1')).toBe(true)
  })

  it('ignores case unless asked not to', () => {
    expect(wildcardMatcher('q1', false, false)('2025-Q1')).toBe(true)
    expect(wildcardMatcher('q1', true, false)('2025-Q1')).toBe(false)
  })

  it('escapes the characters that are not wildcards', () => {
    expect(wildcardMatcher('a.b', false, true)('a.b')).toBe(true)
    expect(wildcardMatcher('a.b', false, true)('axb')).toBe(false)
    expect(wildcardMatcher('a(b', false, true)('a(b')).toBe(true)
  })

  it('lets ~ search for a literal star or question mark', () => {
    expect(wildcardMatcher('50~%', false, true)('50%')).toBe(true)
    expect(wildcardMatcher('~*', false, true)('*')).toBe(true)
    expect(wildcardMatcher('~*', false, true)('anything')).toBe(false)
  })
})
