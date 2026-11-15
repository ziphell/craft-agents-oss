import * as React from 'react'
import type { ComponentEntry } from './types'
import readmeProbe from './readme-probe.json'
import { Markdown, CollapsibleMarkdownProvider, CodeBlock, InlineCode, MarkdownDatatableBlock, MarkdownSpreadsheetBlock, MarkdownImageBlock, ImageCardStack, MarkdownEditorPane, SourceFilePane, HTMLPreviewOverlay, PlatformProvider } from '@craft-agent/ui'

const sampleMarkdown = `# Welcome to Markdown

This is a **bold** statement and this is *italic*.

## Code Examples

Here's some inline code: \`const x = 42\`

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`
}

// Call the function
console.log(greet("World"))
\`\`\`

## Lists

- First item
- Second item
  - Nested item
- Third item

1. Numbered one
2. Numbered two
3. Numbered three

## Table

| Name | Role | Status |
|------|------|--------|
| Alice | Developer | Active |
| Bob | Designer | Away |

## Blockquote

> This is a blockquote with some important information
> that spans multiple lines.

---

That's all folks!`

const codeHeavyMarkdown = `# API Response

The endpoint returned:

\`\`\`json
{
  "status": "success",
  "data": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
    ]
  }
}
\`\`\`

Process with:

\`\`\`python
import json

def process_response(data: dict) -> list:
    return [user["name"] for user in data["users"]]
\`\`\`

Or in TypeScript:

\`\`\`typescript
interface User {
  id: number
  name: string
}

const getNames = (users: User[]): string[] =>
  users.map(u => u.name)
\`\`\``

const typescriptCode = `import { useState, useEffect } from 'react'

interface Todo {
  id: number
  title: string
  completed: boolean
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/todos')
      .then(res => res.json())
      .then(data => {
        setTodos(data)
        setLoading(false)
      })
  }, [])

  return { todos, loading }
}`

const pythonCode = `from dataclasses import dataclass
from typing import Optional

@dataclass
class User:
    id: int
    name: str
    email: Optional[str] = None

def get_user_by_id(user_id: int) -> Optional[User]:
    """Fetch user from database."""
    # Simulated database lookup
    users = {
        1: User(1, "Alice", "alice@example.com"),
        2: User(2, "Bob"),
    }
    return users.get(user_id)`

const jsonCode = `{
  "name": "craft-agent",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build"
  }
}`

const richBlockParityMarkdown = `# Rich Block Interaction Parity

Use this fixture to compare **inline** and **fullscreen** interactions for Mermaid and image blocks.

- Tap/click inline content to open fullscreen
- In fullscreen: wheel/pinch zoom, drag pan, double-click reset
- Keyboard: Cmd/Ctrl +, -, 0

## Mermaid block

\`\`\`mermaid
graph LR
    A[Input] --> B{Validate}
    B -->|Valid| C[Persist]
    B -->|Invalid| D[Show Error]
    C --> E[Notify]
\`\`\`

## Image block

\`\`\`image-preview
{
  "title": "Parity Check",
  "items": [
    { "src": "/mock/images/gallery-1.png", "label": "Lake" },
    { "src": "/mock/images/gallery-2.png", "label": "Forest" }
  ]
}
\`\`\`
`

// Wrapper for collapsible markdown
function CollapsibleWrapper({ children }: { children: React.ReactNode }) {
  return <CollapsibleMarkdownProvider>{children}</CollapsibleMarkdownProvider>
}

const MOCK_IMAGE_DATA: Record<string, string> = {
  '/mock/images/gallery-1.png': 'https://picsum.photos/id/1015/1200/900',
  '/mock/images/gallery-2.png': 'https://picsum.photos/id/1025/900/1200',
  '/mock/images/gallery-3.png': 'https://picsum.photos/id/1035/1400/900',
  '/mock/images/gallery-4.png': 'https://picsum.photos/id/1043/1200/900',
  '/mock/images/gallery-5.png': 'https://picsum.photos/id/1067/1200/900',
}

function MarkdownImageBlockWrapper({ children }: { children: React.ReactNode }) {
  return (
    <PlatformProvider
      actions={{
        onReadFileDataUrl: async (path: string) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          const dataUrl = MOCK_IMAGE_DATA[path]
          if (!dataUrl) {
            throw new Error(`Mock image not found for: ${path}`)
          }
          return dataUrl
        },
      }}
    >
      {children}
    </PlatformProvider>
  )
}

function ImageCardStackPlayground({
  items,
  maxRotate,
}: {
  items: Array<{ src: string; label?: string; ratio?: number }> | string
  maxRotate: number
}) {
  const parsedItems = React.useMemo(() => {
    if (Array.isArray(items)) return items
    if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }, [items])

  const [currentIndex, setCurrentIndex] = React.useState(0)

  React.useEffect(() => {
    setCurrentIndex(0)
  }, [parsedItems])

  return (
    <div className="h-full w-full p-4 flex flex-col gap-3">
      <div className="text-xs text-muted-foreground flex items-center justify-between">
        <span>Active card: {Math.min(currentIndex + 1, Math.max(parsedItems.length, 1))} / {parsedItems.length}</span>
        <span>Swipe left/right on top card</span>
      </div>
      <div className="flex-1 min-h-0 rounded-md border border-border/60 bg-muted/20 p-4 flex items-center justify-center">
        {parsedItems.length > 0 ? (
          <div className="h-[320px] w-full">
            <ImageCardStack items={parsedItems} currentIndex={currentIndex} onIndexChange={setCurrentIndex} maxRotate={maxRotate} maxHeight={320} />
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
            Invalid or empty items JSON
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The document the pane fixture edits.
 *
 * **It opens with frontmatter on purpose.** The strip above the document is the one place a save can
 * change the file without changing the text, so a fixture without one never exercised it — which is
 * how a one-click `✕` was able to delete a file's YAML unnoticed (2026-11-03). With it here, both the
 * strip and the way back from removing it are on screen.
 *
 * Two lines next, so what happens to a keystroke is the variable — then one fence the app draws and
 * one it does not, which is the pair the source face has to get right: the first is drawn in place
 * until the caret is in it, the second is left exactly as written.
 */
const editorPaneFixtureDoc = `---
name: probe-doc
description: 一份用来试编辑面的文档
---

# Probe

Type at the end of this line: 

## A second level

### And a third

Some **bold**, *italic*, ~~struck~~, \`inline code\`, and a [link](https://example.com). Quote:

> a quoted line

> [!WARNING] Mind the gap
> The floor is missing here.

- [ ] a box you can press
- [x] one already pressed

An inline ![shot](shots/picture.png) picture, then a table:

| Name | Qty |
| --- | ---: |
| Bolts | 12 |
| Nuts | 8 |

Display math:

$$
E = mc^2
$$

\`\`\`mermaid
graph TD
  A[Start] --> B[End]
\`\`\`

A fence the app draws is drawn here too, and a fence it does not know is left exactly as written:

\`\`\`python
print("hello")
\`\`\`
`

/**
 * The same document as a conversation shows it: a `markdown-preview` block naming the file.
 *
 * Written as a fence rather than as the component, because the block is reached *through* the
 * renderer in a real message — this is the path that has to keep working.
 */
const editorPaneFixtureBlock = '```markdown-preview\n' +
  JSON.stringify({ src: '/playground/editor-pane-probe.md', title: 'Probe' }) +
  '\n```'

/**
 * The markdown pane and the block that names the same file, with a host of their own.
 *
 * An editor needs somewhere to write to and the playground has no file to save: the "file" here is
 * a line of memory. The host's copy is printed underneath, deliberately — the pane showing the text
 * it holds proves nothing on its own, because a pane that never saved would look the same. What the
 * host ended up with is the part that says a keystroke landed.
 *
 * Both readers are on screen on purpose: the pane is the window's face, the block is what a
 * conversation shows, and they are two separate readers of one file.
 */
function MarkdownEditorPaneFixture() {
  const fileRef = React.useRef(editorPaneFixtureDoc)
  const [saved, setSaved] = React.useState(editorPaneFixtureDoc)
  /**
   * The switch between the two editing faces, with the *same* editor behind both.
   *
   * `edit` and `source` are one component with one flag, so flipping it must not remount the
   * editor: the caret, the undo history and the scroll position have to survive, and the blocks
   * have to appear and disappear without waiting for a keystroke (that is what the field's redraw
   * effect is for).
   */
  const [live, setLive] = React.useState(true)
  /** Where a `Ctrl`-clicked link went — the host's answer, which the editor only asks for. */
  const [opened, setOpened] = React.useState<string | null>(null)

  // Stable identities on purpose: the pane reads the file once per source, so a host whose
  // callbacks changed on every write would send it back to read — and reset — on every save.
  const actions = React.useMemo(
    () => ({
      onReadFile: async () => fileRef.current,
      onWriteFile: async (path: string, content: string) => {
        fileRef.current = content
        setSaved(content)
        return { path }
      },
      onUrlClick: (url: string) => setOpened(url),
      /**
       * How a picture beside the document is read: the path is handed to the host, which answers
       * with bytes. A data URL here so the fixture needs no file — the path is what is being
       * shown, and a relative one goes through this.
       */
      onReadFileDataUrl: async () =>
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" fill="#3b2f63"/><circle cx="112" cy="30" r="16" fill="#c9b7ff"/><path d="M0 96L52 46l40 36 26-22 42 36z" fill="#8f7bd8"/></svg>',
        ),
    }),
    [],
  )

  return (
    <PlatformProvider actions={actions}>
      <div className="flex h-[80vh] flex-col gap-4">
        {/* A definite height, because the pane takes the room it is given (`absolute inset-0`
            inside it) — and with a document long enough to fill the frame, a `flex-1` box is
            squeezed to nothing by the readers underneath. */}
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            data-testid="live-preview"
            checked={live}
            onChange={(event) => setLive(event.target.checked)}
          />
          live preview (unchecked = source, same editor)
        </label>

        <div className="flex h-[360px] shrink-0 flex-col">
          <MarkdownEditorPane
            src="/playground/editor-pane-probe.md"
            mode={live ? 'edit' : 'source'}
            className="px-6 py-4"
            onUrlClick={actions.onUrlClick}
          />
        </div>

        <div data-testid="block-reader" className="shrink-0">
          <Markdown mode="minimal">{editorPaneFixtureBlock}</Markdown>
        </div>

        <div className="shrink-0 border-t p-3">
          <div className="text-[12px] text-muted-foreground">
            Followed link (Ctrl/Cmd-click): <span data-testid="opened-url">{opened ?? '—'}</span>
          </div>
          <div className="mt-2 text-[12px] text-muted-foreground">
            What the host holds — written about a second after typing stops:
          </div>
          <pre data-testid="saved-file" className="mt-1 whitespace-pre-wrap text-[12px]">{saved}</pre>
        </div>
      </div>
    </PlatformProvider>
  )
}

/**
 * The same file as the pane fixture, on its **source** face — the second switch in the document
 * window, where nothing is drawn for a fence and a block is the text it is.
 */
function MarkdownEditorSourceFixture() {
  const fileRef = React.useRef(editorPaneFixtureDoc)
  const [saved, setSaved] = React.useState(editorPaneFixtureDoc)
  const actions = React.useMemo(
    () => ({
      onReadFile: async () => fileRef.current,
      onWriteFile: async (path: string, content: string) => {
        fileRef.current = content
        setSaved(content)
        return { path }
      },
    }),
    [],
  )

  return (
    <PlatformProvider actions={actions}>
      <div className="flex flex-col gap-3">
        <div className="flex h-[360px] flex-col overflow-hidden rounded-lg border border-border">
          <MarkdownEditorPane src="/playground/editor-pane-source.md" mode="source" className="px-6 py-4" />
        </div>
        <div className="border-t pt-3 text-[12px] text-muted-foreground">
          Saved: <span data-testid="source-saved">{saved.slice(0, 40)}</span>
        </div>
      </div>
    </PlatformProvider>
  )
}

/** A page whose source is worth having: a style block, an attribute, and a comment. */
const htmlFixtureDoc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Probe page</title>
    <style>
      body { font-family: system-ui; margin: 24px; }
      .lede { color: rgb(120, 90, 220); }
    </style>
  </head>
  <body>
    <!-- the line a page editor cannot touch -->
    <h1>Probe page</h1>
    <p class="lede">Edited as its own source.</p>
  </body>
</html>
`

function SourceFilePaneFixture() {
  const fileRef = React.useRef(htmlFixtureDoc)
  const [saved, setSaved] = React.useState('')
  /** What the badge's "Open in browser" asked for — the menu item is the story's whole point. */
  const [opened, setOpened] = React.useState('')
  const actions = React.useMemo(
    () => ({
      onReadFile: async () => fileRef.current,
      onWriteFile: async (path: string, content: string) => {
        fileRef.current = content
        setSaved(content)
        return { path }
      },
    }),
    [],
  )

  return (
    <PlatformProvider actions={actions}>
      <div className="flex flex-col gap-3">
        <div className="flex h-[380px] flex-col overflow-hidden rounded-lg border border-border">
          <SourceFilePane src="/playground/page-probe.html" language="html" className="px-4 py-3" />
        </div>
        <div className="text-[12px] text-muted-foreground">
          Saved bytes: <span data-testid="html-saved">{saved.length}</span>
        </div>
      </div>
    </PlatformProvider>
  )
}

/**
 * A page opened in the app's own window, given the way the file window gives it: an item with a
 * path, and a cache holding what was read. That is the difference between a window with an editor
 * in it and a window that can only look — a page with no path behind it has nowhere to save to.
 */
function HtmlWindowFixture() {
  const fileRef = React.useRef(htmlFixtureDoc)
  const [saved, setSaved] = React.useState('')
  /** What the badge's "Open in browser" asked for — the menu item is what this story shows. */
  const [opened, setOpened] = React.useState('')
  const actions = React.useMemo(
    () => ({
      onReadFile: async () => fileRef.current,
      onWriteFile: async (path: string, content: string) => {
        fileRef.current = content
        setSaved(content)
        return { path }
      },
      onOpenFileInBrowser: (path: string) => setOpened(path),
    }),
    [],
  )

  return (
    <PlatformProvider actions={actions}>
      <div className="h-[520px]">
        <HTMLPreviewOverlay
          isOpen
          onClose={() => {}}
          items={[{ src: '/playground/page-window.html' }]}
          contentCache={{ '/playground/page-window.html': fileRef.current }}
          title="page-window.html"
          onSaved={(_, html) => setSaved(html)}
          /* A prop, not a platform action: the overlay is handed the browser it should use —
             `MarkdownHtmlBlock` passes `platform.onOpenFileInBrowser` here. */
          onOpenInBrowser={(path) => setOpened(path)}
        />
      </div>
      <div className="p-2 text-[12px] text-muted-foreground">
        Saved bytes: <span data-testid="window-saved">{saved.length}</span>
        {opened && <span> · open in browser: {opened}</span>}
      </div>
    </PlatformProvider>
  )
}

/**
 * The document a person was actually editing when the editor broke — a real README with lists and a
 * wide table, copied here verbatim rather than retyped, because the failure is in what those lines
 * parse to.
 */
function ReadmeProbeFixture() {
  const fileRef = React.useRef(readmeProbe.doc)
  const [saved, setSaved] = React.useState('')
  const actions = React.useMemo(
    () => ({
      onReadFile: async () => fileRef.current,
      onWriteFile: async (path: string, content: string) => {
        fileRef.current = content
        setSaved(content)
        return { path }
      },
    }),
    [],
  )

  return (
    <PlatformProvider actions={actions}>
      <div className="flex h-[560px] flex-col overflow-hidden rounded-lg border border-border">
        <MarkdownEditorPane src="/playground/readme-probe.md" mode="edit" className="px-6 py-4" />
      </div>
      <div className="p-2 text-[12px] text-muted-foreground">
        Saved bytes: <span data-testid="readme-saved">{saved.length}</span>
      </div>
    </PlatformProvider>
  )
}

export const markdownComponents: ComponentEntry[] = [
  {
    id: 'markdown',
    name: 'Markdown',
    category: 'Markdown',
    description: 'Customizable markdown renderer with three render modes: terminal, minimal, full',
    component: Markdown,
    layout: 'top',
    props: [
      {
        name: 'children',
        description: 'Markdown content to render',
        control: { type: 'textarea', rows: 10 },
        defaultValue: sampleMarkdown,
      },
      {
        name: 'mode',
        description: 'Render mode controlling formatting level',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'minimal',
      },
      {
        name: 'collapsible',
        description: 'Enable collapsible headings',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Terminal', props: { children: sampleMarkdown, mode: 'terminal' } },
      { name: 'Minimal', props: { children: sampleMarkdown, mode: 'minimal' } },
      { name: 'Full', props: { children: sampleMarkdown, mode: 'full' } },
      { name: 'Code Heavy', props: { children: codeHeavyMarkdown, mode: 'minimal' } },
      { name: 'Collapsible', props: { children: sampleMarkdown, mode: 'full', collapsible: true } },
    ],
    mockData: () => ({
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
    wrapper: CollapsibleWrapper,
  },
  {
    id: 'code-block',
    name: 'CodeBlock',
    category: 'Markdown',
    description: 'Syntax highlighted code block using Shiki with copy button',
    component: CodeBlock,
    props: [
      {
        name: 'code',
        description: 'Code to display',
        control: { type: 'textarea', rows: 8 },
        defaultValue: typescriptCode,
      },
      {
        name: 'language',
        description: 'Programming language for syntax highlighting',
        control: {
          type: 'select',
          options: [
            { label: 'TypeScript', value: 'typescript' },
            { label: 'JavaScript', value: 'javascript' },
            { label: 'Python', value: 'python' },
            { label: 'JSON', value: 'json' },
            { label: 'Bash', value: 'bash' },
            { label: 'Plain Text', value: 'text' },
          ],
        },
        defaultValue: 'typescript',
      },
      {
        name: 'mode',
        description: 'Render mode',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'TypeScript Full', props: { code: typescriptCode, language: 'typescript', mode: 'full' } },
      { name: 'TypeScript Minimal', props: { code: typescriptCode, language: 'typescript', mode: 'minimal' } },
      { name: 'Python', props: { code: pythonCode, language: 'python', mode: 'full' } },
      { name: 'JSON', props: { code: jsonCode, language: 'json', mode: 'full' } },
    ],
  },
  {
    id: 'inline-code',
    name: 'InlineCode',
    category: 'Markdown',
    description: 'Styled inline code span with subtle background and border',
    component: InlineCode,
    props: [
      {
        name: 'children',
        description: 'Code text',
        control: { type: 'string' },
        defaultValue: 'const x = 42',
      },
    ],
    variants: [
      { name: 'Variable', props: { children: 'useState' } },
      { name: 'Function', props: { children: 'handleClick()' } },
      { name: 'Type', props: { children: 'React.FC<Props>' } },
      { name: 'Path', props: { children: 'src/components/App.tsx' } },
    ],
  },
  {
    id: 'datatable-block',
    name: 'MarkdownDatatableBlock',
    category: 'Markdown',
    description: 'Interactive data table with sorting for ```datatable code blocks',
    component: MarkdownDatatableBlock,
    props: [
      {
        name: 'code',
        description: 'JSON string with columns and rows',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          title: 'Sales by Region',
          columns: [
            { key: 'region', label: 'Region', type: 'text' },
            { key: 'revenue', label: 'Revenue', type: 'currency' },
            { key: 'growth', label: 'Growth', type: 'percent' },
            { key: 'units', label: 'Units Sold', type: 'number' },
            { key: 'status', label: 'Status', type: 'badge' },
          ],
          rows: [
            { region: 'North America', revenue: 1250000, growth: 0.124, units: 8420, status: 'Active' },
            { region: 'Europe', revenue: 980000, growth: 0.087, units: 6230, status: 'Active' },
            { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, units: 12100, status: 'Active' },
            { region: 'Latin America', revenue: 420000, growth: -0.032, units: 2800, status: 'Revoked' },
            { region: 'Middle East', revenue: 310000, growth: 0.156, units: 1900, status: 'Active' },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Sales Data',
        props: {
          code: JSON.stringify({
            title: 'Sales by Region',
            columns: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'revenue', label: 'Revenue', type: 'currency' },
              { key: 'growth', label: 'Growth', type: 'percent' },
              { key: 'status', label: 'Status', type: 'badge' },
            ],
            rows: [
              { region: 'North America', revenue: 1250000, growth: 0.124, status: 'Active' },
              { region: 'Europe', revenue: 980000, growth: 0.087, status: 'Active' },
              { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, status: 'Active' },
              { region: 'Latin America', revenue: 420000, growth: -0.032, status: 'Revoked' },
            ],
          }),
        },
      },
      {
        name: 'Boolean & Badge Types',
        props: {
          code: JSON.stringify({
            title: 'API Keys',
            columns: [
              { key: 'name', label: 'Name', type: 'text' },
              { key: 'active', label: 'Active', type: 'boolean' },
              { key: 'status', label: 'Status', type: 'badge' },
            ],
            rows: [
              { name: 'Production', active: true, status: 'Passing' },
              { name: 'Staging', active: true, status: 'Passing' },
              { name: 'Legacy', active: false, status: 'Failed' },
            ],
          }),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'spreadsheet-block',
    name: 'MarkdownSpreadsheetBlock',
    category: 'Markdown',
    description: 'Excel-style grid with column letters and row numbers for ```spreadsheet code blocks',
    component: MarkdownSpreadsheetBlock,
    props: [
      {
        name: 'code',
        description: 'JSON string with columns and rows',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          filename: 'Q1_Revenue.xlsx',
          sheetName: 'Summary',
          columns: [
            { key: 'region', label: 'Region', type: 'text' },
            { key: 'q1', label: 'Q1', type: 'currency' },
            { key: 'q2', label: 'Q2', type: 'currency' },
            { key: 'change', label: 'Change', type: 'percent' },
            { key: 'total', label: 'Total', type: 'formula' },
          ],
          rows: [
            { region: 'North', q1: 500000, q2: 620000, change: 0.24, total: 1120000 },
            { region: 'South', q1: 340000, q2: 310000, change: -0.088, total: 650000 },
            { region: 'East', q1: 780000, q2: 850000, change: 0.09, total: 1630000 },
            { region: 'West', q1: 420000, q2: 480000, change: 0.143, total: 900000 },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Revenue Sheet',
        props: {
          code: JSON.stringify({
            filename: 'Q1_Revenue.xlsx',
            sheetName: 'Summary',
            columns: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'q1', label: 'Q1', type: 'currency' },
              { key: 'q2', label: 'Q2', type: 'currency' },
              { key: 'change', label: 'Change', type: 'percent' },
            ],
            rows: [
              { region: 'North', q1: 500000, q2: 620000, change: 0.24 },
              { region: 'South', q1: 340000, q2: 310000, change: -0.088 },
              { region: 'East', q1: 780000, q2: 850000, change: 0.09 },
            ],
          }),
        },
      },
      {
        name: 'Simple Sheet (No Filename)',
        props: {
          code: JSON.stringify({
            columns: [
              { key: 'item', label: 'Item', type: 'text' },
              { key: 'qty', label: 'Quantity', type: 'number' },
              { key: 'price', label: 'Price', type: 'currency' },
            ],
            rows: [
              { item: 'Widget A', qty: 100, price: 29 },
              { item: 'Widget B', qty: 250, price: 15 },
              { item: 'Widget C', qty: 50, price: 89 },
            ],
          }),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'image-card-stack',
    name: 'ImageCardStack',
    category: 'Markdown',
    description: 'Swipeable card stack used for image gallery previews.',
    component: ImageCardStackPlayground,
    layout: 'full',
    props: [
      {
        name: 'items',
        description: 'Gallery items with optional aspect ratio values (width/height).',
        control: { type: 'textarea', rows: 10 },
        defaultValue: JSON.stringify([
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
        ], null, 2),
      },
      {
        name: 'maxRotate',
        description: 'Maximum baseline random card rotation in degrees.',
        control: { type: 'number', min: 0, max: 16, step: 1 },
        defaultValue: 5,
      },
    ],
    variants: [
      {
        name: 'Mixed Ratios',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
          ], null, 2),
          maxRotate: 5,
        },
      },
      {
        name: 'Large Gallery',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Shot 1', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Shot 2', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Shot 3', ratio: 16 / 9 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-4.png'], label: 'Shot 4', ratio: 3 / 4 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-5.png'], label: 'Shot 5', ratio: 4 / 3 },
          ], null, 2),
          maxRotate: 7,
        },
      },
      {
        name: 'Subtle Rotation',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'One', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Two', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Three', ratio: 4 / 3 },
          ], null, 2),
          maxRotate: 2,
        },
      },
    ],
  },
  {
    id: 'markdown-image-block',
    name: 'MarkdownImageBlock',
    category: 'Markdown',
    description: 'Renders ```image-preview blocks with card-stack galleries and fullscreen overlay support.',
    component: MarkdownImageBlock,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'code',
        description: 'JSON spec for image-preview block.',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          title: 'Image Gallery',
          items: [
            { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
            { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
            { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Single Image',
        props: {
          code: JSON.stringify({
            title: 'Single Image',
            src: '/mock/images/gallery-1.png',
          }, null, 2),
        },
      },
      {
        name: 'Gallery Stack',
        props: {
          code: JSON.stringify({
            title: 'Gallery Stack',
            items: [
              { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
              { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
              { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
              { src: '/mock/images/gallery-4.png', label: 'City', ratio: 4 / 3 },
            ],
          }, null, 2),
        },
      },
      {
        name: 'Unknown Path Error',
        props: {
          code: JSON.stringify({
            title: 'Missing Image',
            items: [
              { src: '/mock/images/gallery-1.png', label: 'Found' },
              { src: '/mock/images/does-not-exist.png', label: 'Missing' },
            ],
          }, null, 2),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'markdown-editor-pane',
    name: 'MarkdownEditorPane',
    category: 'Markdown',
    description: 'The markdown pane on its source face, with a host that reads and writes a file of its own — where a keystroke that does not land, or a caret that jumps, is visible.',
    component: MarkdownEditorPaneFixture,
    layout: 'top',
    props: [],
  },
  {
    id: 'markdown-editor-source',
    name: 'MarkdownEditorPane (source)',
    category: 'Markdown',
    description: 'The same document on its source face — the way back to plain text, where nothing is drawn for a fence.',
    component: MarkdownEditorSourceFixture,
    layout: 'top',
    props: [],
  },
  {
    id: 'readme-probe',
    name: 'MarkdownEditorPane (README probe)',
    category: 'Markdown',
    description: 'A real document with lists and a wide table — the failure is in what those lines parse to.',
    component: ReadmeProbeFixture,
    layout: 'top',
    props: [],
  },
  {
    id: 'html-window',
    name: 'HTMLPreviewOverlay (file window)',
    category: 'Markdown',
    description: 'A page opened in a window, given a path: the way in to the visual editor and to its source.',
    component: HtmlWindowFixture,
    layout: 'top',
    props: [],
  },
  {
    id: 'source-file-pane',
    name: 'SourceFilePane',
    category: 'Markdown',
    description: 'A page edited as its own source: the face a visual editor cannot give — a style block, an attribute, a comment.',
    component: SourceFilePaneFixture,
    layout: 'top',
    props: [],
  },
  {
    id: 'rich-block-interaction-parity',
    name: 'RichBlockInteractionParity',
    category: 'Markdown',
    description: 'Single playground fixture to verify inline + fullscreen interaction parity across Mermaid and image-preview blocks.',
    component: Markdown,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'children',
        description: 'Markdown fixture for parity checks',
        control: { type: 'textarea', rows: 20 },
        defaultValue: richBlockParityMarkdown,
      },
      {
        name: 'mode',
        description: 'Render mode controlling formatting level',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'Parity Fixture', props: { children: richBlockParityMarkdown, mode: 'full' } },
    ],
    mockData: () => ({
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
  },
]
