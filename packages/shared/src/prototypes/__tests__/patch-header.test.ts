import { describe, expect, it } from 'bun:test'
import { extractPatchHeader, extractPatchTargets, extractRequirementIds } from '../patch-header'

/**
 * The markers a patch carries about itself (plan §21.1). Both are read from the
 * *text* of the file, so every case here is a spelling an author might write.
 */
describe('extractPatchTargets', () => {
  it('reads a selector out of a css comment', () => {
    expect(extractPatchTargets('/* @target .pay-btn */\n.pay-btn { color: red }')).toEqual(['.pay-btn'])
  })

  it('reads one out of a js comment', () => {
    expect(extractPatchTargets('// @target [data-role="total"]\ndocument.title = "x"')).toEqual([
      '[data-role="total"]',
    ])
  })

  it('keeps a selector that contains spaces', () => {
    expect(extractPatchTargets('/* @target form > div:nth-child(2) button */')).toEqual([
      'form > div:nth-child(2) button',
    ])
  })

  it('accepts a separator after the marker, and quotes around the value', () => {
    expect(extractPatchTargets('/* @target: .a */')).toEqual(['.a'])
    expect(extractPatchTargets('/* @target = `.b` */')).toEqual(['.b'])
    expect(extractPatchTargets('/* @target ".c" */')).toEqual(['.c'])
  })

  /**
   * A consolidated file carries the markers of everything it folded, so the list
   * is not a convenience — one marker per line is what keeps the anchors of the
   * patches it replaced alive (§21.3).
   */
  it('collects several markers, in order, without duplicates', () => {
    const source = '/* @target .a\n   @target .b\n   @target .a */'
    expect(extractPatchTargets(source)).toEqual(['.a', '.b'])
  })

  it('treats a note to self as no declaration at all', () => {
    expect(extractPatchTargets('/* @target TBD */')).toEqual([])
    expect(extractPatchTargets('/* @target */')).toEqual([])
    expect(extractPatchTargets('.btn { color: red }')).toEqual([])
  })

  it('ignores a marker that is part of a word', () => {
    expect(extractPatchTargets('/* not-a-@target-marker */')).toEqual([])
  })
})

describe('extractPatchHeader', () => {
  it('reads both markers of one patch', () => {
    const source = ['/* @requirement R-1', '   @target .pay-btn */', '.pay-btn { color: red }'].join('\n')
    expect(extractPatchHeader(source)).toEqual({ requirements: ['R-001'], targets: ['.pay-btn'] })
  })

  it('is empty rather than wrong when a patch declares nothing', () => {
    expect(extractPatchHeader('.btn { color: red }')).toEqual({ requirements: [], targets: [] })
  })

  // The two parsers are separate on purpose: an id someone is still deciding on
  // must not be invented, and a selector anyone can check must not be lost.
  it('keeps the requirement parser tolerant of an undecided id', () => {
    expect(extractRequirementIds('/* @requirement TBD */')).toEqual([])
  })
})
