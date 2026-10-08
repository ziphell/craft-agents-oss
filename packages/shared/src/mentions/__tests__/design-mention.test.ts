/**
 * Design mentions — the marker `[design:<slug>|<name>]` the composer inserts, and the reference
 * the agent rewrites it into at the model boundary.
 *
 * The marker itself has to survive to the store (so the sent chip can be redrawn from it), so
 * these tests cover both halves: reading it back, and getting the model-facing sentence out.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildDesignMention,
  designLabel,
  findDesignMentions,
  parseDesignMention,
  resolveDesignMentions,
} from '../design-mention.ts'

describe('buildDesignMention / parseDesignMention', () => {
  it('round-trips a plain design', () => {
    const marker = buildDesignMention({ slug: 'cart', name: 'Cart' })
    const payload = marker.slice('[design:'.length, -1)

    expect(parseDesignMention(payload)).toEqual({ slug: 'cart', name: 'Cart' })
  })

  it('keeps a name containing the separator and brackets intact', () => {
    // Both are percent-encoded precisely because a name may carry both, and the marker
    // ends at the first `]` if it is not.
    const name = 'A|B]C'
    const marker = buildDesignMention({ slug: 'cart', name })

    expect(marker.match(/\]/g)).toHaveLength(1)
    expect(findDesignMentions(`see ${marker} there`)[0]?.ref).toEqual({ slug: 'cart', name })
  })

  it('round-trips a design with no name', () => {
    const marker = buildDesignMention({ slug: 'cart', name: '' })

    expect(findDesignMentions(marker)[0]?.ref).toEqual({ slug: 'cart', name: '' })
  })

  it('drops the parts a design did not carry', () => {
    const marker = buildDesignMention({ slug: 'cart', name: 'Cart' })

    expect(marker).toBe('[design:cart|Cart]')
    expect(parseDesignMention('cart|Cart')).toEqual({ slug: 'cart', name: 'Cart' })
  })

  it('rejects payloads that are not ours', () => {
    expect(parseDesignMention('no-separator')).toBeNull()
    expect(parseDesignMention('%E0%A4%A|Name')).toBeNull()
    expect(parseDesignMention('|Name')).toBeNull()
  })
})

describe('designLabel', () => {
  it('prefers the design name over its slug', () => {
    expect(designLabel({ slug: 'cart', name: 'Cart' })).toBe('Cart')
  })

  it('falls back to the slug for a design that has no name', () => {
    expect(designLabel({ slug: 'cart', name: '' })).toBe('cart')
  })
})

describe('findDesignMentions', () => {
  it('finds markers anywhere in the text, in order', () => {
    const first = buildDesignMention({ slug: 'a', name: 'A' })
    const second = buildDesignMention({ slug: 'b', name: 'B' })
    const found = findDesignMentions(`start ${first} middle ${second} end`)

    expect(found.map(m => m.ref.name)).toEqual(['A', 'B'])
    expect(found[1]?.startIndex).toBeGreaterThan(found[0]!.startIndex)
  })

  it('ignores a malformed marker instead of rendering a chip for it', () => {
    expect(findDesignMentions('see [design:broken] here')).toEqual([])
  })

  it('does not match other mention kinds', () => {
    expect(findDesignMentions('[file:src/a.ts] [tab:https%3A%2F%2Fa.example%2F|A]')).toEqual([])
  })
})

describe('resolveDesignMentions', () => {
  it('rewrites a marker into the reference the model reads', () => {
    const marker = buildDesignMention({ slug: 'cart', name: 'Cart' })

    expect(resolveDesignMentions(`看看 ${marker}`))
      .toBe('看看 [Mentioned design: Cart (slug: cart)]')
  })

  it('names the slug when the design has no name', () => {
    const marker = buildDesignMention({ slug: 'cart', name: '' })

    expect(resolveDesignMentions(marker)).toBe('[Mentioned design: cart (slug: cart)]')
  })

  it('leaves the user text around the marker untouched', () => {
    const marker = buildDesignMention({ slug: 'cart', name: 'Cart' })
    expect(resolveDesignMentions(`before ${marker} after`))
      .toBe('before [Mentioned design: Cart (slug: cart)] after')
  })

  it('rewrites every marker', () => {
    const text = `${buildDesignMention({ slug: 'a', name: 'A' })} and ${buildDesignMention({ slug: 'b', name: 'B' })}`
    expect(resolveDesignMentions(text))
      .toBe('[Mentioned design: A (slug: a)] and [Mentioned design: B (slug: b)]')
  })

  it('leaves text with no markers byte-identical', () => {
    expect(resolveDesignMentions('just a question')).toBe('just a question')
  })

  it('leaves a malformed marker visible rather than dropping it', () => {
    expect(resolveDesignMentions('see [design:broken] here')).toBe('see [design:broken] here')
  })
})
