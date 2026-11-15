import { describe, expect, it } from 'bun:test'
import { minimalChange } from '../minimal-change'

/** Applying a change to a string, so the tests can assert round trips rather than offsets. */
function apply(source: string, change: { from: number; to: number; insert: string }): string {
  return source.slice(0, change.from) + change.insert + source.slice(change.to)
}

describe('minimalChange', () => {
  it('costs nothing when nothing changed', () => {
    expect(minimalChange('same text', 'same text')).toEqual({ from: 0, to: 0, insert: '' })
  })

  it('replaces one word in the middle', () => {
    const before = 'the quick brown fox'
    const change = minimalChange(before, 'the quick red fox')
    expect(change).toEqual({ from: 10, to: 15, insert: 'red' })
    expect(apply(before, change)).toBe('the quick red fox')
  })

  it('inserts at the end', () => {
    const change = minimalChange('alpha', 'alpha beta')
    expect(change).toEqual({ from: 5, to: 5, insert: ' beta' })
  })

  it('deletes a prefix', () => {
    const change = minimalChange('# title\nbody', 'body')
    expect(apply('# title\nbody', change)).toBe('body')
  })

  it('handles a deletion that eats the whole string', () => {
    const change = minimalChange('everything', '')
    expect(apply('everything', change)).toBe('')
  })

  it('handles two versions with no common prefix or suffix', () => {
    const change = minimalChange('aaa', 'bbb')
    expect(change).toEqual({ from: 0, to: 3, insert: 'bbb' })
  })

  it('does not let the suffix walk back into the prefix', () => {
    // "abc" → "ab": the prefix pass consumes both characters; a suffix pass would ask for a
    // negative-length replacement.
    const change = minimalChange('abc', 'ab')
    expect(change.to).toBeGreaterThanOrEqual(change.from)
    expect(apply('abc', change)).toBe('ab')
  })

  it('round-trips an outside write into the middle of a long document', () => {
    const before = 'one\ntwo\nthree\nfour\nfive'
    const after = before.replace('three', 'THREE')
    expect(apply(before, minimalChange(before, after))).toBe(after)
    // And the change is small, which is the point: the caret above it survives.
    const change = minimalChange(before, after)
    expect(change.to - change.from).toBeLessThan(10)
  })
})
