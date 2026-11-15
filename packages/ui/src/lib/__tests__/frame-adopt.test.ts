import { describe, expect, it } from 'bun:test'
import { parseHTML } from 'linkedom'
import { adoptChangedElements } from '../html-edit/frame-adopt'

/**
 * The frame is a derived view of the source, so an outside write *could* be shown by building it again — and that is
 * what the editor used to do, at the cost of the person's scroll, focus and half-typed field. This applies the
 * difference to the live DOM instead: only the elements that changed are replaced.
 *
 * Measured on a real parsed document (`linkedom`), not on a description of one.
 */
const PAGE = `<!doctype html>
<html>
  <head><title>报告</title></head>
  <body>
    <h1>标题</h1>
    <main>
      <p>第一段。</p>
      <p>第二段。</p>
    </main>
  </body>
</html>
`

function open(source: string) {
  const { document } = parseHTML(source)
  return document
}

describe('adopting an outside write into the live page', () => {
  it('replaces the element whose text changed, and nothing else', () => {
    const doc = open(PAGE)
    const after = PAGE.replace('第一段。', '第一段，改过。')
    const keep = doc.querySelectorAll('p')[1] // the paragraph nobody touched

    const result = adoptChangedElements(doc as unknown as Document, PAGE, after)

    expect(result).toEqual({ applied: true, replaced: 1 })
    expect(doc.querySelectorAll('p')[0]!.textContent).toBe('第一段，改过。')
    expect(doc.querySelectorAll('p')[1]).toBe(keep) // the same node: not rebuilt
  })

  it('marks what it changed, with the same mark the markdown editor uses', () => {
    const doc = open(PAGE)
    adoptChangedElements(doc as unknown as Document, PAGE, PAGE.replace('标题', '新标题'))
    expect(doc.querySelectorAll('.agent-changed').length).toBe(1)
    expect(doc.querySelector('.agent-caret')!.textContent).toBe('Craft Agent')
  })

  it('names every replaced element', () => {
    const doc = open(PAGE)
    const after = PAGE.replace('第一段。', '甲').replace('第二段。', '乙')
    const result = adoptChangedElements(doc as unknown as Document, PAGE, after)
    expect(result.replaced).toBe(2)
    expect([...doc.querySelectorAll('.agent-changed')].map((el) => el.textContent)).toEqual(['甲', '乙'])
  })

  it('says nothing happened when the page did not change', () => {
    const doc = open(PAGE)
    expect(adoptChangedElements(doc as unknown as Document, PAGE, PAGE)).toEqual({ applied: true, replaced: 0 })
    expect(doc.querySelector('.agent-changed')).toBeNull()
  })

  it('refuses rather than guessing when a path is not in the page', () => {
    const doc = open('<html><body><p>x</p></body></html>')
    const result = adoptChangedElements(doc as unknown as Document, PAGE, PAGE.replace('标题', '新标题'))
    expect(result.applied).toBe(false)
    expect(result.reason).toContain('no element at')
  })
})
