import { describe, expect, it } from 'bun:test'
import {
  buildElementMention,
  elementLabel,
  expandElementMentions,
  findElementMentions,
  parseElementMention,
} from '../element-mention'

const format = (ref: { selector: string; text: string }) =>
  `[Mentioned element: ${ref.selector} ("${ref.text}")]`

describe('buildElementMention / parseElementMention', () => {
  it('round-trips a plain reference', () => {
    const marker = buildElementMention({ selector: '#submit', text: 'Submit' })
    const payload = marker.slice('[element:'.length, -1)

    expect(parseElementMention(payload)).toEqual({ selector: '#submit', text: 'Submit' })
  })

  it('keeps selectors with brackets and quotes intact', () => {
    // Attribute selectors are common (buildStableSelector prefers data-testid) and
    // their brackets would otherwise end the marker early.
    const selector = 'div[data-testid="card"] > span:nth-of-type(2)'
    const marker = buildElementMention({ selector, text: 'Total: 42' })

    expect(marker.match(/\]/g)).toHaveLength(1)
    expect(findElementMentions(`see ${marker} there`)[0]?.ref).toEqual({ selector, text: 'Total: 42' })
  })

  it('keeps text containing the separator and closing brackets intact', () => {
    const marker = buildElementMention({ selector: '.a', text: 'a|b] c' })

    expect(findElementMentions(marker)[0]?.ref).toEqual({ selector: '.a', text: 'a|b] c' })
  })

  it('round-trips an element with no text', () => {
    const marker = buildElementMention({ selector: 'svg.icon', text: '' })

    expect(findElementMentions(marker)[0]?.ref).toEqual({ selector: 'svg.icon', text: '' })
  })

  it('rejects payloads that are not ours', () => {
    expect(parseElementMention('no-separator')).toBeNull()
    expect(parseElementMention('%E0%A4%A|text')).toBeNull()
  })
})

describe('findElementMentions', () => {
  it('finds markers anywhere in the text, in order', () => {
    const first = buildElementMention({ selector: '.a', text: 'A' })
    const second = buildElementMention({ selector: '.b', text: 'B' })
    const found = findElementMentions(`start ${first} middle ${second} end`)

    expect(found.map(m => m.ref.selector)).toEqual(['.a', '.b'])
    expect(found[1]?.startIndex).toBeGreaterThan(found[0]!.startIndex)
  })

  it('ignores a malformed marker instead of rendering a chip for it', () => {
    expect(findElementMentions('see [element:broken] here')).toEqual([])
  })

  it('does not match other mention kinds', () => {
    expect(findElementMentions('[file:src/a.ts] [folder:src]')).toEqual([])
  })
})

describe('elementLabel', () => {
  it('prefers what the element says over its selector', () => {
    expect(elementLabel({ selector: '#submit', text: 'Submit' })).toBe('Submit')
  })

  it('falls back to the selector for an element with no text', () => {
    expect(elementLabel({ selector: 'svg.icon', text: '' })).toBe('svg.icon')
  })
})

describe('expandElementMentions', () => {
  it('replaces a marker with the reference the model reads', () => {
    const marker = buildElementMention({ selector: '#submit', text: 'Submit' })

    expect(expandElementMentions(`改一下 ${marker}`, format))
      .toBe('改一下 [Mentioned element: #submit ("Submit")]')
  })

  it('leaves the user text around the marker untouched', () => {
    const marker = buildElementMention({ selector: '.a', text: 'A' })
    expect(expandElementMentions(`before ${marker} after`, format))
      .toBe('before [Mentioned element: .a ("A")] after')
  })

  it('expands every marker', () => {
    const text = `${buildElementMention({ selector: '.a', text: 'A' })} and ${buildElementMention({ selector: '.b', text: 'B' })}`
    expect(expandElementMentions(text, format))
      .toBe('[Mentioned element: .a ("A")] and [Mentioned element: .b ("B")]')
  })

  it('leaves text with no markers byte-identical', () => {
    expect(expandElementMentions('just a question', format)).toBe('just a question')
  })

  it('leaves a malformed marker visible rather than dropping it', () => {
    expect(expandElementMentions('see [element:broken] here', format))
      .toBe('see [element:broken] here')
  })
})
