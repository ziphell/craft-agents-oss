import { describe, it, expect, mock } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The block asks for translations; the drawing under test does not.
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const { MarkdownMermaidBlock } = await import('../MarkdownMermaidBlock')

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
