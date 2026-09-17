import { describe, expect, it } from 'bun:test'
import {
  buildElementMention,
  elementLabel,
  elementOriginText,
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

  it('round-trips the page the element was picked on', () => {
    // The picker is the window's and stays on across its tabs, so this is what
    // tells two picks of the same element apart.
    const marker = buildElementMention({
      selector: '[data-testid="pay"]',
      text: 'Pay now',
      url: 'https://shop.example.com/cart?step=2',
      prototypeSlug: 'checkout',
      prototypePage: 'cart',
    })

    expect(parseElementMention(marker.slice('[element:'.length, -1))).toEqual({
      selector: '[data-testid="pay"]',
      text: 'Pay now',
      url: 'https://shop.example.com/cart?step=2',
      prototypeSlug: 'checkout',
      prototypePage: 'cart',
    })
  })

  it('drops the parts a pick did not carry', () => {
    // The agent's own `browser_tool pick` knows a page but not a prototype: the
    // marker is shorter, and reading it back leaves nothing empty behind.
    const marker = buildElementMention({ selector: '.a', text: 'A', url: 'https://example.com/' })

    expect(marker).toBe('[element:.a|A|https%3A%2F%2Fexample.com%2F]')
    expect(parseElementMention('.a|A|https%3A%2F%2Fexample.com%2F')).toEqual({
      selector: '.a',
      text: 'A',
      url: 'https://example.com/',
    })
  })

  it('still reads a marker written before picks carried an origin', () => {
    expect(parseElementMention('%23submit|Submit')).toEqual({ selector: '#submit', text: 'Submit' })
  })

  it('rejects payloads that are not ours', () => {
    expect(parseElementMention('no-separator')).toBeNull()
    expect(parseElementMention('%E0%A4%A|text')).toBeNull()
  })
})

describe('elementOriginText', () => {
  it('names the prototype and its page, then the address', () => {
    expect(elementOriginText({ selector: '.a', text: 'A', url: 'https://example.com/', prototypeSlug: 'demo', prototypePage: 'cart' }))
      .toBe('demo / cart (https://example.com/)')
  })

  it('names the prototype alone when the page is unknown', () => {
    expect(elementOriginText({ selector: '.a', text: 'A', prototypeSlug: 'demo' })).toBe('demo')
  })

  it('falls back to the address for a page nobody owns', () => {
    expect(elementOriginText({ selector: '.a', text: 'A', url: 'https://example.com/' })).toBe('https://example.com/')
  })

  it('is empty when the pick carried nothing about where it came from', () => {
    expect(elementOriginText({ selector: '.a', text: 'A' })).toBe('')
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
