/**
 * Tab mentions — the marker `[tab:<url>|<title>|<tabId>]` the composer inserts, and the
 * reference the agent rewrites it into at the model boundary.
 *
 * The marker itself has to survive to the store (so the sent chip can be redrawn from it), so
 * these tests cover both halves: reading it back, and getting the model-facing sentence out.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildTabMention,
  findTabMentions,
  parseTabMention,
  resolveTabMentions,
  tabLabel,
} from '../tab-mention.ts'

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

  it('drops the parts a tab did not carry', () => {
    const marker = buildTabMention({ url: 'https://example.com/', title: 'Example' })

    expect(marker).toBe('[tab:https%3A%2F%2Fexample.com%2F|Example]')
    expect(parseTabMention('https%3A%2F%2Fexample.com%2F|Example')).toEqual({
      url: 'https://example.com/',
      title: 'Example',
    })
  })

  it('round-trips the tab the reference is pointed with', () => {
    // The address says where the reader is standing; the id is the only part a
    // command can be pointed with (`--tab <id>`), so a tab mention carries both.
    const marker = buildTabMention({ url: 'https://example.com/cart', title: 'Cart', tabId: '12' })

    expect(marker).toBe('[tab:https%3A%2F%2Fexample.com%2Fcart|Cart|12]')
    expect(parseTabMention(marker.slice('[tab:'.length, -1))).toEqual({
      url: 'https://example.com/cart',
      title: 'Cart',
      tabId: '12',
    })
  })

  it('keeps the id in its place for a tab with no title', () => {
    const marker = buildTabMention({ url: 'about:blank', title: '', tabId: '7' })

    expect(marker).toBe('[tab:about%3Ablank||7]')
    expect(parseTabMention(marker.slice('[tab:'.length, -1))).toEqual({
      url: 'about:blank',
      title: '',
      tabId: '7',
    })
  })

  it('still reads a marker written before tabs carried an id', () => {
    expect(parseTabMention('about%3Ablank|')).toEqual({ url: 'about:blank', title: '' })
  })

  it('rejects payloads that are not ours', () => {
    expect(parseTabMention('no-separator')).toBeNull()
    expect(parseTabMention('%E0%A4%A|title')).toBeNull()
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

describe('resolveTabMentions', () => {
  it('rewrites a marker into the reference the model reads', () => {
    const marker = buildTabMention({ url: 'https://example.com/cart', title: 'Cart' })

    expect(resolveTabMentions(`看看 ${marker}`))
      .toBe('看看 [Mentioned tab: Cart (https://example.com/cart)]')
  })

  it('names the tab by id, so a command can be pointed at it', () => {
    const marker = buildTabMention({ url: 'https://example.com/cart', title: 'Cart', tabId: '12' })

    expect(resolveTabMentions(`看看 ${marker}`))
      .toBe('看看 [Mentioned tab: Cart (tab 12, https://example.com/cart)]')
  })

  it('names the address when the title says nothing', () => {
    const marker = buildTabMention({ url: 'about:blank', title: '' })

    expect(resolveTabMentions(marker)).toBe('[Mentioned tab: about:blank (about:blank)]')
  })

  it('leaves the user text around the marker untouched', () => {
    const marker = buildTabMention({ url: 'https://example.com/', title: 'Example' })
    expect(resolveTabMentions(`before ${marker} after`))
      .toBe('before [Mentioned tab: Example (https://example.com/)] after')
  })

  it('rewrites every marker', () => {
    const text = `${buildTabMention({ url: 'https://a.example/', title: 'A' })} and ${buildTabMention({ url: 'https://b.example/', title: 'B' })}`
    expect(resolveTabMentions(text))
      .toBe('[Mentioned tab: A (https://a.example/)] and [Mentioned tab: B (https://b.example/)]')
  })

  it('leaves text with no markers byte-identical', () => {
    expect(resolveTabMentions('just a question')).toBe('just a question')
  })

  it('leaves a malformed marker visible rather than dropping it', () => {
    expect(resolveTabMentions('see [tab:broken] here')).toBe('see [tab:broken] here')
  })
})
