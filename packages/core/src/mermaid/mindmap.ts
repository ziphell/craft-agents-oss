/**
 * Mermaid mindmap source, parsed into a tree.
 *
 * `beautiful-mermaid` — the renderer every other diagram in the app goes through — has no
 * mindmap pipeline, so this is the one diagram type the app reads itself. Parsing lives in
 * core rather than in the UI because the syntax is not a drawing: `mermaid_validate` checks the
 * same source in the main process, where there is no DOM and no renderer.
 *
 * Supported subset — what Mermaid's own mindmap examples use:
 *
 * ```mermaid
 * mindmap
 *   root((Root))
 *     Branch
 *       Leaf
 *     Other[Square]
 * ```
 *
 * - indentation defines the hierarchy (spaces or tabs; each level only has to be deeper)
 * - exactly one root; everything indented under a node is its child
 * - shapes: `((circle))`, `(rounded)`, `[rect]`, `{{hexagon}}`, `)cloud(`, `))bang((`,
 *   `>asymmetric]`; a leading id (`id[text]`) is accepted and dropped
 * - `"quoted"` / `` `backticked` `` labels, `<br/>` line breaks
 * - `::icon(...)` and `:::class` are accepted and ignored — decoration, and refusing them would
 *   turn a diagram Mermaid draws into a code block
 * - `%%` comments and leading YAML frontmatter are skipped
 *
 * Anything else stays the label, so a typo shows a wrong word rather than an empty diagram.
 */

export type MindmapShape =
  | 'default'
  | 'rounded'
  | 'circle'
  | 'rect'
  | 'hexagon'
  | 'bang'
  | 'cloud'
  | 'asymmetric'

export interface MindmapNode {
  /** Positional id (`n0`, `n1`, …). Mindmap syntax has no cross-links, so ids are only for keys. */
  id: string
  /** The node's text, one entry per line (`<br/>` splits). */
  label: string
  shape: MindmapShape
  children: MindmapNode[]
}

export class MindmapParseError extends Error {
  /** 1-based line number in the source that failed, when the failure belongs to one. */
  readonly line: number | undefined

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `Line ${line}: ${message}`)
    this.name = 'MindmapParseError'
    this.line = line
  }
}

/** Whether this source is a mindmap, as Mermaid's own header spells it. */
export function isMindmapSource(code: string): boolean {
  const first = firstMeaningfulLine(code)
  return first !== null && /^mindmap\b/i.test(first)
}

/** Parse a `mindmap` fence body. Throws `MindmapParseError` with the offending line. */
export function parseMindmap(code: string): MindmapNode {
  const lines = stripFrontmatter(code).replace(/^\uFEFF/, '').split(/\r?\n/)
  const stack: Array<{ indent: number; node: MindmapNode }> = []
  let root: MindmapNode | null = null
  let nodeCount = 0
  let headerSeen = false

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? ''
    const lineNumber = index + 1
    const content = raw.trim()

    // Blank lines and comments are not nodes; neither is anything Mermaid uses as decoration.
    if (content.length === 0 || content.startsWith('%%')) continue

    if (!headerSeen) {
      if (!/^mindmap\b/i.test(content)) {
        throw new MindmapParseError('A mindmap must start with "mindmap"', lineNumber)
      }
      headerSeen = true
      continue
    }

    if (content.startsWith(':::') || content.startsWith('::icon')) continue

    const indent = indentWidth(raw)
    const node = parseNode(content, nodeCount, lineNumber)
    nodeCount += 1

    // A node belongs to the nearest line above it that is strictly less indented.
    while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop()

    if (stack.length === 0) {
      if (root !== null) throw new MindmapParseError('A mindmap can only have one root node', lineNumber)
      root = node
    } else {
      stack[stack.length - 1]?.node.children.push(node)
    }

    stack.push({ indent, node })
  }

  if (!headerSeen) throw new MindmapParseError('A mindmap must start with "mindmap"')
  if (root === null) throw new MindmapParseError('A mindmap needs a root node')
  return root
}

function firstMeaningfulLine(code: string): string | null {
  for (const line of stripFrontmatter(code).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 0 && !trimmed.startsWith('%%')) return trimmed
  }
  return null
}

/** Remove Mermaid YAML frontmatter (`--- … ---`) from the start of a diagram. */
function stripFrontmatter(code: string): string {
  const withoutBom = code.replace(/^\uFEFF/, '')
  const leadingWhitespace = withoutBom.match(/^\s*/)?.[0] ?? ''
  const candidate = withoutBom.slice(leadingWhitespace.length)
  const lines = candidate.split(/\r?\n/)

  if (lines[0]?.trim() !== '---') return code

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (endIndex === -1) return code

  return lines.slice(endIndex + 1).join('\n').trimStart()
}

/** Indentation as a width, so a tab and four spaces are the same level. */
function indentWidth(line: string): number {
  let width = 0
  for (const character of line) {
    if (character === ' ') width += 1
    else if (character === '\t') width += 4
    else break
  }
  return width
}

const SHAPE_PATTERNS: ReadonlyArray<{ shape: MindmapShape; pattern: RegExp }> = [
  // Order matters: `((…))` is a circle before it can be read as a parenthesised label, and
  // `))…((` before `)…(` for the same reason.
  //
  // The prefix before a delimiter is a bare id, and it has to touch the delimiter: `id[text]`,
  // never `id [text]`. Without that rule a plain label that merely contains brackets —
  // `Node (note)` — would be read as id `Node` plus a shape, and lose its first word. Text with
  // brackets is written as a quoted label instead.
  { shape: 'circle', pattern: /^(?:[^\s()\[\]{}>]*?)\(\((.*?)\)\)$/ },
  { shape: 'bang', pattern: /^(?:[^\s()\[\]{}>]*?)\)\)(.*?)\(\($/ },
  { shape: 'hexagon', pattern: /^(?:[^\s()\[\]{}>]*?)\{\{(.*?)\}\}$/ },
  { shape: 'cloud', pattern: /^(?:[^\s()\[\]{}>]*?)\)(.*?)\($/ },
  { shape: 'rounded', pattern: /^(?:[^\s()\[\]{}>]*?)\((.*?)\)$/ },
  { shape: 'rect', pattern: /^(?:[^\s()\[\]{}>]*?)\[(.*?)\]$/ },
  { shape: 'asymmetric', pattern: /^(?:[^\s()\[\]{}>]*?)>(.*?)\]$/ },
]

function parseNode(text: string, index: number, line: number): MindmapNode {
  const { shape, label } = splitShape(text)
  const cleaned = label
    .replace(/::icon\([^)]*\)/g, '')
    .replace(/\s*:::[\w-]+\s*$/, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .trim()
  const unquoted = unquote(cleaned)

  if (unquoted.length === 0) throw new MindmapParseError('A node needs text', line)

  return { id: `n${index}`, label: unquoted, shape, children: [] }
}

function splitShape(text: string): { shape: MindmapShape; label: string } {
  // A quoted label is the whole node: brackets inside it are text, not a shape.
  if (isQuoted(text)) return { shape: 'default', label: text }

  for (const { shape, pattern } of SHAPE_PATTERNS) {
    const match = pattern.exec(text)
    if (match) return { shape, label: match[1] ?? '' }
  }

  return { shape: 'default', label: text }
}

function isQuoted(text: string): boolean {
  const first = text[0]
  const last = text[text.length - 1]
  return text.length >= 2 && ((first === '"' && last === '"') || (first === '`' && last === '`'))
}

function unquote(text: string): string {
  if (isQuoted(text)) return text.slice(1, -1).trim()
  return text
}
