import { describe, it, expect, afterEach } from 'bun:test'
import {
  PREVIEW_BLOCK_LANGUAGES,
  fenceBlockType,
  fenceChoices,
  recordFenceUse,
  resetFenceUsage,
  fenceDrawing,
  fenceSpec,
  fenceSpecs,
  fenceWidgetDrawing,
  isPreviewBlockLanguage,
  registerFence,
  unregisterFence,
} from '../fences'

/** Fences whose body is a *preview spec* — the shapes a picker has to get right. */
const JSON_BODY_FENCES = [
  'datatable',
  'spreadsheet',
  'drawio-preview',
  'html-preview',
  'pdf-preview',
  'image-preview',
  'markdown-preview',
]

afterEach(() => {
  // Every registration in this file is undone, so a test cannot decide the next one's answer.
  unregisterFence('chart')
  unregisterFence('mermaid')
  resetFenceUsage()
})

describe('the fence table', () => {
  it('names every fence once, in lower case', () => {
    const names = fenceSpecs().map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toBe(name.toLowerCase())
  })

  it('has an entry for every language the preview-block list names, and no others', () => {
    // The list is a tuple (a type is derived from it), so it cannot be computed from the table. This
    // is the seam that would otherwise let a fence be added to one and not the other.
    const previews = fenceSpecs()
      .filter((spec) => spec.kind === 'preview')
      .map((spec) => spec.name)
    expect([...previews].sort()).toEqual([...PREVIEW_BLOCK_LANGUAGES].sort())
  })

  /**
   * A retired fence is an unknown fence.
   *
   * `office-preview` was taken out of the table on 2026-10-30 — one block per message mounted a whole
   * editor application, and a conversation renders every turn it has. What must stay true is that
   * nothing draws it, no editor can be reached through it, and the picker does not offer it; the
   * component being present in the bundle is fine, and is how it comes back.
   */
  it('draws nothing for a retired fence', () => {
    expect(fenceSpec('office-preview')).toBeUndefined()
    expect(fenceDrawing('office-preview')).toBeUndefined()
    expect(fenceWidgetDrawing('office-preview')).toBeUndefined()
    expect(fenceBlockType('office-preview')).toBe('code')
    expect(fenceChoices().map((spec) => spec.name)).not.toContain('office-preview')
    expect(isPreviewBlockLanguage('office-preview')).toBe(false)
  })

  it('gives every fence a title, a description and a body', () => {
    for (const spec of fenceSpecs()) {
      expect(spec.title.length).toBeGreaterThan(0)
      expect(spec.description.length).toBeGreaterThan(0)
      // An empty body is allowed only where the block itself needs nothing (`latex`'s `E = mc^2` is
      // a body; a fence with an empty one would open into a blank block).
      expect(spec.scaffold.length).toBeGreaterThan(0)
    }
  })

  it('writes a body its own block can parse', () => {
    for (const name of JSON_BODY_FENCES) {
      const spec = fenceSpec(name)
      expect(spec).toBeDefined()
      const body = JSON.parse(spec!.scaffold) as Record<string, unknown>
      // `datatable`/`spreadsheet` may hold inline data instead of a `src`, and both blocks require
      // one of the two.
      const usable =
        typeof body.src === 'string' ||
        (Array.isArray(body.columns) && Array.isArray(body.rows))
      expect(usable).toBe(true)
    }

    // A plain JSON fence is not a spec: its body is just JSON, and the tree view is what proves it.
    expect(() => JSON.parse(fenceSpec('json')!.scaffold)).not.toThrow()
  })
})

describe('what draws a fence', () => {
  it('draws a fence as itself by default', () => {
    expect(fenceDrawing('mermaid')).toBe('mermaid')
    expect(fenceDrawing('datatable')).toBe('datatable')
    expect(fenceDrawing('  MERMAID  ')).toBe('mermaid')
  })

  it('draws `math` with the latex block, under the name the reader has always used', () => {
    expect(fenceDrawing('math')).toBe('latex')
    expect(fenceBlockType('math')).toBe('latex')
  })

  it('leaves a fence it does not know as a code block', () => {
    expect(fenceDrawing('python')).toBeUndefined()
    expect(fenceDrawing('')).toBeUndefined()
    expect(fenceBlockType('python')).toBe('code')
  })

  it('keeps the block type annotations were written with', () => {
    // `diff` and `json` were wrapped as `code` before the table existed; an annotation recorded then
    // still has to match the block it names today.
    expect(fenceBlockType('diff')).toBe('code')
    expect(fenceBlockType('json')).toBe('code')
    expect(fenceBlockType('datatable')).toBe('datatable')
  })

  it('does not draw a document fence inside an editor', () => {
    expect(fenceWidgetDrawing('markdown-preview')).toBeUndefined()
    expect(fenceWidgetDrawing('mermaid')).toBe('mermaid')
  })

  it('says which fences the preview-block list claims', () => {
    expect(isPreviewBlockLanguage('datatable')).toBe(true)
    expect(isPreviewBlockLanguage('markdown-preview')).toBe(false)
    expect(isPreviewBlockLanguage('python')).toBe(false)
  })
})

describe('the picker list', () => {
  it('offers one entry per thing, not one per name', () => {
    const names = fenceChoices().map((spec) => spec.name)

    expect(names).toContain('latex')
    expect(names).not.toContain('math')
    expect(names).toContain('mermaid')
    expect(names).not.toContain('mermaidjs')
  })

  it('still resolves a second name, and draws it as the one it spells', () => {
    expect(fenceDrawing('mermaidjs')).toBe('mermaid')
    expect(fenceWidgetDrawing('mermaidjs')).toBe('mermaid')
  })

  it('puts what this editor reaches for at the top', () => {
    expect(fenceChoices()[0]?.name).not.toBe('json')

    recordFenceUse('json')
    recordFenceUse('json')
    recordFenceUse('datatable')

    expect(fenceChoices().slice(0, 2).map((spec) => spec.name)).toEqual(['json', 'datatable'])
  })
})

describe('custom fences', () => {
  it('lets a new name borrow a block that already exists', () => {
    registerFence({
      name: 'chart',
      kind: 'preview',
      title: 'Chart',
      description: 'The table, under another name',
      scaffold: '{"columns": [], "rows": []}',
      draws: 'datatable',
    })

    expect(fenceDrawing('chart')).toBe('datatable')
    expect(fenceWidgetDrawing('chart')).toBe('datatable')
    // The name is what is written and what an annotation records; the drawing is the table's.
    expect(fenceBlockType('chart')).toBe('datatable')
    expect(fenceSpec('chart')?.kind).toBe('preview')
  })

  it('can be taken back out again', () => {
    registerFence({
      name: 'chart',
      kind: 'preview',
      title: 'Chart',
      description: 'x',
      scaffold: '{}',
      draws: 'datatable',
    })
    unregisterFence('chart')
    expect(fenceDrawing('chart')).toBeUndefined()
  })

  it('replaces a built-in and puts it back unchanged', () => {
    const before = fenceSpec('mermaid')
    registerFence({
      name: 'mermaid',
      kind: 'diagram',
      title: 'Diagram (ours)',
      description: 'x',
      scaffold: 'graph TD',
    })
    expect(fenceSpec('mermaid')?.title).toBe('Diagram (ours)')

    unregisterFence('mermaid')
    expect(fenceSpec('mermaid')).toEqual(before)
  })
})
