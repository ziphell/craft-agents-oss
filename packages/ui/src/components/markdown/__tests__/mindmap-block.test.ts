import { describe, it, expect, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The block asks for translations; the drawing under test does not.
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { MarkdownMermaidBlock } = await import('../MarkdownMermaidBlock')
const { MarkdownMindmapBlock } = await import('../MarkdownMindmapBlock')

describe('a mind map written as a mermaid diagram', () => {
  it('draws the map instead of falling back to the source', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMermaidBlock, {
        code: 'mindmap\n  root((Root))\n    Child',
        interactive: false,
        showExpandButton: false,
      }),
    )

    expect(html).toContain('<svg')
    expect(html).toContain('>Root<')
    expect(html).toContain('>Child<')
  })

  it('still draws an ordinary mermaid diagram through the shared frame', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMermaidBlock, {
        code: 'graph TD\n  A --> B',
        interactive: false,
        showExpandButton: false,
      }),
    )

    expect(html).toContain('<svg')
    expect(html).toContain('>A<')
    expect(html).toContain('>B<')
  })
})

describe('a `mindmap` fence', () => {
  it('draws a body that starts straight at the root', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMindmapBlock, {
        code: '根节点\n  子节点1\n    孙节点1.1\n  子节点2',
        interactive: false,
        showExpandButton: false,
      }),
    )

    expect(html).toContain('<svg')
    expect(html).toContain('>根节点<')
    expect(html).toContain('>孙节点1.1<')
  })

  it('shows an unreadable body as its own source, not as mermaid', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMindmapBlock, {
        code: '',
        interactive: false,
        showExpandButton: false,
      }),
    )

    expect(html).toContain('mindmap')
    expect(html).not.toContain('mermaid')
  })
})
