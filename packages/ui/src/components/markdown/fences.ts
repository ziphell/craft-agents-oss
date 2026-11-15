/**
 * The fences this app draws as a block of its own — one table, read by everything that has an
 * opinion about them.
 *
 * There used to be three opinions, and they had to be kept in step by hand: `Markdown` compared the
 * fence's language against a chain of `if`s (twice — the `minimal` and `full` modes), `PreviewBlock`
 * kept a `Record` of the ones the rich editor knew, and `preview-block-languages` kept the list the
 * code block had to skip. Adding a fence meant four edits and a chance to miss one, and a fence
 * missed in the third place came back from the editor as a code block — which is the diagram being
 * gone, not a display difference. So: one list, and everybody reads it.
 *
 * **This module imports no components.** It is read by the code block (`tiptapCodeBlock`, to know
 * which fences are somebody else's), by the renderer, and by the editor's fence picker; only the
 * last two need anything drawn, and they get it from `fence-components`, which is the heavy half.
 * Keeping the split means a fence's *name* costs nothing to know.
 *
 * ## Custom fences
 *
 * A fence this table does not have is not an error: it stays a code block, in the reader and in the
 * editor alike, and nothing about it is rewritten on the way in or out of the file. To make one draw
 * a block, `registerFence` adds it at runtime — a name, how to describe it in the picker, and
 * `draws`, which borrows an existing block's drawing rather than requiring a second implementation:
 *
 * ```ts
 * registerFence({ name: 'chart', kind: 'preview', draws: 'datatable', title: 'Chart', … })
 * ```
 *
 * That is the whole of "custom fences": a fence name can be given a drawing without a new component,
 * and the reader, the editor's widgets and its picker all learn about it from this one call.
 */

/** How a fence is drawn — the set of blocks the app has an implementation of. */
export type FenceDrawing =
  | 'datatable'
  | 'spreadsheet'
  | 'diff'
  | 'json'
  | 'mermaid'
  | 'mindmap'
  | 'latex'
  | 'drawio-preview'
  | 'html-preview'
  | 'office-preview'
  | 'pdf-preview'
  | 'image-preview'
  | 'markdown-preview'

/**
 * What kind of thing a fence is, which is the question the *reader* asks:
 *
 * - `preview` — a block drawn by one of the preview components, and one `disablePreviewBlocks` may
 *   suppress (a document nested in a document must not draw its own nest again).
 * - `document` — names another document; drawn like a preview but never suppressed-less, and never
 *   drawn *inside* an editor (that would be an editor inside an editor).
 * - `diagram` — mermaid, drawn from its own source.
 * - `math` — a display-math fence.
 */
export type FenceKind = 'preview' | 'document' | 'diagram' | 'math'

export interface FenceSpec {
  /** The fence's language, as written after the backticks. */
  name: string
  kind: FenceKind
  /**
   * What the editor's fence picker calls it.
   *
   * Plain English, like the rich editor's slash menu (`TiptapSlashMenu`) already was: what is being
   * picked is a piece of syntax whose name is English, and a translated label beside an
   * untranslated `drawio-preview` would be the more confusing of the two.
   */
  title: string
  /** One line under the title in the picker: what the block is for. */
  description: string
  /** The body a newly inserted fence starts with — the shape its block actually parses. */
  scaffold: string
  /** The block that draws it. Absent means: a plain code block, which is what most fences are. */
  draws?: FenceDrawing
  /**
   * What a block annotation records as this block's type.
   *
   * Preserved from before this table existed rather than tidied: `diff` and `json` were wrapped as
   * `code`, and annotations written into conversations on that basis must keep matching. Everything
   * else records its own name.
   */
  blockType?: string
  /**
   * Whether an editor may draw this fence in place of its source. Default true; `false` for a fence
   * that names another document, because drawing one is that other document's own pane.
   */
  widget?: boolean
  /**
   * A second name for a fence that already exists — resolvable, drawn, and **kept out of the
   * picker**.
   *
   * The same idea as Outline's `alias: true` in its code-language table: documents written by
   * people (and by other tools) say `math` and `mermaidjs`, and refusing those names would be a
   * filing error about somebody else's file. Offering both in the picker, though, is two entries
   * that do one thing.
   */
  alias?: boolean
}

/**
 * Fences the app no longer draws, though their implementations are still in the codebase.
 *
 * **`office-preview`, off since 2026-10-30.** One block mounts a whole editor application in a frame
 * — 8.3 MB of script for Word, 20.3 MB for Excel, 5.3 MB for PowerPoint — and asks the host for the
 * document's bytes. A conversation renders every turn it has, with no windowing, so a history with a
 * dozen documents booted a dozen editors at once. (Mounting is now also gated on visibility; that
 * made the worst case survivable, not the block cheap.)
 *
 * Retiring the *spec* is what turns it off, and it is the whole of turning it on again: the fence is
 * then an unknown fence, which is a code block — the reader draws nothing, the editor offers
 * nothing, the picker lists nothing. `MarkdownOfficeBlock` and its drawing stay right where they
 * are, unreachable and ready.
 *
 * Nothing to migrate: this fence has never shipped (the table it lives in is still being written),
 * so no person's history turns into JSON code blocks. Delete the name from `RETIRED_FENCES` below and
 * it is back.
 */
const RETIRED_FENCES: ReadonlySet<string> = new Set(['office-preview'])

/**
 * The built-in fences.
 *
 * A fence that is only ever code (`python`, `bash`, …) is deliberately *not* here: this table is
 * "what the app draws", and listing every language would make the picker a language picker. The
 * picker filters as you type, so a fence that is not here simply offers nothing.
 */
const BUILT_IN_FENCES: readonly FenceSpec[] = [
  {
    name: 'mermaid',
    kind: 'diagram',
    title: 'Mermaid diagram',
    description: 'A diagram from mermaid source',
    scaffold: 'graph TD\n  A[Start] --> B[End]',
  },
  {
    // A mindmap is drawn by the app itself rather than by beautiful-mermaid, but it is a
    // self-contained drawing like a mermaid one: no `src`, no overlay of its own, and a block
    // of its own in the editor (`MindmapBlock`).
    name: 'mindmap',
    kind: 'diagram',
    title: 'Mind map',
    description: 'A hierarchy drawn as a mind map',
    scaffold: 'mindmap\n  root((Root))\n    Branch A\n      Leaf A1\n    Branch B',
  },
  {
    name: 'datatable',
    kind: 'preview',
    title: 'Table',
    description: 'A sortable, filterable table from a JSON spec or a data file',
    scaffold: '{"columns": [{"key": "name", "label": "Name"}], "rows": [{"name": "First row"}]}',
  },
  {
    name: 'spreadsheet',
    kind: 'preview',
    title: 'Spreadsheet',
    description: 'An Excel-style grid from a JSON spec or a data file',
    scaffold: '{"columns": [{"key": "a", "label": "A"}], "rows": [{"a": 1}]}',
  },
  {
    name: 'diff',
    kind: 'preview',
    title: 'Diff',
    description: 'A before/after difference, drawn as a change',
    scaffold: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after',
    blockType: 'code',
  },
  {
    name: 'json',
    kind: 'preview',
    title: 'JSON',
    description: 'JSON as a tree you can open and close',
    scaffold: '{"hello": "world"}',
    blockType: 'code',
  },
  {
    name: 'latex',
    kind: 'math',
    title: 'Math',
    description: 'Display math, typeset by KaTeX',
    scaffold: 'E = mc^2',
  },
  {
    // The same block, under the name people actually type.
    name: 'math',
    kind: 'math',
    title: 'Math',
    description: 'The same display-math block as `latex`',
    scaffold: 'E = mc^2',
    draws: 'latex',
    blockType: 'latex',
    alias: true,
  },
  {
    // Spelling seen in the wild, and in Outline's own language table.
    name: 'mermaidjs',
    kind: 'diagram',
    title: 'Mermaid diagram',
    description: 'The same diagram block as `mermaid`',
    scaffold: 'graph TD\n  A[Start] --> B[End]',
    draws: 'mermaid',
    alias: true,
  },
  {
    name: 'drawio-preview',
    kind: 'preview',
    title: 'Diagram file',
    description: 'A .drawio file, drawn by drawio’s own viewer',
    scaffold: '{"src": "diagram.drawio", "title": "Diagram"}',
  },
  {
    name: 'html-preview',
    kind: 'preview',
    title: 'Web page',
    description: 'An HTML file, drawn in a frame with its scripts off',
    scaffold: '{"src": "page.html", "title": "Page"}',
  },
  {
    name: 'office-preview',
    kind: 'preview',
    title: 'Office file',
    description: 'A Word, Excel or PowerPoint file, shown and edited in place',
    scaffold: '{"src": "document.docx"}',
  },
  {
    name: 'pdf-preview',
    kind: 'preview',
    title: 'PDF',
    description: 'A PDF’s first page, with the full viewer a click away',
    scaffold: '{"src": "document.pdf"}',
  },
  {
    name: 'image-preview',
    kind: 'preview',
    title: 'Image',
    description: 'An image file, with the full viewer a click away',
    scaffold: '{"src": "image.png"}',
  },
  {
    name: 'markdown-preview',
    kind: 'document',
    title: 'Document',
    description: 'Another markdown file, rendered here',
    scaffold: '{"src": "notes.md"}',
    widget: false,
  },
]

const registry = new Map<string, FenceSpec>(
  BUILT_IN_FENCES.filter((spec) => !RETIRED_FENCES.has(spec.name)).map((spec) => [spec.name, spec]),
)

/**
 * Add a fence, or change a built-in one.
 *
 * Registered at runtime rather than configured, because the caller is code that already knows what
 * it is drawing — and because a fence is a *drawing*, not a preference. Re-registering a name
 * replaces it, which is how a host app overrides a built-in.
 */
export function registerFence(spec: FenceSpec): void {
  registry.set(spec.name.toLowerCase(), { ...spec, name: spec.name.toLowerCase() })
}

/** For a test that registers a fence and must not leak it into the next one. */
export function unregisterFence(name: string): void {
  const lower = name.toLowerCase()
  const builtIn = BUILT_IN_FENCES.find((spec) => spec.name === lower)
  if (builtIn) registry.set(lower, builtIn)
  else registry.delete(lower)
}

/** The fence with this language, if the app knows it. */
export function fenceSpec(name: string): FenceSpec | undefined {
  return registry.get(name.trim().toLowerCase())
}

/** Everything registered, built-ins first in the order they are written above. */
export function fenceSpecs(): FenceSpec[] {
  return Array.from(registry.values())
}

/**
 * How often each fence has been inserted, for the picker's order.
 *
 * In memory on purpose: this is a convenience of the session, not a preference — the shape a person
 * prefers is the `alias`, and what the picker remembers is which block they reach for, which is
 * worth a session and not worth a file that has to be migrated.
 */
const usage = new Map<string, number>()

export function recordFenceUse(name: string): void {
  const key = name.toLowerCase()
  usage.set(key, (usage.get(key) ?? 0) + 1)
}

/** For a test that needs a known starting point. */
export function resetFenceUsage(): void {
  usage.clear()
}

/**
 * The fences a picker should offer: what the app draws, minus the second names.
 *
 * Ordered by how often this editor has been asked for one, most used first — the list a person
 * actually reaches for settles to the top within a session, which is what makes an unfiltered
 * picker usable instead of a wall of entries. Ties (and the first ever use) are alphabetical, so the
 * order is stable rather than the order of the table above.
 */
export function fenceChoices(): FenceSpec[] {
  return fenceSpecs()
    .filter((spec) => !spec.alias)
    .sort((a, b) => {
      const used = (usage.get(b.name) ?? 0) - (usage.get(a.name) ?? 0)
      return used !== 0 ? used : a.name.localeCompare(b.name)
    })
}

/**
 * The block that draws this fence, or `undefined` for a fence that is a code block.
 *
 * The name a custom fence borrows is resolved here rather than at the call site, so `math` → KaTeX
 * and a registered `chart` → the table are the same question with the same answer.
 */
export function fenceDrawing(name: string): FenceDrawing | undefined {
  const spec = fenceSpec(name)
  if (!spec) return undefined
  return spec.draws ?? (isDrawingName(spec.name) ? (spec.name as FenceDrawing) : undefined)
}

/**
 * What an editor may draw in place of this fence's source.
 *
 * Everything `fenceDrawing` answers, except the ones marked `widget: false` — a document is drawn by
 * its own pane, not inside this one.
 */
export function fenceWidgetDrawing(name: string): FenceDrawing | undefined {
  const spec = fenceSpec(name)
  if (!spec || spec.widget === false) return undefined
  return fenceDrawing(name)
}

/** What a block annotation records for this fence. */
export function fenceBlockType(name: string): string {
  const spec = fenceSpec(name)
  if (!spec) return 'code'
  return spec.blockType ?? fenceDrawing(name) ?? 'code'
}

function isDrawingName(name: string): name is FenceDrawing {
  return (DRAWING_NAMES as readonly string[]).includes(name)
}

const DRAWING_NAMES = [
  'datatable',
  'spreadsheet',
  'diff',
  'json',
  'mermaid',
  'mindmap',
  'latex',
  'drawio-preview',
  'html-preview',
  'office-preview',
  'pdf-preview',
  'image-preview',
  'markdown-preview',
] as const satisfies readonly FenceDrawing[]

/**
 * The fences `disablePreviewBlocks` may suppress, and the ones that have no node of their own in the
 * rich editor — one list, because they are the same list: a preview block is the kind of block that
 * only makes sense while it is not nesting inside itself.
 *
 * `markdown-preview` is deliberately absent: drawing another document here would mount a second
 * editor (or a second renderer) inside this one, with no floor on how deep that goes. It stays a
 * code block.
 */
export const PREVIEW_BLOCK_LANGUAGES = [
  'drawio-preview',
  'html-preview',
  // `office-preview` is absent on purpose: retired, see `RETIRED_FENCES`.
  'pdf-preview',
  'image-preview',
  'datatable',
  'spreadsheet',
  'diff',
  'json',
] as const

export type PreviewBlockLanguage = (typeof PREVIEW_BLOCK_LANGUAGES)[number]

export function isPreviewBlockLanguage(lang: string): lang is PreviewBlockLanguage {
  return (PREVIEW_BLOCK_LANGUAGES as readonly string[]).includes(lang)
}
