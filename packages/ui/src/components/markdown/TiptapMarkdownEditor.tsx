import * as React from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from './extensions/AnimatedTaskItem'
import { BlockMathMarkdown, InlineMathMarkdown } from './extensions/InlineMathMarkdown'
import { AgentPresence } from './extensions/AgentPresence'
import { CalloutBlockquote } from './extensions/CalloutBlockquote'
import { DocumentImage, resolveDocumentPictures } from './extensions/DocumentImage'
import FileHandler from '@tiptap/extension-file-handler'
import { TableRow } from '@tiptap/extension-table'
import { AlignedTable, AlignedTableCell, AlignedTableHeader } from './extensions/TableAlignment'
import { Markdown as OfficialMarkdown } from '@tiptap/markdown'
import { Markdown as LegacyMarkdown } from 'tiptap-markdown'
import { tiptapCodeBlock } from './TiptapCodeBlockView'
import { TiptapBubbleMenus, INLINE_MATH_EDIT_EVENT } from './TiptapBubbleMenus'
import { TiptapSlashMenu } from './TiptapSlashMenu'
import { MermaidBlock } from './extensions/MermaidBlock'
import { MindmapBlock } from './extensions/MindmapBlock'
import { looksLikeMermaidSource } from './mermaid-source'
import { isMindmapSource } from '@craft-agent/core/mermaid/mindmap'
import { LatexBlock } from './extensions/LatexBlock'
import { PreviewBlock } from './extensions/PreviewBlock'
import { LiteralBlock } from './extensions/LiteralBlock'
import { RichBlockInteractions } from './extensions/RichBlockInteractions'
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { MarkdownFenceViewProvider } from './fence-view-context'
import { resolveMarkdownLinkTarget } from './link-target'
import { resolveDocumentPath } from './document-path'
import { landMarkdown } from '../editors/markdown-land'
import { parseDocText, serializeDocText } from '../editors/markdown-envelope'
import { buildBlockTable, type BlockTable, type BlockBridge } from '../editors/block-table'
import { bridgeOf, saveBlocks } from '../editors/markdown-save'
import { blocksToDocument } from '../editors/block-parse'
import { blockTexts, layoutMarkdown } from '../editors/markdown-blocks'
import { applyTextEdit, liveTextOf, registerTextEditTarget, type TextEditRequest, type TextEditResult } from '../editors/text-edits'
import { syncVerdict } from '../editors/markdown-sync'
import { cn } from '../../lib/utils'
import 'katex/dist/katex.min.css'
import './tiptap-editor.css'
import './extensions/animated-task-item.css'

export type MarkdownEngine = 'legacy' | 'official'


function getLegacyMarkdown(editor: { storage: { markdown?: { getMarkdown?: () => string } } }): string {
  return editor.storage.markdown?.getMarkdown?.() ?? ''
}

function getOfficialMarkdown(editor: { getMarkdown?: () => string }): string {
  return editor.getMarkdown?.() ?? ''
}

function forceShikiDecorations(editor: any) {
  try {
    if (editor?.isDestroyed) return
    const tr = editor.view?.state.tr.setMeta('shikiPluginForceDecoration', true)
    if (tr) {
      editor.view?.dispatch(tr)
    }
  } catch {
    // Best-effort refresh only.
  }
}

/** Whether this document has anything for Shiki to paint — a fenced code block. */
function hasCodeBlock(editor: any): boolean {
  try {
    let found = false
    editor?.state?.doc?.descendants((node: any) => {
      if (found) return false
      if (node?.type?.name === 'codeBlock') {
        found = true
        return false
      }
      return true
    })
    return found
  } catch {
    // A document that cannot be inspected keeps the old best-effort behaviour.
    return true
  }
}

function scheduleShikiRefresh(editor: any, options: { once?: boolean } = {}) {
  // A document with no code has nothing for Shiki to paint. Forcing the decoration anyway
  // dispatched four whole-document transactions (now, then at 80/220/450 ms) for every plain
  // note opened — the stutter that was reported on opening a `.md`.
  if (!hasCodeBlock(editor)) return
  forceShikiDecorations(editor)
  // A large document built in batches only needs the pass that saw the whole document.
  if (options.once) return

  for (const delay of [80, 220, 450]) {
    setTimeout(() => {
      forceShikiDecorations(editor)
    }, delay)
  }
}

/**
 * Above this, the reading face is built in batches.
 *
 * One `setContent` with a whole 300 KB file meant one commit building ~800 blocks and ~30k inline
 * nodes — measured at 2.1 s of ProseMirror DOM work. Tiptap's own recipe for large documents is to
 * insert chunks progressively; each batch is then one short task and the window stays responsive.
 */
const LARGE_READING_CHARS = 120_000
const READING_BATCH_BLOCKS = 50

/** Run after the current work — a batch is one short task, and this must progress even when the window is in the background. */
function scheduleTask(callback: () => void): () => void {
  const id = window.setTimeout(callback, 0)
  return () => window.clearTimeout(id)
}

/**
 * The code mark excludes every other mark in the schema. The markdown parser can still produce
 * `**`code`**` as text carrying both `bold` and `code`; `setContent` accepts it, but the batch
 * insert path validates the JSON and throws `Invalid collection of marks`. Keep the code mark —
 * the code is the part that must survive — and drop the ones it excludes.
 */
function keepReadableMarks(node: unknown): void {
  if (!node || typeof node !== 'object') return
  const current = node as { type?: string; marks?: Array<{ type?: string }>; content?: unknown[] }
  if (current.type === 'text' && Array.isArray(current.marks)) {
    const code = current.marks.find((mark) => mark?.type === 'code')
    if (code) current.marks = [code]
  }
  if (Array.isArray(current.content)) {
    for (const child of current.content) keepReadableMarks(child)
  }
}

const INLINE_DOUBLE_DOLLAR_REGEX = /\$\$([^\n]+?)\$\$/g
// Currency marker used during official parse to avoid accidental math tokenization.
const CURRENCY_MARKER = '¤'
const CURRENCY_RANGE_REGEX = /\$(\d[\dA-Za-z.,]*\s*[–-]\s*)\$(\d[\dA-Za-z.,]*)/g
const CURRENCY_AMOUNT_REGEX = /\$(\d[\dA-Za-z.,]*)/g

/**
 * Normalize markdown for official TipTap parser:
 * - Keep product policy: users write math with $$...$$
 * - Convert same-line $$...$$ to inline $...$ (TipTap inline math)
 * - Escape currency-like dollars ($100, $2M...) so they don't become inline math nodes
 */
export function preprocessMarkdownForOfficial(markdown: string): string {
  let index = 0
  const placeholders = new Map<string, string>()

  const withPlaceholders = markdown.replace(INLINE_DOUBLE_DOLLAR_REGEX, (_, latex: string) => {
    const key = `@@CA_INLINE_MATH_${index++}@@`
    placeholders.set(key, latex)
    return key
  })

  const rangeProtected = withPlaceholders.replace(
    CURRENCY_RANGE_REGEX,
    (_match, left: string, right: string) => `${CURRENCY_MARKER}${left}${CURRENCY_MARKER}${right}`
  )

  const amountProtected = rangeProtected.replace(
    CURRENCY_AMOUNT_REGEX,
    (_match, amount: string) => `${CURRENCY_MARKER}${amount}`
  )

  return amountProtected.replace(/@@CA_INLINE_MATH_\d+@@/g, (key) => {
    const latex = placeholders.get(key) ?? ''
    return `$${latex}$`
  })
}

/** Undo parser-safety escaping in serialized markdown. */
export function postprocessMarkdownFromOfficial(markdown: string): string {
  return markdown.replaceAll(CURRENCY_MARKER, '$')
}

const MERMAID_FILE_EXTENSIONS = new Set(['mmd', 'mermaid'])

export function isMermaidFilename(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop()
  return ext != null && MERMAID_FILE_EXTENSIONS.has(ext)
}

export function extractMermaidSource(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const fenced = trimmed.match(/^```mermaid\s*\n([\s\S]*?)\n```$/i)
  if (fenced?.[1]) {
    const source = fenced[1].trim()
    return source.length > 0 ? source : null
  }

  return looksLikeMermaidSource(trimmed) ? trimmed : null
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('Failed to read file as data URL'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

async function readImageDimensions(src: string): Promise<{ width: number; height: number } | null> {
  return await new Promise((resolve) => {
    const image = new globalThis.Image()
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        resolve(null)
        return
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => resolve(null)
    image.src = src
  })
}

function insertDiagramBlock(editor: NonNullable<ReturnType<typeof useEditor>>, source: string, pos?: number) {
  // A pasted mindmap is written back as the fence it is; only the node type differs.
  const payload = isMindmapSource(source)
    ? { type: 'mindmapBlock', attrs: { code: source } }
    : { type: 'mermaidBlock', attrs: { code: source } }

  const chain = editor.chain().focus()
  if (typeof pos === 'number') chain.setTextSelection(pos)
  chain.insertContent(payload).run()
}

function insertImageNode(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  src: string,
  pos?: number,
  dimensions?: { width: number; height: number } | null,
) {
  const chain = editor.chain().focus()
  if (typeof pos === 'number') chain.setTextSelection(pos)
  chain.setImage({
    src,
    ...(dimensions?.width && dimensions?.height
      ? { width: dimensions.width, height: dimensions.height }
      : {}),
  }).run()
}

async function handleDroppedOrPastedFiles(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  files: File[],
  pos?: number,
): Promise<void> {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const src = await readFileAsDataUrl(file)
      const dimensions = await readImageDimensions(src)
      insertImageNode(editor, src, pos, dimensions)
      continue
    }

    if (!isMermaidFilename(file.name)) continue
    const text = await file.text()
    const source = extractMermaidSource(text) ?? text.trim()
    if (!source) continue
    insertDiagramBlock(editor, source, pos)
  }
}

export interface TiptapMarkdownEditorProps {
  /** Markdown string content */
  content: string
  /** Called when content changes */
  onUpdate?: (markdown: string) => void
  /** Placeholder text when empty */
  placeholder?: string
  className?: string
  /** Whether the editor is editable */
  editable?: boolean
  /**
   * Whether the caret goes into the document when this editor appears.
   *
   * For the case where the document was opened *to be typed in* rather than to be read — the
   * full-size window a block's pencil opens, as against the same window opened by its full-screen
   * button. It is an event and not a state: the caret goes in once, on the mount that opened it,
   * because a later render taking the caret back would be fighting whoever is typing. It goes to
   * the start, which is where a document being edited is read from.
   */
  autoFocus?: boolean
  /**
   * Migration flag for markdown engine foundations.
   * - `legacy`: tiptap-markdown (default for safe rollout)
   * - `official`: @tiptap/markdown + mathematics extension
   */
  markdownEngine?: MarkdownEngine
  /**
   * Where a click on a link goes.
   *
   * A link in these documents is usually a path — to a diagram, a sibling document — and the
   * app, not the browser, is what can open one. Whatever these do not claim is left to the
   * editor, and there is deliberately no fallback: a document that opened a random address
   * because nobody said what a link meant would be worse than a link that does nothing.
   */
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
  /**
   * The file this document came from, when it is a real one.
   *
   * Naming it registers this editor as the place an edit addressed to that path lands (`text-edits.ts`), which is
   * what lets an agent change the document a person has open without going through the disk: the change becomes one
   * step of this editor's history, the caret is mapped through it, and their unsaved work is still theirs.
   */
  documentPath?: string
  /**
   * The folder the document lives in, and the host's read for a picture beside it.
   *
   * A relative `![](pics/a.png)` is a path in the *document's* folder, not in the app's origin — so it is read through
   * the platform and drawn as a data URL, exactly as the reading face does it. What is drawn is a data URL; what is
   * *saved* is still `pics/a.png` (see `DocumentImage`).
   */
  baseDir?: string
  readFileDataUrl?: (path: string) => Promise<string>
  /**
   * **Reading**, not editing: the same document, drawn by the same nodes, for a file nobody is typing in.
   *
   * This is the reading face of a `.md` file, the artwork poster, and `markdown_tool shot` — one renderer for all three,
   * so a document cannot look like one thing when it is read and another when it is edited. What changes is only what
   * the reading face needs and the editing face must not have:
   *
   * - `editable` is forced off, and the editor stops being importable: no placeholder, no slash menu, no bubble menus,
   *   no agent-presence wash, no file drop.
   * - **Blocks are live.** A diagram can be opened, a table sorted — the mouse belongs to the block, not to a caret
   *   (`PreviewBlock` reads `editor.isEditable`).
   * - **A block the engine cannot carry is drawn by the reader** (`literalBlock` → `Markdown`) instead of being shown as
   *   its own source: raw HTML, an angle-bracket autolink. In an editor that would be a typing surface; here it is a
   *   regression, because the reading face has always drawn them.
   * - A new `content` rebuilds the document whole. There is no caret to keep, and no save to write back.
   */
  presentation?: boolean
  /**
   * Drawings this host refuses, by fence name — a poster's `NOT_DRAWN`, a file's "no document nested in a document".
   *
   * Read by the node views through `fence-view-context`; suppressed blocks draw nothing rather than their subject.
   */
  suppressedFenceDrawings?: ReadonlySet<string>
  /**
   * How the reading face draws a block the engine cannot carry (`literalBlock`) — normally `Markdown`, supplied by the
   * host so this component does not depend on the reader. Unused while editing: that path keeps such a block as
   * editable text.
   */
  renderLiteralBlock?: (text: string) => React.ReactNode
}

export function TiptapMarkdownEditor({
  content,
  onUpdate,
  placeholder = 'Write something...',
  className,
  editable = true,
  autoFocus = false,
  markdownEngine = 'legacy',
  onUrlClick,
  onFileClick,
  documentPath,
  baseDir,
  readFileDataUrl,
  presentation = false,
  suppressedFenceDrawings,
  renderLiteralBlock,
}: TiptapMarkdownEditorProps) {
  /** Reading: no caret, no menus, live blocks, and the reader draws what the engine cannot carry. */
  const reading = presentation
  const canEdit = editable && !reading
  const onUpdateRef = React.useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onUrlClickRef = React.useRef(onUrlClick)
  const onFileClickRef = React.useRef(onFileClick)
  onUrlClickRef.current = onUrlClick
  onFileClickRef.current = onFileClick

  // Ref for the editor instance — used by the Mathematics onClick callback
  // which is created at extension-configure time (before useEditor returns).
  const editorRef = React.useRef<ReturnType<typeof useEditor>>(null!)

  const useOfficialMarkdown = markdownEngine === 'official'

  const extensions = React.useMemo(() => {
    const base = [
      StarterKit.configure({
        codeBlock: false,
        // Replaced below by the same node with a callout on it: `> [!NOTE]` has to mean one thing in both faces.
        blockquote: false,
        heading: { levels: [1, 2, 3] },
        // Links are followed by this component rather than by the browser: an `<a>` inside a
        // document here is a path in the workspace, and the app is what knows how to open one.
        link: { openOnClick: false },
      }),
      CalloutBlockquote,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      // Tables are how these documents are argued — a requirement and what covers it, side by
      // side. Without a table node the parser has nowhere to put one, and it is not the display
      // that suffers: the rows are gone from the document, so saving the file would delete them.
      // The `Aligned*` versions are the same nodes with GFM's column alignment on the cells (see
      // `extensions/TableAlignment.ts` — upstream TipTap ≥ 3.21 has this built in).
      AlignedTable,
      TableRow,
      AlignedTableHeader,
      AlignedTableCell,
      tiptapCodeBlock.configure({
        themes: { light: 'github-light', dark: 'github-dark' },
      }),
      MermaidBlock,
      MindmapBlock,
      LatexBlock,
      // The fences the app draws as something other than code — a diagram, a page, a table —
      // which `Markdown` has always drawn this way, and which an editor that saves the file has
      // to keep as fences rather than flat text.
      PreviewBlock,
      /*
       * A block the engine cannot carry, handed back to the reader (`literalBlock`). Registered in both faces so the
       * schema can hold one; only the reading face builds them.
       */
      LiteralBlock,
      DocumentImage.configure({
        inline: false,
        allowBase64: true,
      }),
      RichBlockInteractions,
      // The rest is what typing needs: a placeholder, dropped files, the slash menu, and the agent's own wash.
      ...(reading
        ? []
        : [
            Placeholder.configure({ placeholder }),
            FileHandler.configure({
              onPaste: async (editor, files) => {
                if (!canEdit || files.length === 0) return
                await handleDroppedOrPastedFiles(editor as NonNullable<ReturnType<typeof useEditor>>, files)
              },
              onDrop: async (editor, files, pos) => {
                if (!canEdit || files.length === 0) return
                await handleDroppedOrPastedFiles(editor as NonNullable<ReturnType<typeof useEditor>>, files, pos)
              },
            }),
            /*
             * Display-only, and last: it decorates what the other extensions produced. Its marks have a **deadline** —
             * set by the agent's own transaction and never moved by typing (`expiresAt` in the extension) — so the wash
             * and the "Craft Agent" caret are gone 8 s later, whatever the person does in the meantime.
             */
            AgentPresence,
            ...(canEdit ? [TiptapSlashMenu] : []),
          ]),
    ]

    if (useOfficialMarkdown) {
      return [
        ...base,
        /*
         * The stock `Mathematics` bundle would do, except for its inline tokenizer: it reads neither `$$…$$` on one line
         * (the form these documents are written in) nor money (`$100` became a formula). `InlineMathMarkdown` is that
         * node with a tokenizer that fixes both; `BlockMath` is unchanged, and `$$…$$` on its own line is still its.
         */
        BlockMathMarkdown.configure({
          katexOptions: {
            throwOnError: false,
            strict: false,
          },
        }),
        InlineMathMarkdown.configure({
          onClick: (_node, pos) => {
            const e = editorRef.current
            if (!e) return
            e.chain().focus().setNodeSelection(pos).run()
            // Emit after selection so BubbleMenu mounts, then the event activates the input
            queueMicrotask(() => (e as any).emit(INLINE_MATH_EDIT_EVENT))
          },
          katexOptions: {
            throwOnError: false,
            strict: false,
          },
        }),
        OfficialMarkdown.configure({
          markedOptions: {
            gfm: true,
          },
        }),
      ]
    }

    return [
      ...base,
      LegacyMarkdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ]
  }, [placeholder, useOfficialMarkdown, reading, canEdit])

  /**
   * The file's own parts — YAML frontmatter, line endings, trailing newline, BOM — kept out of the document.
   *
   * A `SKILL.md` opens with frontmatter, and the markdown parser reads it as a thematic break plus a heading: one
   * file block would become two nodes, and every block splice in this editor is built on those staying one to one.
   * So the document is built from the body alone and the envelope is re-attached whenever the editor hands text
   * back. The person editing the body can therefore never damage the metadata above it.
   */
  const envelopeRef = React.useRef(parseDocText(content))
  /**
   * What the document is made of, and what each block looked like when it was last written.
   *
   * Saving is a question about blocks (*did this one change?*), not about strings: a block nobody edited keeps the
   * file's exact bytes even when its serialization would differ — a table, whose columns the serializer pads. The
   * table is what makes that distinction possible, and it is rebuilt whenever the document is.
   */
  const tableRef = React.useRef<BlockTable | null>(null)

  /** The editor instance whose document has been built — so the build happens exactly once, whoever calls it. */
  const builtRef = React.useRef<unknown>(null)

  /**
   * A reading build that is still inserting its batches.
   *
   * Every new build (a re-read, a different file) cancels the previous pump: two pumps appending
   * into the same document would duplicate blocks. The cleanup also runs on unmount.
   */
  const readingCancelRef = React.useRef<(() => void) | null>(null)
  const baseDirRef = React.useRef(baseDir)
  baseDirRef.current = baseDir
  const readFileDataUrlRef = React.useRef(readFileDataUrl)
  readFileDataUrlRef.current = readFileDataUrl
  const cancelReadingBuild = React.useCallback(() => {
    readingCancelRef.current?.()
    readingCancelRef.current = null
  }, [])
  React.useEffect(() => () => cancelReadingBuild(), [cancelReadingBuild])

  /**
   * The reading face, built the way Tiptap recommends for large documents: a first batch paints,
   * the rest are appended with `insertContentAt` in idle slices. Each insertion is one small
   * transaction, so no single commit has to build the whole document.
   */
  const applyReadingDocument = React.useCallback(
    (target: NonNullable<ReturnType<typeof useEditor>>, body: string, bridge: BlockBridge) => {
      cancelReadingBuild()
      const blocks = blockTexts(layoutMarkdown(body))
      if (blocks.length === 0) {
        target.commands.setContent({ type: 'doc', content: [] } as never, { emitUpdate: false } as never)
        return
      }

      const batched = body.length > LARGE_READING_CHARS
      const batchSize = batched ? READING_BATCH_BLOCKS : blocks.length
      const literalAs = 'literalBlock'

      const nodesFor = (from: number, to: number) => {
        const nodes: ProseMirrorNode[] = []
        for (const block of blocks.slice(from, to)) {
          const built = blocksToDocument(bridge, [block], { literalAs })
          const json = built.content[0]
          keepReadableMarks(json)
          try {
            const node = target.schema.nodeFromJSON(json as never)
            node.check()
            nodes.push(node)
          } catch {
            // A construct the parser produced but the schema will not accept: show the block as
            // its own text, which is the reading face's literal-block answer too.
            nodes.push(target.schema.nodeFromJSON({ type: 'literalBlock', attrs: { text: block.trim() } } as never))
          }
        }
        return Fragment.fromArray(nodes)
      }

      const write = (from: number, to: number, first: boolean) => {
        const fragment = nodesFor(from, to)
        if (first) {
          target.commands.setContent(fragment as never, { emitUpdate: false } as never)
        } else {
          target.commands.insertContentAt(target.state.doc.content.size, fragment as never, {
            updateSelection: false,
          } as never)
        }
      }

      const firstEnd = Math.min(batchSize, blocks.length)
      write(0, firstEnd, true)
      let index = firstEnd
      if (index >= blocks.length) {
        queueMicrotask(() => {
          if (!target.isDestroyed) scheduleShikiRefresh(target, { once: batched })
        })
        return
      }

      const pump = () => {
        readingCancelRef.current = null
        if (target.isDestroyed) return
        try {
          const end = Math.min(index + batchSize, blocks.length)
          write(index, end, false)
          index = end
        } catch {
          // A batch the schema still refuses stops the growth rather than taking the window down.
          return
        }
        if (index < blocks.length) {
          readingCancelRef.current = scheduleTask(pump)
          return
        }
        // Pictures can appear in any batch; the whole document exists only now.
        resolveDocumentPictures(target, baseDirRef.current, readFileDataUrlRef.current)
        queueMicrotask(() => {
          if (!target.isDestroyed) scheduleShikiRefresh(target, { once: true })
        })
      }
      readingCancelRef.current = scheduleTask(pump)
    },
    [cancelReadingBuild],
  )

  /**
   * The document on screen, built from the file's blocks — one block per node, never by handing the engine the file.
   *
   * **Built before the first paint, and not in `onCreate`.** TipTap emits `create` from a `setTimeout(…, 0)` (`mount`
   * in `@tiptap/core`), so a document built there lands one macrotask *after* the first paint: the edit face drew an
   * empty page for a frame (reported as the window flashing) and — worse — the caret `autoFocus` had already put at
   * position 1 of that empty document was then mapped to the **end** of the real one, because a whole-document
   * replacement maps a selection inside the replaced range to the end of the new content. Measured in the app:
   * `mount sel=1 size=2` → one transaction, no `uiEvent` → `sel=1365 size=1366`.
   *
   * A layout effect runs before the paint, and `editor.markdown` is already there by then — the markdown extension
   * attaches it in `onBeforeCreate`. `onCreate` still calls this, and is a no-op when the document is already built.
   */
  const buildDocument = React.useCallback(
    (target: NonNullable<ReturnType<typeof useEditor>>) => {
      if (builtRef.current === target) return
      // A view is what a command dispatches through; without one, `onCreate` (which runs after the mount) builds it.
      if (!target.view) return
      const bridge = bridgeOf(target)
      if (!bridge) return
      builtRef.current = target
      const body = envelopeRef.current.body
      if (reading) {
        // Batches: the first paints now, the rest arrive in idle slices (see `applyReadingDocument`).
        applyReadingDocument(target, body, bridge)
        tableRef.current = null
        return
      }
      const blocks = blockTexts(layoutMarkdown(body))
      target.commands.setContent(blocksToDocument(bridge, blocks) as never, { emitUpdate: false } as never)
      tableRef.current = buildBlockTable(body, bridge)
      queueMicrotask(() => {
        if (!target.isDestroyed) scheduleShikiRefresh(target)
      })
    },
    [reading, applyReadingDocument],
  )

  const editor = useEditor({
    extensions,
    // Empty on purpose: the document is built block by block (`buildDocument`), because the engine's whole-file
    // parse is what drops a block it cannot represent.
    content: '',
    editable: canEdit,
    // Tiptap 3 defaults this to false; stated here because the reading face is one large document
    // and nothing in it should re-render React on every insertion batch.
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: 'tiptap-prose outline-none',
      },
      /**
       * Following a link, without taking the click away from the text.
       *
       * In an editable document a plain click on a link is how the caret gets into it, so that
       * is what it stays: the link is followed with the modifier every other editor uses, and
       * only a document nobody can type in follows one on a plain click. The `<a href>` is left
       * alone by the Link extension (`openOnClick: false`) so this is the only thing that
       * decides.
       */
      handleClick: (view, _pos, event) => {
        const anchor = (event.target as HTMLElement | null)?.closest('a')
        const href = anchor?.getAttribute('href')?.trim()
        if (!href) return false
        if (view.editable && !event.metaKey && !event.ctrlKey) return false

        event.preventDefault()
        const target = resolveMarkdownLinkTarget(href)
        if (target.kind === 'file') {
          // The editing face follows the same rule as the reading one: a link written beside the
          // document is relative to *that* document, not to the app.
          onFileClickRef.current?.(resolveDocumentPath(baseDirRef.current, target.path) ?? target.path)
        } else onUrlClickRef.current?.(target.url)
        return true
      },
      handlePaste: (_view, event) => {
        if (!editable) return false
        if (event.clipboardData?.files?.length) return false

        const text = event.clipboardData?.getData('text/plain') ?? ''
        const source = extractMermaidSource(text)
        if (!source) return false

        const activeEditor = editorRef.current
        if (!activeEditor) return false
        insertDiagramBlock(activeEditor, source)
        return true
      },
      handleDrop: (view, event) => {
        if (!editable) return false
        if (event.dataTransfer?.files?.length) return false

        const text = event.dataTransfer?.getData('text/plain') ?? ''
        const source = extractMermaidSource(text)
        if (!source) return false

        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        const activeEditor = editorRef.current
        if (!activeEditor) return false
        insertDiagramBlock(activeEditor, source, pos)
        return true
      },
    },
    onCreate: ({ editor }) => {
      // A no-op when the layout effect got there first, which is the normal case — see `buildDocument`.
      buildDocument(editor as NonNullable<ReturnType<typeof useEditor>>)
    },
    onUpdate: ({ editor, transaction }) => {
      // A document being read has no file behind it to write: nothing on this path is an edit.
      if (reading) return
      const envelope = envelopeRef.current
      // A landing arrived from the file: writing it straight back would be echoing somebody else's save.
      if (transaction?.getMeta('agentEdit')) return

      const table = tableRef.current
      const saved = table ? saveBlocks(editor, table, transaction, postprocessMarkdownFromOfficial) : null
      if (!saved) {
        const md = useOfficialMarkdown
          ? postprocessMarkdownFromOfficial(getOfficialMarkdown(editor as { getMarkdown?: () => string }))
          : getLegacyMarkdown(editor as { storage: { markdown?: { getMarkdown?: () => string } } })
        // What the caller gets back is a *file*, so it carries the envelope the editor was never given.
        emittedRef.current = serializeDocText(envelope, md)
        onUpdateRef.current?.(emittedRef.current)
        return
      }
      tableRef.current = saved.table
      // Not `touched.length`: typing in the paragraph the editor keeps past the end touches no block of the file and is
      // still a new block in it.
      if (!saved.changed) return
      emittedRef.current = serializeDocText(envelope, saved.text)
      onUpdateRef.current?.(emittedRef.current)
    },
  }, [useOfficialMarkdown, extensions, reading])

  // Keep editorRef in sync for the Mathematics onClick callback
  editorRef.current = editor

  /*
   * The first paint already holds the document. A layout effect, because the paint is the thing being fixed: see
   * `buildDocument` (and the caret that used to be mapped to the end of the file by building it a frame later).
   */
  React.useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return
    buildDocument(editor)
  }, [editor, buildDocument])

  /**
   * A picture beside the document is drawn from the file, not from the app's origin.
   *
   * Runs when the document is built and again whenever the text outside this editor changes (an agent's write landing,
   * a reload): the two moments a picture can appear. It reads nothing twice (`DocumentImage`), and the transaction it
   * dispatches is not an edit — `src` is untouched, so the block still serializes to the file's own bytes.
   */
  React.useEffect(() => {
    if (!editor) return
    resolveDocumentPictures(editor, baseDir, readFileDataUrl)
  }, [editor, content, baseDir, readFileDataUrl])


  // Sync editable prop
  React.useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable)
    }
  }, [editor, editable])

  /**
   * The caret, once, for a document that was opened to be typed in — see `autoFocus`.
   *
   * Only into an editable document: a host with nothing to save puts a read-only document on
   * screen, and a caret in one would promise typing that cannot land anywhere.
   */
  const autoFocusedRef = React.useRef(false)
  React.useEffect(() => {
    if (!editor || !autoFocus || !canEdit || autoFocusedRef.current) return
    autoFocusedRef.current = true
    editor.commands.focus('start')
  }, [editor, autoFocus, canEdit])


  /**
   * A version of the text this editor did not type — the file changing underneath it.
   *
   * **Not `setContent`.** That is a new document: the caret, the selection and the undo stack go with the old one,
   * and it is why this editor used to ignore an outside write outright while somebody was typing (`isFocused`).
   * `landMarkdown` replaces only the blocks that differ, as one transaction in this editor's history, so an
   * agent's edit and a person's typing can finally be in the document at the same time — the person can undo the
   * agent's change, and their own caret is mapped through it.
   *
   * Falling back to `setContent` is for the case the block layer cannot serve: a legacy markdown engine with no
   * bridge to the document, or a file whose blocks no longer line up. Losing the caret is bad; splicing the wrong
   * block is worse.
   */
  /**
   * An edit addressed here — by the agent, through `text-edits.ts` — applied to the live document.
   *
   * The landing is a transaction, so it arrives with the `agentEdit` mark and is *skipped* by the save path below:
   * a change that came from outside is not a change to write back. What does have to happen is the caller hearing
   * about it, so the file follows through the same route as typing, and the block table following the document.
   */
  const applyRef = React.useRef<(request: TextEditRequest) => TextEditResult>((request) => ({
    ok: false,
    message: 'the editor is not ready',
  }))
  applyRef.current = (request) => {
    if (!editor) return { ok: false, message: 'the editor is not ready' }
    const envelope = envelopeRef.current
    const before = liveTextOf(editor, envelope)
    const result = applyTextEdit(editor, envelope, request)
    if (!result.ok) return result
    const next = parseDocText(result.text ?? '')
    // An addressed edit may carry its own frontmatter; the envelope follows the file it describes.
    if (next.frontmatter !== envelope.frontmatter) envelopeRef.current = next
    const bridge = bridgeOf(editor)
    tableRef.current = bridge ? buildBlockTable(next.body, bridge) : null
    if (result.text && result.text !== before) {
      emittedRef.current = result.text
      onUpdateRef.current?.(result.text)
    }
    return result
  }

  React.useEffect(() => {
    if (!documentPath) return
    return registerTextEditTarget(documentPath, {
      applyEdit: (request) => applyRef.current(request),
    })
  }, [documentPath])

  const prevContentRef = React.useRef(content)
  /**
   * The last text this editor handed to `onUpdate`.
   *
   * Every save comes back as a new `content` prop, and the effect has to be able to say "this is mine". Without that
   * memory it fell through to a content comparison which cannot tell an echo from an arrival: the document's own
   * serialization pads a table, so it never equals the file's body, and **every save of a document with a table**
   * landed its own edit back onto itself — a transaction marked `agentEdit`, which is what painted the wash and the
   * "Craft Agent" caret over a paragraph somebody had just bolded by hand (`markdown-sync.ts` has the measurement).
   */
  const emittedRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!editor || content === prevContentRef.current) return
    // The file the document on screen was built from — the diff's *file* side. Snapshot before overwriting.
    const previous = prevContentRef.current
    prevContentRef.current = content

    /*
     * Reading: a new document, built the way `onCreate` builds one. There is no caret to keep and no edit to land, so
     * the whole thing is replaced rather than spliced — and the literal blocks come back as literal blocks.
     */
    if (reading) {
      const next = parseDocText(content)
      envelopeRef.current = next
      const bridge = bridgeOf(editor)
      if (bridge) applyReadingDocument(editor, next.body, bridge)
      return
    }

    const envelope = parseDocText(content)
    const previousBody = parseDocText(previous).body
    // Frontmatter is not a document change: it belongs to the file, so it is taken as a fact and put back on write.
    const envelopeChanged = envelope.frontmatter !== envelopeRef.current.frontmatter
    envelopeRef.current = envelope

    const currentMd = useOfficialMarkdown
      ? postprocessMarkdownFromOfficial(getOfficialMarkdown(editor as { getMarkdown?: () => string }))
      : getLegacyMarkdown(editor as { storage: { markdown?: { getMarkdown?: () => string } } })

    const verdict = syncVerdict({ content, previous, emitted: emittedRef.current, editorMarkdown: currentMd, body: envelope.body })
    if (verdict === 'nothing') return
    if (verdict === 'echo') {
      // The body needs no transaction, but the file's metadata may have moved: say so rather than look idle.
      if (envelopeChanged) onUpdateRef.current?.(content)
      return
    }

    const landed = landMarkdown(editor, envelope.body, { current: previousBody })
    if (landed.applied) {
      // The document is a different one now (or a different part of it), so the table starts again from this body.
      const bridge = bridgeOf(editor)
      tableRef.current = bridge ? buildBlockTable(envelope.body, bridge) : null
      if (envelopeChanged) {
        // The body did not need a transaction, but the file's metadata moved: say so rather than look idle.
        onUpdateRef.current?.(content)
      }
      queueMicrotask(() => {
        if (!editor.isDestroyed) scheduleShikiRefresh(editor)
      })
      return
    }

    /*
     * The last resort: the document is replaced whole. `setContent` maps a selection that sat inside the replaced
     * range to the **end** of the new text, which is why a reload used to throw the caret to the bottom of the file
     * (reported: entering the edit face put it after the last line). Where the caret was is the only answer that
     * means anything here, so it is put back, clamped to the document it is now in.
     */
    const caret = editor.state.selection.from
    if (useOfficialMarkdown) {
      const normalized = preprocessMarkdownForOfficial(envelope.body)
      editor.commands.setContent(normalized, { contentType: 'markdown' } as never)
    } else {
      editor.commands.setContent(envelope.body)
    }
    if (editor.isFocused) {
      editor.commands.setTextSelection(Math.max(1, Math.min(caret, editor.state.doc.content.size - 1)))
    }
    queueMicrotask(() => {
      if (!editor.isDestroyed) scheduleShikiRefresh(editor)
    })
  }, [editor, content, useOfficialMarkdown, applyReadingDocument])

  /* What a fence's node view may do — read across the portal, so it is context and not props (`fence-view-context`). */
  const fenceView = React.useMemo(
    () => ({ suppressed: suppressedFenceDrawings, baseDir, onUrlClick, onFileClick, renderLiteral: renderLiteralBlock }),
    [suppressedFenceDrawings, baseDir, onUrlClick, onFileClick, renderLiteralBlock],
  )

  return (
    <MarkdownFenceViewProvider value={fenceView}>
      <div className={cn('tiptap-editor', className)}>
        <EditorContent editor={editor} />
        {editor && canEdit && <TiptapBubbleMenus editor={editor} />}
      </div>
    </MarkdownFenceViewProvider>
  )
}
