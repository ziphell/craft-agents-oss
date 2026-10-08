/**
 * Element mentions — the marker `[element:<selector>|<text>|<url>|<tabId>]` the browser picker
 * inserts,
 * and the reference the agent rewrites it into at the model boundary.
 *
 * The marker itself has to survive to the store (so the sent chip can be redrawn from it), so
 * these tests cover both halves: reading it back, and getting the model-facing sentence out.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildElementMention,
  elementLabel,
  findElementMentions,
  parseElementMention,
  resolveElementMentions,
} from '../element-mention.ts'

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
    })

    expect(parseElementMention(marker.slice('[element:'.length, -1))).toEqual({
      selector: '[data-testid="pay"]',
      text: 'Pay now',
      url: 'https://shop.example.com/cart?step=2',
    })
  })

  it('round-trips the tab the element was picked in', () => {
    // Two tabs can be on the same page, so the address alone does not say which
    // one to change; the id is what a command is pointed with.
    const marker = buildElementMention({
      selector: '#submit',
      text: 'Submit',
      url: 'https://shop.example.com/cart',
      tabId: '12',
    })

    expect(marker).toBe('[element:%23submit|Submit|https%3A%2F%2Fshop.example.com%2Fcart|12]')
    expect(parseElementMention(marker.slice('[element:'.length, -1))).toEqual({
      selector: '#submit',
      text: 'Submit',
      url: 'https://shop.example.com/cart',
      tabId: '12',
    })
  })

  it('drops the parts a pick did not carry', () => {
    // The agent's own `browser_tool pick` carries no page: the marker is shorter,
    // and reading it back leaves nothing empty behind.
    const marker = buildElementMention({ selector: '.a', text: 'A' })

    expect(marker).toBe('[element:.a|A]')
    expect(parseElementMention('.a|A')).toEqual({
      selector: '.a',
      text: 'A',
    })
  })

  it('still reads a marker written before picks carried an origin', () => {
    expect(parseElementMention('%23submit|Submit')).toEqual({ selector: '#submit', text: 'Submit' })
  })

  it('still reads a marker written before picks carried a tab', () => {
    expect(parseElementMention('%23submit|Submit|https%3A%2F%2Fshop.example%2Fcart')).toEqual({
      selector: '#submit',
      text: 'Submit',
      url: 'https://shop.example/cart',
    })
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

describe('resolveElementMentions', () => {
  it('rewrites a marker with the label, the selector and the page', () => {
    const marker = buildElementMention({
      selector: '#submit',
      text: 'Submit',
      url: 'https://shop.example/cart',
    })

    expect(resolveElementMentions(`改一下 ${marker}`))
      .toBe('改一下 [Mentioned element: Submit (#submit on https://shop.example/cart)]')
  })

  it('names the tab when the pick carried one', () => {
    const marker = buildElementMention({
      selector: '#submit',
      text: 'Submit',
      url: 'https://shop.example/cart',
      tabId: '12',
    })

    expect(resolveElementMentions(`改一下 ${marker}`))
      .toBe('改一下 [Mentioned element: Submit (#submit on https://shop.example/cart, tab 12)]')
  })

  it('omits the page when the pick carried none', () => {
    const marker = buildElementMention({ selector: '#submit', text: 'Submit' })

    expect(resolveElementMentions(marker)).toBe('[Mentioned element: Submit (#submit)]')
  })

  it('falls back to the selector as the label for an element with no text', () => {
    const marker = buildElementMention({ selector: 'svg.icon', text: '' })

    expect(resolveElementMentions(marker)).toBe('[Mentioned element: svg.icon (svg.icon)]')
  })

  it('leaves the user text around the marker untouched', () => {
    const marker = buildElementMention({ selector: '.a', text: 'A' })
    expect(resolveElementMentions(`before ${marker} after`))
      .toBe('before [Mentioned element: A (.a)] after')
  })

  it('rewrites every marker', () => {
    const text = `${buildElementMention({ selector: '.a', text: 'A' })} and ${buildElementMention({ selector: '.b', text: 'B' })}`
    expect(resolveElementMentions(text))
      .toBe('[Mentioned element: A (.a)] and [Mentioned element: B (.b)]')
  })

  it('leaves text with no markers byte-identical', () => {
    expect(resolveElementMentions('just a question')).toBe('just a question')
  })

  it('leaves a malformed marker visible rather than dropping it', () => {
    expect(resolveElementMentions('see [element:broken] here')).toBe('see [element:broken] here')
  })
})
