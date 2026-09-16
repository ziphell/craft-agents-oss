import { describe, it, expect } from 'bun:test'
import { isEscapeDuringComposition, textToHTML } from '../rich-text-input'
import { buildElementMention } from '@/lib/element-mention'

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})

describe('textToHTML - element chips', () => {
  it('renders an element marker as a chip labelled with what the element says', () => {
    const marker = buildElementMention({ selector: '#submit', text: 'Submit' })
    const html = textToHTML(`change ${marker}`, [], [])

    expect(html).toContain('data-mention="true"')
    expect(html).toContain('>Submit<')
    expect(html).toContain('title="#submit"')
  })

  it('keeps the marker in data-mention-text, so it survives being read back', () => {
    const marker = buildElementMention({ selector: '#submit', text: 'Submit' })
    const html = textToHTML(marker, [], [])

    expect(html).toContain(`data-mention-text="${marker}"`)
  })

  it('falls back to the selector when the element has no text of its own', () => {
    const marker = buildElementMention({ selector: 'svg.icon', text: '' })
    expect(textToHTML(marker, [], [])).toContain('>svg.icon<')
  })

  it('escapes the element text instead of injecting it as markup', () => {
    const marker = buildElementMention({ selector: '.a', text: '<img src=x>' })
    const html = textToHTML(marker, [], [])

    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img src=x&gt;')
  })

  it('leaves surrounding text and other mentions untouched', () => {
    const marker = buildElementMention({ selector: '.a', text: 'A' })
    const html = textToHTML(`fix ${marker} please`, [], [])

    expect(html).toContain('fix ')
    expect(html).toContain(' please')
  })
})
