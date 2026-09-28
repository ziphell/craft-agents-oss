import { describe, it, expect, mock } from 'bun:test'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Mathematics } from '@tiptap/extension-mathematics'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { tiptapCodeBlock } from '../TiptapCodeBlockView'
import { MermaidBlock } from '../extensions/MermaidBlock'
import { LatexBlock } from '../extensions/LatexBlock'

// `MarkdownPdfBlock` reaches pdf.js through a Vite-only `?url` specifier, which `bun test` cannot
// resolve (the query is not part of a module id, so it lands on the worker script and finds no
// default export). Nothing here draws a PDF block — the fence languages and what they round-trip
// to are the subject — so the one block is stubbed. The two imports that carry it in their graph
// are dynamic because a static import is evaluated before anything in this file runs, and the
// stub would arrive too late.
mock.module('../MarkdownPdfBlock', () => ({ MarkdownPdfBlock: () => null }))
const { preprocessMarkdownForOfficial, postprocessMarkdownFromOfficial } = await import(
  '../TiptapMarkdownEditor'
)
const { PreviewBlock } = await import('../extensions/PreviewBlock')

describe('official markdown + mathematics foundation', () => {
  it('parses markdown content when contentType is markdown', () => {
    const editor = new Editor({
      extensions: [StarterKit, Markdown],
      content: '# Hello\n\n**World**',
      contentType: 'markdown',
    })

    const md = editor.getMarkdown()
    expect(md).toContain('# Hello')
    expect(md).toContain('**World**')

    editor.destroy()
  })

  it('normalizes one-line $$...$$ and protects currency ranges', () => {
    const source = 'Inline $$x$$, money $100, range $2M–$4M, formula $$E=mc^2$$'

    const normalized = preprocessMarkdownForOfficial(source)
    expect(normalized).toContain('Inline $x$')
    expect(normalized).toContain('money ¤100')
    expect(normalized).toContain('range ¤2M–¤4M')
    expect(normalized).toContain('formula $E=mc^2$')

    const restored = postprocessMarkdownFromOfficial(normalized)
    expect(restored).toContain('$100')
    expect(restored).toContain('$2M–$4M')
  })

  it('round-trips official math without inlineMath placeholder leakage', () => {
    const source = 'Inline $$x$$ and value $100 and range $2M–$4M.\n\n$$E=mc^2$$'
    const normalized = preprocessMarkdownForOfficial(source)

    const editor = new Editor({
      extensions: [
        StarterKit,
        Mathematics.configure({
          katexOptions: {
            throwOnError: false,
            strict: false,
          },
        }),
        Markdown,
      ],
      content: normalized,
      contentType: 'markdown',
    })

    const md = postprocessMarkdownFromOfficial(editor.getMarkdown())
    const json = editor.getJSON()

    expect(md).not.toContain('[inlineMath]')
    expect(md).toContain('$x$')
    expect(md).toContain('$100')
    expect(md).toContain('$2M–$4M')
    expect(md).toContain('E=mc^2')

    // Guardrails: ensure math nodes exist while currency range remains literal text.
    const jsonText = JSON.stringify(json)
    expect(jsonText).toContain('inlineMath')
    expect(jsonText).toContain('¤2M–¤4M')

    editor.destroy()
  })

  it('parses mermaid/latex fences into dedicated rich nodes and keeps regular fences as codeBlock', () => {
    const source = [
      'before',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '```latex',
      'E = mc^2',
      '```',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      'after',
    ].join('\n')

    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        MermaidBlock,
        LatexBlock,
        tiptapCodeBlock,
        Markdown,
      ],
      content: source,
      contentType: 'markdown',
    })

    const json = editor.getJSON()
    const md = editor.getMarkdown()
    const jsonText = JSON.stringify(json)

    expect(jsonText).toContain('"type":"mermaidBlock"')
    expect(jsonText).toContain('"type":"latexBlock"')
    expect(jsonText).toContain('"type":"codeBlock"')
    expect(jsonText).toContain('"language":"ts"')
    expect(md).toContain('```mermaid')
    expect(md).toContain('graph TD')
    expect(md).toContain('```latex')
    expect(md).toContain('E = mc^2')
    expect(md).toContain('```ts')
    expect(md).toContain('const x = 1')

    editor.destroy()
  })

  it('round-trips markdown task lists in official markdown mode', () => {
    const source = [
      '- [ ] Draft release notes',
      '- [x] Ship task list slash command',
      '  - [ ] Add follow-up docs',
    ].join('\n')

    const editor = new Editor({
      extensions: [
        StarterKit,
        TaskList,
        TaskItem.configure({ nested: true }),
        Markdown,
      ],
      content: source,
      contentType: 'markdown',
    })

    const json = editor.getJSON()
    const md = editor.getMarkdown()
    const jsonText = JSON.stringify(json)

    expect(jsonText).toContain('"type":"taskList"')
    expect(jsonText).toContain('"type":"taskItem"')
    expect(jsonText).toContain('"checked":true')
    expect(jsonText).toContain('"checked":false')
    expect(md).toContain('- [ ] Draft release notes')
    expect(md).toContain('- [x] Ship task list slash command')
    expect(md).toContain('  - [ ] Add follow-up docs')

    editor.destroy()
  })

  it('round-trips markdown tables in official markdown mode', () => {
    // Not a display question. A table these documents are full of is a node the parser has to
    // have; without one the rows are not styled differently, they are *gone* from the document,
    // and a file saved from the editor would come back with its tables deleted.
    const source = [
      '| Requirement | Covered |',
      '| --- | --- |',
      '| R-001 | yes |',
    ].join('\n')

    const editor = new Editor({
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell, Markdown],
      content: source,
      contentType: 'markdown',
    })

    const jsonText = JSON.stringify(editor.getJSON())
    const md = editor.getMarkdown()

    expect(jsonText).toContain('"type":"table"')
    expect(jsonText).toContain('"type":"tableHeader"')
    expect(jsonText).toContain('"type":"tableCell"')
    expect(md).toContain('| Requirement | Covered |')
    expect(md).toContain('| R-001')
    expect(md).toContain('yes')

    editor.destroy()
  })

  it('draws the app\'s preview fences as their own blocks, and writes the fences back unchanged', () => {
    // The blocks below are what a markdown file's `drawio-preview` / `datatable` / `json` fences
    // are drawn as everywhere else in the app. In an editor that *saves the file*, reading one as
    // a plain code block is not a display difference: the picture is gone from the document, and
    // what gets written back has to be the fence, byte for byte, or the file has been rewritten
    // by the act of opening it.
    const drawioFence = ['```drawio-preview', '{ "src": "/x/flow.drawio" }', '```'].join('\n')
    const datatableFence = ['```datatable', 'id,name', '1,alpha', '```'].join('\n')
    const jsonFence = ['```json', '{ "a": 1 }', '```'].join('\n')
    const codeFence = ['```ts', 'const x = 1', '```'].join('\n')
    const nestedDocFence = ['```markdown-preview', '{ "src": "/y/other.md" }', '```'].join('\n')

    const source = [drawioFence, datatableFence, jsonFence, codeFence, nestedDocFence].join('\n\n')

    const editor = new Editor({
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        MermaidBlock,
        LatexBlock,
        PreviewBlock,
        tiptapCodeBlock,
        Markdown,
      ],
      content: source,
      contentType: 'markdown',
    })

    const jsonText = JSON.stringify(editor.getJSON())
    const md = editor.getMarkdown()

    expect(jsonText).toContain('"type":"previewBlock"')
    expect(jsonText).toContain('"lang":"drawio-preview"')
    expect(jsonText).toContain('"lang":"datatable"')
    expect(jsonText).toContain('"lang":"json"')

    // A fence the app has no component for, and one that names another document, stay code
    // blocks: the first is the fallback working, the second is the recursion guard.
    expect(jsonText).toContain('"language":"ts"')
    expect(jsonText).toContain('"language":"markdown-preview"')

    expect(md).toContain(drawioFence)
    expect(md).toContain(datatableFence)
    expect(md).toContain(jsonFence)
    expect(md).toContain(codeFence)
    expect(md).toContain(nestedDocFence)

    editor.destroy()
  })

  it('round-trips markdown images with alt, src, and title in official markdown mode', () => {
    const source = [
      'Before image',
      '',
      '![Planner board](https://picsum.photos/seed/planner-image-test/1200/600 "Planner Board")',
      '',
      'After image',
    ].join('\n')

    const editor = new Editor({
      extensions: [StarterKit, Image, Markdown],
      content: source,
      contentType: 'markdown',
    })

    const json = editor.getJSON()
    const md = editor.getMarkdown()
    const jsonText = JSON.stringify(json)

    expect(jsonText).toContain('"type":"image"')
    expect(jsonText).toContain('"src":"https://picsum.photos/seed/planner-image-test/1200/600"')
    expect(jsonText).toContain('"alt":"Planner board"')
    expect(jsonText).toContain('"title":"Planner Board"')
    expect(md).toContain('![Planner board](https://picsum.photos/seed/planner-image-test/1200/600 "Planner Board")')

    editor.destroy()
  })
})
