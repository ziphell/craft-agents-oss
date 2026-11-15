import { describe, expect, it } from 'bun:test'
import { changedElements } from '../html-edit/element-diff'

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

describe('which elements an outside write changed', () => {
  it('says nothing when nothing changed', () => {
    expect(changedElements(PAGE, PAGE)).toEqual([])
  })

  it('names the paragraph whose text was edited', () => {
    const after = PAGE.replace('第一段。', '第一段，改过。')
    const changes = changedElements(PAGE, after)
    expect(changes).toEqual([
      { path: '1/1/0', tag: 'p', kind: 'text', from: after.indexOf('<p>第一段'), to: after.indexOf('</p>') + 4 },
    ])
  })

  it('names the element whose attribute changed', () => {
    const before = '<html><body><div class="a">x</div></body></html>'
    const after = '<html><body><div class="b">x</div></body></html>'
    expect(changedElements(before, after).map((change) => change.kind)).toEqual(['attrs'])
  })

  it('stops at the parent when children were added, rather than pairing them up and guessing', () => {
    const after = PAGE.replace('<p>第二段。</p>', '<p>第二段。</p>\n      <p>新的。</p>')
    const changes = changedElements(PAGE, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: '1/1', tag: 'main', kind: 'children' })
  })

  it('does not call re-indenting a change', () => {
    const after = PAGE.replace(/\n\s+/g, '\n')
    expect(changedElements(PAGE, after)).toEqual([])
  })

  it('names a replaced element once, not everything below it', () => {
    const before = '<html><body><h1>x</h1></body></html>'
    const after = '<html><body><h2>x</h2></body></html>'
    expect(changedElements(before, after)).toEqual([
      { path: '1/0', tag: 'h2', kind: 'replaced', from: after.indexOf('<h2>'), to: after.indexOf('</h2>') + 5 },
    ])
  })
})
