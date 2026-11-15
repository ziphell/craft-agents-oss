import { describe, it, expect } from 'bun:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import remarkCallouts, { parseCalloutMarker } from '../remarkCallouts'

/** The document as the reader's pipeline produces it, with and without `rehype-raw`. */
function toHast(source: string, withRaw: boolean) {
  const pipeline = unified()
    .use(remarkParse)
    .use(remarkCallouts)
    .use(remarkRehype, { allowDangerousHtml: true })
  if (withRaw) pipeline.use(rehypeRaw)
  return pipeline.runSync(pipeline.parse(source)) as any
}

const propertiesOf = (tree: any) =>
  tree.children.find((child: any) => child.tagName === 'blockquote')?.properties ?? {}

describe('the marker itself', () => {
  it('reads the type, in either case', () => {
    expect(parseCalloutMarker('[!NOTE] something')?.type).toBe('note')
    expect(parseCalloutMarker('[!Note]')?.type).toBe('note')
  })

  it('also keeps the spelling the line used', () => {
    // The editor writes the marker back in this case: lower-casing it made `says()` read a lost word.
    expect(parseCalloutMarker('[!NOTE] something')?.spelling).toBe('NOTE')
    expect(parseCalloutMarker('[!Note]')?.spelling).toBe('Note')
    expect(parseCalloutMarker('[!note]-')?.spelling).toBe('note')
  })

  it('says whether the app knows the type', () => {
    expect(parseCalloutMarker('[!warning]')?.known).toBe(true)
    expect(parseCalloutMarker('[!flibbertigibbet]')?.known).toBe(false)
  })

  it('keeps the fold marker out of the type, and counts it in the length', () => {
    const marker = parseCalloutMarker('[!note]- a folded callout')

    expect(marker?.type).toBe('note')
    expect(marker?.fold).toBe('-')
    expect(marker?.length).toBe('[!note]- '.length)
  })

  it('is not a marker when the line does not start with one', () => {
    expect(parseCalloutMarker('some [!NOTE] in passing')).toBeNull()
    expect(parseCalloutMarker('[]')).toBeNull()
  })
})

describe('through the reader pipeline', () => {
  it('marks the blockquote and takes the marker out of the text', () => {
    const tree = toHast('> [!NOTE] Read this', false)
    const blockquote = tree.children.find((child: any) => child.tagName === 'blockquote')
    // A blockquote's own children start with the newline it was written after.
    const paragraph = blockquote?.children.find((child: any) => child.tagName === 'p')

    expect(propertiesOf(tree)['data-callout']).toBe('note')
    expect(paragraph?.children[0].value).toBe('Read this')
  })

  it('keeps the marker as a property even when `rehype-raw` re-spells it', () => {
    // Measured: `rehype-raw` normalises `data-*` into camel case. The renderer reads both spellings,
    // so a callout cannot depend on which plugins are in front of it.
    expect(propertiesOf(toHast('> [!WARNING] Mind the gap', true))).toEqual({
      dataCallout: 'warning',
    })
  })
})
