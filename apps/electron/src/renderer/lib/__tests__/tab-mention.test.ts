import { describe, expect, it } from 'bun:test'
import {
  buildTabMention,
  expandTabMentions,
  findTabMentions,
  parseTabMention,
  tabLabel,
  tabOriginText,
} from '../tab-mention'

const format = (ref: { url: string; title: string }) =>
  `[Mentioned tab: "${ref.title}" (${ref.url})]`

describe('buildTabMention / parseTabMention', () => {
  it('round-trips a plain tab', () => {
    const marker = buildTabMention({ url: 'https://example.com/cart', title: 'Cart' })
    const payload = marker.slice('[tab:'.length, -1)

    expect(parseTabMention(payload)).toEqual({ url: 'https://example.com/cart', title: 'Cart' })
  })

  it('keeps an address containing brackets and the separator intact', () => {
    // The URL is percent-encoded precisely because a query string may carry both,
    // and the marker ends at the first `]` if it is not.
    const url = 'https://example.com/search?q=a|b]c&x=1'
    const marker = buildTabMention({ url, title: 'Search' })

    expect(marker.match(/\]/g)).toHaveLength(1)
    expect(findTabMentions(`see ${marker} there`)[0]?.ref).toEqual({ url, title: 'Search' })
  })

  it('round-trips a tab with no title', () => {
    const marker = buildTabMention({ url: 'about:blank', title: '' })

    expect(findTabMentions(marker)[0]?.ref).toEqual({ url: 'about:blank', title: '' })
  })

  it('round-trips the prototype the tab belongs to', () => {
    const marker = buildTabMention({
      url: 'https://demo-1a2b.localhost/',
      title: 'Cart',
      prototypeSlug: 'demo',
      prototypePage: 'cart',
    })

    expect(parseTabMention(marker.slice('[tab:'.length, -1))).toEqual({
      url: 'https://demo-1a2b.localhost/',
      title: 'Cart',
      prototypeSlug: 'demo',
      prototypePage: 'cart',
    })
  })

  it('drops the parts a tab did not carry', () => {
    const marker = buildTabMention({ url: 'https://example.com/', title: 'Example' })

    expect(marker).toBe('[tab:https%3A%2F%2Fexample.com%2F|Example]')
    expect(parseTabMention('https%3A%2F%2Fexample.com%2F|Example')).toEqual({
      url: 'https://example.com/',
      title: 'Example',
    })
  })

  it('rejects payloads that are not ours', () => {
    expect(parseTabMention('no-separator')).toBeNull()
    expect(parseTabMention('%E0%A4%A|title')).toBeNull()
  })
})

describe('tabOriginText', () => {
  it('names the prototype and its page', () => {
    expect(tabOriginText({ url: 'https://x/', title: 'Cart', prototypeSlug: 'demo', prototypePage: 'cart' }))
      .toBe('demo / cart')
  })

  it('names the prototype alone when the page is unknown', () => {
    expect(tabOriginText({ url: 'https://x/', title: 'Cart', prototypeSlug: 'demo' })).toBe('demo')
  })

  it('is empty for a tab nobody owns', () => {
    expect(tabOriginText({ url: 'https://example.com/', title: 'Example' })).toBe('')
  })
})

describe('tabLabel', () => {
  it('prefers the tab title over its address', () => {
    expect(tabLabel({ url: 'https://example.com/', title: 'Example' })).toBe('Example')
  })

  it('falls back to the address for a tab that has no title', () => {
    expect(tabLabel({ url: 'about:blank', title: '' })).toBe('about:blank')
  })
})

describe('findTabMentions', () => {
  it('finds markers anywhere in the text, in order', () => {
    const first = buildTabMention({ url: 'https://a.example/', title: 'A' })
    const second = buildTabMention({ url: 'https://b.example/', title: 'B' })
    const found = findTabMentions(`start ${first} middle ${second} end`)

    expect(found.map(m => m.ref.title)).toEqual(['A', 'B'])
    expect(found[1]?.startIndex).toBeGreaterThan(found[0]!.startIndex)
  })

  it('ignores a malformed marker instead of rendering a chip for it', () => {
    expect(findTabMentions('see [tab:broken] here')).toEqual([])
  })

  it('does not match other mention kinds', () => {
    expect(findTabMentions('[file:src/a.ts] [element:.a|A]')).toEqual([])
  })
})

describe('expandTabMentions', () => {
  it('replaces a marker with the reference the model reads', () => {
    const marker = buildTabMention({ url: 'https://example.com/cart', title: 'Cart' })

    expect(expandTabMentions(`看看 ${marker}`, format))
      .toBe('看看 [Mentioned tab: "Cart" (https://example.com/cart)]')
  })

  it('leaves the user text around the marker untouched', () => {
    const marker = buildTabMention({ url: 'https://example.com/', title: 'Example' })
    expect(expandTabMentions(`before ${marker} after`, format))
      .toBe('before [Mentioned tab: "Example" (https://example.com/)] after')
  })

  it('expands every marker', () => {
    const text = `${buildTabMention({ url: 'https://a.example/', title: 'A' })} and ${buildTabMention({ url: 'https://b.example/', title: 'B' })}`
    expect(expandTabMentions(text, format))
      .toBe('[Mentioned tab: "A" (https://a.example/)] and [Mentioned tab: "B" (https://b.example/)]')
  })

  it('leaves text with no markers byte-identical', () => {
    expect(expandTabMentions('just a question', format)).toBe('just a question')
  })

  it('leaves a malformed marker visible rather than dropping it', () => {
    expect(expandTabMentions('see [tab:broken] here', format))
      .toBe('see [tab:broken] here')
  })
})
