import { describe, it, expect } from 'bun:test'
import { isMindmapSource, parseMindmap } from '@craft-agent/core/mermaid/mindmap'
import { renderMindmapSVG } from '../mindmap-svg'
import { fenceBlockType, fenceChoices, fenceDrawing, fenceSpec } from '../fences'

const SOURCE = `mindmap
  root((Root))
    Discover
      Interviews
      Surveys
    Deliver
      Build
`

describe('reading a mermaid mindmap', () => {
  it('reads indentation as the hierarchy', () => {
    const root = parseMindmap(SOURCE)

    expect(root.label).toBe('Root')
    expect(root.shape).toBe('circle')
    expect(root.children.map((child) => child.label)).toEqual(['Discover', 'Deliver'])
    expect(root.children[0]?.children.map((child) => child.label)).toEqual(['Interviews', 'Surveys'])
    expect(root.children[1]?.children.map((child) => child.label)).toEqual(['Build'])
  })

  it('reads the node shapes, and a quoted label literally', () => {
    const root = parseMindmap(
      ['mindmap', '  root(rounded)', '    a[square]', '    b{{hexagon}}', '    "a [label] with brackets"'].join('\n'),
    )

    expect(root.shape).toBe('rounded')
    expect(root.children.map((child) => child.shape)).toEqual(['rect', 'hexagon', 'default'])
    expect(root.children[2]?.label).toBe('a [label] with brackets')
  })

  it('keeps brackets in an unquoted label, rather than reading them as a shape', () => {
    // `Node (note)` is text: an id must touch its delimiter to be a shape, otherwise the first
    // word would silently become an id and disappear from the label.
    const root = parseMindmap('mindmap\n  root\n    Node (note)')

    expect(root.children[0]?.shape).toBe('default')
    expect(root.children[0]?.label).toBe('Node (note)')
  })

  it('skips frontmatter, comments, icons and class annotations', () => {
    const root = parseMindmap(
      ['---', 'title: Example', '---', '%% a comment', 'mindmap', '  root', '    ::icon(fa fa-book)', '    child:::hot'].join('\n'),
    )

    expect(root.label).toBe('root')
    expect(root.children.map((child) => child.label)).toEqual(['child'])
  })

  it('splits a label on <br/>', () => {
    const root = parseMindmap('mindmap\n  root\n    first<br/>second')
    expect(root.children[0]?.label).toBe('first\nsecond')
  })

  it('refuses a source that is not a mindmap, and a second root', () => {
    expect(() => parseMindmap('graph TD\n  A --> B')).toThrow(/start with "mindmap"/)
    expect(() => parseMindmap('mindmap\n  one\n  two')).toThrow(/one root node/)
  })

  it('recognises the header after frontmatter and comments', () => {
    expect(isMindmapSource('---\ntitle: x\n---\n%% note\nmindmap\n  root')).toBe(true)
    expect(isMindmapSource('graph TD\n  A --> B')).toBe(false)
  })
})

describe('drawing a mindmap', () => {
  it('states its own size and draws every label', () => {
    const svg = renderMindmapSVG(parseMindmap(SOURCE))

    expect(svg).toMatch(/^<svg [^>]*width="\d+"/)
    expect(svg).toContain('height="')
    expect(svg).toContain('>Root<')
    expect(svg).toContain('>Discover<')
    expect(svg).toContain('>Interviews<')
    expect(svg).toContain('<path')
    expect(svg).toContain('var(--foreground)')
  })

  it('escapes markup in a label', () => {
    const svg = renderMindmapSVG(parseMindmap('mindmap\n  root("<A & B>")'))

    expect(svg).toContain('&lt;A &amp; B&gt;')
    expect(svg).not.toContain('<A')
  })

  it('draws a tree without children', () => {
    const svg = renderMindmapSVG(parseMindmap('mindmap\n  only'))
    expect(svg).toContain('>only<')
  })

  it('draws the bang shape with its bowed sides', () => {
    const svg = renderMindmapSVG(parseMindmap('mindmap\n  root\n    b))bang(('))

    expect(svg).toContain('>bang<')
    expect(svg).toMatch(/<path d="M -?[\d.]+ -?[\d.]+ L -?[\d.]+ -?[\d.]+ Q /)
  })

  it('gives each top-level branch its own hue', () => {
    const svg = renderMindmapSVG(parseMindmap('mindmap\n  root\n    A\n    B'))

    expect(svg).toContain('calc(h + 0)')
    expect(svg).toContain('calc(h + 16)')
  })

  it('refuses to draw a map past the node limit', () => {
    const children = Array.from({ length: 800 }, (_, index) => `    n${index}`).join('\n')
    const source = `mindmap\n  root\n${children}`

    expect(() => renderMindmapSVG(parseMindmap(source))).toThrow(/limit for drawing/)
  })

  it('clips a label that would be a wall of text', () => {
    const svg = renderMindmapSVG(parseMindmap(`mindmap\n  ${'word '.repeat(400)}`))

    expect((svg.match(/<tspan/g) ?? []).length).toBeLessThanOrEqual(12)
    expect(svg).toContain('…')
  })
})

describe('the mindmap fence', () => {
  it('is registered and drawn by its own block', () => {
    expect(fenceSpec('mindmap')?.name).toBe('mindmap')
    expect(fenceSpec('mindmap')?.kind).toBe('diagram')
    expect(fenceDrawing('mindmap')).toBe('mindmap')
    expect(fenceBlockType('mindmap')).toBe('mindmap')
  })

  it('is offered in the fence picker', () => {
    expect(fenceChoices().map((spec) => spec.name)).toContain('mindmap')
  })

  it('starts a new block with a body its own parser reads', () => {
    const scaffold = fenceSpec('mindmap')?.scaffold ?? ''
    expect(() => parseMindmap(scaffold)).not.toThrow()
  })
})
